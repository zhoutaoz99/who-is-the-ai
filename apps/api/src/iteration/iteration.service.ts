import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AiService } from "../ai/ai.service";
import { PromptRegistry } from "../ai/prompt-registry";
import type { AiModelCallConfig, AiPersonaContext } from "../ai/ai.types";
import { DEBUG } from "../game/game.config";
import { GameService } from "../game/game.service";
import type { RoomSnapshot } from "../game/game.types";
import { PostgresService } from "../data/postgres.service";
import { buildReplayExportData } from "../replay/replay-export.builder";
import { ReplayService } from "../replay/replay.service";
import { renderTemplateString } from "../ai/prompt-loader";
import { aggregateScores, type GameScore, type Scorecard } from "./iteration-score";
import type {
  IterationGameResult,
  IterationRound,
  IterationRunStatus,
  IterationStatus,
  StartIterationPayload,
} from "./iteration.types";

const DEFAULT_ROUNDS = 4;
const DEFAULT_GAMES_PER_ROUND = 6;
const DEFAULT_DISCUSSION_SECONDS = 60;
const GAME_CONCURRENCY = 3;
const POLL_INTERVAL_MS = 2500;
const STUCK_AFTER_MS = 90_000;
const SCORE_TIMEOUT_MS = 120_000;

/**
 * 进程内自动对局评估自迭代编排器。
 * - 用 GameService 直接驱动 debug 自动对局(纯服务端定时器,无需 socket 客户端)。
 * - 单进程互斥:同时只允许一个 run。
 * - 通过 EventEmitter 对外发本地事件(status/game/round/done),由网关桥接成 socket 广播。
 * 评估循环自动跑;版本激活由前端人工操作(自动编辑器预留 editor 钩子,本期不接)。
 */
@Injectable()
export class IterationService implements OnModuleInit {
  private readonly logger = new Logger(IterationService.name);
  readonly events = new EventEmitter();

  private activeRunId: string | null = null;
  private stopRequested = false;
  private currentRoundGames: IterationGameResult[] = [];
  private rounds: IterationRound[] = [];

  async onModuleInit(): Promise<void> {
    await this.postgres.ready;
    await this.reconcileStaleRuns();
  }

  constructor(
    private readonly gameService: GameService,
    private readonly replayService: ReplayService,
    private readonly aiService: AiService,
    private readonly prompts: PromptRegistry,
    private readonly postgres: PostgresService,
  ) {}

  async start(payload: StartIterationPayload): Promise<{ ok: boolean; runId?: string; error?: string }> {
    if (!DEBUG) return { ok: false, error: "调试模式未开启" };
    if (this.activeRunId) {
      // 防御:若内存 activeRunId 与 DB 不一致(如进程重启后残留),且对应 run 已终态/不存在,则自动释放。
      const row = await this.postgres.query<{ status: string }>(
        "SELECT status FROM iteration_runs WHERE id = $1",
        [this.activeRunId],
      );
      const status = row.rows[0]?.status;
      if (!status || status === "completed" || status === "stopped" || status === "failed") {
        this.activeRunId = null;
      } else {
        return { ok: false, error: "已有迭代正在进行,请先停止或在页面上继续/停止当前轮" };
      }
    }

    const totalRounds = clampInt(payload.rounds, DEFAULT_ROUNDS, 1, 20);
    const gamesPerRound = clampInt(payload.gamesPerRound, DEFAULT_GAMES_PER_ROUND, 1, 20);
    const discussionSeconds = clampInt(
      payload.discussionSeconds,
      DEFAULT_DISCUSSION_SECONDS,
      10,
      600,
    );

    const id = randomUUID();
    const now = new Date().toISOString();
    this.activeRunId = id;
    this.stopRequested = false;
    this.rounds = [];
    this.currentRoundGames = [];

    await this.persist({
      id,
      status: "running",
      current_round: 1,
      total_rounds: totalRounds,
      games_per_round: gamesPerRound,
      discussion_seconds: discussionSeconds,
      active_generation_id: this.prompts.getActiveGenerationId(),
      rounds: [],
      created_at: now,
      updated_at: now,
    });

    this.emitStatus("running", 1, totalRounds, gamesPerRound, discussionSeconds);

    // 异步推进,不阻塞 ack。
    void this.runRound(id, 1, totalRounds, gamesPerRound, discussionSeconds).catch((err) => {
      this.logger.error(`迭代 run ${id} 异常: ${errMsg(err)}`);
      void this.failRun(id, totalRounds, gamesPerRound, discussionSeconds, errMsg(err));
    });

    return { ok: true, runId: id };
  }

