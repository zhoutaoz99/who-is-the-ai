import { Global, Module } from "@nestjs/common";
import { AiService } from "./ai.service";
import { EvalPromptRegistry } from "./eval-prompt-registry";
import { EvalPromptVersionController } from "./eval-prompt-version.controller";
import { PromptRegistry } from "./prompt-registry";
import { PromptVersionController } from "./prompt-version.controller";

@Global()
@Module({
  providers: [PromptRegistry, EvalPromptRegistry, AiService],
  controllers: [PromptVersionController, EvalPromptVersionController],
  exports: [PromptRegistry, EvalPromptRegistry, AiService],
})
export class AiModule {}
