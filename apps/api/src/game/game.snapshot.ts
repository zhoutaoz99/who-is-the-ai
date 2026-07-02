import {
  AI_PLAYER_COUNT,
  MAX_HUMAN_PLAYERS,
  MAX_ROUNDS,
  REWARD_POOL,
  SPEAK_COOLDOWN_MS,
  VOTE_DURATION_MS,
} from "./game.config";
import { getAiPersonaById } from "../ai/ai.personas";
import {
  canStartSandboxRoom,
  countAi,
  countHumans,
  isSandboxRoom,
} from "./game.rules";
import {
  ChatMessage,
  PublicVoteResult,
  Room,
  RoomSnapshot,
} from "./game.types";

export function toRoomSnapshot(room: Room, availableModels?: Array<{ id: string; default?: boolean }>): RoomSnapshot {
  const revealTypes = room.status === "finished";
  const showSandbox = isSandboxRoom(room);
  const hideAi = room.status === "waiting" && !showSandbox;
  const aiPlayerCount = showSandbox ? countAi(room) : AI_PLAYER_COUNT;

  return {
    id: room.id,
    status: room.status,
    ownerPlayerId: room.ownerPlayerId,
    players: room.players
      .slice()
      .sort((a, b) => a.seatNo - b.seatNo)
      .filter((player) => !hideAi || player.type !== "ai")
      .map((player) => {
        const exposeModelDrivenType = showSandbox;
        const persona = revealTypes || exposeModelDrivenType
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
            : exposeModelDrivenType
              ? player.type
              : undefined,
          simulated:
            revealTypes || showSandbox
              ? player.simulated === true
              : undefined,
          aiPersonaId: persona?.id,
          aiPersonaName: persona?.nickname,
          aiModelId: (revealTypes || exposeModelDrivenType) ? player.aiModelId : undefined,
          // 沙盒角色(仅 sandbox 房有;前台据此显示 被测AI/侦探/填充)。
          sandboxRole: player.sandboxRole,
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
      availableModels: (showSandbox && availableModels?.length) ? availableModels : undefined,
      maxRounds: MAX_ROUNDS,
      discussionDurationMs: room.discussionDurationMs,
      voteDurationMs: VOTE_DURATION_MS,
      speakCooldownMs: SPEAK_COOLDOWN_MS,
      rewardPool: REWARD_POOL,
    },
    canStart:
      room.status === "waiting" &&
      (showSandbox
        ? canStartSandboxRoom(room)
        : countHumans(room) >= 1),
    // 沙盒房标识(有则前台按被测AI/侦探/填充渲染)。
    sandboxScenarioId: room.sandboxScenarioId,
    promptGenerationId: room.promptGenerationId,
    createdAt: room.createdAt,
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
      room.status === "finished" || isSandboxRoom(room)
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
