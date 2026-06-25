import { Module } from "@nestjs/common";
import { GameController } from "./game.controller";
import { GameGateway } from "./game.gateway";
import { GameService } from "./game.service";
import { GameRoomRepository } from "./game-room.repository";
import { AiModule } from "../ai/ai.module";
import { AuthModule } from "../auth/auth.module";
import { DataModule } from "../data/data.module";

// 正常对局只接 AI / 鉴权 / 存储三块。IterationService/IterationController（旧自迭代工具链）
// 与 ReplayModule（复盘）已从运行时模块图中摘除，文件保留；自动对局现走 SandboxModule。
@Module({
  imports: [AiModule, AuthModule, DataModule],
  controllers: [GameController],
  providers: [GameGateway, GameService, GameRoomRepository],
  exports: [GameService],
})
export class GameModule {}
