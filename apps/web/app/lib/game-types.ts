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
  simulated?: boolean;
  eliminatedRound?: number;
  aiPersonaId?: string;
  aiPersonaName?: string;
  aiModelId?: string;
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

export type AiModelOption = {
  id: string;
  default?: boolean;
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
  speechGeneratings?: SpeechGeneratingPayload[];
  voteCounts: Record<string, number>;
  voteResults: PublicVoteResult[];
  pointAwards: PointAward[];
  config: {
    maxHumanPlayers: number;
    aiPlayerCount: number;
    aiPersonas?: AiPersonaOption[];
    availableModels?: AiModelOption[];
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
  createdAt: string;
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

export type SpeechGeneratingPayload = {
  roomId?: string;
  roundNo?: number;
  playerId: string;
  playerName: string;
  seatNo: number;
  startedAt?: string;
};

export type SpeechDiscardedPayload = {
  roomId?: string;
  roundNo?: number;
  playerId: string;
  playerName: string;
  seatNo: number;
  reason: string;
  discardedAt?: string;
};

// ===== 自动对局评估自迭代 =====

export type IterationStatus =
  | "running"
  | "auto_editing"
  | "awaiting_activation"
  | "awaiting_confirmation"
  | "completed"
  | "stopped"
  | "failed";

export type IterationPersonaMode =
  | "random_each_game"
  | "fixed_per_run"
  | "fixed_schedule";

export type IterationPostRoundMode =
  | "manual"
  | "auto_edit_wait_confirm"
  | "auto_edit_activate_continue";

export type IterationRunOptions = {
  sequentialSpeech: boolean;
  personaMode: IterationPersonaMode;
  personaIds?: string[];
  personaSchedule?: string[][];
  autoEdit: boolean;
  postRoundMode: IterationPostRoundMode;
};

export type IterationGameResult = {
  gameIndex?: number;
  status?: "pending" | "running" | "scoring" | "finished" | "failed";
  round: number;
  roomId: string;
  winner: string | null;
  generationId: string | null;
  currentGameRound?: number;
  phase?: string;
  aiAlive?: number;
  simulatedHumanAlive?: number;
  aiTotal?: number;
  simulatedHumanTotal?: number;
  humanLikeScore?: number;
  aiWin?: boolean;
  error?: string;
  score?: Record<string, unknown> | null;
};

export type IterationRoundAggregate = {
  n: number;
  aiWinRate: number;
  aiSurvivorsMean: number;
  roundsPlayedMean: number;
  humanLikeScore: { mean: number; se: number };
  naturalnessAiVsHuman: { mean: number; se: number };
  voteThreatTargeting: { mean: number; se: number };
  tells: Record<string, number>;
  tellGameRates: Record<string, number>;
  topIssues: Array<{ issue: string; count: number }>;
  generatedAt: string;
};

export type IterationRound = {
  round: number;
  generationId: string | null;
  games: IterationGameResult[];
  aggregate: IterationRoundAggregate | null;
  autoEdit?: {
    status: "created" | "skipped" | "failed";
    generationId?: string;
    changedAssetKeys?: string[];
    note?: string;
    error?: string;
    response?: string;
    durationMs?: number;
  };
};

export type IterationRunStatus = {
  id: string;
  status: IterationStatus;
  currentRound: number;
  totalRounds: number;
  gamesPerRound: number;
  discussionSeconds: number;
  activeGenerationId: string | null;
  pendingGenerationId?: string | null;
  options?: IterationRunOptions;
  currentRoundGames: IterationGameResult[];
  rounds: IterationRound[];
  lastAutoEdit?: IterationRound["autoEdit"] | null;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type StartIterationPayload = {
  rounds?: number;
  gamesPerRound?: number;
  discussionSeconds?: number;
  sequentialSpeech?: boolean;
  personaMode?: IterationPersonaMode;
  personaIds?: string[];
  autoEdit?: boolean;
  postRoundMode?: IterationPostRoundMode;
};

export type GenerationSummary = {
  id: string;
  parentId: string | null;
  status: string;
  isBest: boolean;
  score: unknown;
  note: string | null;
  manifest: Record<string, number>;
  createdAt: string;
};