  async continueToNextRound(): Promise<{ ok: boolean; error?: string }> {
    if (!this.activeRunId) return { ok: false, error: "没有进行中的迭代" };
    const run = await this.getActiveRunRow();
    if (!run || run.status !== "awaiting_activation") {
      return { ok: false, error: "当前不在等待激活状态" };
    }
    const nextRound = run.current_round + 1;
    if (nextRound > run.total_rounds) return { ok: false, error: "已达最大轮数" };

    this.stopRequested = false;
    await this.persist({ ...run, status: "running", current_round: nextRound, active_generation_id: this.prompts.getActiveGenerationId(), updated_at: new Date().toISOString() });
    this.emitStatus("running", nextRound, run.total_rounds, run.games_per_round, run.discussion_seconds);

    void this.runRound(this.activeRunId, nextRound, run.total_rounds, run.games_per_round, run.discussion_seconds).catch((err) => {
      this.logger.error(`迭代 run ${this.activeRunId} 异常: ${errMsg(err)}`);
      void this.failRun(this.activeRunId!, run.total_rounds, run.games_per_round, run.discussion_seconds, errMsg(err));
    });
    return { ok: true };
  }

  async stop(): Promise<{ ok: boolean; error?: string }> {
    // 优先用内存 activeRunId;若缺失(如进程重启后),回退到最近一条非终态 run。
    let row = this.activeRunId ? await this.getRow(this.activeRunId) : null;
    if (!row || isTerminal(row.status)) {
      row = await this.mostRecentNonTerminalRow();
    }
    if (!row) return { ok: false, error: "没有进行中的迭代" };

    this.stopRequested = true;
    await this.persist({ ...row, status: "stopped", updated_at: new Date().toISOString() });
    this.emitStatus(
      "stopped",
      row.current_round,
      row.total_rounds,
      row.games_per_round,
      row.discussion_seconds,
    );
    this.activeRunId = null;
    return { ok: true };
  }

  /** 当前/最近 run 的全量快照(供前端首屏与轮询兜底)。 */
  async getStatus(): Promise<{ ok: boolean; run: IterationRunStatus | null }> {
    const row = await this.getActiveRunRow();
    if (!row) return { ok: true, run: null };
    return { ok: true, run: this.rowToStatus(row) };
  }

  /** 冻结打分尺子(打分的 system prompt),供前端展示。 */
  getScorerPrompt(): string {
    return this.loadScorerPrompt();
  }

  /** 打分模型的调用配置(不含 apiKey),供前端拼装完整请求 JSON 展示。 */
  getScoreModelConfig(): {
    url: string;
    model: string;
    temperature: number;
    reasoningEffort: string;
    thinking: boolean;
  } {
    const { modelConfig, options } = this.resolveScoreModel();
    return {
      url: `${options.baseURL}/chat/completions`,
      model: modelConfig.model,
      temperature: modelConfig.temperature,
      reasoningEffort: modelConfig.reasoningEffort,
      thinking: modelConfig.thinking !== false,
    };
  }

  /**
   * 重建某局打分时发往大模型的完整请求(system + user + config),供前端如实展示。
   * user 用与 scoreReplay 相同的 buildScoreUserPrompt(含 user 模板 + AI 人格定义)。
   */
  async getScoreRequest(roomId: string): Promise<{
    ok: boolean;
    request?: { system: string; user: string; config: ReturnType<IterationService["getScoreModelConfig"]> };
    error?: string;
  }> {
    const obs = await this.gameService.observeRoom({ roomId });
    const room = obs?.room;
    if (!room) return { ok: false, error: "房间不存在" };
    const aiCallLogs = await this.replayService.getAiCallLogs(roomId);
    const replay = buildReplayExportData(room, aiCallLogs, {
      includeSkips: true,
      includeUserPrompt: false,
      promptGenerationId: room.promptGenerationId,
    });
    const user = await this.buildScoreUserPrompt(replay);
    return {
      ok: true,
      request: {
        system: this.loadScorerPrompt(),
        user,
        config: this.getScoreModelConfig(),
      },
    };
  }

