import { Global, Module } from "@nestjs/common";
import { AiService } from "./ai.service";

// v4.0 单层对局只需要 AiService。提示词版本控制 / Eval 注册表（PromptRegistry、
// EvalPromptRegistry 及其控制器）属于复盘/迭代工具链，已从运行时模块图中摘除，
// 文件保留待后续按单层方案重做，详见各文件。
@Global()
@Module({
  providers: [AiService],
  exports: [AiService],
})
export class AiModule {}
