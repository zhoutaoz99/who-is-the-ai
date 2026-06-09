import { Injectable, Logger } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AiCallRecord,
  AiCallRecorder,
  AiConfig,
  AiModelCallConfig,
  AiModelEntry,
  AiSpeechAction,
  AiSpeechStrategy,
  AiSpeechStrategyAction,
  AiVoteAction,
  ChatMessageInput,
  GameContext,
} from "./ai.types";
import { loadPrompt, renderTemplate } from "./prompt-loader";
import {
  getSimulatedHumanIntensity,
  getSimulatedHumanSpeechPromptFilename,
  getSimulatedHumanVotePromptFilename,
  SIMULATED_HUMAN_INTENSITY_ENV,
} from "./sim-human-intensity";

const DEFAULT_AI_NEXT_CHECK_MS = 10_000;
const MAX_MODEL_SPEECH_CONTENT_LENGTH = 240;

type ParsedSpeechContent =
  | { type: "speak"; content: string }
  | { type: "skip" };

type ModelUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly config: AiConfig;
  private readonly models = new Map<string, AiModelEntry>();
  private readonly configPath = process.env.AI_MODELS_PATH || join(__dirname, "..", "..", "..", "..", "ai-models.json");
  private readonly simulatedHumanIntensity = getSimulatedHumanIntensity();
  private recorder?: AiCallRecorder;

  setRecorder(recorder: AiCallRecorder) {
    this.recorder = recorder;
  }

  recordCalls(records: AiCallRecord[]) {
    for (const record of records) {
      this.recorder?.record(record);
    }
  }

  constructor() {
    this.loadModels();

    const defaultModel = this.getDefaultModel();
    if (defaultModel) {
      this.config = {
        baseURL: defaultModel.baseURL,
        apiKey: defaultModel.apiKey,
        model: defaultModel.model,
        temperature: defaultModel.temperature,
        reasoningEffort: defaultModel.reasoningEffort,
        thinking: defaultModel.thinking,
        timeoutMs: defaultModel.timeoutMs ?? 15000,
        speechStrategy: {
          model: defaultModel.model,
          temperature: defaultModel.temperature,
          reasoningEffort: defaultModel.reasoningEffort,
          thinking: defaultModel.thinking,
        },
        speechExpression: {
          model: defaultModel.expression?.model ?? defaultModel.model,
          temperature: defaultModel.expression?.temperature ?? defaultModel.temperature,
          reasoningEffort: defaultModel.expression?.reasoningEffort ?? defaultModel.reasoningEffort,
          thinking: defaultModel.expression?.thinking ?? defaultModel.thinking,
        },
      };
      this.logger.log(
        [
          `AI service configured: ${this.config.baseURL}`,
          `default=${this.describeModelConfig(this.config)}`,
          `strategy=${this.describeModelConfig(this.config.speechStrategy)}`,
          `expression=${this.describeModelConfig(this.config.speechExpression)}`,
        ].join(" "),
      );
    } else {
      this.config = {
        baseURL: "",
        apiKey: "",
        model: "",
        temperature: 0.7,
        reasoningEffort: "high",
        timeoutMs: 15000,
        speechStrategy: { model: "", temperature: 0.7, reasoningEffort: "high" },
        speechExpression: { model: "", temperature: 0.7, reasoningEffort: "high" },
      };
      this.logger.warn("No default model found in ai-models.json, AI will skip speaking");
    }

    this.logger.log(
      `Simulated human intensity: ${this.simulatedHumanIntensity} ` +
        `(${SIMULATED_HUMAN_INTENSITY_ENV})`,
    );
  }

  private loadModels() {
    let raw: string | undefined;
    try {
      raw = readFileSync(this.configPath, "utf-8").trim();
    } catch {
      this.logger.warn(`ai-models.json not found at ${this.configPath}`);
      return;
    }

    try {
      const entries: AiModelEntry[] = JSON.parse(raw);
      if (!Array.isArray(entries)) {
        this.logger.warn("AI_MODELS must be a JSON array");
        return;
      }

      for (const entry of entries) {
        if (!entry.id || !entry.baseURL || !entry.apiKey || !entry.model) {
          this.logger.warn(`Skipping invalid AI_MODELS entry: ${JSON.stringify(entry).slice(0, 200)}`);
          continue;
        }

        const resolved: AiModelEntry = {
          id: entry.id,
          default: entry.default,
          baseURL: entry.baseURL.replace(/\/+$/, ""),
          apiKey: entry.apiKey,
          model: entry.model,
          temperature: entry.temperature ?? 0.7,
          reasoningEffort: entry.reasoningEffort ?? "high",
          timeoutMs: entry.timeoutMs,
          thinking: entry.thinking,
          expression: entry.expression,
        };
        this.models.set(resolved.id, resolved);
        this.logger.log(
          `Model "${resolved.id}": ${resolved.baseURL} model=${resolved.model}/temp=${resolved.temperature}`,
        );
      }
    } catch (error) {
      this.logger.warn(`Failed to parse AI_MODELS: ${error instanceof Error ? error.message : error}`);
    }
  }

  getAvailableModels(): Array<{ id: string; default?: boolean }> {
    return Array.from(this.models.values()).map((m) => ({ id: m.id, default: m.default }));
  }

  getDefaultModelId(): string | undefined {
    const entry = this.getDefaultModel();
    return entry?.id;
  }

  private getDefaultModel(): AiModelEntry | undefined {
    return Array.from(this.models.values()).find((m) => m.default === true);
  }

  private resolveModelOverride(modelId?: string) {
    if (!modelId || !this.models.has(modelId)) {
      return null;
    }

    const entry = this.models.get(modelId)!;

    const mainConfig: AiModelCallConfig = {
      model: entry.model,
      temperature: entry.temperature,
      reasoningEffort: entry.reasoningEffort,
      thinking: entry.thinking,
    };

    const expressionConfig: AiModelCallConfig = {
      model: entry.expression?.model ?? entry.model,
      temperature: entry.expression?.temperature ?? entry.temperature,
      reasoningEffort: entry.expression?.reasoningEffort ?? entry.reasoningEffort,
      thinking: entry.expression?.thinking ?? entry.thinking,
    };

    const connection = {
      baseURL: entry.baseURL,
      apiKey: entry.apiKey,
      timeoutMs: entry.timeoutMs ?? this.config.timeoutMs,
    };

    return { mainConfig, expressionConfig, connection };
  }

  async generateSpeech(context: GameContext): Promise<AiSpeechAction> {
    if (!this.config.apiKey) {
      return { type: "skip", nextCheckAfterMs: DEFAULT_AI_NEXT_CHECK_MS, callRecords: [] };
    }

    if (this.isSimulatedHumanContext(context)) {
      return this.generateSimulatedHumanSpeech(context);
    }

    const override = this.resolveModelOverride(context.myModelId);
    const strategyConfig = override?.mainConfig ?? this.config.speechStrategy;
    const expressionConfig = override?.expressionConfig ?? this.config.speechExpression;
    const callOptions = override?.connection;

    try {
      const callRecords: AiCallRecord[] = [];
      const strategySystemPrompt = loadPrompt("ai-player/system-speech-strategy.txt");
      const strategyUserPrompt = this.buildSpeechStrategyPrompt(context);
      this.logger.log(
        this.formatAiLog(
          context.myName,
          "Speech Strategy Prompt",
          strategyUserPrompt,
          context.roundNo,
          context.mySeatNo,
          undefined,
        ),
      );
      const strategyStartedAt = new Date().toISOString();
      const { content: strategyResult, usage: strategyUsage } = await this.callModel(
        strategySystemPrompt,
        strategyUserPrompt,
        strategyConfig,
        callOptions,
      );
      this.logger.log(
        this.formatAiLog(
          context.myName,
          "Raw Speech Strategy Response",
          strategyResult.slice(0, 500),
          context.roundNo,
          context.mySeatNo,
          undefined,
        ),
      );
      this.logUsage(strategyConfig.model, strategyUsage);
      callRecords.push({
        roomId: context.roomId,
        roundNo: context.roundNo,
        callType: "speech-strategy",
        aiPlayerId: context.myPlayerId,
        aiPlayerName: context.myName,
        aiPlayerSeatNo: context.mySeatNo,
        userPrompt: strategyUserPrompt,
        rawResponse: strategyResult,
        modelName: strategyConfig.model,
        temperature: strategyConfig.temperature,
        reasoningEffort: strategyConfig.reasoningEffort,
        createdAt: strategyStartedAt,
      });

      const strategyAction = this.parseSpeechStrategyResult(strategyResult);
      if (strategyAction.type === "skip") {
        return {
          type: "skip",
          nextCheckAfterMs: strategyAction.nextCheckAfterMs,
          callRecords,
        };
      }

      const expressionSystemPrompt = loadPrompt("ai-player/system-speech-expression.txt");
      const expressionUserPrompt = this.buildSpeechExpressionPrompt(
        context,
        strategyAction.strategy,
      );
      this.logger.log(
        this.formatAiLog(
          context.myName,
          "Speech Expression Prompt",
          expressionUserPrompt,
          context.roundNo,
          context.mySeatNo,
          undefined,
        ),
      );
      const expressionStartedAt = new Date().toISOString();
      const { content: expressionResult, usage: expressionUsage } = await this.callModel(
        expressionSystemPrompt,
        expressionUserPrompt,
        expressionConfig,
        callOptions,
      );
      this.logger.log(
        this.formatAiLog(
          context.myName,
          "Raw Speech Expression Response",
          expressionResult.slice(0, 500),
          context.roundNo,
          context.mySeatNo,
          undefined,
        ),
      );
      this.logUsage(expressionConfig.model, expressionUsage);
      const expressionTemplatePrompt = this.buildSpeechExpressionPrompt(
        context,
        null,
      );
      callRecords.push({
        roomId: context.roomId,
        roundNo: context.roundNo,
        callType: "speech-expression",
        aiPlayerId: context.myPlayerId,
        aiPlayerName: context.myName,
        aiPlayerSeatNo: context.mySeatNo,
        userPrompt: expressionUserPrompt,
        rawResponse: expressionResult,
        modelName: expressionConfig.model,
        temperature: expressionConfig.temperature,
        reasoningEffort: expressionConfig.reasoningEffort,
        templatePrompt: expressionTemplatePrompt,
        createdAt: expressionStartedAt,
      });

      const speechAction = this.parseSpeechResult(expressionResult, context);
      if (speechAction.type === "speak") {
        return {
          ...speechAction,
          targetResponseDelayMs: strategyAction.targetResponseDelayMs,
          nextCheckAfterMs: strategyAction.nextCheckAfterMs,
          callRecords,
        };
      }

      return {
        type: "skip",
        nextCheckAfterMs: strategyAction.nextCheckAfterMs,
        callRecords,
      };
    } catch (error) {
      this.logger.warn(
        `Speech generation failed: ${error instanceof Error ? error.message : error}`,
      );
      return { type: "skip", nextCheckAfterMs: DEFAULT_AI_NEXT_CHECK_MS, callRecords: [] };
    }
  }

  private async generateSimulatedHumanSpeech(
    context: GameContext,
  ): Promise<AiSpeechAction> {
    const override = this.resolveModelOverride(context.myModelId);
    const modelConfig = override?.mainConfig ?? this.config.speechStrategy;
    const callOptions = override?.connection;

    try {
      const systemPrompt = loadPrompt(
        getSimulatedHumanSpeechPromptFilename(this.simulatedHumanIntensity),
      );
      const userPrompt = this.buildSimulatedHumanSpeechPrompt(context);
      this.logger.log(
        this.formatAiLog(
          context.myName,
          "Simulated Human Speech Prompt",
          userPrompt,
          context.roundNo,
          context.mySeatNo,
          true,
        ),
      );
      const startedAt = new Date().toISOString();
      const { content: result, usage } = await this.callModel(
        systemPrompt,
        userPrompt,
        modelConfig,
        callOptions,
      );
      this.logger.log(
        this.formatAiLog(
          context.myName,
          "Raw Simulated Human Speech Response",
          result.slice(0, 500),
          context.roundNo,
          context.mySeatNo,
          true,
        ),
      );
      this.logUsage(modelConfig.model, usage);

      const callRecords: AiCallRecord[] = [{
        roomId: context.roomId,
        roundNo: context.roundNo,
        callType: "sim-human-speech",
        aiPlayerId: context.myPlayerId,
        aiPlayerName: context.myName,
        aiPlayerSeatNo: context.mySeatNo,
        userPrompt,
        rawResponse: result,
        modelName: modelConfig.model,
        temperature: modelConfig.temperature,
        reasoningEffort: modelConfig.reasoningEffort,
        createdAt: startedAt,
      }];

      const action = this.parseSimulatedHumanSpeechResult(result);
      if (action.type === "speak") {
        return {
          ...action,
          callRecords,
        };
      }

      return {
        type: "skip",
        nextCheckAfterMs: action.nextCheckAfterMs,
        callRecords,
      };
    } catch (error) {
      this.logger.warn(
        `Simulated human speech generation failed: ${error instanceof Error ? error.message : error}`,
      );
      return { type: "skip", nextCheckAfterMs: DEFAULT_AI_NEXT_CHECK_MS, callRecords: [] };
    }
  }

  async generateVote(
    context: GameContext,
    aiPlayerId: string,
  ): Promise<AiVoteAction | null> {
    if (!this.config.apiKey) {
      return null;
    }

    const override = this.resolveModelOverride(context.myModelId);
    const modelConfig = override?.mainConfig ?? this.config;
    const callOptions = override?.connection;

    try {
      const isSimulatedHuman = this.isSimulatedHumanContext(context);
      const systemPrompt = loadPrompt(
        isSimulatedHuman
          ? getSimulatedHumanVotePromptFilename(this.simulatedHumanIntensity)
          : "ai-player/system-vote.txt",
      );
      const userPrompt = isSimulatedHuman
        ? this.buildSimulatedHumanVotePrompt(context, aiPlayerId)
        : this.buildVotePrompt(context, aiPlayerId);
      this.logger.log(
        this.formatAiLog(context.myName, "Vote Prompt", userPrompt, context.roundNo, context.mySeatNo, isSimulatedHuman),
      );
      const voteStartedAt = new Date().toISOString();
      const { content: result, usage } = await this.callModel(systemPrompt, userPrompt, modelConfig, callOptions);
      this.logger.log(
        this.formatAiLog(
          context.myName,
          "Raw Vote Response",
          result.slice(0, 300),
          context.roundNo,
          context.mySeatNo,
          isSimulatedHuman,
        ),
      );
      this.logUsage(modelConfig.model, usage);
      this.recorder?.record({
        roomId: context.roomId,
        roundNo: context.roundNo,
        callType: isSimulatedHuman ? "sim-human-vote" : "vote",
        aiPlayerId: context.myPlayerId,
        aiPlayerName: context.myName,
        aiPlayerSeatNo: context.mySeatNo,
        userPrompt,
        rawResponse: result,
        modelName: modelConfig.model,
        temperature: modelConfig.temperature,
        reasoningEffort: modelConfig.reasoningEffort,
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
      "ai-player/user-speech-strategy-template.txt",
      this.buildSpeechVars(context),
    );
  }

  private buildSimulatedHumanSpeechPrompt(context: GameContext): string {
    return renderTemplate(
      "sim-human/user-sim-human-speech-template.txt",
      this.buildSpeechVars(context),
    );
  }

  private logUsage(model: string, usage?: ModelUsage): void {
    if (!usage) return;
    const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens;
    const parts = [`model=${model}`, `prompt=${usage.prompt_tokens ?? "-"}`, `completion=${usage.completion_tokens ?? "-"}`];
    if (cachedTokens != null && cachedTokens > 0) {
      const promptTokens = usage.prompt_tokens ?? 0;
      parts.push(`cached=${cachedTokens}`, `hit=${promptTokens > 0 ? ((cachedTokens / promptTokens) * 100).toFixed(1) + "%" : "?"}`);
    }
    if (usage.cache_creation_input_tokens != null && usage.cache_creation_input_tokens > 0) {
      parts.push(`cache_write=${usage.cache_creation_input_tokens}`);
    }
    const sep = "-".repeat(72);
    this.logger.log(`\n${sep}\n[Cache Hit] ${parts.join(", ")}\n${sep}\n`);
  }

  private formatAiLog(
    playerName: string,
    title: string,
    content: string,
    roundNo?: number,
    seatNo?: number,
    simulated?: boolean,
  ): string {
    const playerTypeTag = simulated ? "模拟真人" : "AI";
    const prefix = roundNo != null && seatNo != null ? `[第${roundNo}轮 #${seatNo} ${playerTypeTag}] ` : "";
    const separator = "=".repeat(72);
    const subSeparator = "-".repeat(72);
    return [
      "",
      separator,
      `${prefix}[${playerName}] ${title}`,
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
    return renderTemplate("ai-player/user-speech-expression-template.txt", {
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
      myPersonaInfo: this.formatPersonaInfo(context),
      recentMessages: "无",
      historicalMessages: "无",
      voteHistory: "无",
      currentVoteInfo: "无",
      shortMemory: this.formatShortMemory(context),
      alivePlayersList: context.alivePlayers
        .map((p) => `${p.seatNo}号位(ID:${p.id})`)
        .join("、"),
    };

    if (context.recentMessages.length > 0) {
      vars.recentMessages = this.formatRecentMessages(context.recentMessages, "  ");
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
      myPersonaInfo: this.formatPersonaInfo(context),
      recentMessages: "无",
      historicalMessages: "无",
      voteHistory: "无",
      currentVoteInfo: "同时盲投，当前票数不可见",
      shortMemory: this.formatShortMemory(context),
      voteTargets: targets
        .map((p) => `${p.seatNo}号位 - ID: ${p.id}`)
        .join("\n"),
    };

    if (context.recentMessages.length > 0) {
      vars.recentMessages = this.formatRecentMessages(context.recentMessages, "  ");
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

    return renderTemplate("ai-player/user-vote-template.txt", vars);
  }

  private buildSimulatedHumanVotePrompt(
    context: GameContext,
    playerId: string,
  ): string {
    const targets = context.alivePlayers.filter((p) => p.id !== playerId);

    const vars: Record<string, string> = {
      mySeatNo: String(context.mySeatNo),
      myName: context.myName,
      roundNo: String(context.roundNo),
      recentMessages: "无",
      historicalMessages: "无",
      voteHistory: "无",
      currentVoteInfo: "同时盲投，当前票数不可见",
      shortMemory: this.formatShortMemory(context),
      voteTargets: targets
        .map((p) => `${p.seatNo}号位 - ID: ${p.id}`)
        .join("\n"),
    };

    if (context.recentMessages.length > 0) {
      vars.recentMessages = this.formatRecentMessages(context.recentMessages, "  ");
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

    return renderTemplate("sim-human/user-sim-human-vote-template.txt", vars);
  }

  private formatShortMemory(context: GameContext): string {
    const memory = context.shortMemory;
    if (!memory || memory.votes.length === 0) {
      return "无";
    }

    return memory.votes
      .map((vote) => {
        const reason = vote.publicReason
          ? `，公开理由：${vote.publicReason}`
          : vote.source === "fallback"
            ? "，当时没有可靠的公开理由记录"
            : "";
        return `- 第${vote.roundNo}轮你投给${vote.targetSeatNo}号${reason}`;
      })
      .join("\n");
  }

  private formatPersonaInfo(context: GameContext): string {
    const persona = context.myPersona;
    if (!persona) {
      return "无固定人格，保持自然、短句、不要模板化。";
    }

    return [
      `人格：${persona.name}`,
      `说话风格：${persona.speechStyle}`,
      `句式偏好：${persona.sentenceStyle}`,
      `回应倾向：${persona.responseBias}`,
      `语气规则：${persona.toneRules.join("；")}`,
      `额外避免：${persona.avoidPhrases.join("、")}`,
    ].join("\n");
  }

  private formatHistoricalMessages(
    messages: Array<ChatMessageInput & { roundNo: number }>,
  ): string {
    const lines: string[] = [];
    let currentRoundNo: number | null = null;

    for (const msg of messages) {
      if (msg.roundNo !== currentRoundNo) {
        currentRoundNo = msg.roundNo;
        lines.push(`  第${msg.roundNo}轮：`);
      }

      lines.push(`    ${msg.playerName}：${msg.content}`);
    }

    return lines.join("\n");
  }

  private formatRecentMessages(
    messages: ChatMessageInput[],
    indent: string,
  ): string {
    return messages
      .map((msg) => {
        return `${indent}${msg.playerName}：${msg.content}`;
      })
      .join("\n");
  }

  async callModel(
    systemPrompt: string,
    userPrompt: string,
    modelConfig: AiModelCallConfig,
    options?: { baseURL?: string; apiKey?: string; timeoutMs?: number },
  ): Promise<{ content: string; usage?: ModelUsage }> {
    const baseURL = options?.baseURL ?? this.config.baseURL;
    const apiKey = options?.apiKey ?? this.config.apiKey;
    const timeoutMs = options?.timeoutMs ?? this.config.timeoutMs;
    const url = `${baseURL}/chat/completions`;

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      timeoutMs,
    );

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: modelConfig.model,
          temperature: modelConfig.temperature,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          ...(modelConfig.thinking !== false ? { thinking: { type: "enabled" } } : {}),
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
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number };
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
      };

      return {
        content: data.choices?.[0]?.message?.content ?? "",
        usage: data.usage,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async streamModel(
    systemPrompt: string,
    userPrompt: string,
    modelConfig: AiModelCallConfig,
    onChunk: (chunk: string) => void,
    options?: {
      baseURL?: string;
      apiKey?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<void> {
    const baseURL = options?.baseURL ?? this.config.baseURL;
    const apiKey = options?.apiKey ?? this.config.apiKey;
    const timeoutMs = options?.timeoutMs ?? this.config.timeoutMs;
    const url = `${baseURL}/chat/completions`;

    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(
      () => {
        timedOut = true;
        controller.abort();
      },
      timeoutMs,
    );
    const abortFromParent = () => controller.abort();
    options?.signal?.addEventListener("abort", abortFromParent);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: modelConfig.model,
          temperature: modelConfig.temperature,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          ...(modelConfig.thinking !== false ? { thinking: { type: "enabled" } } : {}),
          reasoning_effort: modelConfig.reasoningEffort,
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `API returned ${response.status}: ${body.slice(0, 200)}`,
        );
      }

      if (!response.body) {
        throw new Error("API returned empty stream");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const chunk = this.parseStreamLine(line);
          if (chunk === null) {
            continue;
          }

          if (chunk === "[DONE]") {
            return;
          }

          if (chunk.length > 0) {
            onChunk(chunk);
          }
        }
      }

      buffer += decoder.decode();
      const finalChunk = this.parseStreamLine(buffer);
      if (finalChunk && finalChunk !== "[DONE]") {
        onChunk(finalChunk);
      }
    } catch (error) {
      if (timedOut) {
        throw new Error(`模型调用超时（${timeoutMs}ms）`);
      }

      throw error;
    } finally {
      clearTimeout(timeout);
      options?.signal?.removeEventListener("abort", abortFromParent);
    }
  }

  private parseStreamLine(line: string): string | null {
    const trimmed = line.trim();
    if (!trimmed) {
      return null;
    }

    const payload = trimmed.startsWith("data:")
      ? trimmed.slice("data:".length).trim()
      : trimmed;
    if (!payload) {
      return null;
    }

    if (payload === "[DONE]") {
      return "[DONE]";
    }

    try {
      const parsed = JSON.parse(payload) as {
        choices?: Array<{
          delta?: { content?: string };
          message?: { content?: string };
          text?: string;
        }>;
      };
      return parsed.choices?.[0]?.delta?.content ??
        parsed.choices?.[0]?.message?.content ??
        parsed.choices?.[0]?.text ??
        "";
    } catch {
      return null;
    }
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
      const content = this.trimSpeechContent(parsed.content);
      if (content.length > 0) {
        return { type: "speak", content };
      }
    }

    return { type: "skip" };
  }

  private parseSimulatedHumanSpeechResult(raw: string):
    | {
        type: "speak";
        content: string;
        targetResponseDelayMs: number;
        nextCheckAfterMs: number;
      }
    | { type: "skip"; nextCheckAfterMs: number } {
    const parsed = this.extractJson(raw);
    if (!parsed) {
      return { type: "skip", nextCheckAfterMs: DEFAULT_AI_NEXT_CHECK_MS };
    }

    if (parsed.type === "skip") {
      return {
        type: "skip",
        nextCheckAfterMs:
          this.readPositiveInteger(parsed.nextCheckAfterMs) ??
          DEFAULT_AI_NEXT_CHECK_MS,
      };
    }

    if (parsed.type === "speak" && typeof parsed.content === "string") {
      const content = this.trimSpeechContent(parsed.content);
      if (content.length > 0) {
        return {
          type: "speak",
          content,
          targetResponseDelayMs:
            this.readPositiveInteger(parsed.targetResponseDelayMs) ?? 4_000,
          nextCheckAfterMs:
            this.readPositiveInteger(parsed.nextCheckAfterMs) ??
            DEFAULT_AI_NEXT_CHECK_MS,
        };
      }
    }

    return { type: "skip", nextCheckAfterMs: DEFAULT_AI_NEXT_CHECK_MS };
  }

  private trimSpeechContent(content: string): string {
    return content.trim().slice(0, MAX_MODEL_SPEECH_CONTENT_LENGTH);
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

  private isSimulatedHumanContext(context: GameContext): boolean {
    return context.myPlayerType === "human" && context.mySimulated;
  }
}
