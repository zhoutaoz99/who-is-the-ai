import type { RoomSnapshot } from "./game-types";

export type AiCallType = "speech-strategy" | "speech-expression" | "vote";

export type AiCallLog = {
  id: string;
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
  createdAt: string;
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
