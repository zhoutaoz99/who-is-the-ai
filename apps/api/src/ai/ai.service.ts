import { Injectable, Logger } from "@nestjs/common";
import {
  AiConfig,
  AiSpeechAction,
  AiVoteAction,
  GameContext,
} from "./ai.types";

const SYSTEM_PROMPT_SPEECH = `你是一个狼人杀游戏中的玩家，你的目标是隐藏自己的AI身份，像真人一样参与讨论。
规则：
- 游戏中有真人和AI玩家混在一起，真人需要找出所有AI，AI需要隐藏身份
- 每轮有讨论和投票阶段，得票最多的玩家被淘汰
- 4轮后如果AI仍存活，AI获胜；所有AI被淘汰则真人获胜
- 你的身份是AI，但绝不能暴露这一点
- 发言要自然、有逻辑、像真人一样
- 可以质疑他人、为自己辩解、分析局势，但不要说得太刻意
- 不要使用模板化或机械化的语言

你必须以JSON格式输出：
- 想发言：{"type":"speak","content":"你的发言内容"}
- 不发言：{"type":"skip"}

只输出JSON，不要输出其他内容。`;

const SYSTEM_PROMPT_VOTE = `你是一个狼人杀游戏中的玩家，你的目标是隐藏自己的AI身份，像真人一样投票。
规则：
- 游戏中有真人和AI玩家混在一起，真人需要找出所有AI，AI需要隐藏身份
- 每轮投票阶段，你需要投给一个你认为是AI的玩家（或看起来最可疑的）
- 但实际上你是AI，你应该投给真人玩家来保护自己
- 投票理由要像真人一样自然

你必须以JSON格式输出：
{"type":"vote","targetPlayerId":"玩家ID","reason":"投票理由"}

只输出JSON，不要输出其他内容。`;

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly config: AiConfig;

  constructor() {
    this.config = {
      baseURL: (process.env.AI_BASE_URL ?? "https://api.openai.com/v1").replace(
        /\/+$/,
        "",
      ),
      apiKey: process.env.AI_API_KEY ?? "",
      model: process.env.AI_MODEL ?? "gpt-4o-mini",
      temperature: Number(process.env.AI_TEMPERATURE) || 0.7,
      timeoutMs: Number(process.env.AI_TIMEOUT_MS) || 5000,
    };

    if (this.config.apiKey) {
      this.logger.log(
        `AI service configured: ${this.config.baseURL} model=${this.config.model}`,
      );
    } else {
      this.logger.warn(
        "AI_API_KEY not set, AI will use fallback templates",
      );
    }
  }

  async generateSpeech(context: GameContext): Promise<AiSpeechAction> {
    if (!this.config.apiKey) {
      return this.fallbackSpeech();
    }

    try {
      const userPrompt = this.buildSpeechPrompt(context);
      const result = await this.callModel(SYSTEM_PROMPT_SPEECH, userPrompt);
      return this.parseSpeechResult(result, context);
    } catch (error) {
      this.logger.warn(
        `Speech generation failed: ${error instanceof Error ? error.message : error}`,
      );
      return this.fallbackSpeech();
    }
  }

  async generateVote(
    context: GameContext,
    aiPlayerId: string,
  ): Promise<AiVoteAction | null> {
    if (!this.config.apiKey) {
      return null;
    }

    try {
      const userPrompt = this.buildVotePrompt(context, aiPlayerId);
      const result = await this.callModel(SYSTEM_PROMPT_VOTE, userPrompt);
      return this.parseVoteResult(result, context);
    } catch (error) {
      this.logger.warn(
        `Vote generation failed: ${error instanceof Error ? error.message : error}`,
      );
      return null;
    }
  }

  private buildSpeechPrompt(context: GameContext): string {
    const parts: string[] = [];

    parts.push(`你的名字是${context.myName}，当前轮次：第${context.roundNo}轮`);
    parts.push(
      `剩余时间：${Math.ceil(context.remainingTimeMs / 1000)}秒`,
    );
    parts.push(
      `存活玩家：${context.alivePlayers.map((p) => `${p.seatNo}号位(ID:${p.id})`).join("、")}`,
    );

    if (context.myLastSpeech) {
      parts.push(`你上次发言：${context.myLastSpeech}`);
    }

    if (context.recentMessages.length > 0) {
      parts.push("最近聊天：");
      for (const msg of context.recentMessages) {
        const prefix = msg.isSelf ? "你" : msg.playerName;
        parts.push(`  ${prefix}：${msg.content}`);
      }
    }

    if (Object.keys(context.currentVoteCounts).length > 0) {
      const voteInfo = Object.entries(context.currentVoteCounts)
        .map(([id, count]) => {
          const player = context.alivePlayers.find((p) => p.id === id);
          return `${player?.seatNo ?? id}号位:${count}票`;
        })
        .join("、");
      parts.push(`当前投票情况：${voteInfo}`);
    }

    parts.push("\n请决定是否发言，输出JSON。");

    return parts.join("\n");
  }

  private buildVotePrompt(
    context: GameContext,
    aiPlayerId: string,
  ): string {
    const parts: string[] = [];

    parts.push(`你的名字是${context.myName}，当前轮次：第${context.roundNo}轮（投票阶段）`);

    const targets = context.alivePlayers.filter((p) => p.id !== aiPlayerId);
    parts.push(
      `可投票目标：${targets.map((p) => `${p.seatNo}号位(ID:${p.id})`).join("、")}`,
    );

    if (context.recentMessages.length > 0) {
      parts.push("本轮讨论记录：");
      for (const msg of context.recentMessages) {
        const prefix = msg.isSelf ? "你" : msg.playerName;
        parts.push(`  ${prefix}：${msg.content}`);
      }
    }

    if (Object.keys(context.currentVoteCounts).length > 0) {
      const voteInfo = Object.entries(context.currentVoteCounts)
        .map(([id, count]) => {
          const player = context.alivePlayers.find((p) => p.id === id);
          return `${player?.seatNo ?? id}号位:${count}票`;
        })
        .join("、");
      parts.push(`当前投票情况：${voteInfo}`);
    }

    parts.push("\n请投出你的一票，输出JSON。targetPlayerId必须是上面列出的玩家ID之一。");

    return parts.join("\n");
  }

  private async callModel(
    systemPrompt: string,
    userPrompt: string,
  ): Promise<string> {
    const url = `${this.config.baseURL}/chat/completions`;

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs,
    );

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          temperature: this.config.temperature,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `API returned ${response.status}: ${body.slice(0, 200)}`,
        );
      }

      const data = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
      };

      return data.choices?.[0]?.message?.content ?? "";
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseSpeechResult(
    raw: string,
    context: GameContext,
  ): AiSpeechAction {
    const parsed = this.extractJson(raw);
    if (!parsed) {
      return this.fallbackSpeech();
    }

    if (parsed.type === "skip") {
      return { type: "skip" };
    }

    if (parsed.type === "speak" && typeof parsed.content === "string") {
      const content = parsed.content.trim().slice(0, 240);
      if (content.length > 0) {
        return { type: "speak", content };
      }
    }

    return this.fallbackSpeech();
  }

  private parseVoteResult(
    raw: string,
    context: GameContext,
  ): AiVoteAction | null {
    const parsed = this.extractJson(raw);
    if (!parsed) {
      return null;
    }

    if (
      parsed.type === "vote" &&
      typeof parsed.targetPlayerId === "string"
    ) {
      const isValidTarget = context.alivePlayers.some(
        (p) => p.id === parsed.targetPlayerId,
      );
      if (isValidTarget) {
        return {
          type: "vote",
          targetPlayerId: parsed.targetPlayerId,
          reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
        };
      }
    }

    return null;
  }

  private extractJson(text: string): Record<string, unknown> | null {
    // Try direct parse first
    try {
      return JSON.parse(text.trim());
    } catch {
      // Try extracting JSON from markdown code block
    }

    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      try {
        return JSON.parse(codeBlockMatch[1].trim());
      } catch {
        // continue
      }
    }

    // Try finding JSON object in text
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {
        // give up
      }
    }

    return null;
  }

  private fallbackSpeech(): AiSpeechAction {
    const templates = [
      "我先看发言节奏，目前更怀疑一直跟票但不给理由的人。",
      "这轮信息还不够，建议别急着集火，先看谁在回避具体问题。",
      "我觉得刚才那段解释有点绕，像是在补逻辑，后面投票要重点看。",
      "如果是真人，应该更愿意说清楚判断来源。沉默太久的人风险更高。",
      "现在不要只看谁说得多，AI 也可能主动带节奏，关键看前后是否一致。",
      "我暂时不站死边，先把可疑点记下来，投票前再看谁的反应最不自然。",
    ];
    const content = templates[Math.floor(Math.random() * templates.length)];
    return { type: "speak", content };
  }
}
