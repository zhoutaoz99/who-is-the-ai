import { Injectable } from "@nestjs/common";
import { PostgresService } from "../data/postgres.service";
import { AiCallLog } from "./replay.types";

@Injectable()
export class ReplayService {
  constructor(private readonly postgres: PostgresService) {}

  async saveAiCallLog(log: AiCallLog): Promise<void> {
    await this.postgres.query(
      `INSERT INTO ai_call_logs
        (id, room_id, round_no, call_type, ai_player_id, ai_player_name,
         ai_player_seat_no, system_prompt, user_prompt, raw_response,
         model_name, temperature, reasoning_effort, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        log.id,
        log.roomId,
        log.roundNo,
        log.callType,
        log.aiPlayerId,
        log.aiPlayerName,
        log.aiPlayerSeatNo,
        log.systemPrompt,
        log.userPrompt,
        log.rawResponse,
        log.modelName,
        log.temperature,
        log.reasoningEffort,
        log.createdAt,
      ],
    );
  }

  async getAiCallLogs(roomId: string): Promise<AiCallLog[]> {
    const result = await this.postgres.query<AiCallLog>(
      `SELECT
        id, room_id AS "roomId", round_no AS "roundNo",
        call_type AS "callType", ai_player_id AS "aiPlayerId",
        ai_player_name AS "aiPlayerName",
        ai_player_seat_no AS "aiPlayerSeatNo",
        system_prompt AS "systemPrompt",
        user_prompt AS "userPrompt",
        raw_response AS "rawResponse",
        model_name AS "modelName", temperature, reasoning_effort AS "reasoningEffort",
        created_at AS "createdAt"
      FROM ai_call_logs
      WHERE room_id = $1
      ORDER BY round_no, created_at`,
      [roomId],
    );
    return result.rows;
  }
}
