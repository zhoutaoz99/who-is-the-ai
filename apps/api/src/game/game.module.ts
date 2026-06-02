import { Module } from "@nestjs/common";
import { GameController } from "./game.controller";
import { GameGateway } from "./game.gateway";
import { GameService } from "./game.service";
import { GameRoomRepository } from "./game-room.repository";
import { AiModule } from "../ai/ai.module";
import { AuthModule } from "../auth/auth.module";
import { DataModule } from "../data/data.module";

@Module({
  imports: [AiModule, AuthModule, DataModule],
  controllers: [GameController],
  providers: [GameGateway, GameService, GameRoomRepository],
})
export class GameModule {}
