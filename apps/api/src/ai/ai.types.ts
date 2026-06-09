import type { AiShortMemory } from "../game/game.types";

export type AiModelFormat = "openai" | "claude";

export interface AiModelCallConfig {
  model: string;
  temperature: number;
  reasoningEffort: string;
  thinking?: boolean;
  format?: AiModelFormat;
  maxTokens?: number;
}

export interface AiModelEntry {
  id: string;
  default?: boolean;
  format?: AiModelFormat;
  baseURL: string;
  apiKey: string;
  model: string;
  temperature: number;
  reasoningEffort: string;
  timeoutMs?: number;
  thinking?: boolean;
  maxTokens?: number;
  expression?: {
    model?: string;
    temperature?: number;
    reasoningEffort?: string;
    thinking?: boolean;
    maxTokens?: number;
  };
}

export interface AiConfig extends AiModelCallConfig {
  baseURL: string;
  apiKey: string;
  timeoutMs: number;
  speechStrategy: AiModelCallConfig;
  speechExpression: AiModelCallConfig;
}

export type AiSpeechAction =
  | {
      type: "speak";
      content: string;
      targetResponseDelayMs: number;
      nextCheckAfterMs: number;
      callRecords: AiCallRecord[];
    }
  | { type: "skip"; nextCheckAfterMs: number; callRecords: AiCallRecord[] };

export interface AiSpeechStrategy {
  replyTo: string;
  speechAct: string;
  publicPoint: string;
  tone: string;
  maxSentences: number;
  constraints: string[];
  avoidPhrases: string[];
}

export interface AiPersonaContext {
  id: string;
  name: string;
  speechStyle: string;
  sentenceStyle: string;
  responseBias: string;
  toneRules: string[];
  avoidPhrases: string[];
}

export type AiSpeechStrategyAction =
  | {
      type: "speak";
      strategy: AiSpeechStrategy;
      targetResponseDelayMs: number;
      nextCheckAfterMs: number;
    }
  | { type: "skip"; reason?: string; nextCheckAfterMs: number };

export type AiVoteAction = {
  type: "vote";
  targetPlayerId: string;
  reason?: string;
};

export interface ChatMessageInput {
  playerName: string;
  content: string;
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
  myPlayerType: "human" | "ai";
  mySimulated: boolean;
  myModelId?: string;
  mySeatNo: number;
  myPersona: AiPersonaContext | null;
  alivePlayers: Array<{ id: string; seatNo: number }>;
  recentMessages: ChatMessageInput[];
  historicalMessages: Array<ChatMessageInput & { roundNo: number }>;
  myLastSpeech: string | null;
  currentVoteCounts: Record<string, number>;
  voteHistory: RoundVoteSummary[];
  shortMemory: AiShortMemory | null;
}

export type AiCallType =
  | "speech-strategy"
  | "speech-expression"
  | "vote"
  | "sim-human-speech"
  | "sim-human-vote";

export interface AiCallRecord {
  roomId: string;
  roundNo: number;
  callType: AiCallType;
  aiPlayerId: string;
  aiPlayerName: string;
  aiPlayerSeatNo: number;
  userPrompt: string;
  rawResponse: string;
  modelName: string;
  temperature: number;
  reasoningEffort: string;
  templatePrompt?: string;
  createdAt?: string;
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
