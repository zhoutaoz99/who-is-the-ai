export interface AiModelCallConfig {
  model: string;
  temperature: number;
  reasoningEffort: string;
}

export interface AiConfig extends AiModelCallConfig {
  baseURL: string;
  apiKey: string;
  timeoutMs: number;
  speechStrategy: AiModelCallConfig;
  speechExpression: AiModelCallConfig;
}

export type AiSpeechAction =
  | { type: "speak"; content: string }
  | { type: "skip" };

export interface AiSpeechStrategy {
  goal: string;
  reason: string;
  intensity: string;
  length: string;
  constraints: string[];
}

export type AiSpeechStrategyAction =
  | { type: "speak"; strategy: AiSpeechStrategy }
  | { type: "skip"; reason?: string };

export type AiVoteAction = {
  type: "vote";
  targetPlayerId: string;
  reason?: string;
};

export interface ChatMessageInput {
  playerName: string;
  content: string;
  isSelf: boolean;
}

export interface VoteRecord {
  voterSeatNo: number;
  targetSeatNo: number;
}

export interface RoundVoteSummary {
  roundNo: number;
  votes: VoteRecord[];
  eliminatedSeatNo: number | null;
}

export interface GameContext {
  roundNo: number;
  phase: string;
  remainingTimeMs: number;
  myName: string;
  mySeatNo: number;
  alivePlayers: Array<{ id: string; seatNo: number }>;
  recentMessages: ChatMessageInput[];
  historicalMessages: Array<ChatMessageInput & { roundNo: number }>;
  myLastSpeech: string | null;
  currentVoteCounts: Record<string, number>;
  voteHistory: RoundVoteSummary[];
}
