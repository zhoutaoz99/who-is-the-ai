import {
  AI_PLAYER_COUNT,
  DEBUG,
  MAX_HUMAN_PLAYERS,
  MAX_ROUNDS,
  REWARD_POOL,
  SPEAK_COOLDOWN_MS,
  VOTE_DURATION_MS,
} from "./game.config";
import { AI_PERSONAS, getAiPersonaById } from "../ai/ai.personas";
import {
  canStartDebugAutoAiRoom,
  countAi,
  countHumans,
} from "./game.rules";
import {
  ChatMessage,
  PublicVoteResult,
  Room,
  RoomSnapshot,
} from "./game.types";

export function toRoomSnapshot(room: Room): RoomSnapshot {
  const revealTypes = room.status === "finished";
  const showDebugWaitingAi = DEBUG && room.status === "waiting";
  const showDebugAutoAi = DEBUG && room.debugAutoAi === true;
  const hideAi = room.status === "waiting" && !showDebugWaitingAi;
  const aiPlayerCount = room.debugAutoAi ? countAi(room) : AI_PLAYER_COUNT;

  return {
    id: room.id,
    status: room.status,
    ownerPlayerId: room.ownerPlayerId,
    players: room.players
      .slice()
      .sort((a, b) => a.seatNo - b.seatNo)
      .filter((player) => !hideAi || player.type !== "ai")
      .map((player) => {
        const exposeDebugAi =
          player.type === "ai" && (showDebugWaitingAi || showDebugAutoAi);
        const persona = revealTypes || exposeDebugAi
          ? getAiPersonaById(player.aiPersonaId)
          : null;
        return {
          id: player.id,
          name: player.name,
          status: player.status,
          seatNo: player.seatNo,
          connected: player.connected,
          eliminatedRound: player.eliminatedRound,
          revealedType: revealTypes
            ? player.type
            : exposeDebugAi
              ? player.type
              : undefined,
          aiPersonaId: persona?.id,
          aiPersonaName: persona?.name,
        };
      }),
    currentRound: room.currentRound,
    phase: room.phase,
    phaseEndsAt: room.phaseEndsAt,
    winner: room.winner,
    messages: (room.status === "finished" ? room.messages : room.messages.slice(-80))
      .map((message) => toPublicMessage(message, room)),
    voteCounts: getVoteCounts(room),
    voteResults: getPublicVoteResults(room),
    pointAwards: room.pointAwards,
    config: {
      maxHumanPlayers: MAX_HUMAN_PLAYERS,
      aiPlayerCount,
      aiPersonas: DEBUG
        ? AI_PERSONAS.map((persona) => ({
            id: persona.id,
            name: persona.name,
          }))
        : undefined,
      maxRounds: MAX_ROUNDS,
      discussionDurationMs: room.discussionDurationMs,
      voteDurationMs: VOTE_DURATION_MS,
      speakCooldownMs: SPEAK_COOLDOWN_MS,
      rewardPool: REWARD_POOL,
    },
    canStart:
      room.status === "waiting" &&
      (countHumans(room) >= 1 ||
        (showDebugAutoAi && canStartDebugAutoAiRoom(room))),
    debug: DEBUG || undefined,
    debugAutoAi: showDebugAutoAi || undefined,
    updatedAt: room.updatedAt,
  };
}

export function toPublicMessage(message: ChatMessage, room: Room) {
  return {
    id: message.id,
    roundNo: message.roundNo,
    playerId: message.playerId,
    playerName: message.playerName,
    content: message.content,
    createdAt: message.createdAt,
    source:
      room.status === "finished" || (DEBUG && room.debugAutoAi)
        ? message.source
        : undefined,
  };
}

function getVoteCounts(room: Room): Record<string, number> {
  if (!isVoteResultPublic(room, room.currentRound)) {
    return {};
  }

  const counts: Record<string, number> = {};
  for (const vote of room.votes) {
    if (vote.roundNo !== room.currentRound) {
      continue;
    }
    counts[vote.targetPlayerId] = (counts[vote.targetPlayerId] ?? 0) + 1;
  }
  return counts;
}

function getPublicVoteResults(room: Room): PublicVoteResult[] {
  return room.votes
    .filter((vote) => isVoteResultPublic(room, vote.roundNo))
    .map((vote) => ({
      id: vote.id,
      roundNo: vote.roundNo,
      voterPlayerId: vote.voterPlayerId,
      targetPlayerId: vote.targetPlayerId,
      createdAt: vote.createdAt,
    }));
}

function isVoteResultPublic(room: Room, roundNo: number) {
  if (room.status === "finished" || room.phase === "game_over") {
    return true;
  }

  if (roundNo < room.currentRound) {
    return true;
  }

  return room.currentRound === roundNo && room.phase === "resolving";
}
