import type { GameScore, Scorecard } from "./iteration-score";

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

export interface IterationRunOptions {
  fastMode: boolean;
  personaMode: IterationPersonaMode;
  personaIds?: string[];
  personaSchedule?: string[][];
  autoEdit: boolean;
  postRoundMode: IterationPostRoundMode;
}

export interface StartIterationPayload {
  rounds?: number;
  gamesPerRound?: number;
  discussionSeconds?: number;
  fastMode?: boolean;
  personaMode?: IterationPersonaMode;
  personaIds?: string[];
  autoEdit?: boolean;
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
  currentGameRound?: number;
  phase?: string;
  aiAlive?: number;
  simulatedHumanAlive?: number;
  aiTotal?: number;
  simulatedHumanTotal?: number;
  humanLikeScore?: number;
  aiWin?: boolean;
  error?: string;
  /** 该局完整打分(含 tells/naturalness/voteThreatTargeting/topIssues),供轮聚合使用。 */
  score?: GameScore;
}

/** 一轮的聚合记录(持久化进 iteration_runs.rounds)。 */
export interface IterationRound {
  round: number;
  generationId: string | null;
  games: IterationGameResult[];
  aggregate: Scorecard | null;
  autoEdit?: {
    status: "created" | "skipped" | "failed";
    generationId?: string;
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
  lastAutoEdit?: IterationRound["autoEdit"] | null;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
