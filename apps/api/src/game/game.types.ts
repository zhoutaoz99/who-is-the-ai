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
  aiLastConsideredRound?: number;
  aiLastConsideredAt?: number;
  aiSkipBackoffUntil?: number;
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

export interface PointAward {
  playerId: string;
  playerName: string;
  points: number;
}

export interface Room {
  id: string;
  status: RoomStatus;
  ownerPlayerId: string;
  debugAutoAi?: boolean;
  players: Player[];
  discussionDurationMs: number;
  currentRound: number;
  phase: GamePhase;
  phaseEndsAt: string | null;
  winner: Winner;
  messages: ChatMessage[];
  votes: Vote[];
  pointAwards: PointAward[];
  rewardSettledAt: string | null;
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
    maxRounds: number;
    discussionDurationMs: number;
    voteDurationMs: number;
    speakCooldownMs: number;
    rewardPool: number;
  };
  canStart: boolean;
  debug?: boolean;
  debugAutoAi?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRoomPayload {
  authToken?: string;
  playerName?: string;
  discussionDurationMinutes?: number;
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

export interface StopGamePayload {
  roomId?: string;
  playerId?: string;
}

export interface DebugAddAiPayload {
  roomId?: string;
  playerId?: string;
  playerType?: PlayerType;
  personaId?: string;
}

export interface CreateDebugAutoAiRoomPayload {
  discussionDurationMinutes?: number;
}

export interface DebugRemoveAiPayload {
  roomId?: string;
  playerId?: string;
  aiPlayerId?: string;
  targetPlayerId?: string;
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

export interface ActionResult {
  ok: boolean;
  error?: string;
  room?: RoomSnapshot;
  playerId?: string;
  deletedRoomId?: string;
}
