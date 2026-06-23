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

// v4.0 单层方案的人设卡：整张卡直接拼进讨论/投票 system 末尾的 {{persona}}。
export interface PersonaCard {
  id: string;
  // 类型标签，如「摆烂躺平型」；用于抽卡时的多样性与前端展示。
  group: string;
  // 角色名，如「阿条」。
  nickname: string;
  // v4.0 人设卡字段：直接拼进 system 模板末尾的 {{persona}}。
  basicSetting: string;
  personality: string;
  speakingStyle: string;
  catchphrases: string;
  blindSpots: string;
  howToPlay: string;
  examples: string[];
}

export interface PersonaOption {
  id: string;
  label: string;
  group: string;
}

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
  myPersona: PersonaCard | null;
  alivePlayers: Array<{ id: string; seatNo: number }>;
  recentMessages: ChatMessageInput[];
  historicalMessages: Array<ChatMessageInput & { roundNo: number }>;
  myLastSpeech: string | null;
  currentVoteCounts: Record<string, number>;
  voteHistory: RoundVoteSummary[];
  shortMemory: AiShortMemory | null;
}

export type AiCallType =
  | "discussion"
  | "vote";

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
