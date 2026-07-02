// M5.3/M5.4 配对评测驱动 + paired_cache + (F0.2/F0.4) 逐局进度回调 / 停止钩子。
// 跑某版本在 eval 集上的全部 (scenario, seed, run) → MatchRecord → ScoreRecord。
// 子/父用【同一批 scenario、同一组 seed、同一 run_index】,差异只来自 AI 提示词版本。
// paired_cache:同 (version, evalSet, seed 计划) 复用 → 重跑新子版本时父代不重跑,省算力。
// 并发:按成本层把 versions×scenarios×seeds×runs 扁平化进 worker 池;
// onGameStatus 回调逐局广播 pending→running→scoring→finished/failed 状态(含对局内细节);
// shouldStop 让编排器能在局间中止(用户停止)。

import { Injectable, Logger } from "@nestjs/common";
import type { RoomSnapshot } from "../../game/game.types";
import type { Scenario } from "../scenario/types";
import { ScoreService } from "../score/score.service";
import type { ScoreRecord } from "../score/types";
import { SandboxRepository } from "../sandbox.repository";
import { SandboxService } from "../sandbox.service";
import { runWorkerPool } from "../shared/concurrency";
import type { GameDetail, GameStatusPatch, GameStatusUpdate } from "./active-run";
import type { PromptVersion } from "./prompt-version";
import {
  concurrencyForCostTier,
  expandEvalTasks,
  resolveCostTier,
  type EvalTask,
  type EvalCostTier,
} from "./scheduler";

export interface EvalPlan {
  scenarios: Scenario[];
  /**
   * 留出集场景(split=holdout):过优化集闸后跑留出复核(M5.7)。空/缺省 → 跳过留出闸。
   * 这些场景 split=holdout,引擎据此只解析没见过的探测实例(held-out probes)。
   */
  holdoutScenarios?: Scenario[];
  /** 每场景跑几个种子(>1 时用 scenario.seed + i*7919 派生,父子同计划)。 */
  seedsPerScenario: number;
  /** 每个种子跑几局(压 LLM 噪声)。 */
  runsPerSeed: number;
  judgeModelId?: string;
  /** 多裁判集成(M2.11):传 2+ 个模型 id 时 ScoreService 会聚合盲测读数。 */
  judgeModelIds?: string[];
  /** 诊断评分(M2.6/2.7/2.9):逐轮轨迹 + 八维 rubric + judge_eval_needed 探测裁定。 */
  diagnose?: boolean;
  /** 成本分层(M5.14):默认按 diagnose / 多裁判推断。 */
  costTier?: EvalCostTier;
  discussionSeconds?: number;
  evalSetVersion: string;
}

export interface EvalRunOptions {
  /** 逐局状态补丁回调(过程可视化:pending→running→scoring→finished/failed,带对局内细节)。 */
  onGameStatus?: (patch: GameStatusPatch) => void;
  /** 局间检查;返回 true 则尽早中止,返回部分评分(不缓存)。 */
  shouldStop?: () => boolean;
  /** 暂停:与 shouldStop 一样让 worker 池停止派发新局(在跑的跑完),配合 resumeFrom 可续跑。 */
  shouldPause?: () => boolean;
  /** 续跑:已完成的评分(按 scenario|seed|run 跳过,不重跑),暂停后恢复用。 */
  resumeFrom?: ScoreRecord[];
  /** 缓存写入后回调,用于临时 run 回滚时只清理本次新写入的 cache。 */
  onCacheSaved?: (version: PromptVersion, cacheKey: string) => void;
}

export interface MultiVersionEvalRunOptions {
  /** 多版本调度时,回调会携带当前版本,由编排器补 side/child_id。 */
  onGameStatus?: (version: PromptVersion, patch: GameStatusPatch) => void;
  shouldStop?: () => boolean;
  /** 暂停:让 worker 池停止派发新局(在跑的跑完),配合 resumeFrom 可续跑。 */
  shouldPause?: () => boolean;
  /** 续跑:按版本索引的已完成评分,跳过对应任务(不重跑)。 */
  resumeFrom?: Map<string, ScoreRecord[]>;
  /** 缓存写入后回调,用于临时 run 回滚时只清理本次新写入的 cache。 */
  onCacheSaved?: (version: PromptVersion, cacheKey: string) => void;
}

