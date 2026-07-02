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
    availableModels?: AiModelOption[];
    maxRounds: number;
    discussionDurationMs: number;
    voteDurationMs: number;
    speakCooldownMs: number;
    rewardPool: number;
  };
  canStart: boolean;
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

// ===== 编排器一代闭环(F) =====

export type OrchestratorPhase =
  | "evaluating_champion"
  | "optimizing"
  | "validating"
  | "evaluating_child"
  | "gating"
  | "evaluating_holdout"
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

/** 留出集复核结论(M5.7;过优化集闸后的第二道闸)。 */
export type OrchestratorHoldoutDecision = {
  decision: "pass" | "fail";
  reasons: string[];
  marginVerdict: OrchestratorVerdict | null;
  marginPoint: number | null;
  marginCi95: [number, number] | null;
};

/** 留出复核运行态(进度 + 结论;来自 active_run.holdout)。 */
export type OrchestratorHoldout = {
  eval_set: string;
  champion_total: number;
  champion_done: number;
  child_total: number;
  child_done: number;
  games: OrchestratorGame[];
  validation?: OrchestratorValidation;
  decision?: OrchestratorHoldoutDecision;
};

export type OrchestratorValidate = { ok: boolean; reasons: string[] };

export type OrchestratorChild = {
  version_id: string;
  based_on?: string;
  crossover?: {
    base: string;
    donor: string;
    grafted_trait: string;
  };
  target: string;
  edit_type: string;
  hypothesis?: string;
  diff_summary?: string;
  prompt_text: string;
  validate?: OrchestratorValidate;
  validation?: OrchestratorValidation;
  gate?: OrchestratorGate;
  holdout?: OrchestratorHoldout;
  decision?: "promoted" | "rejected";
  score?: number | null;
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
  child_id?: string;
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
    judgeModelIds?: string[];
    diagnose?: boolean;
    costTier?: "decision" | "diagnostic" | "calibration";
    optimizerModelId?: string;
    assignedTarget?: string;
  };
  children?: OrchestratorChild[];
  selected_child_id?: string;
  child?: OrchestratorChild;
  validation?: OrchestratorValidation;
  gate?: OrchestratorGate;
  /** 留出集复核(M5.7);仅过优化集闸时存在,无 holdout 配置则缺省。 */
  holdout?: OrchestratorHoldout;
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

/** 留出复核摘要(写入 GenerationEval child.holdout;§11)。 */
export type OrchestratorHoldoutSummary = {
  eval_set: string;
  held_out_probes: boolean;
  blind_suspicion_margin_paired_diff: number | null;
  ci95: [number, number] | null;
  holds: boolean;
  reasons: string[];
};

export type OrchestratorGenerationChild = {
  child_id: string;
  based_on: string;
  hypothesis?: string;
  target_dimension?: string;
  edit_type?: string;
  validation?: OrchestratorValidation;
  gate?: OrchestratorGate;
  holdout?: OrchestratorHoldoutSummary;
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
  accepted_trait?: {
    target: string;
    edit_type: string;
    hypothesis?: string;
    summary: string;
    excerpt: string;
    source: "mutation" | "crossover";
  };
  created_by_generation?: number;
  created_at: string;
};

export type OrchestratorVersion = OrchestratorVersionMeta & { prompt_text: string };

export type OrchestratorStartPayload = {
  /** 单个场景模式:显式场景 id 列表。与 set_id 二选一。 */
  scenario_ids?: string[];
  /** 场景组合模式:冻结评测集 id。传了就用它的 optimize 半,忽略 scenario_ids。 */
  set_id?: string;
  mode?: "auto" | "confirm";
  seeds_per_scenario?: number;
  runs_per_seed?: number;
  assigned_target?: string;
  assigned_edit_type?: string;
  optimizer_model_id?: string;
  judge_model_id?: string;
  judge_model_ids?: string[];
  diagnose?: boolean;
  cost_tier?: "decision" | "diagnostic" | "calibration";
  discussion_seconds?: number;
  eval_set_version?: string;
};

