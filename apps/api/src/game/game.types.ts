export type RoomStatus = "waiting" | "playing" | "finished";
export type PlayerType = "human" | "ai";
export type PlayerStatus = "alive" | "eliminated";
export type GamePhase =
  | "waiting"
  | "discussion"
  | "voting"
  | "resolving"
  | "game_over";
export type Winner = "human" | "ai" | null;

/** 离线沙盒角色:被测 AI / 侦探 / 填充;产品对局留空。 */
export type SandboxRole = "ai_under_test" | "detective" | "filler";

export interface Player {
  id: string;
  accountId?: string;
  socketId?: string;
  name: string;
  type: PlayerType;
  simulated?: boolean;
  status: PlayerStatus;
  seatNo: number;
  lastSpokeAt: number;
  connected: boolean;
  eliminatedRound?: number;
  aiPersonaId?: string;
  aiModelId?: string;
  aiLastConsideredRound?: number;
  aiLastConsideredAt?: number;
  aiSkipBackoffUntil?: number;
  // ===== 离线沙盒(仅 sandbox 房间使用,产品对局留空) =====
  /** 该槽位在场景 roster 中的角色,决定用哪套提示词。 */
  sandboxRole?: SandboxRole;
  /** 静态立场/性格补充,注入侦探提示词的 base_intent 槽。 */
  baseIntent?: string;
}

export interface ChatMessage {
  id: string;
  roundNo: number;
  playerId: string;
  playerName: string;
  source: PlayerType;
  content: string;
  createdAt: string;
}

export interface Vote {
  id: string;
  roundNo: number;
  voterPlayerId: string;
  targetPlayerId: string;
  createdAt: string;
}

export interface PublicVoteResult {
  id: string;
  roundNo: number;
  voterPlayerId: string;
  targetPlayerId: string;
  createdAt: string;
}

export interface SpeechGeneratingPayload {
  roomId?: string;
  roundNo?: number;
  playerId: string;
  playerName: string;
  seatNo: number;
  startedAt?: string;
}

export interface PointAward {
  playerId: string;
  playerName: string;
  points: number;
}

export type AiVoteMemorySource = "model" | "fallback";

export interface AiShortMemory {
  votes: Array<{
    roundNo: number;
    targetSeatNo: number;
    publicReason?: string;
    source: AiVoteMemorySource;
  }>;
}

