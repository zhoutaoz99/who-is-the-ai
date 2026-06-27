// M2 裁判评分模块入口:消费 MatchRecord → 产出并落库 ScoreRecord(决策信号层)。
// 流程:匿名化 → 客观指标(纯算)→ 盲测可疑度(LLM,局末一次)→ 否决 → 组装 → 落库。
// MVP(Phase 1)只跑决策信号;诊断层(八维/failure_cases)随《诊断评分》在 Phase 2 接入。
// 持久化:Postgres(sandbox_score_records),经 SandboxRepository。

import { Injectable, Logger } from "@nestjs/common";
import { AiService } from "../../ai/ai.service";
import type { MatchRecord } from "../match-record/types";
import { SandboxRepository } from "../sandbox.repository";
import { buildAnonymizedView } from "./anonymize";
import { buildScoreRecord } from "./builder";
import { BlindSuspicionScorer } from "./blind-suspicion";
import { computeOutcomeMetrics } from "./objective-metrics";
import { computeVeto } from "./veto";
import type { ScoreRecord, ScoreStatus } from "./types";

export interface ScoreOptions {
  /** 裁判模型 id;缺省用默认模型。 */
  judgeModelId?: string;
  /** 是否落库(默认 true)。 */
  persist?: boolean;
}

@Injectable()
export class ScoreService {
  private readonly logger = new Logger(ScoreService.name);

  constructor(
    private readonly ai: AiService,
    private readonly blind: BlindSuspicionScorer,
    private readonly repo: SandboxRepository,
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
      await this.repo.upsertScoreRecord(record);
      this.logger.log(`ScoreRecord 已落库: ${record.score_id}`);
    }
    return record;
  }

  /** 按 match_id 从 DB 读 MatchRecord 再评分。 */
  async scoreStoredMatch(
    matchId: string,
    opts: ScoreOptions = {},
  ): Promise<ScoreRecord> {
    const match = await this.repo.loadMatchRecord(matchId);
    if (!match) {
      throw new Error(`未找到 MatchRecord: ${matchId}`);
    }
    return this.scoreMatch(match, opts);
  }

  /** 读已落库的 ScoreRecord(按 match_id);缺失返回 null。 */
  async loadStoredScore(matchId: string): Promise<ScoreRecord | null> {
    return this.repo.loadScoreByMatch(matchId);
  }
}
