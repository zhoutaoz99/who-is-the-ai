import { RoomSnapshot } from "../game/game.types";

export interface AiCallLog {
  id: string;
  roomId: string;
  roundNo: number;
  /** v4.0 单层对局:"discussion" | "vote"(DB 列为 text,兼容历史旧值)。 */
  callType: string;
  aiPlayerId: string;
  aiPlayerName: string;
  aiPlayerSeatNo: number;
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
}

export interface ReplayResponse {
  ok: boolean;
  room: RoomSnapshot | null;
  aiCallLogs: AiCallLog[];
  error?: string;
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
