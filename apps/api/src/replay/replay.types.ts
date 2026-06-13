import { RoomSnapshot } from "../game/game.types";

export type AiCallType =
  | "speech-strategy"
  | "speech-expression"
  | "vote"
  | "sim-human-speech"
  | "sim-human-vote";

export interface AiCallLog {
  id: string;
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
  createdAt: string;
  templatePrompt?: string;
}

export interface ReplayResponse {
  ok: boolean;
  room: RoomSnapshot | null;
  aiCallLogs: AiCallLog[];
  error?: string;
}

export interface ReplayAnalyzeRequest {
  replay?: unknown;
}

export interface ReplayExportRecord {
  data: unknown;
  includeSkips: boolean;
  includeUserPrompt: boolean;
}

export interface ReplayExportSaveRequest {
  data: unknown;
  includeSkips: boolean;
  includeUserPrompt: boolean;
}
