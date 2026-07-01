export interface ModelUsageLike {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface NormalizedLlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  totalInputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  cacheHitRate: number;
}

export function normalizeLlmUsage(usage?: ModelUsageLike): NormalizedLlmUsage {
  const promptTokens = toSafeInt(usage?.prompt_tokens);
  const completionTokens = toSafeInt(usage?.completion_tokens);
  const cachedTokens = toSafeInt(
    usage?.prompt_tokens_details?.cached_tokens ?? usage?.cache_read_input_tokens,
  );
  const cacheWriteTokens = toSafeInt(usage?.cache_creation_input_tokens);
  const usesSeparateCacheAccounting =
    usage?.cache_read_input_tokens != null || usage?.cache_creation_input_tokens != null;
  const totalInputTokens = usesSeparateCacheAccounting
    ? promptTokens + cachedTokens + cacheWriteTokens
    : promptTokens;
  const rawTotalTokens = toSafeInt(usage?.total_tokens);
  const totalTokens = rawTotalTokens > 0
    ? rawTotalTokens
    : promptTokens + completionTokens;

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    totalInputTokens,
    cachedTokens,
    cacheWriteTokens,
    cacheHitRate: totalInputTokens > 0 ? cachedTokens / totalInputTokens : 0,
  };
}

function toSafeInt(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return 0;
  }
  return Math.floor(n);
}
