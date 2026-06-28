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
}

export interface ChatMessage {
  id: string;
  roundNo: number;
  playerId: string;
  playerName: string;
  source: PlayerType;
  content: string;
  createdAt: string;
  // ===== 离线沙盒探测(仅 sandbox 房,产品对局留空) =====
  /** 该消息是否承载探测投放。 */
  sandboxIsProbe?: boolean;
  /** 指向所投探测实例 id(delivery 与 AI response 均带同一 ref)。 */
  sandboxProbeRef?: string;
  /** spotlight 预置历史消息(非本轮实时生成)。 */
  sandboxFromSeedHistory?: boolean;
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
export type SandboxVotePolicy = "live" | "rule" | "scripted";

export interface AiShortMemory {
  votes: Array<{
    roundNo: number;
    targetSeatNo: number;
    publicReason?: string;
    source: AiVoteMemorySource;
    /** 该票实际走的投票策略(便于 MatchRecord 的 policy_applied 审计)。 */
    policyApplied?: SandboxVotePolicy;
  }>;
}

export interface Room {
  id: string;
  status: RoomStatus;
  ownerPlayerId: string;
  /** 本局开局时生效的 AI 提示词版本代号(用于版本感知复盘);旧局可能缺失。 */
  promptGenerationId?: string;
  players: Player[];
  discussionDurationMs: number;
  currentRound: number;
  phase: GamePhase;
  phaseEndsAt: string | null;
  winner: Winner;
  messages: ChatMessage[];
  votes: Vote[];
  aiMemories?: Record<string, AiShortMemory>;
  /** 沙盒顺序发言循环的 pass 状态(仅 sandbox 房,内部使用)。 */
  sandboxSpeech?: {
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
  /** 建房时冻结的场景 JSON(opaque:运行时不读,仅沙盒 prepare/start/config 用)。 */
  sandboxScenario?: unknown;
  /** 场景形态(默认 full_match)。 */
  sandboxForm?: "full_match" | "spotlight";
  /** spotlight 起跑轮(full_match 缺省 1)。 */
  sandboxStartRound?: number;
  /** spotlight 从起跑轮往后最多跑几轮。 */
  sandboxMaxRoundsForward?: number;
  /** 种子(场景层可复现随机用)+ run 序号。 */
  sandboxSeed?: number;
  sandboxRunIndex?: number;
  /** 投票策略(整局默认)+ 按座号覆盖。 */
  sandboxVotePolicy?: SandboxVotePolicy;
  sandboxVoteOverrides?: Record<number, SandboxVotePolicy>;
  /** scripted 投票:每轮每个存活投票者一条。 */
  sandboxScriptedVotes?: Array<{
    round: number;
    voter_seat: number;
    target_seat: number;
  }>;
  /** 探测调度(已解析为不透明 fire 计划,Phase 2 用)。 */
  sandboxProbeSchedule?: Array<{
    probe_id: string;
    type: string;
    round: number;
    timing: unknown;
    from_seat: number;
    intent: string;
    templates?: string[];
    auto_check?: { checker: string; params?: Record<string, unknown> } | null;
    split: string;
  }>;
  /** 运行中累积的探测事件(Phase 2 用,opaque)。 */
  sandboxProbeEvents?: unknown[];
  /** 探测调度运行期状态(跨 getRoom 重读,持久化)。 */
  sandboxProbeState?: {
    round: number;
    delivered: string[];
    aiSpoke: boolean;
    pendingResponseProbeId?: string;
    pendingDeliveredText?: string;
    pendingFromSeat?: number;
    pendingReassigned?: boolean;
  };
  /** 被测 AI 使用的提示词版本代号(编排器配对评测用);缺省走产品默认 AI 提示词。 */
  sandboxAiPromptVersionId?: string;
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
  /** 沙盒角色(仅 sandbox 房;前台显示 被测AI/侦探/填充)。 */
  sandboxRole?: SandboxRole;
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
  /** 沙盒房标识(有则前台按被测AI/侦探/填充渲染)。 */
  sandboxScenarioId?: string;
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

export interface UpdateSandboxPlayerModelPayload {
  roomId?: string;
  playerId?: string;
  targetPlayerId?: string;
  modelId?: string;
}

export interface DeleteSandboxRoomPayload {
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

export interface ActionResult {
  ok: boolean;
  error?: string;
  room?: RoomSnapshot;
  playerId?: string;
  deletedRoomId?: string;
}
