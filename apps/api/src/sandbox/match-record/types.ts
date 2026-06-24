// MatchRecord 输出契约(子集)——以《对局记录 · Schema 契约》为准。
// 本增量:full_match / scripted_intent / live;probe_events 恒为空数组。

import type { SandboxRole, ScenarioForm, VotePolicy } from "../scenario/types";

export const MATCH_RECORD_SCHEMA_VERSION = "1.3.0";

export type ReachedTerminal = "ai_eliminated" | "ai_survived" | "rounds_exhausted";
export type MatchStatus = "ok" | "degraded";

export interface Turn {
  idx: number;
  round: number;
  phase: "discussion";
  /** 玩家编号(座位号,1..N)。 */
  slot: number;
  role: SandboxRole;
  text: string;
  is_probe: boolean;
  probe_ref?: string | null;
  injected_intent?: string | null;
  from_seed_history?: boolean;
}

export interface MatchVote {
  round: number;
  voter_slot: number;
  target_slot: number;
  reason: string | null;
  policy_applied: VotePolicy;
}

export interface Elimination {
  round: number;
  eliminated_slot: number | null;
  tie: boolean;
  tally: Record<number, number>;
}

export interface Outcome {
  ai_won: boolean;
  ai_rounds_survived_from_start: number;
  ai_eliminated_round: number | null;
  reached_terminal: ReachedTerminal;
}

export interface ErrorEntry {
  round: number;
  phase: string;
  slot: number;
  kind: string;
  detail: string;
  retries: number;
}

export interface MatchRecord {
  schema_version: string;
  match_id: string;
  scenario_id: string;
  scenario_form: ScenarioForm;
  seed_history_ref: string | null;
  prompt_version_id: string;
  run_index: number;
  seed: number;
  mode: string;
  vote_policy: VotePolicy;
  ai_under_test_slot: number;
  start_round: number;
  models: Record<number, string>;
  personas: Record<number, string>;
  transcript: Turn[];
  votes: MatchVote[];
  eliminations: Elimination[];
  probe_events: unknown[];
  outcome: Outcome;
  config: Record<string, unknown>;
  status: MatchStatus;
  errors?: ErrorEntry[];
  timestamp: string;
}
