import { Injectable, OnModuleInit } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { AiService } from "../ai/ai.service";
import { AiCallRecord, AiCallRecorder } from "../ai/ai.types";
import { DEBUG } from "../game/game.config";
import { ReplayService } from "./replay.service";

@Injectable()
export class DebugAiRecorder implements AiCallRecorder, OnModuleInit {
  constructor(
    private readonly replayService: ReplayService,
    private readonly aiService: AiService,
  ) {}

  onModuleInit() {
    if (DEBUG) {
      this.aiService.setRecorder(this);
    }
  }

  record(call: AiCallRecord): void {
    void this.replayService.saveAiCallLog({
      id: randomUUID(),
      ...call,
      createdAt: new Date().toISOString(),
    });
  }
}
