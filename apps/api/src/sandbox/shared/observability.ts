// M0.6 沙盒 LLM 调用观测:进程内环形缓冲,用于排查裁判/优化器 partial、重试和成本。
// 另:trace 开启时(AUDIT_TRACE=1)额外把完整 I/O(prompt 原文 + 回复)落盘(🟡,见 trace.ts)。

import { isTraceOn, traceEvent } from "./trace";

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

export async function observeSandboxLlmCall<
  T extends { usage?: UsageLike; content?: string; reasoning?: string },
>(
  meta: {
    stage: string;
    model: string;
    match_id?: string;
    round?: number;
    attempt: number;
    run_id?: string;
    /** trace 开启时落盘的提示词原文(🟡);不进内存环形缓冲。 */
    system?: string;
    user?: string;
  },
  call: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  const ring = {
    stage: meta.stage,
    model: meta.model,
    match_id: meta.match_id,
    round: meta.round,
    attempt: meta.attempt,
  };
  try {
    const result = await call();
    pushRecord({
      ...ring,
      ok: true,
      duration_ms: Date.now() - start,
      ...usageFields(result.usage),
    });
    if (isTraceOn()) {
      traceEvent({
        kind: "llm_io",
        stage: meta.stage,
        match_id: meta.match_id,
        run_id: meta.run_id,
        data: {
          model: meta.model,
          round: meta.round,
          attempt: meta.attempt,
          ok: true,
          system: meta.system,
          user: meta.user,
          response: result.content,
          reasoning: result.reasoning,
          usage: result.usage,
          duration_ms: Date.now() - start,
        },
      });
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    pushRecord({
      ...ring,
      ok: false,
      duration_ms: Date.now() - start,
      error: message,
    });
    if (isTraceOn()) {
      traceEvent({
        kind: "llm_io",
        stage: meta.stage,
        match_id: meta.match_id,
        run_id: meta.run_id,
        data: {
          model: meta.model,
          attempt: meta.attempt,
          ok: false,
          system: meta.system,
          user: meta.user,
          error: message,
          duration_ms: Date.now() - start,
        },
      });
    }
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