interface VersionEvalTask {
  version: PromptVersion;
  task: EvalTask;
}

interface VersionScore {
  versionId: string;
  score: ScoreRecord;
}

@Injectable()
export class PairedEvalService {
  private readonly logger = new Logger(PairedEvalService.name);

  constructor(
    private readonly sandbox: SandboxService,
    private readonly score: ScoreService,
    private readonly repo: SandboxRepository,
  ) {}

  async runVersionEval(
    version: PromptVersion,
    plan: EvalPlan,
    opts: EvalRunOptions = {},
  ): Promise<ScoreRecord[]> {
    const results = await this.runVersionsEval([version], plan, {
      onGameStatus: (_version, patch) => opts.onGameStatus?.(patch),
      shouldStop: opts.shouldStop,
      shouldPause: opts.shouldPause,
      resumeFrom: opts.resumeFrom
        ? new Map([[version.version_id, opts.resumeFrom]])
        : undefined,
      onCacheSaved: opts.onCacheSaved,
    });
    return results.get(version.version_id) ?? [];
  }

  /**
   * M5.14:把 versions×scenarios×seeds×runs 扁平化进同一个 worker 池。
   * 这样 K 个候选共享同一成本层并发预算,而不是外层逐候选顺序跑或嵌套放大并发。
   */
  async runVersionsEval(
    versions: PromptVersion[],
    plan: EvalPlan,
    opts: MultiVersionEvalRunOptions = {},
  ): Promise<Map<string, ScoreRecord[]>> {
    const result = new Map<string, ScoreRecord[]>();

    const tasks = expandEvalTasks(plan);
    const work: VersionEvalTask[] = [];
    for (const version of versions) {
      // 续跑:该版本已完成的评分(暂停前跑好的),据此跳过对应任务并回放 finished。
      const prior = opts.resumeFrom?.get(version.version_id) ?? [];
      if (prior.length === 0) {
        const key = cacheKey(version.version_id, plan);
        const cached = await this.loadCache(key);
        if (cached) {
          for (const sc of cached) {
            opts.onGameStatus?.(version, scoreToFinishedPatch(sc));
          }
          this.logger.log(`paired_cache 命中(回放 ${cached.length} 条): ${version.version_id}`);
          result.set(version.version_id, cached);
          continue;
        }
      }
      const priorByTask = new Map(
        prior.map((s) => [evalTaskKey(s.scenario_id, s.seed, s.run_index), s] as const),
      );
      for (const task of tasks) {
        const done = priorByTask.get(evalTaskKey(task.scenario.scenario_id, task.seed, task.run));
        if (done) {
          opts.onGameStatus?.(version, scoreToFinishedPatch(done)); // 续跑:已跑完,回放不重跑
          continue;
        }
        opts.onGameStatus?.(version, {
          scenario_id: task.scenario.scenario_id,
          seed: task.seed,
          run: task.run,
          status: "pending",
        });
        work.push({ version, task });
      }
    }

    const tier = resolveCostTier(plan);
    const { results: scored, stopped } = await runWorkerPool<VersionEvalTask, VersionScore>(
      work,
      async ({ version, task }) => {
        const score = await this.runEvalTask(
          version,
          plan,
          task,
          (patch) => opts.onGameStatus?.(version, patch),
          opts.shouldStop,
        );
        return score ? { versionId: version.version_id, score } : undefined;
      },
      {
        concurrency: concurrencyForCostTier(tier),
        // 暂停与停止都让池停派新局(在跑的跑完);paused 靠 resumeFrom 续跑,故也不缓存部分结果。
        shouldStop: () => (opts.shouldStop?.() ?? false) || (opts.shouldPause?.() ?? false),
      },
    );

    // 续跑:先垫入已完成的评分,再并入本轮新跑的。
    const byVersion = new Map<string, ScoreRecord[]>();
    for (const version of versions) {
      const prior = opts.resumeFrom?.get(version.version_id);
      if (prior?.length) byVersion.set(version.version_id, [...prior]);
    }
    for (const item of scored) {
      const arr = byVersion.get(item.versionId) ?? [];
      arr.push(item.score);
      byVersion.set(item.versionId, arr);
    }
    for (const version of versions) {
      if (result.has(version.version_id)) continue;
      const scores = byVersion.get(version.version_id) ?? [];
      result.set(version.version_id, scores);
      if (!stopped) {
        const key = cacheKey(version.version_id, plan);
        await this.saveCache(key, scores);
        opts.onCacheSaved?.(version, key);
      }
    }
    return result;
  }

