// 审计 trace:把🟡(LLM 原始 I/O)/🔴(聚合中间产物)等"仅内存/算完即弃"的中间数据落盘,
// 供设计一致性审计 agent 读取(见 docs/audit/CHARTER.md §4.4/§13)。
//
// 设计要点:
//  - 默认关闭。仅当环境变量 AUDIT_TRACE=1 且 sink 已注入时才落盘——普通/生产跑零开销。
//  - sink 由 TraceSinkService 在模块初始化时通过 setTraceSink 注入(落 sandbox_trace_events)。
//  - traceEvent 永不抛错、不阻塞调用方(fire-and-forget),绝不影响运行时。

export interface TraceEvent {
  /** 事件类别:"llm_io" | "aggregate" | ... */
  kind: string;
  stage?: string;
  match_id?: string;
  run_id?: string;
  data: unknown;
}

type TraceSink = (ev: TraceEvent) => void | Promise<void>;

let sink: TraceSink | null = null;

/** trace 是否生效(AUDIT_TRACE=1 且已注入 sink)。供调用方在拼装大 payload 前先判断。 */
export function isTraceOn(): boolean {
  return process.env.AUDIT_TRACE === "1" && sink !== null;
}

/** 由 TraceSinkService 在 onModuleInit 注入;传 null 解除(测试用)。 */
export function setTraceSink(fn: TraceSink | null): void {
  sink = fn;
}

/** 落一条 trace 事件;关闭或无 sink 时 no-op,任何异常被吞,绝不影响运行时。 */
export function traceEvent(ev: TraceEvent): void {
  if (process.env.AUDIT_TRACE !== "1" || !sink) return;
  try {
    void Promise.resolve(sink(ev)).catch(() => {});
  } catch {
    /* trace 绝不影响运行时 */
  }
}
