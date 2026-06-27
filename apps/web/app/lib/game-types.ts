export type RoomStatus = "waiting" | "playing" | "finished";
export type PlayerStatus = "alive" | "eliminated";
export type GamePhase =
  | "waiting"
  | "discussion"
  | "voting"
  | "resolving"
  | "game_over";
export type Winner = "human" | "ai" | null;

export type SandboxRole = "ai_under_test" | "detective" | "filler";

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
  sandboxRole?: SandboxRole;
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
  sandboxScenarioId?: string;
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
  | "auto_optimizing"
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
  | "auto_optimize_wait_confirm"
  | "auto_optimize_activate_continue";

export type IterationRunOptions = {
  sequentialSpeech: boolean;
  personaMode: IterationPersonaMode;
  personaIds?: string[];
  personaSchedule?: string[][];
  autoOptimize: boolean;
  postRoundMode: IterationPostRoundMode;
};

export type IterationGameResult = {
  gameIndex?: number;
  status?: "pending" | "running" | "scoring" | "finished" | "failed";
  round: number;
  roomId: string;
  winner: string | null;
  generationId: string | null;
  scoreGenerationId?: string | null;
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

export type IssueCode =
  | "ROUND1_PUSH_VOTE"
  | "SINGLE_CHAR_WHEN_NAMED"
  | "SAMPLE_LINE_COPY"
  | "LOCKSTEP_BLOCK_VOTE"
  | "FORMULAIC_VOTE_REASON"
  | "TEAMMATE_MISFIRE"
  | "POST_PROVOCATION_SKIP"
  | "TEMPLATE_PHRASE"
  | "WEAK_SUSPICION"
  | "OVER_DEFENSIVE"
  | "LOW_THREAT_TARGETING"
  | "LOW_CONTEXT_AWARENESS";

export type IterationRoundAggregate = {
  n: number;
  aiWinRate: number;
  aiSurvivorsMean: number;
  roundsPlayedMean: number;
  humanLikeScore: { mean: number; se: number };
  naturalnessAiVsHuman: { mean: number; se: number };
  voteThreatTargeting: { mean: number; se: number };
  issueCounts: Partial<Record<IssueCode, number>>;
  issueGameRates: Partial<Record<IssueCode, number>>;
  primaryIssues: Array<{ code: IssueCode; count: number }>;
  confidenceMix: Partial<Record<"low" | "medium" | "high", number>>;
  generatedAt: string;
};

export type IterationRound = {
  round: number;
  generationId: string | null;
  games: IterationGameResult[];
  aggregate: IterationRoundAggregate | null;
  autoOptimize?: {
    status: "created" | "skipped" | "failed";
    generationId?: string;
    evalGenerationId?: string;
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
  lastAutoOptimize?: IterationRound["autoOptimize"] | null;
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
  autoOptimize?: boolean;
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

// ===== 编排器一代闭环(F) =====

export type OrchestratorPhase =
  | "evaluating_champion"
  | "optimizing"
  | "validating"
  | "evaluating_child"
  | "gating"
  | "awaiting_confirmation"
  | "settled";

export type OrchestratorVerdict = "improved" | "regressed" | "inconclusive";

export type OrchestratorMetric = {
  key: string;
  nScenarios: number;
  nPairs: number;
  point: number | null;
  ci95: [number, number] | null;
  mde: number;
  p?: number | null;
  verdict: OrchestratorVerdict;
};

export type OrchestratorValidation = {
  parentVersion: string;
  childVersion: string;
  buckets: Array<{
    form: string;
    nScenarios: number;
    metrics: Record<string, OrchestratorMetric>;
  }>;
};

export type OrchestratorGate = {
  decision: "promote" | "reject";
  reasons: string[];
  marginVerdict: OrchestratorVerdict | null;
};

export type OrchestratorValidate = { ok: boolean; reasons: string[] };

export type OrchestratorChild = {
  version_id: string;
  target: string;
  edit_type: string;
  hypothesis?: string;
  diff_summary?: string;
  prompt_text: string;
};

export type OrchestratorGameStatus =
  | "pending"
  | "running"
  | "scoring"
  | "finished"
  | "failed";

/** 单局进度(以 side×scenario×seed×run 为稳定 key,逐局增量更新)。 */
export type OrchestratorGame = {
  side: "champion" | "child";
  scenario_id: string;
  seed: number;
  run: number;
  status: OrchestratorGameStatus;
  room_id?: string;
  /** 完成态:打分详情回看用(读 sandbox-out/scores/s_${match_id}.json)。 */
  match_id?: string;
  error?: string;
  /** 进行中:对局内实时细节。 */
  phase?: string;
  current_round?: number;
  ai_alive?: number;
  ai_total?: number;
  /** 完成态。 */
  margin?: number | null;
  veto?: boolean;
};

export type OrchestratorActiveRun = {
  run_id: string;
  phase: OrchestratorPhase;
  mode: "auto" | "confirm";
  generation: number;
  champion_id: string;
  plan_summary: {
    scenarios: string[];
    seedsPerScenario: number;
    runsPerSeed: number;
    evalSetVersion: string;
    discussionSeconds?: number;
    judgeModelId?: string;
    optimizerModelId?: string;
    assignedTarget?: string;
  };
  child?: OrchestratorChild;
  validation?: OrchestratorValidation;
  gate?: OrchestratorGate;
  validate?: OrchestratorValidate;
  progress: {
    champion_done: number;
    champion_total: number;
    child_done: number;
    child_total: number;
    games: OrchestratorGame[];
  };
  decision?: string;
  started_at: string;
  settled_at?: string;
  error?: string;
};

export type OrchestratorTriedEntry = {
  version_id: string;
  hypothesis?: string;
  target_dimension?: string;
  edit_type?: string;
  reason: string;
  generation: number;
};

export type OrchestratorSnapshot = {
  champion: string;
  population: string[];
  generation: number;
  eval_set_version: string;
  tried_count: number;
  tried_and_rejected: OrchestratorTriedEntry[];
  active_run: OrchestratorActiveRun | null;
};

export type OrchestratorGenerationChild = {
  child_id: string;
  based_on: string;
  hypothesis?: string;
  target_dimension?: string;
  edit_type?: string;
  decision: "promoted" | "rejected";
};

export type OrchestratorGeneration = {
  generation_id: string;
  generation: number;
  eval_set_version: string;
  mode: string;
  champion_before: string;
  champion_after: string;
  children_evaluated: OrchestratorGenerationChild[];
  population_after: string[];
  tried_and_rejected_added: string[];
  timestamp: string;
};

export type OrchestratorVersionMeta = {
  version_id: string;
  parent_id: string | null;
  persona_scope: string;
  status: string;
  hypothesis?: string;
  target_dimension?: string;
  edit_type?: string;
  created_by_generation?: number;
  created_at: string;
};

export type OrchestratorVersion = OrchestratorVersionMeta & { prompt_text: string };

export type OrchestratorStartPayload = {
  scenario_ids: string[];
  mode?: "auto" | "confirm";
  seeds_per_scenario?: number;
  runs_per_seed?: number;
  assigned_target?: string;
  assigned_edit_type?: string;
  optimizer_model_id?: string;
  judge_model_id?: string;
  discussion_seconds?: number;
  eval_set_version?: string;
};

export type SandboxExample = {
  id: string;
  label: string;
  form: string;
};