  // ---------- 单轮编排 ----------

  private async runRound(
    runId: string,
    roundNo: number,
    totalRounds: number,
    gamesPerRound: number,
    discussionSeconds: number,
  ): Promise<void> {
    const generationId = this.prompts.getActiveGenerationId();
    this.currentRoundGames = [];

    // 并发跑 B 局(上限 GAME_CONCURRENCY),逐局完成即 emit。
    const results: IterationGameResult[] = new Array(gamesPerRound);
    let next = 0;
    const workers = Array.from({ length: Math.min(GAME_CONCURRENCY, gamesPerRound) }, async () => {
      while (next < gamesPerRound) {
        const i = next++;
        if (this.stopRequested) break;
        const result = await this.runOneGame(roundNo, discussionSeconds);
        results[i] = result;
        this.currentRoundGames.push(result);
        this.events.emit("game", result);
        this.emitStatus("running", roundNo, totalRounds, gamesPerRound, discussionSeconds);
      }
    });
    await Promise.all(workers);

    if (this.stopRequested) return; // stop() 已持久化状态

    const games = results.filter(Boolean);
    const aggregate = this.buildAggregate(games);

    const round: IterationRound = { round: roundNo, generationId, games, aggregate };
    this.rounds.push(round);

    // 把本轮聚合分写回该代(让谱系带分数)。
    if (generationId && aggregate) {
      await this.prompts.writeScore(generationId, aggregate).catch((err) => {
        this.logger.warn(`writeScore ${generationId} 失败: ${errMsg(err)}`);
      });
    }

    const row = await this.getActiveRunRow();
    if (!row) return;
    const persistedRounds = [...(row.rounds ?? []), round];
    const isLast = roundNo >= totalRounds;
    const status: IterationStatus = isLast ? "completed" : "awaiting_activation";
    await this.persist({
      ...row,
      status,
      rounds: persistedRounds,
      updated_at: new Date().toISOString(),
    });

    this.events.emit("round", round);
    this.emitStatus(status, roundNo, totalRounds, gamesPerRound, discussionSeconds);
    if (isLast) {
      this.events.emit("done", { runId, status });
      this.activeRunId = null;
    }
  }

  private buildAggregate(games: IterationGameResult[]): Scorecard | null {
    // 用每局的完整打分(tells/naturalness/voteThreatTargeting/topIssues 等)聚合。
    const scores: GameScore[] = games
      .filter((g) => g.error === undefined && g.score)
      .map((g) => g.score as GameScore);
    if (!scores.length) return null;
    return aggregateScores(scores);
  }

  // ---------- 单局 ----------

  private async runOneGame(roundNo: number, discussionSeconds: number): Promise<IterationGameResult> {
    const base: IterationGameResult = { round: roundNo, roomId: "", winner: null, generationId: null };
    try {
      const created = await this.gameService.createDebugAutoAiRoom({
        fastMode: true,
        discussionDurationSeconds: discussionSeconds,
      });
      if (!created?.ok || !created.room) throw new Error(`建房失败: ${created?.error ?? "?"}`);
      const roomId = created.room.id;
      const playerId = created.playerId!;
      base.roomId = roomId;
      base.generationId = created.room.promptGenerationId ?? this.prompts.getActiveGenerationId();

      const started = await this.gameService.startGame({ roomId, playerId });
      if (!started?.ok) throw new Error(`开局失败: ${started?.error ?? "?"}`);

      const finished = await this.waitForFinished(roomId);
      base.winner = finished.winner;

      const aiCallLogs = await this.replayService.getAiCallLogs(roomId);
      const replay = buildReplayExportData(finished, aiCallLogs, {
        includeSkips: true,
        includeUserPrompt: false,
        promptGenerationId: base.generationId ?? undefined,
      });

      // scoreReplay 内部用 buildScoreUserPrompt 注入 user 模板 + 该局 AI 人格定义。
      const score = await this.scoreReplay(replay);
      base.humanLikeScore = score.humanLikeScore;
      base.aiWin = score.aiWin;
      base.score = score;
      return base;
    } catch (err) {
      base.error = errMsg(err);
      return base;
    }
  }

