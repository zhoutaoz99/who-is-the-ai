import { Module } from "@nestjs/common";
import { GameGateway } from "./game.gateway";
import { GameService } from "./game.service";
import { AiModule } from "../ai/ai.module";

@Module({
  imports: [AiModule],
  providers: [GameGateway, GameService],
})
export class GameModule {}
