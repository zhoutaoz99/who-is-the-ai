import { Module } from "@nestjs/common";
import { GameController } from "./game.controller";
import { GameGateway } from "./game.gateway";
import { GameService } from "./game.service";
import { GameRoomRepository } from "./game-room.repository";
import { IterationService } from "../iteration/iteration.service";
import { IterationController } from "../iteration/iteration.controller";
import { AiModule } from "../ai/ai.module";
import { AuthModule } from "../auth/auth.module";
import { DataModule } from "../data/data.module";
import { ReplayModule } from "../replay/replay.module";

@Module({
  imports: [AiModule, AuthModule, DataModule, ReplayModule],
  controllers: [GameController, IterationController],
  providers: [GameGateway, GameService, GameRoomRepository, IterationService],
})
export class GameModule {}
