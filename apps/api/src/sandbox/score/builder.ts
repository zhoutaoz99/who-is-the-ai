// M2.10 ScoreRecord 组装器(纯函数):把各部件拼成一份合规 ScoreRecord。

import type { MatchRecord } from "../match-record/types";
import {
  SCORE_RECORD_SCHEMA_VERSION,
  type BlindSuspicion,
  type OutcomeMetrics,
  type ScoreRecord,
  type ScoreStatus,
} from "./types";

export interface ScoreRecordParts {
  outcome: OutcomeMetrics;
  blind: BlindSuspicion;
  judges: string[];
  veto: boolean;
  status: ScoreStatus;
  errors?: string[];
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
    veto_triggered: parts.veto,
    status: parts.status,
    errors: parts.errors,
    timestamp: new Date().toISOString(),
  };
}
