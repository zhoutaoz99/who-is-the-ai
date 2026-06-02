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
  roomId: string;
  roundNo: number;
  phase: string;
  remainingTimeMs: number;
  myName: string;
  myPlayerId: string;
  mySeatNo: number;
  alivePlayers: Array<{ id: string; seatNo: number }>;
  recentMessages: ChatMessageInput[];
  historicalMessages: Array<ChatMessageInput & { roundNo: number }>;
  myLastSpeech: string | null;
  currentVoteCounts: Record<string, number>;
  voteHistory: RoundVoteSummary[];
}

export type AiCallType = "speech-strategy" | "speech-expression" | "vote";

export interface AiCallRecord {
  roomId: string;
  roundNo: number;
  callType: AiCallType;
  aiPlayerId: string;
  aiPlayerName: string;
  aiPlayerSeatNo: number;
  systemPrompt: string;
  userPrompt: string;
  rawResponse: string;
  modelName: string;
  temperature: number;
  reasoningEffort: string;
  templatePrompt?: string;
}

export interface AiCallRecorder {
  record(call: AiCallRecord): void;
}

export interface DebugCallRequest {
  systemPrompt: string;
  userPrompt: string;
  model?: string;
  temperature?: number;
  reasoningEffort?: string;
}

export interface DebugCallResponse {
  ok: boolean;
  rawResponse?: string;
  thinkingContent?: string;
  error?: string;
}
