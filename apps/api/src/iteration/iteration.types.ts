import type { GameAssessment, Scorecard } from "./iteration-score";

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

export interface IterationRunOptions {
  sequentialSpeech: boolean;
  personaMode: IterationPersonaMode;
  personaIds?: string[];
  personaSchedule?: string[][];
  autoOptimize: boolean;
  postRoundMode: IterationPostRoundMode;
}

export interface StartIterationPayload {
  rounds?: number;
  gamesPerRound?: number;
  discussionSeconds?: number;
  sequentialSpeech?: boolean;
  personaMode?: IterationPersonaMode;
  personaIds?: string[];
  autoOptimize?: boolean;
  postRoundMode?: IterationPostRoundMode;
}

/** 单局评估结果(发给前端逐局展示)。 */
export interface IterationGameResult {
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
  /** 该局完整评估(客观项 + Issue Code 结构化头 + 自由文本评语),供轮聚合与优化器使用。 */
  score?: GameAssessment;
}

/** 一轮的聚合记录(持久化进 iteration_runs.rounds)。 */
export interface IterationRound {
  round: number;
  generationId: string | null;
  games: IterationGameResult[];
  aggregate: Scorecard | null;
  autoOptimize?: {
    status: "created" | "skipped" | "failed";
    generationId?: string;
    evalGenerationId?: string;
    changedAssetKeys?: string[];
    note?: string;
    error?: string;
    /** 自动优化器(大模型)返回的原始正文,供详情弹窗展示生成结果。 */
    response?: string;
    /** 本次自动优化(模型调用)耗时,毫秒;前端展示「已耗时」。 */
    durationMs?: number;
  };
}

/** 发给前端的 run 全量快照。 */
export interface IterationRunStatus {
  id: string;
  status: IterationStatus;
  currentRound: number;
  totalRounds: number;
  gamesPerRound: number;
  discussionSeconds: number;
  activeGenerationId: string | null;
  pendingGenerationId?: string | null;
  options?: IterationRunOptions;
  /** 本轮已完成的局(进行中实时更新)。 */
  currentRoundGames: IterationGameResult[];
  rounds: IterationRound[];
  lastAutoOptimize?: IterationRound["autoOptimize"] | null;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
