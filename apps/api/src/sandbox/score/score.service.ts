// M2 裁判评分模块入口:消费 MatchRecord → 产出并落盘 ScoreRecord(决策信号层)。
// 流程:匿名化 → 客观指标(纯算)→ 盲测可疑度(LLM,局末一次)→ 否决 → 组装 → 落盘。
// MVP(Phase 1)只跑决策信号;诊断层(八维/failure_cases)随《诊断评分》在 Phase 2 接入。

import { Injectable, Logger } from "@nestjs/common";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AiService } from "../../ai/ai.service";
import { writeJsonFile } from "../shared/store";
import type { MatchRecord } from "../match-record/types";
import { buildAnonymizedView } from "./anonymize";
import { buildScoreRecord } from "./builder";
import { BlindSuspicionScorer } from "./blind-suspicion";
import { computeOutcomeMetrics } from "./objective-metrics";
import { computeVeto } from "./veto";
import type { ScoreRecord, ScoreStatus } from "./types";

export interface ScoreOptions {
  /** 裁判模型 id;缺省用默认模型。 */
  judgeModelId?: string;
  /** 是否落盘(默认 true)。 */
  persist?: boolean;
}

@Injectable()
export class ScoreService {
  private readonly logger = new Logger(ScoreService.name);
  private readonly outDir =
    process.env.SANDBOX_OUT_DIR ?? join(process.cwd(), "sandbox-out");

  constructor(
    private readonly ai: AiService,
    private readonly blind: BlindSuspicionScorer,
  ) {}

  /** 评分一份已产出的 MatchRecord。 */
  async scoreMatch(
    match: MatchRecord,
    opts: ScoreOptions = {},
  ): Promise<ScoreRecord> {
    const view = buildAnonymizedView(match);
    const outcome = computeOutcomeMetrics(match);
    const veto = computeVeto(match);
    const { suspicion, judgeModel, ok } = await this.blind.score(
      match,
      view,
      opts.judgeModelId,
    );

    // 来源对局 degraded 优先;否则裁判失败 → partial。
    const status: ScoreStatus =
      match.status === "degraded" ? "degraded" : ok ? "ok" : "partial";

    const record = buildScoreRecord(match, {
      outcome,
      blind: suspicion,
      judges: ok ? [judgeModel] : [],
      veto,
      status,
      errors: ok ? undefined : ["blind_suspicion_failed"],
    });

    if (opts.persist !== false) {
      const dir = join(this.outDir, "scores");
      const path = await writeJsonFile(dir, `${record.score_id}.json`, record);
      this.logger.log(`ScoreRecord 已写出: ${path}`);
    }
    return record;
  }

  /** 按 match_id 从 sandbox-out 读 MatchRecord 再评分。 */
  async scoreStoredMatch(
    matchId: string,
    opts: ScoreOptions = {},
  ): Promise<ScoreRecord> {
    const file = join(this.outDir, `${matchId}.json`);
    let raw: string;
    try {
      raw = readFileSync(file, "utf-8");
    } catch {
      throw new Error(`未找到 MatchRecord: ${file}`);
    }
    const match = JSON.parse(raw) as MatchRecord;
    return this.scoreMatch(match, opts);
  }

  /** 读已落盘的 ScoreRecord(score_id = s_<match_id>);缺失返回 null。 */
  loadStoredScore(matchId: string): ScoreRecord | null {
    const file = join(this.outDir, "scores", `s_${matchId}.json`);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf-8")) as ScoreRecord;
    } catch {
      return null;
    }
  }
}
