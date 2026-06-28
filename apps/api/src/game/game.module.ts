import { Module } from "@nestjs/common";
import { GameController } from "./game.controller";
import { GameGateway } from "./game.gateway";
import { GameService } from "./game.service";
import { GameRoomRepository } from "./game-room.repository";
import { AiModule } from "../ai/ai.module";
import { AuthModule } from "../auth/auth.module";
import { DataModule } from "../data/data.module";

// 正常对局只接 AI / 鉴权 / 存储三块。旧自迭代工具链(iteration/)已删除;
// 复盘(ReplayModule)与自动迭代(SandboxModule)在 AppModule 顶层挂载,不在此导入。
@Module({
  imports: [AiModule, AuthModule, DataModule],
  controllers: [GameController],
  providers: [GameGateway, GameService, GameRoomRepository],
  exports: [GameService],
})
export class GameModule {}
