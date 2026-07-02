import { randomUUID } from "node:crypto";
import { getActivePersonas } from "../ai/ai.personas";
import {
  AI_NAMES,
  AI_PLAYER_COUNT,
  DEFAULT_DISCUSSION_DURATION_MS,
  MAX_ROUNDS,
  MESSAGE_LIMIT,
  MIN_DISCUSSION_DURATION_MS,
  SPEAK_COOLDOWN_MS,
  SIMULATED_HUMAN_NAMES,
} from "./game.config";
import {
  ChatMessage,
  CreateRoomPayload,
  Player,
  PlayerType,
  Room,
  SandboxRole,
  Winner,
} from "./game.types";

export function countHumans(room: Room) {
  return room.players.filter((player) => player.type === "human").length;
}

export function countAi(room: Room) {
  return room.players.filter((player) => player.type === "ai").length;
}

export function isSimulatedHuman(player: Player) {
  return player.type === "human" && player.simulated === true;
}

export function countSimulatedHumans(room: Room) {
  return room.players.filter((player) => isSimulatedHuman(player)).length;
}

export function isModelDrivenPlayer(player: Player) {
  return player.type === "ai" || isSimulatedHuman(player);
}

/** 是否沙盒房(以场景来源 sandboxScenarioId 判定)。 */
export function isSandboxRoom(room: Room): boolean {
  return room.sandboxScenarioId != null;
}

export function canStartSandboxRoom(room: Room) {
  return countAi(room) >= 1 && countSimulatedHumans(room) >= 1;
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

  // 只剩1个AI和1个模型驱动真人时，该真人不可能获胜，提前结束
  if (aliveAiCount === 1 && aliveHumanCount === 1) {
    const aliveHuman = room.players.find(
      (player) => player.type === "human" && player.status === "alive",
    );
    if (aliveHuman?.simulated) {
      return "ai";
    }
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
    simulated: false,
    status: "alive",
    seatNo,
    lastSpokeAt: 0,
    connected: true,
  };
}

export function createAiPlayers(
  startSeatNo: number,
  count = AI_PLAYER_COUNT,
  excludedPersonaIds: string[] = [],
): Player[] {
  const names = [...AI_NAMES].sort(() => Math.random() - 0.5);
  const preferredPersonas = getActivePersonas().filter(
    (persona) => !excludedPersonaIds.includes(persona.id),
  ).sort(() => Math.random() - 0.5);
  const fallbackPersonas = [...getActivePersonas()].sort(() => Math.random() - 0.5);
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


// ===== 离线沙盒:按场景 roster 建玩家 =====

export interface SandboxPlayerSpec {
  /** 玩家编号(座位号),1..N;直接作为 Player.seatNo。 */
  slot: number;
  role: SandboxRole;
  personaId: string;
  modelId?: string;
}

/**
 * 按场景 roster 逐槽位建玩家:ai_under_test→type:"ai";detective/filler→
 * type:"human",simulated:true(均 model-driven,由沙盒顺序发言循环驱动)。slot 即座位号,
 * 直接落到 seatNo;role 落到 Player 上供提示词分支(侦探/填充的立场由人设卡承载)。
 */
export function createSandboxPlayers(
  specs: SandboxPlayerSpec[],
  aiUnderTestModelId?: string,
): Player[] {
  const usedAiNames: string[] = [];
  const usedHumanNames: string[] = [];
  return specs.map((spec, index) => {
    const isAiUnderTest = spec.role === "ai_under_test";
    const name = isAiUnderTest
      ? pickUniqueName(AI_NAMES, usedAiNames, index)
      : pickUniqueName(SIMULATED_HUMAN_NAMES, usedHumanNames, index);
    return {
      id: randomUUID(),
      name,
      type: (isAiUnderTest ? "ai" : "human") as PlayerType,
      simulated: isAiUnderTest ? undefined : true,
      status: "alive" as const,
      seatNo: spec.slot,
      lastSpokeAt: 0,
      connected: true,
      aiPersonaId: spec.personaId,
      aiModelId: isAiUnderTest ? aiUnderTestModelId : spec.modelId,
      sandboxRole: spec.role,
    };
  });
}

function pickUniqueName(pool: string[], used: string[], index: number): string {
  const available = pool.filter((name) => !used.includes(name));
  const chosen = available[0] ?? pool[index % pool.length] ?? `玩家${index + 1}`;
  used.push(chosen);
  return chosen;
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
  const seconds = Number(payload.discussionDurationSeconds);
  if (Number.isFinite(seconds)) {
    // 秒级(主要用于沙盒/自动化运行):最小 10s。
    return Math.max(Math.floor(seconds), 10) * 1000;
  }
  const minutes = Number(payload.discussionDurationMinutes);
  if (!Number.isFinite(minutes)) {
    return Math.max(DEFAULT_DISCUSSION_DURATION_MS, MIN_DISCUSSION_DURATION_MS);
  }

  return Math.max(Math.floor(minutes), 1) * 60_000;
}

/**
 * rule 投票(零 LLM、确定性):主信号=此前各轮被投次数(谁最被怀疑),平票按最小座号兜底。
 * 无历史票时(如 R1)所有候选同分 → 最小座号(非自己)。机械、可复现,仅作快测/冒烟。
 */
export function ruleVote(room: Room, voter: Player): Player | null {
  const candidates = room.players.filter(
    (player) => player.status === "alive" && player.id !== voter.id,
  );
  if (candidates.length === 0) {
    return null;
  }

  const score = new Map<string, number>();
  for (const vote of room.votes) {
    if (vote.roundNo >= room.currentRound) continue; // 仅历史轮的票作"被指认"信号
    score.set(vote.targetPlayerId, (score.get(vote.targetPlayerId) ?? 0) + 1);
  }

  let best = candidates[0];
  let bestScore = score.get(best.id) ?? 0;
  for (const candidate of candidates) {
    const s = score.get(candidate.id) ?? 0;
    if (s > bestScore || (s === bestScore && candidate.seatNo < best.seatNo)) {
      best = candidate;
      bestScore = s;
    }
  }
  return best;
}

export function chooseFallbackVoteTarget(
  room: Room,
  voter: Player,
): Player | null {
  const fallbackTargets = room.players.filter(
    (player) => player.id !== voter.id && player.status === "alive",
  );
  if (fallbackTargets.length === 0) {
    return null;
  }

  if (voter.type === "ai") {
    const aliveHumans = fallbackTargets.filter((player) => player.type === "human");
    if (aliveHumans.length > 0) {
      return randomItem(aliveHumans);
    }
  }

  const voteCounts = new Map<string, number>();
  for (const vote of room.votes) {
    if (vote.roundNo !== room.currentRound || vote.targetPlayerId === voter.id) {
      continue;
    }
    voteCounts.set(vote.targetPlayerId, (voteCounts.get(vote.targetPlayerId) ?? 0) + 1);
  }

  const rankedTargets = fallbackTargets
    .map((player) => ({
      player,
      count: voteCounts.get(player.id) ?? 0,
    }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count);

  if (rankedTargets.length > 0) {
    const topCount = rankedTargets[0].count;
    const topTargets = rankedTargets
      .filter((item) => item.count === topCount)
      .map((item) => item.player);
    return randomItem(topTargets);
  }

  return randomItem(fallbackTargets);
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