  private async waitForFinished(roomId: string): Promise<RoomSnapshot> {
    const deadline = Date.now() + 15 * 60_000;
    let stuckSince = 0;
    while (Date.now() < deadline) {
      if (this.stopRequested) throw new Error("已停止");
      await sleep(POLL_INTERVAL_MS);
      const res = await this.gameService.observeRoom({ roomId });
      const room = res?.room;
      if (!room) continue;
      if (room.status === "finished") return room;
      // 卡死检测:phaseEndsAt 过期超过阈值多半是服务端重启致定时器丢失。
      if (room.status === "playing" && room.phaseEndsAt) {
        const overdueMs = Date.now() - new Date(room.phaseEndsAt).getTime();
        if (overdueMs > STUCK_AFTER_MS) {
          if (stuckSince === 0) stuckSince = Date.now();
          else if (Date.now() - stuckSince > 30_000) {
            throw new Error(`对局卡死(phase=${room.phase})`);
          }
        }
      }
    }
    throw new Error("对局超时");
  }

  private async scoreReplay(replay: Record<string, unknown>): Promise<GameScore & Record<string, unknown>> {
    const systemPrompt = this.loadScorerPrompt();
    const { modelConfig, options } = this.resolveScoreModel();
    const userPrompt = await this.buildScoreUserPrompt(replay);
    const { content } = await this.aiService.callModel(
      systemPrompt,
      userPrompt,
      modelConfig,
      options,
    );
    const parsed = parseJsonObject(content);
    if (!parsed) throw new Error(`打分返回非 JSON: ${content.slice(0, 200)}`);
    return parsed as GameScore & Record<string, unknown>;
  }

  /** 打分 user 消息:复盘 JSON + 本局 AI 人格定义(让模型能判 sampleLineCopy/templatePhrase 等 tell)。 */
  private async buildScoreUserPrompt(replay: Record<string, unknown>): Promise<string> {
    const genId =
      (replay.promptGenerationId as string | undefined) || this.prompts.getActiveGenerationId();
    const personas = await this.getPersonasForGeneration(genId);
    const personaDigest = personas.map((p) => ({
      id: p.id,
      name: p.name,
      sampleLines: p.sampleLines ?? [],
      avoidPhrases: p.avoidPhrases ?? [],
    }));
    return renderTemplateString(this.loadScorerUserTemplate(), {
      replayJson: JSON.stringify(replay),
      personasJson: JSON.stringify(personaDigest, null, 2),
    });
  }

  private readonly personaCache = new Map<string, AiPersonaContext[]>();
  private async getPersonasForGeneration(genId: string): Promise<AiPersonaContext[]> {
    const cached = this.personaCache.get(genId);
    if (cached) return cached;
    const assets = await this.prompts.getGenerationAssets(genId);
    this.personaCache.set(genId, assets.personas);
    return assets.personas;
  }

  // ---------- 打分模型配置 ----------

