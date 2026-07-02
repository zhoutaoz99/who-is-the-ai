import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module";
import { DataModule } from "../data/data.module";
import { AiCallLogRecorder } from "./ai-call-log-recorder";
import { ReplayDebugController } from "./replay-debug.controller";
import { ReplayController } from "./replay.controller";
import { ReplayService } from "./replay.service";

@Module({
  imports: [AiModule, DataModule],
  controllers: [ReplayController, ReplayDebugController],
  providers: [ReplayService, AiCallLogRecorder],
  exports: [ReplayService],
})
export class ReplayModule {}
