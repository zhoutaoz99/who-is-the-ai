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
  socketId?: string;
  name: string;
  type: PlayerType;
  status: PlayerStatus;
  seatNo: number;
  lastSpokeAt: number;
  connected: boolean;
  eliminatedRound?: number;
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

export interface Room {
  id: string;
  status: RoomStatus;
  ownerPlayerId: string;
  players: Player[];
  discussionDurationMs: number;
  currentRound: number;
  phase: GamePhase;
  phaseEndsAt: string | null;
  winner: Winner;
  messages: ChatMessage[];
  votes: Vote[];
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
  eliminatedRound?: number;
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
  config: {
    maxHumanPlayers: number;
    aiPlayerCount: number;
    maxRounds: number;
    discussionDurationMs: number;
    voteDurationMs: number;
    speakCooldownMs: number;
    rewardPool: number;
  };
  canStart: boolean;
  updatedAt: string;
}

export interface CreateRoomPayload {
  playerName?: string;
  discussionDurationMinutes?: number;
}

export interface JoinRoomPayload {
  roomId?: string;
  playerName?: string;
}

export interface StartGamePayload {
  roomId?: string;
  playerId?: string;
}

export interface SendChatPayload {
  roomId?: string;
  content?: string;
}

export interface CastVotePayload {
  roomId?: string;
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

export interface ActionResult {
  ok: boolean;
  error?: string;
  room?: RoomSnapshot;
  playerId?: string;
}
