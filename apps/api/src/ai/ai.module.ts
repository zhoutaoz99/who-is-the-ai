import { Global, Module } from "@nestjs/common";
import { AiService } from "./ai.service";
import { PromptRegistry } from "./prompt-registry";
import { PromptVersionController } from "./prompt-version.controller";

@Global()
@Module({
  providers: [PromptRegistry, AiService],
  controllers: [PromptVersionController],
  exports: [PromptRegistry, AiService],
})
export class AiModule {}
