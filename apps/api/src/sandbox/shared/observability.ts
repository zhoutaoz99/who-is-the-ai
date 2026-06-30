// M0.6 沙盒 LLM 调用观测:进程内环形缓冲,用于排查裁判/优化器 partial、重试和成本。

interface UsageLike {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface SandboxLlmCallRecord {
  id: string;
  timestamp: string;
  stage: string;
  model: string;
  match_id?: string;
  round?: number;
  attempt: number;
  ok: boolean;
  duration_ms: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cached_tokens?: number;
  cache_write_tokens?: number;
  error?: string;
}

const MAX_RECORDS = 1000;
const records: SandboxLlmCallRecord[] = [];

export async function observeSandboxLlmCall<T extends { usage?: UsageLike }>(
  meta: {
    stage: string;
    model: string;
    match_id?: string;
    round?: number;
    attempt: number;
  },
  call: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  try {
    const result = await call();
    pushRecord({
      ...meta,
      ok: true,
      duration_ms: Date.now() - start,
      ...usageFields(result.usage),
    });
    return result;
  } catch (err) {
    pushRecord({
      ...meta,
      ok: false,
      duration_ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export function listSandboxLlmCalls(limit = 200): SandboxLlmCallRecord[] {
  const n = Math.max(1, Math.min(MAX_RECORDS, Math.floor(limit)));
  return records.slice(-n).reverse();
}

export function clearSandboxLlmCalls(): void {
  records.length = 0;
}

function pushRecord(record: Omit<SandboxLlmCallRecord, "id" | "timestamp">): void {
  records.push({
    id: `llm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    ...record,
  });
  if (records.length > MAX_RECORDS) {
    records.splice(0, records.length - MAX_RECORDS);
  }
}

function usageFields(usage?: UsageLike): Partial<SandboxLlmCallRecord> {
  if (!usage) return {};
  return {
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens,
    cache_write_tokens: usage.cache_creation_input_tokens,
  };
}
