// ControlTestGateway:订阅对照测试 + 优化器自检两个服务的内部事件,桥接到 socket。
// 复用默认 namespace(与 GameGateway / OrchestratorGateway 同一个 io server)。
// - 对照测试(验评估链):controltest.status / game / control / done
// - 优化器自检(验优化器,零对局):optcheck.status / hole / done

import { OnModuleInit } from "@nestjs/common";
import { WebSocketGateway, WebSocketServer } from "@nestjs/websockets";
import type { Server } from "socket.io";
import { ControlTestService } from "./control-test.service";
import { OptimizerCheckService } from "./optimizer-check.service";

@WebSocketGateway({
  cors: { origin: "*" },
})
export class ControlTestGateway implements OnModuleInit {
  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly controlTest: ControlTestService,
    private readonly optimizerCheck: OptimizerCheckService,
  ) {}

  onModuleInit(): void {
    const bridge = (prefix: string, channel: string) => (payload: unknown) => {
      this.server?.emit(`${prefix}.${channel}`, payload);
    };
    for (const ch of ["status", "game", "control", "done"]) {
      this.controlTest.events.on(ch, bridge("controltest", ch));
    }
    for (const ch of ["status", "hole", "done"]) {
      this.optimizerCheck.events.on(ch, bridge("optcheck", ch));
    }
  }
}
