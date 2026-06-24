import { MAX_ROUNDS } from "../../game/game.config";
import type { Player, Room } from "../../game/game.types";
import type { Scenario } from "../scenario/types";
import {
  MATCH_RECORD_SCHEMA_VERSION,
  type Elimination,
  type MatchRecord,
  type MatchVote,
  type Outcome,
  type ReachedTerminal,
  type Turn,
} from "./types";

interface BuildOptions {
  promptVersionId: string;
  runIndex: number;
}

/** 从一局已结束的内部 Room 构建 MatchRecord(对齐《对局记录 · Schema 契约》)。 */
export function buildMatchRecord(
  room: Room,
  scenario: Scenario,
  options: BuildOptions,
): MatchRecord {
  // slot 即玩家编号(座位号):直接用 seatNo,无需额外槽位映射。
  const seatNoOf = (playerId: string): number =>
    room.players.find((p) => p.id === playerId)?.seatNo ?? 0;
  const roleOf = (playerId: string): Turn["role"] =>
    (room.players.find((p) => p.id === playerId)?.sandboxRole as Turn["role"]) ?? "filler";

  const transcript: Turn[] = room.messages.map((message, index) => {
    const slot = seatNoOf(message.playerId);
    const intent = (scenario.intent_schedule ?? []).find(
      (d) => d.round === message.roundNo && d.slot === slot,
    )?.intent;
    return {
      idx: index,
      round: message.roundNo,
      phase: "discussion",
      slot,
      role: roleOf(message.playerId),
      text: message.content,
      is_probe: false,
      probe_ref: null,
      injected_intent: intent ?? null,
      from_seed_history: false,
    };
  });

  const votes: MatchVote[] = room.votes.map((vote) => {
    const memory = room.aiMemories?.[vote.voterPlayerId];
    const reason =
      memory?.votes.find((v) => v.roundNo === vote.roundNo)?.publicReason ?? null;
    return {
      round: vote.roundNo,
      voter_slot: seatNoOf(vote.voterPlayerId),
      target_slot: seatNoOf(vote.targetPlayerId),
      reason,
      policy_applied: "live",
    };
  });

  const lastRound = Math.max(1, room.currentRound, ...room.messages.map((m) => m.roundNo));
  const eliminations: Elimination[] = [];
  for (let round = 1; round <= lastRound; round += 1) {
    const roundVotes = room.votes.filter((v) => v.roundNo === round);
    if (roundVotes.length === 0) {
      continue;
    }
    const tally: Record<number, number> = {};
    for (const vote of roundVotes) {
      const slot = seatNoOf(vote.targetPlayerId);
      tally[slot] = (tally[slot] ?? 0) + 1;
    }
    const eliminatedPlayer = room.players.find((p) => p.eliminatedRound === round);
    const eliminatedSlot = eliminatedPlayer ? eliminatedPlayer.seatNo : null;
    eliminations.push({
      round,
      eliminated_slot: eliminatedSlot,
      tie: eliminatedSlot == null,
      tally,
    });
  }

  const aiPlayer = room.players.find((p) => p.seatNo === scenario.ai_under_test_slot);
  const outcome = buildOutcome(aiPlayer, room, lastRound);

  const models: Record<number, string> = {};
  const personas: Record<number, string> = {};
  for (const player of room.players) {
    models[player.seatNo] = player.aiModelId ?? "";
    personas[player.seatNo] = player.aiPersonaId ?? "";
  }

  return {
    schema_version: MATCH_RECORD_SCHEMA_VERSION,
    match_id: `m_${scenario.scenario_id}_${options.promptVersionId}_run${options.runIndex}_${room.id}`,
    scenario_id: scenario.scenario_id,
    scenario_form: scenario.form,
    seed_history_ref: null,
    prompt_version_id: options.promptVersionId,
    run_index: options.runIndex,
    seed: scenario.seed,
    mode: scenario.mode,
    vote_policy: scenario.vote_policy,
    ai_under_test_slot: scenario.ai_under_test_slot,
    start_round: 1,
    models,
    personas,
    transcript,
    votes,
    eliminations,
    probe_events: [],
    outcome,
    config: {
      discussion_duration_ms: room.discussionDurationMs,
      max_rounds: MAX_ROUNDS,
      temperatures: Object.fromEntries(
        scenario.roster.filter((r) => r.temperature != null).map((r) => [r.slot, r.temperature]),
      ),
    },
    status: "ok",
    timestamp: new Date().toISOString(),
  };
}

function buildOutcome(
  aiPlayer: Player | undefined,
  room: Room,
  lastRound: number,
): Outcome {
  const startRound = 1;
  const eliminatedRound = aiPlayer?.eliminatedRound ?? null;
  const aiWon = room.winner === "ai";
  const survived =
    eliminatedRound != null ? eliminatedRound - startRound : lastRound - startRound + 1;
  let reachedTerminal: ReachedTerminal;
  if (eliminatedRound != null) {
    reachedTerminal = "ai_eliminated";
  } else if (aiWon) {
    reachedTerminal = "ai_survived";
  } else {
    reachedTerminal = "rounds_exhausted";
  }
  return {
    ai_won: aiWon,
    ai_rounds_survived_from_start: Math.max(0, survived),
    ai_eliminated_round: eliminatedRound,
    reached_terminal: reachedTerminal,
  };
}
