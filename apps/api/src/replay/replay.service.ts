import { Injectable } from "@nestjs/common";
import { PostgresService } from "../data/postgres.service";
import { AiCallLog, ReplayExportRecord } from "./replay.types";

@Injectable()
export class ReplayService {
  constructor(private readonly postgres: PostgresService) {}

  async saveAiCallLog(log: AiCallLog): Promise<void> {
    await this.postgres.query(
      `INSERT INTO ai_call_logs
        (id, room_id, round_no, call_type, ai_player_id, ai_player_name,
         ai_player_seat_no, system_prompt, user_prompt, raw_response, reasoning,
         model_name, temperature, reasoning_effort, created_at, template_prompt)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        log.id,
        log.roomId,
        log.roundNo,
        log.callType,
        log.aiPlayerId,
        log.aiPlayerName,
        log.aiPlayerSeatNo,
        log.systemPrompt ?? null,
        log.userPrompt,
        log.rawResponse,
        log.reasoning ?? null,
        log.modelName,
        log.temperature,
        log.reasoningEffort,
        log.createdAt,
        log.templatePrompt ?? null,
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
        reasoning,
        model_name AS "modelName", temperature, reasoning_effort AS "reasoningEffort",
        created_at AS "createdAt",
        template_prompt AS "templatePrompt"
      FROM ai_call_logs
      WHERE room_id = $1
      ORDER BY round_no, created_at`,
      [roomId],
    );
    return result.rows;
  }

  async getReplayExport(roomId: string): Promise<ReplayExportRecord | null> {
    const result = await this.postgres.query<{
      data: unknown;
      includeSkips: boolean;
      includeUserPrompt: boolean;
    }>(
      `SELECT
        data,
        include_skips AS "includeSkips",
        include_user_prompt AS "includeUserPrompt"
      FROM replay_exports
      WHERE room_id = $1`,
      [roomId],
    );
    return result.rows[0] ?? null;
  }

  async saveReplayExport(
    roomId: string,
    data: unknown,
    includeSkips: boolean,
    includeUserPrompt: boolean,
  ): Promise<void> {
    await this.postgres.query(
      `INSERT INTO replay_exports
        (room_id, data, include_skips, include_user_prompt)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (room_id) DO UPDATE
       SET data = EXCLUDED.data,
           include_skips = EXCLUDED.include_skips,
           include_user_prompt = EXCLUDED.include_user_prompt,
           updated_at = NOW()`,
      [roomId, JSON.stringify(data), includeSkips, includeUserPrompt],
    );
  }
}
