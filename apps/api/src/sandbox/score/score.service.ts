// M2 裁判评分模块入口:消费 MatchRecord → 产出并落库 ScoreRecord。
// 决策路径(默认):匿名化 → 客观指标(纯算)→ 盲测可疑度(LLM,局末一次)→ 否决 → 组装 → 落库。
// 诊断路径(diagnose=true,M2.6/2.7/2.9):逐轮可疑度轨迹(定位失败轮)→ 诊断裁判(八维 +
//   judge_eval_needed 探测裁定 + 失败案例)→ 把探测裁定并入 probe_pass_by_type、出戏并入否决。
//   逐轮盲测是主开销,故仅在【需要定位】的局开(决策路径不开,保持便宜/确定),由调用方按
//   "高可疑/被判失败"决定。持久化:Postgres(sandbox_score_records),经 SandboxRepository。

import { Injectable, Logger } from "@nestjs/common";
import { AiService } from "../../ai/ai.service";
import type { MatchRecord } from "../match-record/types";
import { SandboxRepository } from "../sandbox.repository";
import { buildAnonymizedView } from "./anonymize";
import { buildScoreRecord } from "./builder";
import type { DiagnosticParts } from "./builder";
import { BlindSuspicionScorer } from "./blind-suspicion";
import { MultiJudgeScorer } from "./multi-judge";
import { computeOutcomeMetrics } from "./objective-metrics";
import { PerRoundTrajectoryScorer } from "./per-round-trajectory";
import { RubricDiagnosticScorer, mergeProbePassByType } from "./rubric-diagnostic";
import { computeVeto } from "./veto";
import type { BlindSuspicion, ScoreRecord, ScoreStatus } from "./types";

export interface ScoreOptions {
  /** 裁判模型 id;缺省用默认模型。 */
  judgeModelId?: string;
  /** 多裁判集成(M2.11):≥2 个模型 id 时启用截尾均值聚合 + judge_agreement;否则单裁判。 */
  judgeModelIds?: string[];
  /** 是否落库(默认 true)。 */
  persist?: boolean;
  /**
   * 是否跑诊断路径(M2.6/2.7/2.9):逐轮轨迹 + 八维诊断 + 探测裁定 + 失败案例。
   * 默认 false —— 决策路径只需局末单测盲测,保持便宜确定;高可疑/失败局再开诊断定位。
   */
  diagnose?: boolean;
}

@Injectable()
export class ScoreService {
  private readonly logger = new Logger(ScoreService.name);

  constructor(
    private readonly ai: AiService,
    private readonly blind: BlindSuspicionScorer,
    private readonly multiJudge: MultiJudgeScorer,
    private readonly trajectory: PerRoundTrajectoryScorer,
    private readonly diagnostic: RubricDiagnosticScorer,
    private readonly repo: SandboxRepository,
  ) {}

  /** 评分一份已产出的 MatchRecord。 */
  async scoreMatch(
    match: MatchRecord,
    opts: ScoreOptions = {},
  ): Promise<ScoreRecord> {
    const view = buildAnonymizedView(match);
    const outcome = computeOutcomeMetrics(match);
    let veto = computeVeto(match);

    let suspicion: BlindSuspicion;
    let judges: string[] = [];
    let judgeAgreement: number | null = null;
    let blindOk: boolean;
    let diagnostic: DiagnosticParts | undefined;
    let diagPartial = false;

    if (opts.diagnose) {
      // 诊断路径:逐轮轨迹定位失败轮,再跑诊断裁判。
      const traj = await this.trajectory.run(match, opts.judgeModelId);
      suspicion = traj.suspicion;
      blindOk = traj.ok;
      const diag = await this.diagnostic.run(
        match,
        view,
        traj.failureRound,
        opts.judgeModelId,
      );
      if (blindOk) judges = [diag.judgeModel];
      if (diag.ok) {
        diagnostic = {
          rubric: diag.rubric,
          humanness_composite: diag.humanness_composite,
          probe_verdicts: diag.probe_verdicts,
          failure_cases: diag.failure_cases,
          failure_round: traj.failureRound,
        };
        // M2.9:探测裁定并入 probe_pass_by_type(引擎 auto 优先);诊断 出戏 → 否决 OR。
        outcome.probe_pass_by_type = mergeProbePassByType(match, diag.probe_verdicts);
        veto = veto || diag.vetoFromRubric;
      } else {
        diagPartial = true;
      }
    } else if (opts.judgeModelIds && opts.judgeModelIds.length >= 2) {
      // M2.11 多裁判:截尾均值聚合 + judge_agreement。
      const res = await this.multiJudge.score(match, view, opts.judgeModelIds);
      suspicion = res.suspicion;
      judges = res.judges;
      judgeAgreement = res.judge_agreement;
      blindOk = res.ok;
    } else {
      const res = await this.blind.score(match, view, opts.judgeModelId);
      suspicion = res.suspicion;
      if (res.ok) judges = [res.judgeModel];
      blindOk = res.ok;
    }

    // 来源对局 degraded 优先;否则盲测/诊断任一失败 → partial。
    const status: ScoreStatus =
      match.status === "degraded" ? "degraded" : blindOk && !diagPartial ? "ok" : "partial";
    const errors: string[] = [];
    if (!blindOk) errors.push("blind_suspicion_failed");
    if (diagPartial) errors.push("diagnostic_failed");

    const record = buildScoreRecord(match, {
      outcome,
      blind: suspicion,
      judges,
      judgeAgreement,
      veto,
      status,
      errors: errors.length > 0 ? errors : undefined,
      diagnostic,
    });

    if (opts.persist !== false) {
      await this.repo.upsertScoreRecord(record);
      this.logger.log(`ScoreRecord 已落库: ${record.score_id}${opts.diagnose ? " (diagnosed)" : ""}`);
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
