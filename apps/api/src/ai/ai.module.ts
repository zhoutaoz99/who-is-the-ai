import { Global, Module } from "@nestjs/common";
import { AiService } from "./ai.service";

// v4.0 单层对局只需要 AiService。旧迭代/复盘工具链(iteration/、eval/、
// EvalPromptRegistry、prompt/eval-prompt 版本控制器)已删除;PromptRegistry 保留(replay 依赖)。
@Global()
@Module({
  providers: [AiService],
  exports: [AiService],
})
export class AiModule {}