  private resolveScoreModel(): {
    modelConfig: AiModelCallConfig;
    options: { baseURL: string; apiKey: string; timeoutMs: number };
  } {
    const baseURL = (process.env.REPLAY_ANALYSIS_BASE_URL ?? "").trim().replace(/\/+$/, "");
    const apiKey = process.env.REPLAY_ANALYSIS_API_KEY?.trim();
    const model = process.env.REPLAY_ANALYSIS_MODEL?.trim();
    if (!baseURL || !apiKey || !model) {
      throw new Error("缺少 REPLAY_ANALYSIS_BASE_URL/API_KEY/MODEL 环境变量");
    }
    return {
      modelConfig: {
        model,
        temperature: numEnv("REPLAY_ANALYSIS_TEMPERATURE", 0.2),
        reasoningEffort: process.env.REPLAY_ANALYSIS_REASONING_EFFORT?.trim() || "high",
        thinking: boolEnv("REPLAY_ANALYSIS_THINKING", true),
      },
      options: {
        baseURL,
        apiKey,
        timeoutMs: numEnv("REPLAY_ANALYSIS_TIMEOUT_MS", SCORE_TIMEOUT_MS),
      },
    };
  }

  private scorerPromptCache: string | null = null;
  private userPromptTemplateCache: string | null = null;
  private evalPromptsDirCache: string | null = null;
  private evalPromptsDirResolved = false;

  /** 解析 eval/prompts 目录(探测若干候选),解析后缓存。 */
  private resolveEvalPromptsDir(): string {
    if (this.evalPromptsDirResolved) return this.evalPromptsDirCache!;
    this.evalPromptsDirResolved = true;
    const dirs = [
      process.env.EVAL_PROMPTS_DIR?.trim(),
      join(process.cwd(), "eval", "prompts"),
      join(process.cwd(), "..", "eval", "prompts"),
      join(__dirname, "..", "..", "..", "..", "eval", "prompts"),
    ].filter(Boolean) as string[];
    this.evalPromptsDirCache =
      dirs.find((d) => existsSync(join(d, "system-replay-score.txt"))) ?? null;
    if (!this.evalPromptsDirCache) {
      throw new Error(`找不到 eval/prompts 目录(含冻结尺子),已尝试: ${dirs.join(", ")}`);
    }
    return this.evalPromptsDirCache;
  }

  private loadEvalPrompt(filename: string): string {
    return readFileSync(join(this.resolveEvalPromptsDir(), filename), "utf-8");
  }

  private loadScorerPrompt(): string {
    if (this.scorerPromptCache) return this.scorerPromptCache;
    // 允许用 EVAL_SCORE_PROMPT_PATH 单独覆盖系统尺子路径;否则从 eval/prompts 目录读。
    const override = process.env.EVAL_SCORE_PROMPT_PATH?.trim();
    const path = override && existsSync(override) ? override : null;
    this.scorerPromptCache = path
      ? readFileSync(path, "utf-8")
      : this.loadEvalPrompt("system-replay-score.txt");
    return this.scorerPromptCache;
  }

  private loadScorerUserTemplate(): string {
    if (this.userPromptTemplateCache) return this.userPromptTemplateCache;
    this.userPromptTemplateCache = this.loadEvalPrompt("user-replay-score-template.txt");
    return this.userPromptTemplateCache;
  }

  // ---------- 持久化与状态 ----------

  private async persist(row: Record<string, unknown>): Promise<void> {
    await this.postgres.query(
      `INSERT INTO iteration_runs
        (id, status, current_round, total_rounds, games_per_round, discussion_seconds,
         active_generation_id, rounds, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET
         status=EXCLUDED.status,
         current_round=EXCLUDED.current_round,
         total_rounds=EXCLUDED.total_rounds,
         games_per_round=EXCLUDED.games_per_round,
         discussion_seconds=EXCLUDED.discussion_seconds,
         active_generation_id=EXCLUDED.active_generation_id,
         rounds=EXCLUDED.rounds,
         updated_at=EXCLUDED.updated_at`,
      [
        row.id,
        row.status,
        row.current_round,
        row.total_rounds,
        row.games_per_round,
        row.discussion_seconds,
        row.active_generation_id,
        JSON.stringify(row.rounds ?? []),
        row.created_at,
        row.updated_at,
      ],
    );
  }

  private async getActiveRunRow(): Promise<IterationRunRow | null> {
    if (!this.activeRunId) {
      // 无活跃 run 时返回最近一条(供首屏展示历史)。
      const res = await this.postgres.query<IterationRunRow>(
        `SELECT * FROM iteration_runs ORDER BY updated_at DESC LIMIT 1`,
      );
      return res.rows[0] ?? null;
    }
    const res = await this.postgres.query<IterationRunRow>(
      `SELECT * FROM iteration_runs WHERE id = $1`,
      [this.activeRunId],
    );
    return res.rows[0] ?? null;
  }

