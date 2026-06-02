import { Module } from "@nestjs/common";
import { AppController } from "./app.controller";
import { AuthModule } from "./auth/auth.module";
import { DataModule } from "./data/data.module";
import { GameModule } from "./game/game.module";
import { ReplayModule } from "./replay/replay.module";

@Module({
  imports: [DataModule, AuthModule, GameModule, ReplayModule],
  controllers: [AppController],
})
export class AppModule {}
