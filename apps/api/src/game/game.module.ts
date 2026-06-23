import { Module } from "@nestjs/common";
import { GameController } from "./game.controller";
import { GameGateway } from "./game.gateway";
import { GameService } from "./game.service";
import { GameRoomRepository } from "./game-room.repository";
import { AiModule } from "../ai/ai.module";
import { AuthModule } from "../auth/auth.module";
import { DataModule } from "../data/data.module";

// 正常对局只接 AI / 鉴权 / 存储三块。IterationService/IterationController（AI 自动对抗）
// 与 ReplayModule（复盘）属于迭代/复盘工具链，已从运行时模块图中摘除，文件保留。
@Module({
  imports: [AiModule, AuthModule, DataModule],
  controllers: [GameController],
  providers: [GameGateway, GameService, GameRoomRepository],
})
export class GameModule {}
