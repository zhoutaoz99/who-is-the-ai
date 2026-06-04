import { Injectable, Logger } from "@nestjs/common";
import {
  AiCallRecorder,
  AiConfig,
  AiModelCallConfig,
  AiSpeechAction,
  AiSpeechStrategy,
  AiSpeechStrategyAction,
  AiVoteAction,
  ChatMessageInput,
  GameContext,
} from "./ai.types";
import { loadPrompt, renderTemplate } from "./prompt-loader";

const DEFAULT_AI_NEXT_CHECK_MS = 10_000;

type ParsedSpeechContent =
  | { type: "speak"; content: string }
  | { type: "skip" };

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly config: AiConfig;
  private recorder?: AiCallRecorder;

  setRecorder(recorder: AiCallRecorder) {
    this.recorder = recorder;
  }

  constructor() {
    const defaultModelConfig = this.readModelCallConfig("AI");

    this.config = {
      baseURL: (process.env.AI_BASE_URL ?? "https://api.openai.com/v1").replace(
        /\/+$/,
        "",
      ),
      apiKey: process.env.AI_API_KEY ?? "",
      ...defaultModelConfig,
      timeoutMs: Number(process.env.AI_TIMEOUT_MS) || 15000,
      speechStrategy: this.readModelCallConfig(
        "AI_STRATEGY",
        defaultModelConfig,
      ),
      speechExpression: this.readModelCallConfig(
        "AI_EXPRESSION",
        defaultModelConfig,
      ),
    };

    if (this.config.apiKey) {
      this.logger.log(
        [
          `AI service configured: ${this.config.baseURL}`,
          `default=${this.describeModelConfig(this.config)}`,
          `strategy=${this.describeModelConfig(this.config.speechStrategy)}`,
          `expression=${this.describeModelConfig(this.config.speechExpression)}`,
        ].join(" "),
      );
    } else {
      this.logger.warn(
        "AI_API_KEY not set, AI will skip speaking",
      );
    }
  }

  async generateSpeech(context: GameContext): Promise<AiSpeechAction> {
    if (!this.config.apiKey) {
      return { type: "skip", nextCheckAfterMs: DEFAULT_AI_NEXT_CHECK_MS };
    }

    try {
      const strategySystemPrompt = loadPrompt("system-speech-strategy.txt");
      const strategyUserPrompt = this.buildSpeechStrategyPrompt(context);
      this.logger.log(
        this.formatAiLog(
          context.myName,
          "Speech Strategy Prompt",
          strategyUserPrompt,
        ),
      );
      const strategyStartedAt = new Date().toISOString();
      const strategyResult = await this.callModel(
        strategySystemPrompt,
        strategyUserPrompt,
        this.config.speechStrategy,
      );
      this.logger.log(
        this.formatAiLog(
          context.myName,
          "Raw Speech Strategy Response",
          strategyResult.slice(0, 500),
        ),
      );
      this.recorder?.record({
        roomId: context.roomId,
        roundNo: context.roundNo,
        callType: "speech-strategy",
        aiPlayerId: context.myPlayerId,
        aiPlayerName: context.myName,
        aiPlayerSeatNo: context.mySeatNo,
        userPrompt: strategyUserPrompt,
        rawResponse: strategyResult,
        modelName: this.config.speechStrategy.model,
        temperature: this.config.speechStrategy.temperature,
        reasoningEffort: this.config.speechStrategy.reasoningEffort,
        createdAt: strategyStartedAt,
      });

      const strategyAction = this.parseSpeechStrategyResult(strategyResult);
      if (strategyAction.type === "skip") {
        return {
          type: "skip",
          nextCheckAfterMs: strategyAction.nextCheckAfterMs,
        };
      }

      const expressionSystemPrompt = loadPrompt("system-speech-expression.txt");
      const expressionUserPrompt = this.buildSpeechExpressionPrompt(
        context,
        strategyAction.strategy,
      );
      this.logger.log(
        this.formatAiLog(
          context.myName,
          "Speech Expression Prompt",
          expressionUserPrompt,
        ),
      );
      const expressionStartedAt = new Date().toISOString();
      const expressionResult = await this.callModel(
        expressionSystemPrompt,
        expressionUserPrompt,
        this.config.speechExpression,
      );
      this.logger.log(
        this.formatAiLog(
          context.myName,
          "Raw Speech Expression Response",
          expressionResult.slice(0, 500),
        ),
      );
      const expressionTemplatePrompt = this.buildSpeechExpressionPrompt(
        context,
        null,
      );
      this.recorder?.record({
        roomId: context.roomId,
        roundNo: context.roundNo,
        callType: "speech-expression",
        aiPlayerId: context.myPlayerId,
        aiPlayerName: context.myName,
        aiPlayerSeatNo: context.mySeatNo,
        userPrompt: expressionUserPrompt,
        rawResponse: expressionResult,
        modelName: this.config.speechExpression.model,
        temperature: this.config.speechExpression.temperature,
        reasoningEffort: this.config.speechExpression.reasoningEffort,
        templatePrompt: expressionTemplatePrompt,
        createdAt: expressionStartedAt,
      });

      const speechAction = this.parseSpeechResult(expressionResult, context);
      if (speechAction.type === "speak") {
        return {
          ...speechAction,
          targetResponseDelayMs: strategyAction.targetResponseDelayMs,
          nextCheckAfterMs: strategyAction.nextCheckAfterMs,
        };
      }

      return {
        type: "skip",
        nextCheckAfterMs: strategyAction.nextCheckAfterMs,
      };
    } catch (error) {
      this.logger.warn(
        `Speech generation failed: ${error instanceof Error ? error.message : error}`,
      );
      return { type: "skip", nextCheckAfterMs: DEFAULT_AI_NEXT_CHECK_MS };
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
      const systemPrompt = loadPrompt("system-vote.txt");
      const userPrompt = this.buildVotePrompt(context, aiPlayerId);
      this.logger.log(
        this.formatAiLog(context.myName, "Vote Prompt", userPrompt),
      );
      const voteStartedAt = new Date().toISOString();
      const result = await this.callModel(systemPrompt, userPrompt, this.config);
      this.logger.log(
        this.formatAiLog(
          context.myName,
          "Raw Vote Response",
          result.slice(0, 300),
        ),
      );
      this.recorder?.record({
        roomId: context.roomId,
        roundNo: context.roundNo,
        callType: "vote",
        aiPlayerId: context.myPlayerId,
        aiPlayerName: context.myName,
        aiPlayerSeatNo: context.mySeatNo,
        userPrompt,
        rawResponse: result,
        modelName: this.config.model,
        temperature: this.config.temperature,
        reasoningEffort: this.config.reasoningEffort,
        createdAt: voteStartedAt,
      });
      return this.parseVoteResult(result, context);
    } catch (error) {
      this.logger.warn(
        `Vote generation failed: ${error instanceof Error ? error.message : error}`,
      );
      return null;
    }
  }

  private buildSpeechStrategyPrompt(context: GameContext): string {
    return renderTemplate(
      "user-speech-strategy-template.txt",
      this.buildSpeechVars(context),
    );
  }

  private formatAiLog(
    playerName: string,
    title: string,
    content: string,
  ): string {
    const separator = "=".repeat(72);
    const subSeparator = "-".repeat(72);
    return [
      "",
      separator,
      `[${playerName}] ${title}`,
      subSeparator,
      content,
      separator,
      "",
      "",
    ].join("\n");
  }

  private buildSpeechExpressionPrompt(
    context: GameContext,
    strategy: AiSpeechStrategy | null,
  ): string {
    return renderTemplate("user-speech-expression-template.txt", {
      ...this.buildSpeechVars(context),
      speechStrategy: strategy ? JSON.stringify(strategy, null, 2) : "{{speechStrategy}}",
    });
  }

  private buildSpeechVars(context: GameContext): Record<string, string> {
    const vars: Record<string, string> = {
      mySeatNo: String(context.mySeatNo),
      myName: context.myName,
      roundNo: String(context.roundNo),
      remainingSeconds: String(Math.ceil(context.remainingTimeMs / 1000)),
      myLastSpeech: context.myLastSpeech || "无",
      recentMessages: "无",
      historicalMessages: "无",
      voteHistory: "无",
      currentVoteInfo: "无",
      alivePlayersList: context.alivePlayers
        .map((p) => `${p.seatNo}号位(ID:${p.id})`)
        .join("、"),
    };

    if (context.recentMessages.length > 0) {
      vars.recentMessages = context.recentMessages
        .map((msg) => {
          const prefix = msg.isSelf ? "你" : msg.playerName;
          return `  ${prefix}：${msg.content}`;
        })
        .join("\n");
    }

    if (context.historicalMessages.length > 0) {
      vars.historicalMessages = this.formatHistoricalMessages(
        context.historicalMessages,
      );
    }

    if (context.voteHistory.length > 0) {
      vars.voteHistory = context.voteHistory
        .map((round) => {
          const voteDesc = round.votes
            .map((v) => `${v.voterSeatNo}号→${v.targetSeatNo}号`)
            .join("、");
          const eliminated =
            round.eliminatedSeatNo != null
              ? ` → ${round.eliminatedSeatNo}号被淘汰`
              : ` → 平票，无人淘汰`;
          return `  第${round.roundNo}轮：${voteDesc}${eliminated}`;
        })
        .join("\n");
    }

    if (Object.keys(context.currentVoteCounts).length > 0) {
      vars.currentVoteInfo = Object.entries(context.currentVoteCounts)
        .map(([id, count]) => {
          const player = context.alivePlayers.find((p) => p.id === id);
          return `${player?.seatNo ?? id}号位:${count}票`;
        })
        .join("、");
    }

    return vars;
  }

  private buildVotePrompt(
    context: GameContext,
    aiPlayerId: string,
  ): string {
    const targets = context.alivePlayers.filter((p) => p.id !== aiPlayerId);

    const vars: Record<string, string> = {
      mySeatNo: String(context.mySeatNo),
      myName: context.myName,
      roundNo: String(context.roundNo),
      recentMessages: "无",
      historicalMessages: "无",
      voteHistory: "无",
      currentVoteInfo: "无",
      voteTargets: targets
        .map((p) => `${p.seatNo}号位 - ID: ${p.id}`)
        .join("\n"),
    };

    if (context.recentMessages.length > 0) {
      vars.recentMessages = context.recentMessages
        .map((msg) => {
          const prefix = msg.isSelf ? "你" : msg.playerName;
          return `  ${prefix}：${msg.content}`;
        })
        .join("\n");
    }

    if (context.historicalMessages.length > 0) {
      vars.historicalMessages = this.formatHistoricalMessages(
        context.historicalMessages,
      );
    }

    if (context.voteHistory.length > 0) {
      vars.voteHistory = context.voteHistory
        .map((round) => {
          const voteDesc = round.votes
            .map((v) => `${v.voterSeatNo}号→${v.targetSeatNo}号`)
            .join("、");
          const eliminated =
            round.eliminatedSeatNo != null
              ? ` → ${round.eliminatedSeatNo}号被淘汰`
              : ` → 平票，无人淘汰`;
          return `  第${round.roundNo}轮：${voteDesc}${eliminated}`;
        })
        .join("\n");
    }

    if (Object.keys(context.currentVoteCounts).length > 0) {
      vars.currentVoteInfo = Object.entries(context.currentVoteCounts)
        .map(([id, count]) => {
          const player = context.alivePlayers.find((p) => p.id === id);
          return `${player?.seatNo ?? id}号位:${count}票`;
        })
        .join("、");
    }

    return renderTemplate("user-vote-template.txt", vars);
  }

  private formatHistoricalMessages(
    messages: Array<ChatMessageInput & { roundNo: number }>,
  ): string {
    const grouped = new Map<number, string[]>();
    for (const msg of messages) {
      const prefix = msg.isSelf ? "你" : msg.playerName;
      const lines = grouped.get(msg.roundNo) ?? [];
      lines.push(`    ${prefix}：${msg.content}`);
      grouped.set(msg.roundNo, lines);
    }

    return [...grouped.entries()]
      .map(([roundNo, lines]) => [`  第${roundNo}轮：`, ...lines].join("\n"))
      .join("\n");
  }

  async callModel(
    systemPrompt: string,
    userPrompt: string,
    modelConfig: AiModelCallConfig,
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
          model: modelConfig.model,
          temperature: modelConfig.temperature,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          thinking: { type: "enabled" },
          reasoning_effort: modelConfig.reasoningEffort,
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

  private readModelCallConfig(
    prefix: string,
    fallback?: AiModelCallConfig,
  ): AiModelCallConfig {
    return {
      model:
        this.readStringEnv(`${prefix}_MODEL`) ??
        fallback?.model ??
        "gpt-4o-mini",
      temperature:
        this.readNumberEnv(`${prefix}_TEMPERATURE`) ??
        fallback?.temperature ??
        0.7,
      reasoningEffort:
        this.readStringEnv(`${prefix}_REASONING_EFFORT`) ??
        fallback?.reasoningEffort ??
        "high",
    };
  }

  private readStringEnv(name: string): string | null {
    const value = process.env[name]?.trim();
    return value ? value : null;
  }

  private readNumberEnv(name: string): number | null {
    const rawValue = this.readStringEnv(name);
    if (!rawValue) {
      return null;
    }

    const value = Number(rawValue);
    return Number.isFinite(value) ? value : null;
  }

  private describeModelConfig(config: AiModelCallConfig): string {
    return `${config.model}/temp=${config.temperature}/reasoning=${config.reasoningEffort}`;
  }

  private parseSpeechResult(
    raw: string,
    context: GameContext,
  ): ParsedSpeechContent {
    const parsed = this.extractJson(raw);
    if (!parsed) {
      return { type: "skip" };
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

    return { type: "skip" };
  }

  private parseSpeechStrategyResult(raw: string): AiSpeechStrategyAction {
    const parsed = this.extractJson(raw);
    if (!parsed) {
      this.logger.warn(
        `Speech strategy parse failed: invalid JSON. raw="${raw.slice(0, 500)}"`,
      );
      return { type: "skip", nextCheckAfterMs: DEFAULT_AI_NEXT_CHECK_MS };
    }

    if (parsed.type === "skip") {
      const nextCheckAfterMs = this.readPositiveInteger(
        parsed.nextCheckAfterMs,
      );
      if (!nextCheckAfterMs) {
        this.logger.warn(
          `Speech strategy parse failed: skip missing nextCheckAfterMs. parsed=${JSON.stringify(parsed).slice(0, 500)}`,
        );
      }

      return {
        type: "skip",
        reason: this.readString(parsed.reason) ?? undefined,
        nextCheckAfterMs: nextCheckAfterMs ?? DEFAULT_AI_NEXT_CHECK_MS,
      };
    }

    if (parsed.type !== "speak") {
      this.logger.warn(
        `Speech strategy parse failed: unexpected type="${String(parsed.type)}"`,
      );
      return { type: "skip", nextCheckAfterMs: DEFAULT_AI_NEXT_CHECK_MS };
    }

    if (!this.isRecord(parsed.strategy)) {
      this.logger.warn(
        `Speech strategy parse failed: missing strategy object. parsed=${JSON.stringify(parsed).slice(0, 500)}`,
      );
      return { type: "skip", nextCheckAfterMs: DEFAULT_AI_NEXT_CHECK_MS };
    }

    const targetResponseDelayMs = this.readPositiveInteger(
      parsed.targetResponseDelayMs,
    );
    const nextCheckAfterMs = this.readPositiveInteger(
      parsed.nextCheckAfterMs,
    );
    const replyTo = this.readString(parsed.strategy.replyTo);
    const speechAct = this.readString(parsed.strategy.speechAct);
    const publicPoint = this.readString(parsed.strategy.publicPoint);
    const tone = this.readString(parsed.strategy.tone);
    const maxSentences = this.readPositiveInteger(
      parsed.strategy.maxSentences,
    );
    const constraints = this.readRequiredStringArray(parsed.strategy.constraints);
    const avoidPhrases = this.readRequiredStringArray(
      parsed.strategy.avoidPhrases,
    );
    if (
      replyTo &&
      speechAct &&
      publicPoint &&
      tone &&
      maxSentences &&
      targetResponseDelayMs &&
      nextCheckAfterMs &&
      constraints &&
      avoidPhrases
    ) {
      return {
        type: "speak",
        strategy: {
          replyTo,
          speechAct,
          publicPoint,
          tone,
          maxSentences,
          constraints,
          avoidPhrases,
        },
        targetResponseDelayMs,
        nextCheckAfterMs,
      };
    }

    this.logger.warn(
      `Speech strategy parse failed: invalid strategy fields. parsed=${JSON.stringify(parsed).slice(0, 500)}`,
    );
    return { type: "skip", nextCheckAfterMs: DEFAULT_AI_NEXT_CHECK_MS };
  }

  private readPositiveInteger(value: unknown): number | null {
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      return value;
    }

    if (typeof value === "string") {
      const match = value.match(/\d+/);
      if (match) {
        const parsed = Number(match[0]);
        if (Number.isInteger(parsed) && parsed > 0) {
          return parsed;
        }
      }
    }

    return null;
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

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private readString(value: unknown): string | null {
    if (typeof value !== "string") {
      return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private readRequiredStringArray(value: unknown): string[] | null {
    if (!Array.isArray(value)) {
      return null;
    }

    const items = value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    return items.length === value.length ? items : null;
  }
}
