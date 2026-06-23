import { Module } from "@nestjs/common";
import { AppController } from "./app.controller";
import { AuthModule } from "./auth/auth.module";
import { DataModule } from "./data/data.module";
import { GameModule } from "./game/game.module";

// ReplayModule（复盘工具链）已从运行时模块图中摘除，文件保留待后续按单层方案重做。
@Module({
  imports: [DataModule, AuthModule, GameModule],
  controllers: [AppController],
})
export class AppModule {}
