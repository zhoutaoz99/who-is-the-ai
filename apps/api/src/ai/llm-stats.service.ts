import { Injectable, Logger } from "@nestjs/common";
import { PostgresService } from "../data/postgres.service";
import type { LlmCallMeta } from "./ai.types";
import { normalizeLlmUsage, type ModelUsageLike } from "./llm-usage";

interface LlmUsageAggregateRow {
  total_calls: string | number;
  success_calls: string | number;
  failed_calls: string | number;
  prompt_tokens: string | number;
  completion_tokens: string | number;
  total_tokens: string | number;
  total_input_tokens: string | number;
  cached_tokens: string | number;
  cache_write_tokens: string | number;
  avg_duration_ms: string | number;
}

interface LlmUsageModelAggregateRow extends LlmUsageAggregateRow {
  model_name: string;
  provider_format: string;
}

interface LlmUsageSourceAggregateRow extends LlmUsageAggregateRow {
  source: string;
}

export interface LlmStatsBucket {
  totalCalls: number;
  successCalls: number;
  failedCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  totalInputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  cacheHitRate: number;
  avgDurationMs: number;
}

export interface LlmModelStatsBucket extends LlmStatsBucket {
  modelName: string;
  providerFormat: string;
}

export interface LlmSourceStatsBucket extends LlmStatsBucket {
  source: string;
}

export interface LlmStatsView {
  generatedAt: string;
  window: {
    days: number | null;
    since: string | null;
    until: string;
    model?: string;
    source?: string;
  };
  overview: LlmStatsBucket;
  byModel: LlmModelStatsBucket[];
  bySource: LlmSourceStatsBucket[];
}

@Injectable()
export class LlmStatsService {
  private readonly logger = new Logger(LlmStatsService.name);

  constructor(private readonly postgres: PostgresService) {}

