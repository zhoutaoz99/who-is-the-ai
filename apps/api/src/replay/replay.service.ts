import { Injectable } from "@nestjs/common";
import { AiService } from "../ai/ai.service";
import type { AiModelCallConfig } from "../ai/ai.types";
import { loadPrompt, renderTemplate } from "../ai/prompt-loader";
import { PostgresService } from "../data/postgres.service";
import { AiCallLog } from "./replay.types";

const REPLAY_ANALYSIS_TIMEOUT_MS = 60_000;

@Injectable()
export class ReplayService {
  constructor(
    private readonly postgres: PostgresService,
    private readonly aiService: AiService,
  ) {}

  async saveAiCallLog(log: AiCallLog): Promise<void> {
    await this.postgres.query(
      `INSERT INTO ai_call_logs
        (id, room_id, round_no, call_type, ai_player_id, ai_player_name,
         ai_player_seat_no, user_prompt, raw_response,
         model_name, temperature, reasoning_effort, created_at, template_prompt)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        log.id,
        log.roomId,
        log.roundNo,
        log.callType,
        log.aiPlayerId,
        log.aiPlayerName,
        log.aiPlayerSeatNo,
        log.userPrompt,
        log.rawResponse,
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
        user_prompt AS "userPrompt",
        raw_response AS "rawResponse",
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

  async streamReplayAnalysisExport(
    replay: unknown,
    onChunk: (chunk: string) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const { systemPrompt, userPrompt } = this.buildReplayAnalysisPrompt(replay);
    const analysisModel = this.resolveReplayAnalysisModel();
    return this.aiService.streamModel(
      systemPrompt,
      userPrompt,
      analysisModel.modelConfig,
      onChunk,
      { ...analysisModel.options, signal },
    );
  }

  private buildReplayAnalysisPrompt(replay: unknown): {
    systemPrompt: string;
    userPrompt: string;
  } {
    const replayJson = JSON.stringify(replay, null, 2);
    if (!replayJson) {
      throw new Error("复盘数据为空");
    }

    const systemPrompt = loadPrompt("system-replay-analysis.txt");
    const userPrompt = renderTemplate("user-replay-analysis-template.txt", {
      replayJson,
    });

    return { systemPrompt, userPrompt };
  }

  private resolveReplayAnalysisModel(): {
    modelConfig: AiModelCallConfig;
    options: { baseURL: string; apiKey: string; timeoutMs: number };
  } {
    const baseURL = this.readRequiredEnv("REPLAY_ANALYSIS_BASE_URL");
    const apiKey = this.readRequiredEnv("REPLAY_ANALYSIS_API_KEY");
    const model = this.readRequiredEnv("REPLAY_ANALYSIS_MODEL");
    if (!baseURL || !apiKey || !model) {
      throw new Error(
        "缺少复盘分析模型配置：请在 .env 中配置 REPLAY_ANALYSIS_BASE_URL、REPLAY_ANALYSIS_API_KEY、REPLAY_ANALYSIS_MODEL",
      );
    }

    return {
      modelConfig: {
        model,
        temperature: this.readNumberEnv("REPLAY_ANALYSIS_TEMPERATURE", 0.2),
        reasoningEffort:
          process.env.REPLAY_ANALYSIS_REASONING_EFFORT?.trim() || "high",
        thinking: this.readBooleanEnv("REPLAY_ANALYSIS_THINKING", true),
      },
      options: {
        baseURL: baseURL.replace(/\/+$/, ""),
        apiKey,
        timeoutMs: this.readNumberEnv(
          "REPLAY_ANALYSIS_TIMEOUT_MS",
          REPLAY_ANALYSIS_TIMEOUT_MS,
        ),
      },
    };
  }

  private readRequiredEnv(name: string): string | null {
    const value = process.env[name]?.trim();
    return value ? value : null;
  }

  private readNumberEnv(name: string, fallback: number): number {
    const value = process.env[name]?.trim();
    if (!value) {
      return fallback;
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private readBooleanEnv(name: string, fallback: boolean): boolean {
    const value = process.env[name]?.trim().toLowerCase();
    if (!value) {
      return fallback;
    }

    if (["true", "1", "yes", "on"].includes(value)) {
      return true;
    }

    if (["false", "0", "no", "off"].includes(value)) {
      return false;
    }

    return fallback;
  }
}
