// M5.3/M5.4 配对评测驱动 + paired_cache + (F0.2/F0.4) 逐局进度回调 / 停止钩子。
// 跑某版本在 eval 集上的全部 (scenario, seed, run) → MatchRecord → ScoreRecord。
// 子/父用【同一批 scenario、同一组 seed、同一 run_index】,差异只来自 AI 提示词版本。
// paired_cache:同 (version, evalSet, seed 计划) 复用 → 重跑新子版本时父代不重跑,省算力。
// F0:onMatch 回调驱动过程可视化;shouldStop 让编排器能在局间中止(用户停止)。

import { Injectable, Logger } from "@nestjs/common";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Scenario } from "../scenario/types";
import { ScoreService } from "../score/score.service";
import type { ScoreRecord } from "../score/types";
import { SandboxService } from "../sandbox.service";
import type { PromptVersion } from "./prompt-version";

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
  /** 每局评分完成后回调(过程可视化:逐局追加 margin/veto)。 */
  onMatch?: (score: ScoreRecord) => void;
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
      // 缓存命中:回放每条给 onMatch(前台仍能看到逐局进度),不跑新对局。
      if (opts.onMatch) {
        for (const sc of cached) opts.onMatch(sc);
      }
      this.logger.log(`paired_cache 命中(回放 ${cached.length} 条): ${version.version_id}`);
      return cached;
    }

    const scores: ScoreRecord[] = [];
    let stopped = false;
    for (const scenario of plan.scenarios) {
      if (stopped) break;
      for (let s = 0; s < plan.seedsPerScenario; s += 1) {
        if (stopped) break;
        const seed = plan.seedsPerScenario > 1 ? scenario.seed + s * 7919 : scenario.seed;
        for (let r = 0; r < plan.runsPerSeed; r += 1) {
          if (opts.shouldStop?.()) {
            stopped = true;
            break;
          }
          const match = await this.sandbox.runMatch(scenario, {
            run_index: r,
            seed_override: seed,
            ai_prompt_version_id: version.version_id,
            discussion_seconds: plan.discussionSeconds,
          });
          const scoreRec = await this.score.scoreMatch(match, {
            judgeModelId: plan.judgeModelId,
          });
          scores.push(scoreRec);
          opts.onMatch?.(scoreRec);
          this.logger.log(
            `评测 ${version.version_id} ${scenario.scenario_id} seed${seed} run${r} → margin=${scoreRec.blind_suspicion.suspicion_margin ?? "?"}`,
          );
        }
      }
    }

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