  async recordCall(input: {
    model: string;
    providerFormat: string;
    durationMs: number;
    ok: boolean;
    usage?: ModelUsageLike;
    error?: string;
    meta?: LlmCallMeta;
  }): Promise<void> {
    const usage = normalizeLlmUsage(input.usage);

    try {
      await this.postgres.ready;
      await this.postgres.query(
        `INSERT INTO llm_usage_logs (
          provider_format,
          model_name,
          source,
          stage,
          room_id,
          match_id,
          round_no,
          ok,
          prompt_tokens,
          completion_tokens,
          total_tokens,
          total_input_tokens,
          cached_tokens,
          cache_write_tokens,
          cache_hit_rate,
          duration_ms,
          error
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13, $14, $15, $16, $17
        )`,
        [
          input.providerFormat,
          input.model,
          (input.meta?.source ?? "unknown").trim() || "unknown",
          input.meta?.stage?.trim() || null,
          input.meta?.roomId?.trim() || null,
          input.meta?.matchId?.trim() || null,
          input.meta?.roundNo ?? null,
          input.ok,
          usage.promptTokens,
          usage.completionTokens,
          usage.totalTokens,
          usage.totalInputTokens,
          usage.cachedTokens,
          usage.cacheWriteTokens,
          usage.cacheHitRate,
          Math.max(0, Math.floor(input.durationMs)),
          input.error?.slice(0, 500) || null,
        ],
      );
    } catch (error) {
      this.logger.warn(
        `LLM usage stats write failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async getStats(filters?: {
    days?: number;
    model?: string;
    source?: string;
  }): Promise<LlmStatsView> {
    const until = new Date();
    const days = normalizeDays(filters?.days);
    const since = days != null
      ? new Date(until.getTime() - days * 24 * 60 * 60 * 1000)
      : null;
    const model = filters?.model?.trim() || undefined;
    const source = filters?.source?.trim() || undefined;
    const where = this.buildWhereClause({ since, model, source });

    await this.postgres.ready;

    const [overviewRes, byModelRes, bySourceRes] = await Promise.all([
      this.postgres.query<LlmUsageAggregateRow>(
        `SELECT
          COUNT(*)::bigint AS total_calls,
          COUNT(*) FILTER (WHERE ok)::bigint AS success_calls,
          COUNT(*) FILTER (WHERE NOT ok)::bigint AS failed_calls,
          COALESCE(SUM(prompt_tokens), 0)::bigint AS prompt_tokens,
          COALESCE(SUM(completion_tokens), 0)::bigint AS completion_tokens,
          COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
          COALESCE(SUM(total_input_tokens), 0)::bigint AS total_input_tokens,
          COALESCE(SUM(cached_tokens), 0)::bigint AS cached_tokens,
          COALESCE(SUM(cache_write_tokens), 0)::bigint AS cache_write_tokens,
          COALESCE(AVG(duration_ms), 0)::double precision AS avg_duration_ms
         FROM llm_usage_logs
         ${where.clause}`,
        where.params,
      ),
      this.postgres.query<LlmUsageModelAggregateRow>(
        `SELECT
          model_name,
          provider_format,
          COUNT(*)::bigint AS total_calls,
          COUNT(*) FILTER (WHERE ok)::bigint AS success_calls,
          COUNT(*) FILTER (WHERE NOT ok)::bigint AS failed_calls,
          COALESCE(SUM(prompt_tokens), 0)::bigint AS prompt_tokens,
          COALESCE(SUM(completion_tokens), 0)::bigint AS completion_tokens,
          COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
          COALESCE(SUM(total_input_tokens), 0)::bigint AS total_input_tokens,
          COALESCE(SUM(cached_tokens), 0)::bigint AS cached_tokens,
          COALESCE(SUM(cache_write_tokens), 0)::bigint AS cache_write_tokens,
          COALESCE(AVG(duration_ms), 0)::double precision AS avg_duration_ms
         FROM llm_usage_logs
         ${where.clause}
         GROUP BY model_name, provider_format
         ORDER BY total_calls DESC, model_name ASC`,
        where.params,
      ),
      this.postgres.query<LlmUsageSourceAggregateRow>(
        `SELECT
          source,
          COUNT(*)::bigint AS total_calls,
          COUNT(*) FILTER (WHERE ok)::bigint AS success_calls,
          COUNT(*) FILTER (WHERE NOT ok)::bigint AS failed_calls,
          COALESCE(SUM(prompt_tokens), 0)::bigint AS prompt_tokens,
          COALESCE(SUM(completion_tokens), 0)::bigint AS completion_tokens,
          COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
          COALESCE(SUM(total_input_tokens), 0)::bigint AS total_input_tokens,
          COALESCE(SUM(cached_tokens), 0)::bigint AS cached_tokens,
          COALESCE(SUM(cache_write_tokens), 0)::bigint AS cache_write_tokens,
          COALESCE(AVG(duration_ms), 0)::double precision AS avg_duration_ms
         FROM llm_usage_logs
         ${where.clause}
         GROUP BY source
         ORDER BY total_calls DESC, source ASC`,
        where.params,
      ),
    ]);

    return {
      generatedAt: until.toISOString(),
      window: {
        days,
        since: since?.toISOString() ?? null,
        until: until.toISOString(),
        ...(model ? { model } : {}),
        ...(source ? { source } : {}),
      },
      overview: mapBucket(overviewRes.rows[0]),
      byModel: byModelRes.rows.map((row) => ({
        modelName: row.model_name,
        providerFormat: row.provider_format,
        ...mapBucket(row),
      })),
      bySource: bySourceRes.rows.map((row) => ({
        source: row.source,
        ...mapBucket(row),
      })),
    };
  }

  private buildWhereClause(filters: {
    since: Date | null;
    model?: string;
    source?: string;
  }): { clause: string; params: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filters.since) {
      params.push(filters.since.toISOString());
      clauses.push(`created_at >= $${params.length}`);
    }
    if (filters.model) {
      params.push(filters.model);
      clauses.push(`model_name = $${params.length}`);
    }
    if (filters.source) {
      params.push(filters.source);
      clauses.push(`source = $${params.length}`);
    }

    return {
      clause: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
      params,
    };
  }
}

function mapBucket(row?: LlmUsageAggregateRow): LlmStatsBucket {
  const totalInputTokens = toNumber(row?.total_input_tokens);
  const cachedTokens = toNumber(row?.cached_tokens);

  return {
    totalCalls: toNumber(row?.total_calls),
    successCalls: toNumber(row?.success_calls),
    failedCalls: toNumber(row?.failed_calls),
    promptTokens: toNumber(row?.prompt_tokens),
    completionTokens: toNumber(row?.completion_tokens),
    totalTokens: toNumber(row?.total_tokens),
    totalInputTokens,
    cachedTokens,
    cacheWriteTokens: toNumber(row?.cache_write_tokens),
    cacheHitRate: totalInputTokens > 0 ? cachedTokens / totalInputTokens : 0,
    avgDurationMs: round(toNumber(row?.avg_duration_ms)),
  };
}

function normalizeDays(days?: number): number | null {
  if (days == null || Number.isNaN(days)) {
    return null;
  }
  const normalized = Math.floor(days);
  if (normalized <= 0) {
    return null;
  }
  return Math.min(normalized, 3650);
}

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
