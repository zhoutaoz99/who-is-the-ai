export type RoomStatus = "waiting" | "playing" | "finished";
export type PlayerStatus = "alive" | "eliminated";
export type GamePhase =
  | "waiting"
  | "discussion"
  | "voting"
  | "resolving"
  | "game_over";
export type Winner = "human" | "ai" | null;

export type PublicPlayer = {
  id: string;
  name: string;
  status: PlayerStatus;
  seatNo: number;
  connected: boolean;
  revealedType?: "human" | "ai";
  eliminatedRound?: number;
  aiPersonaId?: string;
  aiPersonaName?: string;
};

export type PublicMessage = {
  id: string;
  roundNo: number;
  playerId: string;
  playerName: string;
  content: string;
  createdAt: string;
  source?: "human" | "ai";
};

export type PublicVoteResult = {
  id: string;
  roundNo: number;
  voterPlayerId: string;
  targetPlayerId: string;
  createdAt: string;
};

export type PointAward = {
  playerId: string;
  playerName: string;
  points: number;
};

export type AiPersonaOption = {
  id: string;
  name: string;
};

export type RoomSnapshot = {
  id: string;
  status: RoomStatus;
  ownerPlayerId: string;
  players: PublicPlayer[];
  currentRound: number;
  phase: GamePhase;
  phaseEndsAt: string | null;
  winner: Winner;
  messages: PublicMessage[];
  voteCounts: Record<string, number>;
  voteResults: PublicVoteResult[];
  pointAwards: PointAward[];
  config: {
    maxHumanPlayers: number;
    aiPlayerCount: number;
    aiPersonas?: AiPersonaOption[];
    maxRounds: number;
    discussionDurationMs: number;
    voteDurationMs: number;
    speakCooldownMs: number;
    rewardPool: number;
  };
  canStart: boolean;
  debug?: boolean;
  debugAutoAi?: boolean;
  updatedAt: string;
};

export type ActionResult = {
  ok: boolean;
  error?: string;
  room?: RoomSnapshot;
  playerId?: string;
  deletedRoomId?: string;
};

export type ServerReadyPayload = {
  debug?: boolean;
  socketId: string;
  rooms: RoomSnapshot[];
};

export type RoundTickPayload = {
  roomId: string;
  roundNo: number;
  phase: GamePhase;
  remainingMs: number;
};
