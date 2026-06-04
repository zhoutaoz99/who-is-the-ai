import { randomUUID } from "node:crypto";
import { AI_PERSONAS } from "../ai/ai.personas";
import {
  AI_NAMES,
  AI_PLAYER_COUNT,
  DEFAULT_DISCUSSION_DURATION_MS,
  MAX_ROUNDS,
  MESSAGE_LIMIT,
  MIN_DISCUSSION_DURATION_MS,
  SPEAK_COOLDOWN_MS,
} from "./game.config";
import {
  ChatMessage,
  CreateRoomPayload,
  Player,
  PlayerType,
  Room,
  Winner,
} from "./game.types";

export function countHumans(room: Room) {
  return room.players.filter((player) => player.type === "human").length;
}

export function resolveElimination(room: Room): Player | null {
  const votes = room.votes.filter((vote) => vote.roundNo === room.currentRound);
  if (votes.length === 0) {
    return null;
  }

  const voteCounts = new Map<string, number>();
  for (const vote of votes) {
    voteCounts.set(
      vote.targetPlayerId,
      (voteCounts.get(vote.targetPlayerId) ?? 0) + 1,
    );
  }

  const sorted = Array.from(voteCounts.entries()).sort((a, b) => b[1] - a[1]);
  const [topTargetId, topCount] = sorted[0];
  const isTie = sorted.length > 1 && sorted[1][1] === topCount;
  if (isTie) {
    return null;
  }

  return (
    room.players.find(
      (player) => player.id === topTargetId && player.status === "alive",
    ) ?? null
  );
}

export function getWinner(room: Room): Winner {
  const aliveAiCount = room.players.filter(
    (player) => player.type === "ai" && player.status === "alive",
  ).length;
  const aliveHumanCount = room.players.filter(
    (player) => player.type === "human" && player.status === "alive",
  ).length;

  if (aliveAiCount === 0) {
    return "human";
  }

  if (aliveHumanCount === 0) {
    return "ai";
  }

  if (room.currentRound >= MAX_ROUNDS) {
    return aliveAiCount > 0 ? "ai" : "human";
  }

  return null;
}

export function validateCanSpeak(room: Room, player: Player): string | null {
  if (room.status !== "playing" || room.phase !== "discussion") {
    return "当前不在发言阶段";
  }

  if (player.status !== "alive") {
    return "已出局玩家不能发言";
  }

  const remainingMs = SPEAK_COOLDOWN_MS - (Date.now() - player.lastSpokeAt);
  if (remainingMs > 0) {
    return `发言冷却中，请等待 ${Math.ceil(remainingMs / 1000)} 秒`;
  }

  return null;
}

export function addChatMessage(
  room: Room,
  player: Player,
  content: string,
): ChatMessage {
  const message: ChatMessage = {
    id: randomUUID(),
    roundNo: room.currentRound,
    playerId: player.id,
    playerName: player.name,
    source: player.type,
    content,
    createdAt: new Date().toISOString(),
  };

  player.lastSpokeAt = Date.now();
  room.messages.push(message);
  touch(room);
  return message;
}

export function createHumanPlayer(
  playerName: string | undefined,
  socketId: string,
  seatNo: number,
  accountId?: string,
): Player {
  return {
    id: randomUUID(),
    accountId,
    socketId,
    name: normalizePlayerName(playerName),
    type: "human",
    status: "alive",
    seatNo,
    lastSpokeAt: 0,
    connected: true,
  };
}

export function createAiPlayer(
  seatNo: number,
  personaId?: string,
  usedNames: string[] = [],
): Player {
  const names = AI_NAMES.filter((name) => !usedNames.includes(name));
  const selectedPersona =
    AI_PERSONAS.find((persona) => persona.id === personaId) ??
    randomItem(AI_PERSONAS);

  return {
    id: randomUUID(),
    name: randomItem(names.length > 0 ? names : AI_NAMES) ?? `玩家${seatNo}`,
    type: "ai" as PlayerType,
    status: "alive" as const,
    seatNo,
    lastSpokeAt: 0,
    connected: true,
    aiPersonaId: selectedPersona?.id,
  };
}

export function createAiPlayers(
  startSeatNo: number,
  count = AI_PLAYER_COUNT,
  excludedPersonaIds: string[] = [],
): Player[] {
  const names = [...AI_NAMES].sort(() => Math.random() - 0.5);
  const preferredPersonas = AI_PERSONAS.filter(
    (persona) => !excludedPersonaIds.includes(persona.id),
  ).sort(() => Math.random() - 0.5);
  const fallbackPersonas = [...AI_PERSONAS].sort(() => Math.random() - 0.5);
  const personas =
    preferredPersonas.length > 0 ? preferredPersonas : fallbackPersonas;

  return Array.from({ length: count }, (_, index) => ({
    id: randomUUID(),
    name: names[index] ?? `玩家${startSeatNo + index}`,
    type: "ai" as PlayerType,
    status: "alive" as const,
    seatNo: startSeatNo + index,
    lastSpokeAt: 0,
    connected: true,
    aiPersonaId: personas[index % personas.length]?.id,
  }));
}

export function createRoomId() {
  return randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase();
}

export function normalizeRoomId(roomId: string | undefined) {
  return (roomId ?? "").trim().toUpperCase();
}

export function normalizePlayerName(playerName: string | undefined) {
  const name = (playerName ?? "").trim();
  return name.slice(0, 16) || `玩家${Math.floor(Math.random() * 9000) + 1000}`;
}

export function normalizeContent(content: string | undefined) {
  return (content ?? "").trim().slice(0, MESSAGE_LIMIT);
}

export function normalizeDiscussionDuration(payload: CreateRoomPayload) {
  const minutes = Number(payload.discussionDurationMinutes);
  if (!Number.isFinite(minutes)) {
    return Math.max(DEFAULT_DISCUSSION_DURATION_MS, MIN_DISCUSSION_DURATION_MS);
  }

  return Math.max(Math.floor(minutes), 1) * 60_000;
}

export function chooseFallbackVoteTarget(
  room: Room,
  aiPlayer: Player,
): Player | null {
  const aliveHumans = room.players.filter(
    (player) => player.type === "human" && player.status === "alive",
  );
  if (aliveHumans.length > 0) {
    return randomItem(aliveHumans);
  }

  const fallbackTargets = room.players.filter(
    (player) => player.id !== aiPlayer.id && player.status === "alive",
  );
  return fallbackTargets.length > 0 ? randomItem(fallbackTargets) : null;
}

export function futureIso(durationMs: number) {
  return new Date(Date.now() + durationMs).toISOString();
}

export function touch(room: Room) {
  room.updatedAt = new Date().toISOString();
}

export function randomItem<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}
