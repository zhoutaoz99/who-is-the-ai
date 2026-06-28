import { Body, Controller, Get, Post } from "@nestjs/common";
import { readFileSync } from "fs";
import { join } from "path";
import { AiService } from "../ai/ai.service";
import { DebugCallRequest, DebugCallResponse } from "../ai/ai.types";
import { DEBUG } from "../game/game.config";

@Controller("replay/debug")
export class ReplayDebugController {
  constructor(private readonly aiService: AiService) {}

  /** 返回 v4.0 单层 AI 玩家系统提示词(供调试调用面板预填)。 */
  @Get("prompts")
  getPrompts() {
    const dir = join(__dirname, "..", "ai", "prompts");
    const read = (name: string) =>
      readFileSync(join(dir, "ai-player", name), "utf-8").trim();
    return {
      discussion: read("system-discussion.txt"),
      vote: read("system-vote.txt"),
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
