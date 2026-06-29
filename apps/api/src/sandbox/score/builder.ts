// M2.10 ScoreRecord 组装器(纯函数):把各部件拼成一份合规 ScoreRecord。

import type { MatchRecord } from "../match-record/types";
import {
  SCORE_RECORD_SCHEMA_VERSION,
  type BlindSuspicion,
  type FailureCase,
  type OutcomeMetrics,
  type ProbeVerdict,
  type ScoreRecord,
  type ScoreStatus,
} from "./types";

/** 诊断信号(M2.6/2.7/2.9;仅 diagnose 时存在)。 */
export interface DiagnosticParts {
  rubric: Record<string, number>;
  humanness_composite: number;
  probe_verdicts: ProbeVerdict[];
  failure_cases: FailureCase[];
  failure_round: number | null;
}

export interface ScoreRecordParts {
  outcome: OutcomeMetrics;
  blind: BlindSuspicion;
  judges: string[];
  veto: boolean;
  status: ScoreStatus;
  errors?: string[];
  /** 诊断路径产物;缺省 → 纯决策信号 ScoreRecord。 */
  diagnostic?: DiagnosticParts;
}

export function buildScoreRecord(
  match: MatchRecord,
  parts: ScoreRecordParts,
): ScoreRecord {
  return {
    schema_version: SCORE_RECORD_SCHEMA_VERSION,
    score_id: `s_${match.match_id}`,
    match_id: match.match_id,
    prompt_version_id: match.prompt_version_id,
    scenario_id: match.scenario_id,
    scenario_form: match.scenario_form,
    seed: match.seed,
    run_index: match.run_index,
    judges: parts.judges,
    judge_agreement: null, // MVP 单裁判
    outcome_metrics: parts.outcome,
    blind_suspicion: parts.blind,
    rubric: parts.diagnostic?.rubric,
    humanness_composite: parts.diagnostic?.humanness_composite,
    probe_verdicts: parts.diagnostic?.probe_verdicts,
    failure_round: parts.diagnostic?.failure_round ?? null,
    veto_triggered: parts.veto,
    failure_cases: parts.diagnostic?.failure_cases,
    status: parts.status,
    errors: parts.errors,
    timestamp: new Date().toISOString(),
  };
}
