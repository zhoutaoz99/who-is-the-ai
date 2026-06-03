import { Body, Controller, Get, Post } from "@nestjs/common";
import { readFileSync } from "fs";
import { join } from "path";
import { DebugCallRequest, DebugCallResponse } from "../ai/ai.types";
import { DEBUG } from "../game/game.config";

@Controller("replay/debug")
export class ReplayDebugController {
  @Get("prompts")
  getPrompts() {
    const dir = join(__dirname, "..", "ai", "prompts");
    return {
      "speech-strategy": readFileSync(join(dir, "system-speech-strategy.txt"), "utf-8").trim(),
      "speech-expression": readFileSync(join(dir, "system-speech-expression.txt"), "utf-8").trim(),
      vote: readFileSync(join(dir, "system-vote.txt"), "utf-8").trim(),
    };
  }

  private readonly baseURL = (
    process.env.AI_BASE_URL ?? "https://api.openai.com/v1"
  ).replace(/\/+$/, "");
  private readonly apiKey = process.env.AI_API_KEY ?? "";
  private readonly timeoutMs = Number(process.env.AI_TIMEOUT_MS) || 15000;

  @Post("call")
  async debugCall(@Body() body: DebugCallRequest): Promise<DebugCallResponse> {
    if (!DEBUG) {
      return { ok: false, error: "调试模式未开启" };
    }

    if (!body.systemPrompt || !body.userPrompt) {
      return { ok: false, error: "缺少 systemPrompt 或 userPrompt" };
    }

    if (!this.apiKey) {
      return { ok: false, error: "AI_API_KEY 未配置" };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const url = `${this.baseURL}/chat/completions`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: body.model ?? "gpt-4o-mini",
          temperature: body.temperature ?? 0.7,
          messages: [
            { role: "system", content: body.systemPrompt },
            { role: "user", content: body.userPrompt },
          ],
          thinking: { type: "enabled" },
          reasoning_effort: body.reasoningEffort ?? "high",
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return { ok: false, error: `API ${response.status}: ${text.slice(0, 200)}` };
      }

      const data = (await response.json()) as {
        choices: Array<{
          message: {
            content?: string;
            reasoning_content?: string;
          };
        }>;
      };

      const message = data.choices?.[0]?.message;
      return {
        ok: true,
        rawResponse: message?.content ?? "",
        thinkingContent: message?.reasoning_content || undefined,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
