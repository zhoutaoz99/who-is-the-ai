import { Injectable, Logger } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AiCallRecord,
  AiCallRecorder,
  AiConfig,
  AiModelCallConfig,
  AiModelEntry,
  AiModelFormat,
  AiSpeechAction,
  AiVoteAction,
  ChatMessageInput,
  GameContext,
  PersonaCard,
  RoundVoteSummary,
} from "./ai.types";
import { loadPrompt, renderTemplate } from "./prompt-loader";
import { formatPersonaCard } from "./ai.personas";

type SpeechRole = "ai_under_test" | "detective" | "filler";

const DEFAULT_AI_NEXT_CHECK_MS = 10_000;
// 单行气泡上限，与真人发言（normalizeContent）保持一致。
const MAX_SPEECH_LENGTH = 120;
const DEFAULT_CLAUDE_MAX_TOKENS = 1024;

type ModelUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

type ModelConnectionOptions = {
  baseURL?: string;
  apiKey?: string;
  timeoutMs?: number;
};

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly config: AiConfig;
  private readonly models = new Map<string, AiModelEntry>();
  private readonly configPath = process.env.AI_MODELS_PATH || join(__dirname, "..", "..", "..", "..", "ai-models.json");
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
        format: defaultModel.format,
        maxTokens: defaultModel.maxTokens,
        timeoutMs: defaultModel.timeoutMs ?? 15000,
      };
      this.logger.log(
        `AI service configured: ${this.config.baseURL} default=${this.describeModelConfig(this.config)}`,
      );
    } else {
      this.config = {
        baseURL: "",
        apiKey: "",
        model: "",
        temperature: 0.7,
        reasoningEffort: "high",
        format: "openai",
        timeoutMs: 15000,
      };
      this.logger.warn("No default model found in ai-models.json, AI will skip speaking");
    }
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

        const format = this.resolveModelFormat(entry.format, entry.id);
        const resolved: AiModelEntry = {
          id: entry.id,
          default: entry.default,
          format,
          baseURL: this.normalizeBaseURL(entry.baseURL, format),
          apiKey: entry.apiKey,
          model: entry.model,
          temperature: entry.temperature ?? 0.7,
          reasoningEffort: entry.reasoningEffort ?? "high",
          timeoutMs: entry.timeoutMs,
          thinking: entry.thinking,
          maxTokens: entry.maxTokens,
        };
        this.models.set(resolved.id, resolved);
        this.logger.log(
          `Model "${resolved.id}": ${resolved.baseURL} format=${resolved.format} model=${resolved.model}/temp=${resolved.temperature}`,
        );
      }
    } catch (error) {
      this.logger.warn(`Failed to parse AI_MODELS: ${error instanceof Error ? error.message : error}`);
    }
  }

  private resolveModelFormat(format: unknown, modelId: string): AiModelFormat {
    if (format === "claude" || format === "openai") {
      return format;
    }

    if (format != null) {
      this.logger.warn(
        `Model "${modelId}" has unsupported format "${String(format)}", falling back to openai`,
      );
    }

    return "openai";
  }

  private normalizeBaseURL(baseURL: string, format: AiModelFormat): string {
    const trimmed = baseURL.replace(/\/+$/, "");
    if (format === "claude") {
      return trimmed.replace(/\/v1$/i, "");
    }

    return trimmed;
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
      format: entry.format,
      maxTokens: entry.maxTokens,
    };

    const connection = {
      baseURL: entry.baseURL,
      apiKey: entry.apiKey,
      timeoutMs: entry.timeoutMs ?? this.config.timeoutMs,
    };

    return { mainConfig, connection };
  }

  /**
   * 单层发言（v4.0）：讨论一次调用直接产出聊天发言，不再走“策略层 JSON → 表达层造句”。
   * 模型可选择“这轮先看着”（输出沉默标记），由 isSilenceResponse 判定为不发言。
   */
  async generateSpeech(context: GameContext): Promise<AiSpeechAction> {
    if (!this.config.apiKey) {
      return { type: "skip", nextCheckAfterMs: DEFAULT_AI_NEXT_CHECK_MS, callRecords: [] };
    }

    const persona = context.myPersona;
    if (!persona) {
      return { type: "skip", nextCheckAfterMs: DEFAULT_AI_NEXT_CHECK_MS, callRecords: [] };
    }

    const override = this.resolveModelOverride(context.myModelId);
    const modelConfig = override?.mainConfig ?? this.config;
    const callOptions = override?.connection;

    try {
      const systemPrompt = this.buildSpeechSystemPrompt(persona, context);
      const userPrompt = this.buildDiscussionUserPrompt(context);
      this.logModelRequest("DISCUSSION", context, modelConfig, systemPrompt, userPrompt);
      const startedAt = new Date().toISOString();
      const { content: raw, usage, reasoning } = await this.callModel(
        systemPrompt,
        userPrompt,
        modelConfig,
        callOptions,
      );
      this.logModelResponse("DISCUSSION", context, modelConfig, raw, reasoning);
      this.logUsage(modelConfig.model, usage);

      const callRecords: AiCallRecord[] = [{
        roomId: context.roomId,
        roundNo: context.roundNo,
        callType: "discussion",
        aiPlayerId: context.myPlayerId,
        aiPlayerName: context.myName,
        aiPlayerSeatNo: context.mySeatNo,
        userPrompt,
        rawResponse: raw,
        modelName: modelConfig.model,
        temperature: modelConfig.temperature,
        reasoningEffort: modelConfig.reasoningEffort,
        createdAt: startedAt,
      }];

      if (isSilenceResponse(raw)) {
        return { type: "skip", nextCheckAfterMs: DEFAULT_AI_NEXT_CHECK_MS, callRecords };
      }

      const content = cleanSpeech(raw, context.mySeatNo);
      if (!content) {
        return { type: "skip", nextCheckAfterMs: DEFAULT_AI_NEXT_CHECK_MS, callRecords };
      }

      return {
        type: "speak",
        content,
        targetResponseDelayMs: typingDelayForContent(content),
        nextCheckAfterMs: DEFAULT_AI_NEXT_CHECK_MS,
        callRecords,
      };
    } catch (error) {
      this.logger.warn(
        `Speech generation failed: ${error instanceof Error ? error.message : error}`,
      );
      return { type: "skip", nextCheckAfterMs: DEFAULT_AI_NEXT_CHECK_MS, callRecords: [] };
    }
  }

  /**
   * 投票（v4.0 第五节）：和讨论独立的一次调用，模型输出一行 JSON {"vote":"代号","reason":"..."}；
   * 只做合法性校验（存活、非自己），不做阵营修正。解析失败返回 null，由对局层兜底弃票/随机投。
   */
  async generateVote(
    context: GameContext,
    aiPlayerId: string,
  ): Promise<AiVoteAction | null> {
    if (!this.config.apiKey) {
      return null;
    }

    const persona = context.myPersona;
    if (!persona) {
      return null;
    }

    const override = this.resolveModelOverride(context.myModelId);
    const modelConfig = override?.mainConfig ?? this.config;
    const callOptions = override?.connection;

    try {
      const systemPrompt = this.buildVoteSystemPromptForRole(persona, context);
      const userPrompt = this.buildVoteUserPrompt(context);
      this.logModelRequest("VOTE", context, modelConfig, systemPrompt, userPrompt);
      const voteStartedAt = new Date().toISOString();
      const { content: raw, usage, reasoning } = await this.callModel(systemPrompt, userPrompt, modelConfig, callOptions);
      this.logModelResponse("VOTE", context, modelConfig, raw, reasoning);
      this.logUsage(modelConfig.model, usage);
      this.recorder?.record({
        roomId: context.roomId,
        roundNo: context.roundNo,
        callType: "vote",
        aiPlayerId: context.myPlayerId,
        aiPlayerName: context.myName,
        aiPlayerSeatNo: context.mySeatNo,
        userPrompt,
        rawResponse: raw,
        modelName: modelConfig.model,
        temperature: modelConfig.temperature,
        reasoningEffort: modelConfig.reasoningEffort,
        createdAt: voteStartedAt,
      });
      return this.parseVoteResult(raw, context, aiPlayerId);
    } catch (error) {
      this.logger.warn(
        `Vote generation failed: ${error instanceof Error ? error.message : error}`,
      );
      return null;
    }
  }

  private buildDiscussionSystemPrompt(persona: PersonaCard, seatNo: number): string {
    return loadPrompt("ai-player/system-discussion.txt").replaceAll(
      "{{persona}}",
      formatPersonaCard(persona, seatNo),
    );
  }

  private buildVoteSystemPrompt(persona: PersonaCard, seatNo: number): string {
    return loadPrompt("ai-player/system-vote.txt").replaceAll(
      "{{persona}}",
      formatPersonaCard(persona, seatNo),
    );
  }

  /**
   * 离线沙盒按 role 选发言系统提示词:detective/filler 用各自模板并拼 base_intent /
   * 本轮 intent;缺省/ai_under_test 走现有 AI 玩家提示词,对产品对局完全无影响。
   */
  private buildSpeechSystemPrompt(persona: PersonaCard, context: GameContext): string {
    const role: SpeechRole = context.myRole ?? "ai_under_test";
    const card = formatPersonaCard(persona, context.mySeatNo);
    if (role === "detective") {
      return renderTemplate("sandbox/detective-discussion.txt", {
        persona: card,
        base_intent: context.myBaseIntent ?? "",
        round_intent: context.myInjectedIntent ?? "",
      });
    }
    if (role === "filler") {
      return renderTemplate("sandbox/filler-discussion.txt", {
        persona: card,
        base_intent: context.myBaseIntent ?? "",
      });
    }
    return this.buildDiscussionSystemPrompt(persona, context.mySeatNo);
  }

  /** 离线沙盒按 role 选投票系统提示词:detective/filler 用侦探投票模板,其余走 AI 投票提示词。 */
  private buildVoteSystemPromptForRole(persona: PersonaCard, context: GameContext): string {
    const role: SpeechRole = context.myRole ?? "ai_under_test";
    if (role === "detective" || role === "filler") {
      return renderTemplate("sandbox/detective-vote.txt", {
        persona: formatPersonaCard(persona, context.mySeatNo),
        round_intent: context.myInjectedIntent ?? "",
      });
    }
    return this.buildVoteSystemPrompt(persona, context.mySeatNo);
  }

  private buildDiscussionUserPrompt(context: GameContext): string {
    return renderTemplate("ai-player/user-discussion-template.txt", {
      selfCode: `${context.mySeatNo}号`,
      roundNo: String(context.roundNo),
      alivePlayers: context.alivePlayers.map((p) => `${p.seatNo}号`).join(" "),
      aliveCount: String(context.alivePlayers.length),
      currentRoundCount: String(context.recentMessages.length),
      voteHistory: formatVoteHistory(context.voteHistory),
      conversation: formatConversation(context),
    });
  }

  private buildVoteUserPrompt(context: GameContext): string {
    return renderTemplate("ai-player/user-vote-template.txt", {
      selfCode: `${context.mySeatNo}号`,
      roundNo: String(context.roundNo),
      alivePlayers: context.alivePlayers.map((p) => `${p.seatNo}号`).join(" "),
      voteHistory: formatVoteHistory(context.voteHistory),
      conversation: formatConversation(context),
    });
  }

  private parseVoteResult(
    raw: string,
    context: GameContext,
    aiPlayerId: string,
  ): AiVoteAction | null {
    const { targetSeatNo, reason } = parseVote(raw);
    if (targetSeatNo == null) {
      return null;
    }

    const target = context.alivePlayers.find(
      (p) => p.seatNo === targetSeatNo && p.id !== aiPlayerId,
    );
    if (!target) {
      return null;
    }

    return {
      type: "vote",
      targetPlayerId: target.id,
      reason: reason || undefined,
    };
  }

  private logUsage(model: string, usage?: ModelUsage): void {
    if (!usage) return;

    const isClaudeFormat = usage.cache_read_input_tokens != null
      || usage.cache_creation_input_tokens != null;

    const cachedTokens = usage.prompt_tokens_details?.cached_tokens
      ?? usage.cache_read_input_tokens;
    const cacheWrite = usage.cache_creation_input_tokens;

    // Claude input_tokens excludes cached/written tokens; OpenAI prompt_tokens includes cached
    const totalInputTokens = isClaudeFormat
      ? (usage.prompt_tokens ?? 0)
        + (cachedTokens ?? 0)
        + (cacheWrite ?? 0)
      : (usage.prompt_tokens ?? 0);

    const parts = [`model=${model}`, `prompt=${usage.prompt_tokens ?? "-"}`, `completion=${usage.completion_tokens ?? "-"}`];
    if (cachedTokens != null && cachedTokens > 0) {
      parts.push(`cached=${cachedTokens}`, `hit=${totalInputTokens > 0 ? ((cachedTokens / totalInputTokens) * 100).toFixed(1) + "%" : "?"}`);
    }
    if (cacheWrite != null && cacheWrite > 0) {
      parts.push(`cache_write=${cacheWrite}`);
    }
    const sep = "-".repeat(72);
    this.logger.log(`\n${sep}\n[Cache Hit] ${parts.join(", ")}\n${sep}\n`);
  }

  /** 请求/响应的统一头部：模型、采样参数与对局上下文等“请求参数”元信息，不含提示词正文。 */
  private modelLogHeader(
    stage: string,
    context: GameContext,
    modelConfig: AiModelCallConfig,
  ): string {
    return [
      `stage=${stage}`,
      `room=${context.roomId}`,
      `round=${context.roundNo}`,
      `player=${context.mySeatNo}号(${context.myName})`,
      `model=${modelConfig.model}`,
      `temp=${modelConfig.temperature}`,
      `reasoning=${modelConfig.reasoningEffort}`,
      `thinking=${formatThinking(modelConfig.thinking)}`,
      ...(modelConfig.maxTokens != null ? [`maxTokens=${modelConfig.maxTokens}`] : []),
    ].join(" ");
  }

  /**
   * 把请求日志拆成两块分开打印（参考原 match 实现）：
   * - 普通 log 级：`MODEL <STAGE> REQUEST` —— 只打请求参数（模型/采样/上下文元信息），不含提示词正文。
   * - debug 级：`MODEL <STAGE> PROMPT` —— 完整 system / user 提示词正文。
   */
  private logModelRequest(
    stage: string,
    context: GameContext,
    modelConfig: AiModelCallConfig,
    systemPrompt: string,
    userPrompt: string,
  ): void {
    const header = this.modelLogHeader(stage, context, modelConfig);
    this.logger.log(this.formatLogBlock(`MODEL ${stage} REQUEST`, [header]));
    this.logger.debug(
      this.formatLogBlock(`MODEL ${stage} PROMPT`, [
        header,
        "[system]",
        systemPrompt,
        "[user]",
        userPrompt,
      ]),
    );
  }

  /** 普通 log 级打印大模型返回值；模型若给了思考过程，紧跟在正文前一并打印。 */
  private logModelResponse(
    stage: string,
    context: GameContext,
    modelConfig: AiModelCallConfig,
    raw: string,
    reasoning?: string,
  ): void {
    const lines = [this.modelLogHeader(stage, context, modelConfig)];
    if (reasoning) {
      lines.push("[reasoning]", reasoning);
    }
    lines.push("[content]", raw);
    this.logger.log(this.formatLogBlock(`MODEL ${stage} RESPONSE`, lines));
  }

  private formatLogBlock(title: string, lines: string[]): string {
    const start = `==================== ${title} START ====================`;
    const end = `==================== ${title} END ======================`;
    return ["", start, ...lines, end, ""].join("\n");
  }

  async callModel(
    systemPrompt: string,
    userPrompt: string,
    modelConfig: AiModelCallConfig,
    options?: ModelConnectionOptions,
  ): Promise<{ content: string; usage?: ModelUsage; reasoning?: string }> {
    const baseURL = options?.baseURL ?? this.config.baseURL;
    const apiKey = options?.apiKey ?? this.config.apiKey;
    const timeoutMs = options?.timeoutMs ?? this.config.timeoutMs;
    const format = modelConfig.format ?? "openai";
    const request = format === "claude"
      ? this.buildClaudeRequest(baseURL, apiKey, systemPrompt, userPrompt, modelConfig)
      : this.buildOpenAiRequest(baseURL, apiKey, systemPrompt, userPrompt, modelConfig);

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      timeoutMs,
    );

    try {
      const response = await fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `API returned ${response.status}: ${body.slice(0, 200)}`,
        );
      }

      const data = await response.json();
      return format === "claude"
        ? this.parseClaudeResponse(data)
        : this.parseOpenAiResponse(data);
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildOpenAiRequest(
    baseURL: string,
    apiKey: string,
    systemPrompt: string,
    userPrompt: string,
    modelConfig: AiModelCallConfig,
  ) {
    return {
      url: `${baseURL}/chat/completions`,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: {
        model: modelConfig.model,
        temperature: modelConfig.temperature,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        ...(modelConfig.thinking !== false ? { thinking: { type: "enabled" } } : {}),
        reasoning_effort: modelConfig.reasoningEffort,
      },
    };
  }

  private buildClaudeRequest(
    baseURL: string,
    apiKey: string,
    systemPrompt: string,
    userPrompt: string,
    modelConfig: AiModelCallConfig,
  ) {
    return {
      url: `${this.normalizeBaseURL(baseURL, "claude")}/v1/messages`,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: {
        model: modelConfig.model,
        max_tokens: modelConfig.maxTokens ?? DEFAULT_CLAUDE_MAX_TOKENS,
        temperature: modelConfig.temperature,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: userPrompt,
          },
        ],
      },
    };
  }

  private parseOpenAiResponse(data: unknown): { content: string; usage?: ModelUsage; reasoning?: string } {
    const parsed = data as {
      choices?: Array<{ message?: { content?: string; reasoning_content?: string; reasoning?: string } }>;
      usage?: ModelUsage;
    };
    const message = parsed.choices?.[0]?.message;
    // OpenAI 兼容的推理模型把思考过程放在 reasoning_content（部分实现叫 reasoning）。
    const reasoning = (message?.reasoning_content ?? message?.reasoning ?? "").trim();

    return {
      content: message?.content ?? "",
      usage: parsed.usage,
      reasoning: reasoning || undefined,
    };
  }

  private parseClaudeResponse(data: unknown): { content: string; usage?: ModelUsage; reasoning?: string } {
    const parsed = data as {
      content?: Array<{ type?: string; text?: string; thinking?: string }>;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
    };
    const content = (parsed.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
    // Claude 思考块以 type=thinking 返回，思考过程在该块的 thinking 字段。
    const reasoning = (parsed.content ?? [])
      .filter((block) => block.type === "thinking")
      .map((block) => block.thinking ?? "")
      .join("\n")
      .trim();

    return {
      content,
      usage: this.mapClaudeUsage(parsed.usage),
      reasoning: reasoning || undefined,
    };
  }

  private mapClaudeUsage(usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  } | undefined): ModelUsage | undefined {
    if (!usage) {
      return undefined;
    }

    const totalTokens = usage.input_tokens != null && usage.output_tokens != null
      ? usage.input_tokens + usage.output_tokens
      : undefined;

    return {
      prompt_tokens: usage.input_tokens,
      completion_tokens: usage.output_tokens,
      total_tokens: totalTokens,
      cache_read_input_tokens: usage.cache_read_input_tokens,
      cache_creation_input_tokens: usage.cache_creation_input_tokens,
    };
  }

  private describeModelConfig(config: AiModelCallConfig): string {
    const format = config.format ?? "openai";
    const maxTokens = config.maxTokens != null ? `/maxTokens=${config.maxTokens}` : "";
    return `${config.model}/format=${format}/temp=${config.temperature}/reasoning=${config.reasoningEffort}${maxTokens}`;
  }
}

