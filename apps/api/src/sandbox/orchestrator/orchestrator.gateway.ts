// F0.5 OrchestratorGateway:订阅 OrchestratorService 的内部事件,桥接到 socket。
// 复用默认 namespace(与 GameGateway 同一个 io server),向前台 emit orchestrator.* 事件。
// 事件:status(快照)/ game(逐局状态)/ proposal(候选+校验)/ gate(优化集闸门)/
//       holdout_game(留出逐局)/ holdout(留出复核结论)/ done(落定)。

import { OnModuleInit } from "@nestjs/common";
import { WebSocketGateway, WebSocketServer } from "@nestjs/websockets";
import type { Server } from "socket.io";
import { OrchestratorService } from "./orchestrator.service";

@WebSocketGateway({
  cors: { origin: "*" },
})
export class OrchestratorGateway implements OnModuleInit {
  @WebSocketServer()
  server!: Server;

  constructor(private readonly orchestrator: OrchestratorService) {}

  onModuleInit(): void {
    const bridge = (channel: string) => (payload: unknown) => {
      // run 发生在启动完成后,server 已就绪;?. 兜底极早期竞态。
      this.server?.emit(`orchestrator.${channel}`, payload);
    };
    this.orchestrator.events.on("status", bridge("status"));
    this.orchestrator.events.on("game", bridge("game"));
    this.orchestrator.events.on("proposal", bridge("proposal"));
    this.orchestrator.events.on("gate", bridge("gate"));
    this.orchestrator.events.on("holdout_game", bridge("holdout_game"));
    this.orchestrator.events.on("holdout", bridge("holdout"));
    this.orchestrator.events.on("done", bridge("done"));
  }
}