export interface Room {
  id: string;
  status: RoomStatus;
  ownerPlayerId: string;
  /** 本局开局时生效的 AI 提示词版本代号(用于版本感知复盘);旧局可能缺失。 */
  promptGenerationId?: string;
  debugAutoAi?: boolean;
  debugAutoAiSequentialSpeech?: boolean;
  players: Player[];
  discussionDurationMs: number;
  currentRound: number;
  phase: GamePhase;
  phaseEndsAt: string | null;
  winner: Winner;
  messages: ChatMessage[];
  votes: Vote[];
  aiMemories?: Record<string, AiShortMemory>;
  debugAutoAiSpeech?: {
    roundNo: number;
    startOffset: number;
    passNo: number;
    passInProgress?: boolean;
    passStartedAt?: number;
  };
  pointAwards: PointAward[];
  rewardSettledAt: string | null;
  // ===== 离线沙盒(仅 sandbox 房间使用) =====
  /** 标记该房来自某场景,置位时跳过开局随机洗座、并按 roster 顺序保留座位。 */
  sandboxScenarioId?: string;
  /** 逐轮给对手注入的"本轮意图"(scripted_intent 固定剧本);slot=玩家编号。 */
  sandboxIntentSchedule?: Array<{ round: number; slot: number; intent: string }>;
  /** 建房时冻结的场景 JSON(opaque:运行时不读,仅沙盒 prepare/start/config 用)。 */
  sandboxScenario?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface PublicPlayer {
  id: string;
  name: string;
  status: PlayerStatus;
  seatNo: number;
  connected: boolean;
  revealedType?: PlayerType;
  simulated?: boolean;
  eliminatedRound?: number;
  aiPersonaId?: string;
  aiPersonaName?: string;
  aiModelId?: string;
}

export interface RoomSnapshot {
  id: string;
  status: RoomStatus;
  ownerPlayerId: string;
  players: PublicPlayer[];
  currentRound: number;
  phase: GamePhase;
  phaseEndsAt: string | null;
  winner: Winner;
  messages: Array<Omit<ChatMessage, "source"> & { source?: PlayerType }>;
  speechGeneratings?: SpeechGeneratingPayload[];
  voteCounts: Record<string, number>;
  voteResults: PublicVoteResult[];
  pointAwards: PointAward[];
  config: {
    maxHumanPlayers: number;
    aiPlayerCount: number;
    aiPersonas?: Array<{
      id: string;
      name: string;
    }>;
    availableModels?: Array<{
      id: string;
      default?: boolean;
    }>;
    maxRounds: number;
    discussionDurationMs: number;
    voteDurationMs: number;
    speakCooldownMs: number;
    rewardPool: number;
  };
  canStart: boolean;
  debug?: boolean;
  debugAutoAi?: boolean;
  debugAutoAiSequentialSpeech?: boolean;
  promptGenerationId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRoomPayload {
  authToken?: string;
  playerName?: string;
  discussionDurationMinutes?: number;
  discussionDurationSeconds?: number;
}

export interface JoinRoomPayload {
  authToken?: string;
  roomId?: string;
  playerName?: string;
}

export interface GameAccount {
  id: string;
  displayName: string;
}

export interface StartGamePayload {
  roomId?: string;
  playerId?: string;
}

export interface StartIterationPayload {
  rounds?: number;
  gamesPerRound?: number;
  discussionSeconds?: number;
  sequentialSpeech?: boolean;
  personaMode?: "random_each_game" | "fixed_per_run" | "fixed_schedule";
  personaIds?: string[];
  autoOptimize?: boolean;
  postRoundMode?: "manual" | "auto_optimize_wait_confirm" | "auto_optimize_activate_continue";
}

export interface SendChatPayload {
  roomId?: string;
  playerId?: string;
  content?: string;
}

export interface CastVotePayload {
  roomId?: string;
  playerId?: string;
  targetPlayerId?: string;
}

export interface LeaveRoomPayload {
  roomId?: string;
  playerId?: string;
}

export interface ReconnectPayload {
  roomId?: string;
  playerId?: string;
}

export interface ObserveRoomPayload {
  roomId?: string;
}

export interface StopGamePayload {
  roomId?: string;
  playerId?: string;
}

export interface DebugAddAiPayload {
  roomId?: string;
  playerId?: string;
  playerType?: PlayerType;
  personaId?: string;
  modelId?: string;
}

export interface CreateDebugAutoAiRoomPayload {
  discussionDurationSeconds?: number;
  sequentialSpeech?: boolean;
  personaIds?: string[];
}

export interface DebugRemoveAiPayload {
  roomId?: string;
  playerId?: string;
  aiPlayerId?: string;
  targetPlayerId?: string;
}

export interface DebugUpdateModelPayload {
  roomId?: string;
  playerId?: string;
  targetPlayerId?: string;
  modelId?: string;
}

export interface DebugDeleteAutoAiRoomPayload {
  roomId?: string;
  playerId?: string;
}

export interface DeleteRoomPayload {
  roomId?: string;
}

export interface UpdateDiscussionDurationPayload {
  roomId?: string;
  playerId?: string;
  discussionDurationMinutes?: number;
}

export interface UpdateDebugAutoAiSequentialSpeechPayload {
  roomId?: string;
  playerId?: string;
  sequentialSpeech?: boolean;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
  room?: RoomSnapshot;
  playerId?: string;
  deletedRoomId?: string;
}