  private async loadCache(key: string): Promise<ScoreRecord[] | null> {
    return this.repo.loadCache(key);
  }

  private async saveCache(key: string, scores: ScoreRecord[]): Promise<void> {
    await this.repo.saveCache(key, scores);
  }

  private async runEvalTask(
    version: PromptVersion,
    plan: EvalPlan,
    task: EvalTask,
    onGameStatus?: (patch: GameStatusPatch) => void,
    shouldStop?: () => boolean,
  ): Promise<ScoreRecord | undefined> {
    const publish = (patch: GameStatusUpdate) => {
      onGameStatus?.({
        scenario_id: task.scenario.scenario_id,
        seed: task.seed,
        run: task.run,
        ...patch,
      });
    };
    try {
      publish({ status: "running" });
      const match = await this.sandbox.runMatch(
        task.scenario,
        {
          run_index: task.run,
          seed_override: task.seed,
          ai_prompt_version_id: version.version_id,
          discussion_seconds: plan.discussionSeconds,
        },
        (room) => publish({ status: "running", ...snapshotToGamePatch(room) }),
        shouldStop,
      );
      publish({ status: "scoring" });
      const scoreRec = await this.score.scoreMatch(match, {
        judgeModelId: plan.judgeModelId,
        judgeModelIds: plan.judgeModelIds,
        diagnose: plan.diagnose,
      });
      publish({
        status: "finished",
        match_id: match.match_id,
        margin: scoreRec.blind_suspicion?.suspicion_margin ?? null,
        veto: scoreRec.veto_triggered === true,
      });
      this.logger.log(
        `评测 ${version.version_id} ${task.scenario.scenario_id} seed${task.seed} run${task.run} → margin=${scoreRec.blind_suspicion?.suspicion_margin ?? "?"}`,
      );
      return scoreRec;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      publish({ status: "failed", error: errMsg });
      this.logger.warn(
        `评测 ${version.version_id} ${task.scenario.scenario_id} seed${task.seed} run${task.run} 失败: ${errMsg}`,
      );
      return undefined;
    }
  }
}

/** 单任务稳定 key:(scenario, seed, run),用于续跑时跳过已完成的对局。 */
function evalTaskKey(scenario: string, seed: number, run: number): string {
  return `${scenario}|${seed}|${run}`;
}

/** cache key:版本 × 评测集版本 × 种子计划 × 场景指纹(决定缓存是否可复用)。 */
function cacheKey(versionId: string, plan: EvalPlan): string {
  const scnHash = plan.scenarios.map((s) => s.scenario_id).sort().join(",");
  const judgeHash = [
    plan.judgeModelId ?? "default",
    ...(plan.judgeModelIds ?? []).slice().sort(),
  ].join(",");
  const modeHash = [
    plan.diagnose === true ? "diagnose" : "decision",
    `discussion=${plan.discussionSeconds ?? "default"}`,
    `judge=${judgeHash}`,
  ].join("__");
  return `${versionId}__${plan.evalSetVersion}__s${plan.seedsPerScenario}r${plan.runsPerSeed}__${modeHash}__${scnHash}`;
}

/** 房间快照 → 对局内实时细节(phase/当前轮/AI 存活);口径对齐旧 iteration.gameProgressFromSnapshot。 */
function snapshotToGamePatch(room: RoomSnapshot): GameDetail {
  const aiPlayers = room.players.filter((p) => p.revealedType === "ai");
  return {
    room_id: room.id,
    phase: room.phase,
    current_round: room.currentRound,
    ai_alive: aiPlayers.filter((p) => p.status === "alive").length,
    ai_total: aiPlayers.length,
  };
}

/** ScoreRecord → finished 状态补丁(缓存命中回放用)。 */
function scoreToFinishedPatch(sc: ScoreRecord): GameStatusPatch {
  return {
    scenario_id: sc.scenario_id,
    seed: sc.seed,
    run: sc.run_index,
    status: "finished",
    match_id: sc.match_id,
    margin: sc.blind_suspicion?.suspicion_margin ?? null,
    veto: sc.veto_triggered === true,
  };
}
