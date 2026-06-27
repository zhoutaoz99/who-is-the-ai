// M5.3/M5.4 配对评测驱动 + paired_cache + (F0.2/F0.4) 逐局进度回调 / 停止钩子。
// 跑某版本在 eval 集上的全部 (scenario, seed, run) → MatchRecord → ScoreRecord。
// 子/父用【同一批 scenario、同一组 seed、同一 run_index】,差异只来自 AI 提示词版本。
// paired_cache:同 (version, evalSet, seed 计划) 复用 → 重跑新子版本时父代不重跑,省算力。
// 并发:worker 池(GAME_CONCURRENCY)并发跑局;onGameStatus 回调逐局广播 pending→running→scoring→finished/failed 状态(含对局内细节);shouldStop 让编排器能在局间中止(用户停止)。

import { Injectable, Logger } from "@nestjs/common";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RoomSnapshot } from "../../game/game.types";
import type { Scenario } from "../scenario/types";
import { ScoreService } from "../score/score.service";
import type { ScoreRecord } from "../score/types";
import { SandboxService } from "../sandbox.service";
import type { GameDetail, GameStatusPatch, GameStatusUpdate } from "./active-run";
import type { PromptVersion } from "./prompt-version";

/** 对局并发上限(对齐旧 iteration 的 worker 池;GameService 多房间已验证可安全并发)。 */
const GAME_CONCURRENCY = 3;

export interface EvalPlan {
  scenarios: Scenario[];
  /** 每场景跑几个种子(>1 时用 scenario.seed + i*7919 派生,父子同计划)。 */
  seedsPerScenario: number;
  /** 每个种子跑几局(压 LLM 噪声)。 */
  runsPerSeed: number;
  judgeModelId?: string;
  discussionSeconds?: number;
  evalSetVersion: string;
}

export interface EvalRunOptions {
  /** 逐局状态补丁回调(过程可视化:pending→running→scoring→finished/failed,带对局内细节)。 */
  onGameStatus?: (patch: GameStatusPatch) => void;
  /** 局间检查;返回 true 则尽早中止,返回部分评分(不缓存)。 */
  shouldStop?: () => boolean;
}

@Injectable()
export class PairedEvalService {
  private readonly logger = new Logger(PairedEvalService.name);
  private readonly cacheDir: string;

  constructor(
    private readonly sandbox: SandboxService,
    private readonly score: ScoreService,
  ) {
    const root = process.env.SANDBOX_OUT_DIR ?? join(process.cwd(), "sandbox-out");
    this.cacheDir = join(root, "cache");
  }

  async runVersionEval(
    version: PromptVersion,
    plan: EvalPlan,
    opts: EvalRunOptions = {},
  ): Promise<ScoreRecord[]> {
    const key = cacheKey(version.version_id, plan);
    const cached = this.loadCache(key);
    if (cached) {
      // 缓存命中:回放每条为 finished 状态给前台(列表仍能看到逐局),不跑新对局。
      if (opts.onGameStatus) {
        for (const sc of cached) {
          opts.onGameStatus(scoreToFinishedPatch(sc));
        }
      }
      this.logger.log(`paired_cache 命中(回放 ${cached.length} 条): ${version.version_id}`);
      return cached;
    }

    // 展开全部 (scenario, seed, run) 任务,先广播 pending(列表显示全部待开始)。
    const tasks: Array<{ scenario: Scenario; seed: number; run: number }> = [];
    for (const scenario of plan.scenarios) {
      for (let s = 0; s < plan.seedsPerScenario; s += 1) {
        const seed = plan.seedsPerScenario > 1 ? scenario.seed + s * 7919 : scenario.seed;
        for (let r = 0; r < plan.runsPerSeed; r += 1) {
          tasks.push({ scenario, seed, run: r });
        }
      }
    }
    for (const t of tasks) {
      opts.onGameStatus?.({
        scenario_id: t.scenario.scenario_id,
        seed: t.seed,
        run: t.run,
        status: "pending",
      });
    }

    // worker 池并发(上限 GAME_CONCURRENCY),逐局完成即广播状态。
    const scores: ScoreRecord[] = [];
    let stopped = false;
    let next = 0;
    const workers = Array.from(
      { length: Math.min(GAME_CONCURRENCY, tasks.length) },
      async () => {
        while (next < tasks.length) {
          if (opts.shouldStop?.()) {
            stopped = true;
            break;
          }
          const t = tasks[next++];
          const publish = (patch: GameStatusUpdate) => {
            opts.onGameStatus?.({
              scenario_id: t.scenario.scenario_id,
              seed: t.seed,
              run: t.run,
              ...patch,
            });
          };
          try {
            publish({ status: "running" });
            const match = await this.sandbox.runMatch(
              t.scenario,
              {
                run_index: t.run,
                seed_override: t.seed,
                ai_prompt_version_id: version.version_id,
                discussion_seconds: plan.discussionSeconds,
              },
              (room) => publish({ status: "running", ...snapshotToGamePatch(room) }),
            );
            publish({ status: "scoring" });
            const scoreRec = await this.score.scoreMatch(match, {
              judgeModelId: plan.judgeModelId,
            });
            scores.push(scoreRec);
            publish({
              status: "finished",
              match_id: match.match_id,
              margin: scoreRec.blind_suspicion?.suspicion_margin ?? null,
              veto: scoreRec.veto_triggered === true,
            });
            this.logger.log(
              `评测 ${version.version_id} ${t.scenario.scenario_id} seed${t.seed} run${t.run} → margin=${scoreRec.blind_suspicion?.suspicion_margin ?? "?"}`,
            );
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            publish({ status: "failed", error: errMsg });
            this.logger.warn(
              `评测 ${version.version_id} ${t.scenario.scenario_id} seed${t.seed} run${t.run} 失败: ${errMsg}`,
            );
          }
        }
      },
    );
    await Promise.all(workers);

    if (!stopped) this.saveCache(key, scores); // 只缓存完整结果
    return scores;
  }

  private loadCache(key: string): ScoreRecord[] | null {
    const file = join(this.cacheDir, `${key}.json`);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf-8")) as ScoreRecord[];
    } catch {
      return null;
    }
  }

  private saveCache(key: string, scores: ScoreRecord[]): void {
    mkdirSync(this.cacheDir, { recursive: true });
    writeFileSync(join(this.cacheDir, `${key}.json`), JSON.stringify(scores, null, 2), "utf-8");
  }
}

/** cache key:版本 × 评测集版本 × 种子计划 × 场景指纹(决定缓存是否可复用)。 */
function cacheKey(versionId: string, plan: EvalPlan): string {
  const scnHash = plan.scenarios.map((s) => s.scenario_id).sort().join(",");
  return `${versionId}__${plan.evalSetVersion}__s${plan.seedsPerScenario}r${plan.runsPerSeed}__${scnHash}`;
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
