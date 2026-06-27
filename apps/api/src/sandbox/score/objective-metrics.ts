// M2.2 客观结果指标(纯计算,从 MatchRecord 直接得,不调 LLM)。
// 这是决策信号里的"真值"部分:存活/被票/探测通过率。

import type { MatchRecord } from "../match-record/types";
import type { OutcomeMetrics } from "./types";

/** 从一局记录算出客观结果指标。 */
export function computeOutcomeMetrics(match: MatchRecord): OutcomeMetrics {
  const ai = match.ai_under_test_slot;

  // 每轮票型(被投对象 → 票数),据此算 AI 被票数与是否最多。
  const tallyByRound = new Map<number, Map<number, number>>();
  for (const v of match.votes) {
    const tally = tallyByRound.get(v.round) ?? new Map<number, number>();
    tally.set(v.target_slot, (tally.get(v.target_slot) ?? 0) + 1);
    tallyByRound.set(v.round, tally);
  }

  const votesReceived: Record<number, number> = {};
  const plurality: Record<number, boolean> = {};
  for (const [round, tally] of tallyByRound) {
    const counts = [...tally.values()];
    const max = counts.length > 0 ? Math.max(...counts) : 0;
    const aiVotes = tally.get(ai) ?? 0;
    votesReceived[round] = aiVotes;
    // AI 是否为票最高者(并列最高也属致命,因为最可疑者出局)。
    plurality[round] = aiVotes > 0 && aiVotes === max;
  }

  // 探测通过率:仅统计 auto_eval 已判定的探测(judge_eval_needed 的不计,None≠0)。
  const probeByType = new Map<string, { pass: number; total: number }>();
  for (const pe of match.probe_events) {
    if (!pe.auto_eval) continue; // 交裁判的,本增量未判 → 不入通过率
    const slot = probeByType.get(pe.type) ?? { pass: 0, total: 0 };
    slot.total += 1;
    if (pe.auto_eval.result === "pass") slot.pass += 1;
    probeByType.set(pe.type, slot);
  }
  const probePass: Record<string, number> = {};
  for (const [type, s] of probeByType) {
    probePass[type] = s.total > 0 ? s.pass / s.total : 0;
  }

  return {
    rounds_survived: match.outcome.ai_rounds_survived_from_start,
    eliminated_round: match.outcome.ai_eliminated_round,
    won: match.outcome.ai_won,
    reached_terminal: match.outcome.reached_terminal,
    votes_received_by_round: votesReceived,
    plurality_by_round: plurality,
    probe_pass_by_type: probePass,
  };
}
