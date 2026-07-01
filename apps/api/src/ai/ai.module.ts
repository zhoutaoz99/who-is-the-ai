import { Global, Module } from "@nestjs/common";
import { AiService } from "./ai.service";
import { LlmStatsController } from "./llm-stats.controller";
import { LlmStatsService } from "./llm-stats.service";

// v4.0 单层对局只需要 AiService。旧迭代/评测工具链(iteration/、eval/、
// EvalPromptRegistry、PromptRegistry、prompt/eval-prompt 版本控制器)已全部删除。
@Global()
@Module({
  controllers: [LlmStatsController],
  providers: [AiService, LlmStatsService],
  exports: [AiService, LlmStatsService],
})
export class AiModule {}
