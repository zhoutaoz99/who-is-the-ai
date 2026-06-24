import { Module } from "@nestjs/common";
import { GameModule } from "../game/game.module";
import { SandboxController } from "./sandbox.controller";
import { SandboxService } from "./sandbox.service";

// 离线沙盒模块:复用产品运行时(GameModule 导出的 GameService)驱动场景化对局,
// 与 iteration/ 并列、目录分开;仅在 DEBUG=true 下能建房(createSandboxRoom 内部校验)。
@Module({
  imports: [GameModule],
  controllers: [SandboxController],
  providers: [SandboxService],
})
export class SandboxModule {}
