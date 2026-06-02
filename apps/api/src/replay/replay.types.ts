import { RoomSnapshot } from "../game/game.types";

export type AiCallType = "speech-strategy" | "speech-expression" | "vote";

export interface AiCallLog {
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
}

export interface ReplayResponse {
  ok: boolean;
  room: RoomSnapshot | null;
  aiCallLogs: AiCallLog[];
  error?: string;
}
