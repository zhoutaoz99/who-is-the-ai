import { Module } from "@nestjs/common";
import { AppController } from "./app.controller";
import { AuthModule } from "./auth/auth.module";
import { DataModule } from "./data/data.module";
import { GameModule } from "./game/game.module";
import { ReplayModule } from "./replay/replay.module";
import { SandboxModule } from "./sandbox/sandbox.module";

// ReplayModule(复盘)恢复挂载:大厅 /replay/[roomId] 入口依赖其 /replay/* 端点。
// SandboxModule(离线优化沙盒)复用 GameModule 运行时驱动场景化对局。
@Module({
  imports: [DataModule, AuthModule, GameModule, ReplayModule, SandboxModule],
  controllers: [AppController],
})
export class AppModule {}