  private async getRow(id: string): Promise<IterationRunRow | null> {
    const res = await this.postgres.query<IterationRunRow>(
      `SELECT * FROM iteration_runs WHERE id = $1`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  private async mostRecentNonTerminalRow(): Promise<IterationRunRow | null> {
    const res = await this.postgres.query<IterationRunRow>(
      `SELECT * FROM iteration_runs
       WHERE status IN ('running','awaiting_activation')
       ORDER BY updated_at DESC LIMIT 1`,
    );
    return res.rows[0] ?? null;
  }

  /** 进程重启后:内存里的 run 全丢了,把 DB 里仍处于非终态的 run 标记为 stopped。 */
  private async reconcileStaleRuns(): Promise<void> {
    const res = await this.postgres.query(
      `UPDATE iteration_runs SET status='stopped', updated_at=NOW()
       WHERE status IN ('running','awaiting_activation')`,
    );
    if (res.rowCount && res.rowCount > 0) {
      this.logger.log(`启动时清理 ${res.rowCount} 个中断的迭代 run(标记为 stopped)`);
    }
  }

  private rowToStatus(row: IterationRunRow): IterationRunStatus {
    const rounds = (row.rounds ?? []) as unknown as IterationRound[];
    return {
      id: row.id,
      status: row.status as IterationStatus,
      currentRound: row.current_round,
      totalRounds: row.total_rounds,
      gamesPerRound: row.games_per_round,
      discussionSeconds: row.discussion_seconds,
      activeGenerationId: row.active_generation_id,
      // 运行中给当前轮流式局;否则回退到最近一轮(刚跑完)的局。
      currentRoundGames:
        row.status === "running"
          ? this.currentRoundGames
          : rounds[rounds.length - 1]?.games ?? [],
      rounds,
      error: undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private emitStatus(
    status: IterationStatus,
    currentRound: number,
    totalRounds: number,
    gamesPerRound: number,
    discussionSeconds: number,
  ): void {
    this.events.emit("status", {
      status,
      currentRound,
      totalRounds,
      gamesPerRound,
      discussionSeconds,
      activeGenerationId: this.prompts.getActiveGenerationId(),
      // 运行中流式给当前轮的局;否则回退到最近一轮(刚跑完)的局,避免轮间界面清空。
      currentRoundGames:
        status === "running"
          ? this.currentRoundGames
          : this.rounds[this.rounds.length - 1]?.games ?? [],
      rounds: this.rounds,
    });
  }

  private async failRun(
    runId: string,
    totalRounds: number,
    gamesPerRound: number,
    discussionSeconds: number,
    error: string,
  ): Promise<void> {
    const row = await this.getActiveRunRow();
    if (row) {
      await this.persist({ ...row, status: "failed", updated_at: new Date().toISOString() });
    }
    this.events.emit("status", {
      status: "failed",
      currentRound: row?.current_round ?? 0,
      totalRounds,
      gamesPerRound,
      discussionSeconds,
      activeGenerationId: this.prompts.getActiveGenerationId(),
      currentRoundGames: [],
      rounds: this.rounds,
      error,
    });
    this.activeRunId = null;
  }
}

interface IterationRunRow {
  id: string;
  status: string;
  current_round: number;
  total_rounds: number;
  games_per_round: number;
  discussion_seconds: number;
  active_generation_id: string | null;
  rounds: IterationRound[];
  created_at: string;
  updated_at: string;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function numEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  return ["true", "1", "yes", "on"].includes(v);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isTerminal(status: string): boolean {
  return status === "completed" || status === "stopped" || status === "failed";
}

/** 容错解析 JSON:剥离 ```json 代码块包裹,提取首个 {...} 对象。 */
function parseJsonObject(content: string): unknown | null {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      /* fall through */
    }
  }
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      /* ignore */
    }
  }
  return null;
}
