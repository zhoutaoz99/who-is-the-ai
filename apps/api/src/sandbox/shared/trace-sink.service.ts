// 把 trace.ts 的 sink 接到 SandboxRepository(落 sandbox_trace_events)。
// 单独成 provider:trace.ts 保持纯函数、与 NestDI 解耦;本服务在启动时完成接线。

import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { SandboxRepository } from "../sandbox.repository";
import { setTraceSink, type TraceEvent } from "./trace";

@Injectable()
export class TraceSinkService implements OnModuleInit {
  private readonly logger = new Logger(TraceSinkService.name);

  constructor(private readonly repo: SandboxRepository) {}

  onModuleInit(): void {
    setTraceSink((ev: TraceEvent) =>
      this.repo.insertTraceEvent(ev).catch((err) => {
        this.logger.warn(`trace 落盘失败: ${err instanceof Error ? err.message : err}`);
      }),
    );
    if (process.env.AUDIT_TRACE === "1") {
      this.logger.log("审计 trace 已开启(AUDIT_TRACE=1):中间数据落 sandbox_trace_events");
    }
  }
}
