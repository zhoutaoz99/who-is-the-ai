import type { RoomSnapshot } from "./game-types";

export type AiCallType =
  | "discussion"
  | "vote"
  | "speech-strategy"
  | "speech-expression"
  | "sim-human-speech"
  | "sim-human-vote";

export type AiCallLog = {
  id: string;
  roomId: string;
  roundNo: number;
  callType: AiCallType;
  aiPlayerId: string;
  aiPlayerName: string;
  aiPlayerSeatNo: number;
  /** 该次调用实际使用的系统提示词(含人格注入);旧日志可能缺失,回退到通用模板。 */
  systemPrompt?: string;
  userPrompt: string;
  rawResponse: string;
  /** 推理模型的思考内容(非推理模型为空)。 */
  reasoning?: string;
  modelName: string;
  temperature: number;
  reasoningEffort: string;
  createdAt: string;
  templatePrompt?: string;
};

export type ReplayData = {
  ok: boolean;
  room: RoomSnapshot | null;
  aiCallLogs: AiCallLog[];
  error?: string;
};

export type DebugCallRequest = {
  systemPrompt: string;
  userPrompt: string;
  model?: string;
  temperature?: number;
  reasoningEffort?: string;
};

export type DebugCallResponse = {
  ok: boolean;
  rawResponse?: string;
  thinkingContent?: string;
  error?: string;
};