export type SandboxExample = {
  id: string;
  label: string;
  form: string;
};

/** 评测集摘要(GET /sandbox/orchestrator/eval-sets)。 */
export type EvalSet = {
  set_id: string;
  version: string;
  eval_set_version: string;
  description?: string;
  optimize_count: number;
  holdout_count: number;
};

// ===== 对照测试(control-test:负/正/空三对照验流水线机器)=====

export type ControlKind = "null" | "negative" | "positive";

export type ControlTestPhase = "evaluating_parent" | "running_controls" | "settled";

export type ControlMetric = {
  key: string;
  point: number | null;
  ci95: [number, number] | null;
  verdict: OrchestratorVerdict;
};

export type ControlBucket = {
  form: string;
  nScenarios: number;
  margin: ControlMetric | null;
  rounds_survived: ControlMetric | null;
  plurality_rate: ControlMetric | null;
  veto_rate: ControlMetric | null;
  probe_pass: ControlMetric[];
};

export type ControlResult = {
  kind: ControlKind;
  label: string;
  child_version_id: string;
  expectation: string;
  gate: OrchestratorGate;
  buckets: ControlBucket[];
  pass: boolean;
  notes: string[];
};

/** 逐局进度(side="parent" | 对照 kind)。 */
export type ControlGame = {
  side: string;
  scenario_id: string;
  seed: number;
  run: number;
  status: OrchestratorGameStatus;
  room_id?: string;
  match_id?: string;
  error?: string;
  phase?: string;
  current_round?: number;
  ai_alive?: number;
  ai_total?: number;
  margin?: number | null;
  veto?: boolean;
};

export type ControlTestRun = {
  run_id: string;
  phase: ControlTestPhase;
  set_id: string;
  eval_set_version: string;
  parent_version_id: string;
  plan: { scenarios: string[]; seedsPerScenario: number; runsPerSeed: number };
  kinds: ControlKind[];
  current_kind?: ControlKind;
  games: ControlGame[];
  controls: ControlResult[];
  caveats: string[];
  overall_pass?: boolean;
  decision?: "done" | "stopped";
  error?: string;
  started_at: string;
  settled_at?: string;
};

export type ControlPreview = { kind: ControlKind; label: string; expectation: string };

export type ControlTestStartPayload = {
  set_id?: string;
  kinds?: ControlKind[];
  seeds_per_scenario?: number;
  runs_per_seed?: number;
  judge_model_id?: string;
  discussion_seconds?: number;
};

// ===== 优化器自检(零对局:挖坑→真优化器→子代是否恢复)=====

export type OptHoleStatus = "pending" | "proposing" | "judging" | "done" | "failed";

export type OptCoverage = {
  covered: boolean;
  quote?: string;
  method: "judge" | "keyword";
};

export type OptHoleResult = {
  hole_id: string;
  target: string;
  probe_type: string;
  status: OptHoleStatus;
  child_version_id?: string;
  validate?: { ok: boolean; reasons: string[] };
  target_hit?: boolean;
  seed_covered?: boolean;
  coverage?: OptCoverage;
  hypothesis?: string;
  edit_type?: string;
  diff_summary?: string;
  pass: boolean;
  notes: string[];
  error?: string;
};

export type OptimizerCheckRun = {
  run_id: string;
  phase: "running" | "settled";
  base_version_id: string;
  optimizer_model_id?: string;
  judge_model_id?: string;
  current_hole?: string;
  holes: OptHoleResult[];
  overall_pass?: boolean;
  decision?: "done" | "stopped";
  error?: string;
  started_at: string;
  settled_at?: string;
};

export type OptHolePreview = { id: string; target: string; probe_type: string; reference: string };

export type OptCheckStartPayload = {
  hole_ids?: string[];
  optimizer_model_id?: string;
  judge_model_id?: string;
};
