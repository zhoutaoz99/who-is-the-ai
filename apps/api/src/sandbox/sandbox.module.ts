import { Module } from "@nestjs/common";
import { GameModule } from "../game/game.module";
import { BlindSuspicionScorer } from "./score/blind-suspicion";
import { ScoreService } from "./score/score.service";
import { OrchestratorController } from "./orchestrator/orchestrator.controller";
import { OrchestratorGateway } from "./orchestrator/orchestrator.gateway";
import { OrchestratorService } from "./orchestrator/orchestrator.service";
import { OrchestratorStateStore } from "./orchestrator/state";
import { PairedEvalService } from "./orchestrator/paired-eval";
import { PromptVersionStore } from "./orchestrator/prompt-version";
import { OptimizerService } from "./optimizer/propose";
import { SandboxController } from "./sandbox.controller";
import { SandboxService } from "./sandbox.service";

// 离线沙盒模块:复用产品运行时(GameModule 导出的 GameService)驱动场景化对局。
// 产物链:对局引擎(MatchRecord)→ 裁判(ScoreRecord)→ 评分聚合 → 编排器(代际循环)。
@Module({
  imports: [GameModule],
  controllers: [SandboxController, OrchestratorController],
  providers: [
    SandboxService,
    BlindSuspicionScorer,
    ScoreService,
    PromptVersionStore,
    OrchestratorStateStore,
    PairedEvalService,
    OptimizerService,
    OrchestratorService,
    OrchestratorGateway,
  ],
})
export class SandboxModule {}
