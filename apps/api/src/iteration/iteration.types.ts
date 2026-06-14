import type { GameScore, Scorecard } from "./iteration-score";

export type IterationStatus =
  | "running"
  | "awaiting_activation"
  | "completed"
  | "stopped"
  | "failed";

export interface StartIterationPayload {
  rounds?: number;
  gamesPerRound?: number;
  discussionSeconds?: number;
}

/** 单局评估结果(发给前端逐局展示)。 */
export interface IterationGameResult {
  round: number;
  roomId: string;
  winner: string | null;
  generationId: string | null;
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
  /** 本轮已完成的局(进行中实时更新)。 */
  currentRoundGames: IterationGameResult[];
  rounds: IterationRound[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}