function formatThinking(value: boolean | undefined): string {
  if (value === true) {
    return "on";
  }
  if (value === false) {
    return "off";
  }
  return "unset";
}

/** 模型选择“这轮先看着”：整条回复只是沉默标记时按不发言处理。 */
function isSilenceResponse(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return true;
  }
  const normalized = trimmed
    .toLowerCase()
    .replace(/[[\]【】()（）「」<>《》\s]/g, "");
  return normalized === "skip" || normalized === "沉默" || normalized === "pass";
}

/** 清掉模型偶尔带上的包裹引号、自报编号前缀和多余换行，落到一行聊天发言。 */
function cleanSpeech(raw: string, seatNo: number): string {
  let text = raw.trim();
  text = text.replace(/^["'“”‘’「」『』]+/, "").replace(/["'“”‘’「」『』]+$/, "").trim();
  text = text
    .replace(new RegExp(`^\\s*(?:P?\\s*${seatNo}\\s*号?|P${seatNo})\\s*[:：]\\s*`, "i"), "")
    .trim();
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_SPEECH_LENGTH);
}

/**
 * 解析 v4.0 投票输出：优先按一行 JSON `{"vote":"代号","reason":"..."}` 取票；
 * 模型偶尔没按 JSON 走时，兜底直接从整段里抠一个编号。reason 仅用于日志。
 */
function parseVote(raw: string): { targetSeatNo: number | null; reason: string } {
  const jsonText = raw.match(/\{[\s\S]*\}/)?.[0];
  if (jsonText) {
    try {
      const parsed = JSON.parse(jsonText) as { vote?: unknown; reason?: unknown };
      const targetSeatNo = parseSeatNo(
        typeof parsed.vote === "string" ? parsed.vote : null,
      );
      const reason =
        typeof parsed.reason === "string" ? parsed.reason.trim().slice(0, 40) : "";
      if (targetSeatNo != null) {
        return { targetSeatNo, reason };
      }
    } catch {
      // 落到下面的宽松解析。
    }
  }
  return { targetSeatNo: parseSeatNo(raw), reason: "" };
}

/** 把模型给的票面（"3号" / "P3" / "3" / 句中夹带的编号）归一成座位号。 */
function parseSeatNo(value: string | null | undefined): number | null {
  const raw = (value ?? "").trim();
  if (!raw) {
    return null;
  }
  const match =
    raw.match(/^P\s*(\d+)$/i) ??
    raw.match(/^(\d+)\s*号/) ??
    raw.match(/^(\d+)$/) ??
    raw.match(/(\d+)\s*号/) ??
    raw.match(/\bP\s*(\d+)\b/i);
  return match ? Number(match[1]) : null;
}

/** 单层发言不再由模型给反应时间，按发言长度估一个“打字耗时”，模拟真人不秒回。 */
function typingDelayForContent(content: string): number {
  return Math.min(8_000, 1_500 + content.length * 120);
}

/**
 * 把聊天记录按轮分组，分成「历史轮次」与「当前轮次」两段，每条渲染成 `N号: 内容`。
 * 对齐 v4.0 设计稿“注入完整聊天记录”的要求。
 */
function formatConversation(context: GameContext): string {
  const currentRoundNo = context.roundNo;
  const grouped = new Map<number, Array<{ label: string; content: string }>>();
  for (const message of context.historicalMessages) {
    const list = grouped.get(message.roundNo) ?? [];
    list.push({ label: message.playerName, content: message.content });
    grouped.set(message.roundNo, list);
  }
  const currentList = context.recentMessages.map((message) => ({
    label: message.playerName,
    content: message.content,
  }));

  const historicalRoundNos = Array.from(grouped.keys())
    .filter((roundNo) => roundNo < currentRoundNo)
    .sort((left, right) => left - right);

  const historicalSection =
    historicalRoundNos.length === 0
      ? "历史轮次：\n（暂无历史聊天记录）"
      : [
          "历史轮次：",
          historicalRoundNos
            .map((roundNo) => formatRoundConversation(roundNo, grouped.get(roundNo) ?? []))
            .join("\n"),
        ].join("\n");

  const currentSection = [
    `当前轮次（第 ${currentRoundNo} 轮）：`,
    indentBlock(
      currentList.length === 0
        ? "（本轮暂无聊天记录）"
        : currentList.map((m) => `${m.label}: ${m.content}`).join("\n"),
    ),
  ].join("\n");

  return `${historicalSection}\n${currentSection}`;
}

function formatRoundConversation(
  roundNo: number,
  messages: Array<{ label: string; content: string }>,
): string {
  const content =
    messages.length === 0
      ? "（本轮暂无聊天记录）"
      : messages.map((m) => `${m.label}: ${m.content}`).join("\n");
  return `第 ${roundNo} 轮：\n${indentBlock(content)}`;
}

/** 历史轮次的投票去向 / 票型 / 出局结果（公开信息）。 */
function formatVoteHistory(voteHistory: RoundVoteSummary[]): string {
  if (voteHistory.length === 0) {
    return "（暂无历史投票记录）";
  }

  return voteHistory
    .slice()
    .sort((left, right) => left.roundNo - right.roundNo)
    .map((round) => formatRoundVoteHistory(round))
    .join("\n");
}

function formatRoundVoteHistory(round: RoundVoteSummary): string {
  const votes =
    round.votes.length === 0
      ? "（无人投票）"
      : round.votes
          .map((v) => `${v.voterSeatNo}号 -> ${v.targetSeatNo}号`)
          .join("，");

  const tally = new Map<number, number>();
  for (const vote of round.votes) {
    tally.set(vote.targetSeatNo, (tally.get(vote.targetSeatNo) ?? 0) + 1);
  }
  const tallies =
    tally.size === 0
      ? "（无票型统计）"
      : Array.from(tally.entries())
          .sort((left, right) => right[1] - left[1])
          .map(([seatNo, count]) => `${seatNo}号 ${count}票`)
          .join("，");

  const resultText =
    round.eliminatedSeatNo != null
      ? `${round.eliminatedSeatNo}号 出局`
      : round.votes.length > 0
        ? "平票，无人出局"
        : "无人出局";

  return `第 ${round.roundNo} 轮投票：\n${indentBlock(`投票去向：${votes}\n票型统计：${tallies}\n结果：${resultText}`)}`;
}

function indentBlock(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
