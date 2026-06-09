import { Body, Controller, Get, Post } from "@nestjs/common";
import { readFileSync } from "fs";
import { join } from "path";
import { AiService } from "../ai/ai.service";
import {
  getSimulatedHumanSpeechPromptFilename,
  getSimulatedHumanVotePromptFilename,
} from "../ai/sim-human-intensity";
import { DebugCallRequest, DebugCallResponse } from "../ai/ai.types";
import { DEBUG } from "../game/game.config";

@Controller("replay/debug")
export class ReplayDebugController {
  constructor(private readonly aiService: AiService) {}

  @Get("prompts")
  getPrompts() {
    const dir = join(__dirname, "..", "ai", "prompts");
    return {
      "speech-strategy": readFileSync(join(dir, "ai-player", "system-speech-strategy.txt"), "utf-8").trim(),
      "speech-expression": readFileSync(join(dir, "ai-player", "system-speech-expression.txt"), "utf-8").trim(),
      vote: readFileSync(join(dir, "ai-player", "system-vote.txt"), "utf-8").trim(),
      "sim-human-speech": readFileSync(join(dir, getSimulatedHumanSpeechPromptFilename()), "utf-8").trim(),
      "sim-human-vote": readFileSync(join(dir, getSimulatedHumanVotePromptFilename()), "utf-8").trim(),
    };
  }

  @Post("call")
  async debugCall(@Body() body: DebugCallRequest): Promise<DebugCallResponse> {
    if (!DEBUG) {
      return { ok: false, error: "调试模式未开启" };
    }

    if (!body.systemPrompt || !body.userPrompt) {
      return { ok: false, error: "缺少 systemPrompt 或 userPrompt" };
    }

    try {
      const { content: rawResponse } = await this.aiService.callModel(
        body.systemPrompt,
        body.userPrompt,
        {
          model: body.model ?? "gpt-4o-mini",
          temperature: body.temperature ?? 0.7,
          reasoningEffort: body.reasoningEffort ?? "high",
        },
      );
      return { ok: true, rawResponse };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
