import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { AiService } from "../ai/ai.service";
import {
  AUTO_OPTIMIZE_SYSTEM_ASSET_KEY,
  AUTO_OPTIMIZE_USER_ASSET_KEY,
  EvalPromptRegistry,
  REPLAY_SCORE_SYSTEM_ASSET_KEY,
  REPLAY_SCORE_USER_ASSET_KEY,
} from "../ai/eval-prompt-registry";
import {
  ALL_ASSET_KEYS,
  PERSONAS_ASSET_KEY,
  PromptRegistry,
  TEXT_ASSET_KEYS,
} from "../ai/prompt-registry";
import type { AiModelCallConfig, AiPersonaContext } from "../ai/ai.types";
import {
  AUTO_RESOLVE_DELAY_MS,
  DEBUG,
  DEBUG_AUTO_AI_PLAYER_COUNT,
  DEBUG_AUTO_SIMULATED_HUMAN_COUNT,
  MAX_ROUNDS,
  NEXT_ROUND_DELAY_MS,
  VOTE_DURATION_MS,
} from "../game/game.config";
import { GameService } from "../game/game.service";
import type { RoomSnapshot } from "../game/game.types";
import { PostgresService } from "../data/postgres.service";
import { buildReplayExportData } from "../replay/replay-export.builder";
import { ReplayService } from "../replay/replay.service";
import { aggregateScores, type GameScore, type Scorecard } from "./iteration-score";
import type {
  IterationGameResult,
  IterationPostRoundMode,
  IterationRound,
  IterationRunOptions,
  IterationRunStatus,
  IterationStatus,
  IterationPersonaMode,
  StartIterationPayload,
} from "./iteration.types";

const DEFAULT_ROUNDS = 4;
const DEFAULT_GAMES_PER_ROUND = 6;
const DEFAULT_DISCUSSION_SECONDS = 60;
const GAME_CONCURRENCY = 3;
const POLL_INTERVAL_MS = 2500;
const STUCK_AFTER_MS = 90_000;
const SCORE_TIMEOUT_MS = 120_000;
const DEFAULT_PERSONA_MODE: IterationPersonaMode = "fixed_schedule";
const DEFAULT_POST_ROUND_MODE: IterationPostRoundMode = "auto_optimize_wait_confirm";

/**
 * 进程内自动对局评估自迭代编排器。
 * - 用 GameService 直接驱动 debug 自动对局(纯服务端定时器,无需 socket 客户端)。
 * - 单进程互斥:同时只允许一个 run。
 * - 通过 EventEmitter 对外发本地事件(status/game/round/done),由网关桥接成 socket 广播。
 * 评估循环自动跑;版本激活由前端人工操作(自动优化器预留 optimizer 钩子,本期不接)。
 */
@Injectable()
export class IterationService implements OnModuleInit {
  private readonly logger = new Logger(IterationService.name);
  readonly events = new EventEmitter();

  private activeRunId: string | null = null;
  private stopRequested = false;
  private currentRoundGames: IterationGameResult[] = [];
  private rounds: IterationRound[] = [];
  private currentOptions: IterationRunOptions | null = null;

  async onModuleInit(): Promise<void> {
    await this.postgres.ready;
    await this.reconcileStaleRuns();
  }

  constructor(
    private readonly gameService: GameService,
    private readonly replayService: ReplayService,
    private readonly aiService: AiService,
    private readonly prompts: PromptRegistry,
    private readonly evalPrompts: EvalPromptRegistry,
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
    let options: IterationRunOptions;
    try {
      options = await this.normalizeOptions(payload, gamesPerRound);
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    this.activeRunId = id;
    this.stopRequested = false;
    this.rounds = [];
    this.currentRoundGames = [];
    this.currentOptions = options;

    await this.persist({
      id,
      status: "running",
      current_round: 1,
      total_rounds: totalRounds,
      games_per_round: gamesPerRound,
      discussion_seconds: discussionSeconds,
      active_generation_id: this.prompts.getActiveGenerationId(),
      iteration_options: options,
      pending_generation_id: null,
      rounds: [],
      created_at: now,
      updated_at: now,
    });

    this.emitStatus("running", 1, totalRounds, gamesPerRound, discussionSeconds);

    // 异步推进,不阻塞 ack。
    void this.runRound(id, 1, totalRounds, gamesPerRound, discussionSeconds, options).catch((err) => {
      this.logger.error(`迭代 run ${id} 异常: ${errMsg(err)}`);
      void this.failRun(id, totalRounds, gamesPerRound, discussionSeconds, errMsg(err));
    });

    return { ok: true, runId: id };
  }

  async continueToNextRound(): Promise<{ ok: boolean; error?: string }> {
    // 内存 activeRunId 可能在进程重启后丢失;若 DB 仍有非终态 run,则恢复后再继续。
    if (!this.activeRunId) {
      const recovered = await this.recoverActiveRun();
      if (!recovered) return { ok: false, error: "没有进行中的迭代" };
    }
    const run = await this.getActiveRunRow();
    if (!run || (run.status !== "awaiting_activation" && run.status !== "awaiting_confirmation")) {
      return { ok: false, error: "当前不在等待激活/确认状态" };
    }
    const nextRound = run.current_round + 1;
    if (nextRound > run.total_rounds) return { ok: false, error: "已达最大轮数" };

    if (run.status === "awaiting_confirmation") {
      if (!run.pending_generation_id) {
        return { ok: false, error: "缺少待确认的候选代" };
      }
      await this.prompts.setActive(run.pending_generation_id);
    }

    const options = this.rowOptions(run);
    this.currentOptions = options;
    this.stopRequested = false;
    await this.persist({
      ...run,
      status: "running",
      current_round: nextRound,
      active_generation_id: this.prompts.getActiveGenerationId(),
      pending_generation_id: null,
      updated_at: new Date().toISOString(),
    });
    this.emitStatus("running", nextRound, run.total_rounds, run.games_per_round, run.discussion_seconds);

    void this.runRound(this.activeRunId!, nextRound, run.total_rounds, run.games_per_round, run.discussion_seconds, options).catch((err) => {
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

  async retryAutoOptimize(): Promise<{ ok: boolean; error?: string; generationId?: string }> {
    // 内存 activeRunId 可能在进程重启后丢失;若 DB 仍有非终态 run,则恢复后再重试。
    if (!this.activeRunId) {
      const recovered = await this.recoverActiveRun();
      if (!recovered) return { ok: false, error: "没有进行中的迭代" };
    }
    const row = await this.getActiveRunRow();
    if (!row || row.status !== "awaiting_activation") {
      return { ok: false, error: "当前不在可重试自动优化的状态" };
    }
    const options = this.rowOptions(row);
    if (!this.shouldAutoOptimize(options)) {
      return { ok: false, error: "本次迭代未开启自动优化" };
    }

    const rounds = [...(row.rounds ?? [])];
    const last = rounds[rounds.length - 1];
    if (!last || !last.generationId) {
      return { ok: false, error: "没有可重试的轮次" };
    }
    const lastGenerationId = last.generationId;

    // 先进入"自动优化中"状态,立即返回 ack,AI 调用异步执行以避免客户端 WebSocket 5s 超时。
    await this.persist({
      ...row,
      status: "auto_optimizing",
      updated_at: new Date().toISOString(),
    });
    this.emitStatus(
      "auto_optimizing",
      row.current_round,
      row.total_rounds,
      row.games_per_round,
      row.discussion_seconds,
    );

    // 异步执行自动优化,完成后通过 iteration.status 事件推送结果。
    void this.executeRetryAutoOptimize(
      row,
      rounds,
      last,
      lastGenerationId,
      options,
    ).catch((err) => {
      this.logger.error(`重试自动优化异常: ${errMsg(err)}`);
    });

    return { ok: true };
  }

  private async executeRetryAutoOptimize(
    row: IterationRunRow,
    rounds: IterationRound[],
    last: IterationRound,
    lastGenerationId: string,
    options: IterationRunOptions,
  ): Promise<void> {
    if (this.stopRequested) return;

    const evalGenerationId =
      last.autoOptimize?.evalGenerationId ?? this.evalPrompts.getActiveGenerationId();
    const retryResult = await this.createAutoOptimizeGeneration(
      lastGenerationId,
      last,
      evalGenerationId,
    );
    const updatedRound: IterationRound = { ...last, autoOptimize: retryResult };
    rounds[rounds.length - 1] = updatedRound;
    this.rounds = rounds;

    const createdGenerationId =
      retryResult.status === "created" ? retryResult.generationId : undefined;

    // 重新从 DB 取最新 row,避免覆盖期间通过 socket 更新的字段。
    const freshRow = await this.getActiveRunRow();
    if (!freshRow) return;

    if (!createdGenerationId) {
      await this.persist({
        ...freshRow,
        rounds,
        pending_generation_id: null,
        updated_at: new Date().toISOString(),
      });
      this.emitStatus(
        "awaiting_activation",
        freshRow.current_round,
        freshRow.total_rounds,
        freshRow.games_per_round,
        freshRow.discussion_seconds,
      );
      this.events.emit("iteration.autoOptimizeFailed", {
        error: retryResult.error ?? "自动优化重试未生成新代",
      });
      return;
    }

    if (options.postRoundMode === "auto_optimize_activate_continue") {
      await this.prompts.setActive(createdGenerationId);
      const nextRound = freshRow.current_round + 1;
      await this.persist({
        ...freshRow,
        status: "running",
        current_round: nextRound,
        active_generation_id: this.prompts.getActiveGenerationId(),
        pending_generation_id: null,
        rounds,
        updated_at: new Date().toISOString(),
      });
      this.currentOptions = options;
      this.emitStatus(
        "running",
        nextRound,
        freshRow.total_rounds,
        freshRow.games_per_round,
        freshRow.discussion_seconds,
      );
      void this.runRound(
        this.activeRunId!,
        nextRound,
        freshRow.total_rounds,
        freshRow.games_per_round,
        freshRow.discussion_seconds,
        options,
      ).catch((err) => {
        this.logger.error(`迭代 run ${this.activeRunId} 重试后继续异常: ${errMsg(err)}`);
        void this.failRun(
          this.activeRunId!,
          freshRow.total_rounds,
          freshRow.games_per_round,
          freshRow.discussion_seconds,
          errMsg(err),
        );
      });
      return;
    }

    await this.persist({
      ...freshRow,
      status: "awaiting_confirmation",
      pending_generation_id: createdGenerationId,
      rounds,
      updated_at: new Date().toISOString(),
    });
    this.emitStatus(
      "awaiting_confirmation",
      freshRow.current_round,
      freshRow.total_rounds,
      freshRow.games_per_round,
      freshRow.discussion_seconds,
      createdGenerationId,
    );
  }

  /** 当前/最近 run 的全量快照(供前端首屏与轮询兜底)。 */
  async getStatus(): Promise<{ ok: boolean; run: IterationRunStatus | null }> {
    const row = await this.getActiveRunRow();
    if (!row) return { ok: true, run: null };
    return { ok: true, run: this.rowToStatus(row) };
  }

  /**
   * 估算一次迭代的预计用时(秒),供前端参数面板提示。仅作参考,实际受模型速度与对局结束轮数影响。
   * 用后端真实计时常量(VOTE_DURATION_MS 等可被 env 覆盖),避免前端硬编码漂移。
   * 模型:K 轮 × 每轮 ceil(B / 并发) 批 × 单局(平均 (MAX_ROUNDS-1) 天 × (讨论 + 投票 + 交接) + 打分)
   *      + (开启自动优化时)每轮 + 优化模型调用。
   */
  estimateIteration(params: {
    rounds?: number;
    gamesPerRound?: number;
    discussionSeconds?: number;
    postRoundMode?: string;
    sequentialSpeech?: boolean;
  }): { ok: boolean; seconds?: number; speechesPerPlayer?: number; error?: string } {
    const rounds = clampInt(params.rounds, DEFAULT_ROUNDS, 1, 20);
    const gamesPerRound = clampInt(
      params.gamesPerRound,
      DEFAULT_GAMES_PER_ROUND,
      1,
      20,
    );
    const discussionSeconds = clampInt(
      params.discussionSeconds,
      DEFAULT_DISCUSSION_SECONDS,
      10,
      600,
    );
    const postRoundMode =
      normalizePostRoundMode(params.postRoundMode) ?? DEFAULT_POST_ROUND_MODE;

    const VOTE_SEC = VOTE_DURATION_MS / 1000;
    const TURNOVER_SEC = (NEXT_ROUND_DELAY_MS + AUTO_RESOLVE_DELAY_MS) / 1000;
    const AVG_GAME_ROUNDS = Math.max(1, MAX_ROUNDS - 1); // 一局平均进行的天数
    const SCORE_SEC = 20; // 单局打分模型调用(估算)
    const AUTO_OPTIMIZE_SEC = 45; // 单轮自动优化优化模型调用(估算)

    const perGameRoundSec = discussionSeconds + VOTE_SEC + TURNOVER_SEC;
    const perGameSec = AVG_GAME_ROUNDS * perGameRoundSec + SCORE_SEC;
    const batches = Math.max(1, Math.ceil(gamesPerRound / GAME_CONCURRENCY));
    const perIterationRoundSec = batches * perGameSec;
    const autoOptimize = postRoundMode !== "manual" ? AUTO_OPTIMIZE_SEC : 0;
    const seconds = Math.max(1, rounds) * (perIterationRoundSec + autoOptimize);

    // 每个存活玩家在一次讨论阶段内的发言次数估算(仅作提示;不改变对局计时逻辑)。
    //   快速模式:串行轮次,每轮每名玩家发言一次,一轮耗时 ≈ 玩家数 × 单次发言耗时。
    //   普通模式:各玩家独立调度(并行),按各自周期发言。
    const players = Math.max(
      1,
      DEBUG_AUTO_AI_PLAYER_COUNT + DEBUG_AUTO_SIMULATED_HUMAN_COUNT,
    );
    const FAST_SPEECH_SEC = 8; // 快速模式串行单次发言(模型调用)耗时
    const NORMAL_SPEECH_CYCLE_SEC = 15; // 普通模式单玩家发言周期(含随机间隔)
    const speechesPerPlayer = params.sequentialSpeech
      ? Math.max(1, Math.floor(discussionSeconds / (players * FAST_SPEECH_SEC)))
      : Math.max(1, Math.floor(discussionSeconds / NORMAL_SPEECH_CYCLE_SEC));

    return { ok: true, seconds, speechesPerPlayer };
  }

  /** 当前激活的打分尺子(打分的 system prompt),供前端展示。 */
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
    const scoreGenerationId =
      (await this.findScoreGenerationId(roomId)) ?? this.evalPrompts.getActiveGenerationId();
    const system = await this.evalPrompts.getPromptForGeneration(
      scoreGenerationId,
      REPLAY_SCORE_SYSTEM_ASSET_KEY,
    );
    const user = await this.buildScoreUserPrompt(replay, scoreGenerationId);
    return {
      ok: true,
      request: {
        system,
        user,
        config: this.getScoreModelConfig(),
      },
    };
  }

  /**
   * 重建某轮自动优化时发往大模型的完整请求(优化器 system + user + 模型 config),
   * 供前端在自动优化记录的详情弹窗中如实展示生成过程输入。
   * user 用与 createAutoOptimizeGeneration 相同的 buildOptimizerUserPrompt
   * (含 assetKeys / 当前 prompts / personas / scorecard / games)。
   */
  async getAutoOptimizeRequest(runId: string, roundNo: number): Promise<{
    ok: boolean;
    request?: { system: string; user: string; config: ReturnType<IterationService["getScoreModelConfig"]> };
    error?: string;
  }> {
    const row = await this.getRow(runId);
    if (!row) return { ok: false, error: "迭代 run 不存在" };
    const rounds = row.rounds ?? [];
    const round = rounds.find((r) => r.round === roundNo);
    if (!round) return { ok: false, error: "找不到该轮" };
    if (!round.generationId) {
      return { ok: false, error: "该轮无源代,无法重建自动优化请求" };
    }
    try {
      const assets = await this.prompts.getGenerationAssets(round.generationId);
      const evalGenerationId =
        round.autoOptimize?.evalGenerationId ?? this.evalPrompts.getActiveGenerationId();
      const system = await this.evalPrompts.getPromptForGeneration(
        evalGenerationId,
        AUTO_OPTIMIZE_SYSTEM_ASSET_KEY,
      );
      const user = await this.buildOptimizerUserPrompt(
        round.generationId,
        round,
        assets,
        evalGenerationId,
      );
      return {
        ok: true,
        request: { system, user, config: this.getScoreModelConfig() },
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async findScoreGenerationId(roomId: string): Promise<string | null> {
    const rows = await this.postgres.query<{ rounds: IterationRound[] }>(
      `SELECT rounds FROM iteration_runs
       WHERE rounds::text LIKE $1
       ORDER BY updated_at DESC`,
      [`%${roomId}%`],
    );
    for (const row of rows.rows) {
      for (const round of row.rounds ?? []) {
        const game = round.games?.find((candidate) => candidate.roomId === roomId);
        if (game?.scoreGenerationId) return game.scoreGenerationId;
      }
    }
    return null;
  }

  // ---------- 单轮编排 ----------

  private async runRound(
    runId: string,
    roundNo: number,
    totalRounds: number,
    gamesPerRound: number,
    discussionSeconds: number,
    options: IterationRunOptions,
  ): Promise<void> {
    const generationId = this.prompts.getActiveGenerationId();
    this.currentRoundGames = Array.from({ length: gamesPerRound }, (_, gameIndex) => ({
      gameIndex,
      status: "pending" as const,
      round: roundNo,
      roomId: "",
      winner: null,
      generationId,
    }));
    this.emitStatus("running", roundNo, totalRounds, gamesPerRound, discussionSeconds);

    // 并发跑 B 局(上限 GAME_CONCURRENCY),逐局完成即 emit。
    const results: IterationGameResult[] = new Array(gamesPerRound);
    let next = 0;
    const workers = Array.from({ length: Math.min(GAME_CONCURRENCY, gamesPerRound) }, async () => {
      while (next < gamesPerRound) {
        const i = next++;
        if (this.stopRequested) break;
        const publish = (progress: IterationGameResult) => {
          this.upsertCurrentRoundGame(progress);
          this.events.emit("game", progress);
          this.emitStatus("running", roundNo, totalRounds, gamesPerRound, discussionSeconds);
        };
        const result = await this.runOneGame(roundNo, discussionSeconds, options, i, publish);
        results[i] = result;
        publish(result);
      }
    });
    await Promise.all(workers);

    if (this.stopRequested) return; // stop() 已持久化状态

    const games = results.filter(Boolean);
    const aggregate = this.buildAggregate(games);

    const round: IterationRound = { round: roundNo, generationId, games, aggregate };

    // 把本轮聚合分写回该代(让 AI 提示词版本列表能直接显示分数)。
    if (generationId && aggregate) {
      await this.prompts.writeScore(generationId, aggregate).catch((err) => {
        this.logger.warn(`writeScore ${generationId} 失败: ${errMsg(err)}`);
      });
    }

    const row = await this.getActiveRunRow();
    if (!row) return;
    const persistedRounds = [...(row.rounds ?? []), round];
    this.rounds.push(round);

    const isLast = roundNo >= totalRounds;
    // 自动优化在每一轮(含最后一轮)后都跑;最后一轮生成的候选代照常落库,
    // run 直接进入 completed(见下方 status 计算),候选代会保留在 AI 提示词版本列表里供手动激活。
    if (generationId && this.shouldAutoOptimize(options)) {
      const evalGenerationId = this.evalPrompts.getActiveGenerationId();
      // 进入自动优化前持久化并广播"自动优化中",让前端展示独立状态。
      await this.persist({
        ...row,
        status: "auto_optimizing",
        rounds: persistedRounds,
        updated_at: new Date().toISOString(),
      });
      this.emitStatus(
        "auto_optimizing",
        roundNo,
        totalRounds,
        gamesPerRound,
        discussionSeconds,
      );

      round.autoOptimize = await this.createAutoOptimizeGeneration(
        generationId,
        round,
        evalGenerationId,
      );
      if (this.stopRequested) return;
    }

    const autoOptimizeGenerationId =
      round.autoOptimize?.status === "created" ? round.autoOptimize.generationId : undefined;
    const shouldAutoContinue =
      !isLast &&
      autoOptimizeGenerationId &&
      options.postRoundMode === "auto_optimize_activate_continue";

    if (shouldAutoContinue) {
      await this.prompts.setActive(autoOptimizeGenerationId);
      const nextRound = roundNo + 1;
      await this.persist({
        ...row,
        status: "running",
        current_round: nextRound,
        active_generation_id: this.prompts.getActiveGenerationId(),
        pending_generation_id: null,
        rounds: persistedRounds,
        updated_at: new Date().toISOString(),
      });
      this.events.emit("round", round);
      this.emitStatus("running", nextRound, totalRounds, gamesPerRound, discussionSeconds);
      await this.runRound(runId, nextRound, totalRounds, gamesPerRound, discussionSeconds, options);
      return;
    }

    // 最后一轮跑完即 completed(候选代照常生成并保留在 AI 提示词版本列表里,供手动激活);
    // 不再停在 awaiting_activation,避免 run 非终态占用、阻断开新 run。
    const status: IterationStatus = isLast
      ? "completed"
      : autoOptimizeGenerationId && options.postRoundMode === "auto_optimize_wait_confirm"
        ? "awaiting_confirmation"
        : "awaiting_activation";
    await this.persist({
      ...row,
      status,
      pending_generation_id: status === "awaiting_confirmation" ? autoOptimizeGenerationId : null,
      rounds: persistedRounds,
      updated_at: new Date().toISOString(),
    });

    this.events.emit("round", round);
    this.emitStatus(
      status,
      roundNo,
      totalRounds,
      gamesPerRound,
      discussionSeconds,
      status === "awaiting_confirmation" ? autoOptimizeGenerationId : null,
    );
    if (status === "completed") {
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

  private async normalizeOptions(
    payload: StartIterationPayload,
    gamesPerRound: number,
  ): Promise<IterationRunOptions> {
    const explicitPostRoundMode = normalizePostRoundMode(payload.postRoundMode);
    let postRoundMode =
      explicitPostRoundMode ??
      (payload.autoOptimize === true ? "auto_optimize_wait_confirm" : DEFAULT_POST_ROUND_MODE);
    if (payload.autoOptimize === true && postRoundMode === "manual") {
      postRoundMode = "auto_optimize_wait_confirm";
    }
    if (payload.autoOptimize === false) {
      postRoundMode = "manual";
    }

    const personaMode = normalizePersonaMode(payload.personaMode) ?? DEFAULT_PERSONA_MODE;
    const activeAssets = await this.prompts.getGenerationAssets(this.prompts.getActiveGenerationId());
    const activePersonaIds = activeAssets.personas.map((persona) => persona.id);
    if (activePersonaIds.length === 0) throw new Error("当前 active 代没有可用 AI 人格");

    const requestedPersonaIds = (payload.personaIds ?? [])
      .map((id) => String(id).trim())
      .filter(Boolean);
    const missingPersonaIds = requestedPersonaIds.filter((id) => !activePersonaIds.includes(id));
    if (missingPersonaIds.length > 0) {
      throw new Error(`AI 人格不存在: ${missingPersonaIds.join(", ")}`);
    }

    const options: IterationRunOptions = {
      sequentialSpeech: payload.sequentialSpeech !== false,
      personaMode,
      personaIds: requestedPersonaIds.length > 0 ? requestedPersonaIds : undefined,
      autoOptimize: postRoundMode !== "manual",
      postRoundMode,
    };

    if (personaMode === "fixed_per_run") {
      const fixed = this.buildPersonaCombo(activePersonaIds, requestedPersonaIds);
      options.personaSchedule = Array.from({ length: gamesPerRound }, () => fixed);
    } else if (personaMode === "fixed_schedule") {
      options.personaSchedule = Array.from({ length: gamesPerRound }, () =>
        this.buildPersonaCombo(activePersonaIds, requestedPersonaIds),
      );
    }

    return options;
  }

  private buildPersonaCombo(activePersonaIds: string[], preferredPersonaIds: string[]): string[] {
    const aiCount = Math.max(1, Math.floor(DEBUG_AUTO_AI_PLAYER_COUNT));
    const combo = preferredPersonaIds.slice(0, aiCount);
    const shuffled = shuffle(activePersonaIds.filter((id) => !combo.includes(id)));
    while (combo.length < aiCount) {
      const next = shuffled.shift() ?? activePersonaIds[combo.length % activePersonaIds.length];
      if (!next) break;
      combo.push(next);
    }
    return combo;
  }

  private rowOptions(row: IterationRunRow): IterationRunOptions {
    const raw = (row.iteration_options ?? {}) as Partial<IterationRunOptions>;
    return {
      sequentialSpeech: raw.sequentialSpeech !== false,
      personaMode: normalizePersonaMode(raw.personaMode) ?? DEFAULT_PERSONA_MODE,
      personaIds: Array.isArray(raw.personaIds) ? raw.personaIds.filter(Boolean) : undefined,
      personaSchedule: Array.isArray(raw.personaSchedule)
        ? raw.personaSchedule.filter((entry): entry is string[] => Array.isArray(entry))
        : undefined,
      autoOptimize: raw.postRoundMode !== "manual" && raw.autoOptimize === true,
      postRoundMode: normalizePostRoundMode(raw.postRoundMode) ?? DEFAULT_POST_ROUND_MODE,
    };
  }

  private personaIdsForGame(options: IterationRunOptions, gameIndex: number): string[] | undefined {
    if (!options.personaSchedule?.length) return undefined;
    return options.personaSchedule[gameIndex % options.personaSchedule.length];
  }

  private shouldAutoOptimize(options: IterationRunOptions): boolean {
    return options.autoOptimize && options.postRoundMode !== "manual";
  }

  private async createAutoOptimizeGeneration(
    generationId: string,
    round: IterationRound,
    evalGenerationId: string,
  ): Promise<NonNullable<IterationRound["autoOptimize"]>> {
    if (!round.aggregate) {
      return { status: "skipped", error: "本轮没有有效 scorecard,跳过自动优化" };
    }

    const startedAt = Date.now();
    try {
      this.logger.log(
        `自动优化开始 generationId=${generationId} round=${round.round}`,
      );
      const assets = await this.prompts.getGenerationAssets(generationId);
      const { modelConfig, options } = this.resolveOptimizerModel();
      const systemPrompt = await this.evalPrompts.getPromptForGeneration(
        evalGenerationId,
        AUTO_OPTIMIZE_SYSTEM_ASSET_KEY,
      );
      const userPrompt = await this.buildOptimizerUserPrompt(
        generationId,
        round,
        assets,
        evalGenerationId,
      );

      this.logger.debug(
        this.formatOptimizerRequestLog(
          generationId,
          systemPrompt,
          userPrompt,
          modelConfig,
          options,
        ),
      );

      const { content } = await this.aiService.callModel(
        systemPrompt,
        userPrompt,
        modelConfig,
        options,
      );

      this.logger.debug(this.formatOptimizerResponseLog(generationId, content));

      const parsed = parseJsonObject(content);
      if (!isRecord(parsed)) {
        throw new Error(`自动优化返回非 JSON 对象: ${content.slice(0, 200)}`);
      }
      const changedAssets = this.validateOptimizerChangedAssets(parsed, assets);
      const changedAssetKeys = Object.keys(changedAssets);
      if (changedAssetKeys.length === 0) {
        return {
          status: "skipped",
          error: "自动优化未产生有效变更",
          evalGenerationId,
          response: content,
          durationMs: Date.now() - startedAt,
        };
      }

      const note =
        typeof parsed.note === "string" && parsed.note.trim()
          ? parsed.note.trim().slice(0, 500)
          : `auto-optimize after round ${round.round}`;
      const generation = await this.prompts.createGeneration({
        fromGenId: generationId,
        changedAssets,
        note,
      });
      this.logger.log(
        `自动优化成功 generationId=${generationId} → 新代 ${generation.id}(改动: ${changedAssetKeys.join(", ") || "无"})`,
      );
      return {
        status: "created",
        generationId: generation.id,
        evalGenerationId,
        changedAssetKeys,
        note,
        response: content,
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      const error = errMsg(err);
      this.logger.warn(`自动优化 ${generationId} 失败: ${error}`);
      return {
        status: "failed",
        error,
        evalGenerationId,
        durationMs: Date.now() - startedAt,
      };
    }
  }

  private async buildOptimizerUserPrompt(
    generationId: string,
    round: IterationRound,
    assets: Awaited<ReturnType<PromptRegistry["getGenerationAssets"]>>,
    evalGenerationId: string,
  ): Promise<string> {
    const games = round.games.map((game) => ({
      roomId: game.roomId,
      winner: game.winner,
      aiWin: game.aiWin,
      humanLikeScore: game.humanLikeScore,
      error: game.error,
      score: game.score ?? null,
    }));
    return this.evalPrompts.renderForGeneration(
      evalGenerationId,
      AUTO_OPTIMIZE_USER_ASSET_KEY,
      {
      generationId,
      assetKeysJson: JSON.stringify(ALL_ASSET_KEYS, null, 2),
      currentPromptsJson: JSON.stringify(assets.prompts, null, 2),
      currentPersonasJson: JSON.stringify(assets.personas, null, 2),
      scorecardJson: JSON.stringify(round.aggregate, null, 2),
      gamesJson: JSON.stringify(games, null, 2),
      },
    );
  }

  private formatOptimizerRequestLog(
    generationId: string,
    systemPrompt: string,
    userPrompt: string,
    modelConfig: AiModelCallConfig,
    options: { baseURL: string; apiKey: string; timeoutMs: number },
  ): string {
    const separator = "=".repeat(72);
    const subSeparator = "-".repeat(72);
    return [
      "",
      separator,
      `[自动优化完整请求 generationId=${generationId}]`,
      subSeparator,
      `Model: ${modelConfig.model}`,
      `Format: ${modelConfig.format ?? "openai"}`,
      `BaseURL: ${options.baseURL}`,
      `Timeout(ms): ${options.timeoutMs}`,
      `Temperature: ${modelConfig.temperature}`,
      `ReasoningEffort: ${modelConfig.reasoningEffort}`,
      subSeparator,
      "System Prompt:",
      systemPrompt,
      subSeparator,
      "User Prompt:",
      userPrompt,
      separator,
      "",
    ].join("\n");
  }

  private formatOptimizerResponseLog(generationId: string, content: string): string {
    const separator = "=".repeat(72);
    const subSeparator = "-".repeat(72);
    return [
      "",
      separator,
      `[自动优化完整返回 generationId=${generationId}]`,
      subSeparator,
      content,
      separator,
      "",
    ].join("\n");
  }

  private validateOptimizerChangedAssets(
    parsed: Record<string, unknown>,
    assets: Awaited<ReturnType<PromptRegistry["getGenerationAssets"]>>,
  ): Record<string, string> {
    if (!isRecord(parsed.changedAssets)) {
      throw new Error("自动优化 JSON 缺少 changedAssets 对象");
    }

    const changedAssets: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed.changedAssets)) {
      if (!ALL_ASSET_KEYS.includes(key)) {
        throw new Error(`自动优化返回了不支持的 asset key: ${key}`);
      }
      if (typeof value !== "string") {
        throw new Error(`自动优化 asset ${key} 必须是字符串`);
      }

      if (key === PERSONAS_ASSET_KEY) {
        const personas = parsePersonas(value);
        const currentIds = assets.personas.map((persona) => persona.id).sort();
        const nextIds = personas.map((persona) => persona.id).sort();
        if (JSON.stringify(currentIds) !== JSON.stringify(nextIds)) {
          throw new Error("自动优化人格库必须保留完全相同的 persona id 集合");
        }
        const normalized = JSON.stringify(personas, null, 2);
        if (normalized !== JSON.stringify(assets.personas, null, 2)) {
          changedAssets[key] = normalized;
        }
        continue;
      }

      if (!TEXT_ASSET_KEYS.includes(key)) {
        throw new Error(`自动优化 asset ${key} 不可作为文本模板处理`);
      }
      const missingPlaceholders = extractTemplatePlaceholders(assets.prompts[key] ?? "")
        .filter((placeholder) => !value.includes(placeholder));
      if (missingPlaceholders.length > 0) {
        throw new Error(
          `自动优化 asset ${key} 删除了模板变量: ${missingPlaceholders.join(", ")}`,
        );
      }
      if (value !== assets.prompts[key]) {
        changedAssets[key] = value;
      }
    }

    return changedAssets;
  }

  // ---------- 单局 ----------

  private async runOneGame(
    roundNo: number,
    discussionSeconds: number,
    options: IterationRunOptions,
    gameIndex: number,
    onProgress?: (progress: IterationGameResult) => void,
  ): Promise<IterationGameResult> {
    const base: IterationGameResult = {
      gameIndex,
      status: "running",
      round: roundNo,
      roomId: "",
      winner: null,
      generationId: null,
    };
    try {
      const created = await this.gameService.createDebugAutoAiRoom({
        sequentialSpeech: options.sequentialSpeech,
        discussionDurationSeconds: discussionSeconds,
        personaIds: this.personaIdsForGame(options, gameIndex),
      });
      if (!created?.ok || !created.room) throw new Error(`建房失败: ${created?.error ?? "?"}`);
      const roomId = created.room.id;
      const playerId = created.playerId!;
      base.roomId = roomId;
      base.generationId = created.room.promptGenerationId ?? this.prompts.getActiveGenerationId();
      Object.assign(base, this.gameProgressFromSnapshot(created.room));
      onProgress?.({ ...base });

      const started = await this.gameService.startGame({ roomId, playerId });
      if (!started?.ok) throw new Error(`开局失败: ${started?.error ?? "?"}`);
      if (started.room) {
        Object.assign(base, this.gameProgressFromSnapshot(started.room));
        onProgress?.({ ...base });
      }

      const finished = await this.waitForFinished(roomId, (room) => {
        Object.assign(base, this.gameProgressFromSnapshot(room));
        onProgress?.({ ...base });
      });
      base.winner = finished.winner;
      Object.assign(base, this.gameProgressFromSnapshot(finished));
      base.status = "scoring";
      onProgress?.({ ...base });

      const aiCallLogs = await this.replayService.getAiCallLogs(roomId);
      const replay = buildReplayExportData(finished, aiCallLogs, {
        includeSkips: true,
        includeUserPrompt: false,
        promptGenerationId: base.generationId ?? undefined,
      });

      // scoreReplay 内部用 buildScoreUserPrompt 注入 user 模板 + 该局 AI 人格定义。
      const scoreGenerationId = this.evalPrompts.getActiveGenerationId();
      const score = await this.scoreReplay(replay, scoreGenerationId);
      base.scoreGenerationId = scoreGenerationId;
      base.humanLikeScore = score.humanLikeScore;
      base.aiWin = score.aiWin;
      base.score = score;
      base.status = "finished";
      return base;
    } catch (err) {
      base.error = errMsg(err);
      base.status = "failed";
      return base;
    }
  }

  private async waitForFinished(
    roomId: string,
    onProgress?: (room: RoomSnapshot) => void,
  ): Promise<RoomSnapshot> {
    const deadline = Date.now() + 15 * 60_000;
    let stuckSince = 0;
    while (Date.now() < deadline) {
      if (this.stopRequested) throw new Error("已停止");
      await sleep(POLL_INTERVAL_MS);
      const res = await this.gameService.observeRoom({ roomId });
      const room = res?.room;
      if (!room) continue;
      onProgress?.(room);
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

  private gameProgressFromSnapshot(room: RoomSnapshot): Partial<IterationGameResult> {
    const aiPlayers = room.players.filter(
      (player) => player.revealedType === "ai" || Boolean(player.aiPersonaId),
    );
    const simulatedHumans = room.players.filter(
      (player) => player.revealedType === "human" && player.simulated === true,
    );
    return {
      currentGameRound: room.currentRound,
      phase: room.phase,
      aiAlive: aiPlayers.filter((player) => player.status === "alive").length,
      simulatedHumanAlive: simulatedHumans.filter((player) => player.status === "alive").length,
      aiTotal: aiPlayers.length,
      simulatedHumanTotal: simulatedHumans.length,
    };
  }

  private upsertCurrentRoundGame(progress: IterationGameResult): void {
    const index = this.currentRoundGames.findIndex((game) =>
      (progress.roomId && game.roomId === progress.roomId) ||
      game.gameIndex === progress.gameIndex,
    );
    if (index >= 0) {
      this.currentRoundGames[index] = {
        ...this.currentRoundGames[index],
        ...progress,
      };
    } else {
      this.currentRoundGames.push(progress);
    }
    this.currentRoundGames.sort((a, b) => (a.gameIndex ?? 0) - (b.gameIndex ?? 0));
  }

  private async scoreReplay(
    replay: Record<string, unknown>,
    evalGenerationId: string,
  ): Promise<GameScore & Record<string, unknown>> {
    const systemPrompt = await this.evalPrompts.getPromptForGeneration(
      evalGenerationId,
      REPLAY_SCORE_SYSTEM_ASSET_KEY,
    );
    const { modelConfig, options } = this.resolveScoreModel();
    const userPrompt = await this.buildScoreUserPrompt(replay, evalGenerationId);
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
  private async buildScoreUserPrompt(
    replay: Record<string, unknown>,
    evalGenerationId = this.evalPrompts.getActiveGenerationId(),
  ): Promise<string> {
    const genId =
      (replay.promptGenerationId as string | undefined) || this.prompts.getActiveGenerationId();
    const personas = await this.getPersonasForGeneration(genId);
    const personaDigest = personas.map((p) => ({
      id: p.id,
      name: p.name,
      sampleLines: p.sampleLines ?? [],
      avoidPhrases: p.avoidPhrases ?? [],
    }));
    return this.evalPrompts.renderForGeneration(
      evalGenerationId,
      REPLAY_SCORE_USER_ASSET_KEY,
      {
      replayJson: JSON.stringify(replay),
      personasJson: JSON.stringify(personaDigest, null, 2),
      },
    );
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

  private resolveOptimizerModel(): {
    modelConfig: AiModelCallConfig;
    options: { baseURL: string; apiKey: string; timeoutMs: number };
  } {
    // 自动优化直接复用 REPLAY_ANALYSIS_* 模型配置,与打分模型保持一致。
    return this.resolveScoreModel();
  }

  private loadScorerPrompt(): string {
    return this.evalPrompts.getPrompt(REPLAY_SCORE_SYSTEM_ASSET_KEY);
  }

  // ---------- 持久化与状态 ----------

  private async persist(row: Record<string, unknown>): Promise<void> {
    await this.postgres.query(
      `INSERT INTO iteration_runs
        (id, status, current_round, total_rounds, games_per_round, discussion_seconds,
         active_generation_id, rounds, iteration_options, pending_generation_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE SET
         status=EXCLUDED.status,
         current_round=EXCLUDED.current_round,
         total_rounds=EXCLUDED.total_rounds,
         games_per_round=EXCLUDED.games_per_round,
         discussion_seconds=EXCLUDED.discussion_seconds,
         active_generation_id=EXCLUDED.active_generation_id,
         rounds=EXCLUDED.rounds,
         iteration_options=EXCLUDED.iteration_options,
         pending_generation_id=EXCLUDED.pending_generation_id,
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
        JSON.stringify(row.iteration_options ?? this.currentOptions ?? {}),
        row.pending_generation_id ?? null,
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
       WHERE status IN ('running','auto_optimizing','awaiting_activation','awaiting_confirmation')
       ORDER BY updated_at DESC LIMIT 1`,
    );
    return res.rows[0] ?? null;
  }

  /**
   * 进程重启后(如 nest --watch 重编译)内存 activeRunId 会丢失,但 DB 里的 run 仍可能在等待状态。
   * 本方法从最近一条非终态 run 恢复内存态(activeRunId + this.rounds),使「继续/确认/重试」可用。
   * 与 stop() 的回退逻辑一致;返回恢复到的 row,无则 null。
   */
  private async recoverActiveRun(): Promise<IterationRunRow | null> {
    const row = await this.mostRecentNonTerminalRow();
    if (!row) return null;
    this.activeRunId = row.id;
    this.rounds = (row.rounds ?? []) as IterationRound[];
    this.currentRoundGames = [];
    return row;
  }

  /**
   * 进程重启后:内存里的 run 全丢了。
   * - 大多数非终态 run(running/auto_optimizing/awaiting_activation)已无内存驱动,标记为 stopped。
   *   其中 auto_optimizing 的自动优化调用已丢失,必须清理。
   * - 例外:处于"自动优化失败"(awaiting_activation + 末轮 autoOptimize.status=failed)的 run
   *   允许保留,用户可继续重试自动优化;为此把内存 activeRunId 指回最近一条,使 retryAutoOptimize 可用。
   */
  private async reconcileStaleRuns(): Promise<void> {
    const res = await this.postgres.query<{
      id: string;
      status: string;
      rounds: unknown;
    }>(
      `SELECT id, status, rounds FROM iteration_runs
       WHERE status IN ('running','auto_optimizing','awaiting_activation')
       ORDER BY updated_at DESC`,
    );

    const failedAutoOptimizeIds: string[] = [];
    const toStopIds: string[] = [];
    for (const row of res.rows) {
      if (this.isAutoOptimizeFailedRow(row)) {
        failedAutoOptimizeIds.push(row.id);
      } else {
        toStopIds.push(row.id);
      }
    }

    if (failedAutoOptimizeIds.length > 0) {
      // 取最近一条(updated_at DESC 排第一)作为活跃 run,其余保留待用户手动处理。
      this.activeRunId = failedAutoOptimizeIds[0];
      this.logger.log(
        `启动时保留 ${failedAutoOptimizeIds.length} 个处于"自动优化失败"状态的迭代 run(可继续重试),activeRunId=${this.activeRunId}`,
      );
    }

    let stoppedCount = 0;
    if (toStopIds.length > 0) {
      const update = await this.postgres.query(
        `UPDATE iteration_runs SET status='stopped', updated_at=NOW()
         WHERE id = ANY($1::uuid[])`,
        [toStopIds],
      );
      stoppedCount = update.rowCount ?? 0;
    }
    if (stoppedCount > 0) {
      this.logger.log(`启动时清理 ${stoppedCount} 个中断的迭代 run(标记为 stopped)`);
    }
  }

  /** 判断某 run 是否处于"自动优化失败"状态(末轮 autoOptimize.status=failed),用于启动清理时保留。 */
  private isAutoOptimizeFailedRow(row: { status: string; rounds: unknown }): boolean {
    if (row.status !== "awaiting_activation") return false;
    if (!Array.isArray(row.rounds) || row.rounds.length === 0) return false;
    const last = row.rounds[row.rounds.length - 1] as
      | { autoOptimize?: { status?: string } }
      | undefined;
    return last?.autoOptimize?.status === "failed";
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
      pendingGenerationId: row.pending_generation_id ?? null,
      options: this.rowOptions(row),
      // 运行中给当前轮流式局;否则回退到最近一轮(刚跑完)的局。
      currentRoundGames:
        row.status === "running"
          ? this.currentRoundGames
          : rounds[rounds.length - 1]?.games ?? [],
      rounds,
      lastAutoOptimize: rounds[rounds.length - 1]?.autoOptimize ?? null,
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
    pendingGenerationId?: string | null,
  ): void {
    this.events.emit("status", {
      status,
      currentRound,
      totalRounds,
      gamesPerRound,
      discussionSeconds,
      activeGenerationId: this.prompts.getActiveGenerationId(),
      pendingGenerationId: pendingGenerationId ?? null,
      options: this.currentOptions ?? undefined,
      // 本次状态切换的时间戳;前端「自动优化已耗时」计时器据此起算。
      updatedAt: new Date().toISOString(),
      // 运行中流式给当前轮的局;否则回退到最近一轮(刚跑完)的局,避免轮间界面清空。
      currentRoundGames:
        status === "running"
          ? this.currentRoundGames
          : this.rounds[this.rounds.length - 1]?.games ?? [],
      rounds: this.rounds,
      lastAutoOptimize: this.rounds[this.rounds.length - 1]?.autoOptimize ?? null,
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
      pendingGenerationId: null,
      options: this.currentOptions ?? undefined,
      currentRoundGames: [],
      rounds: this.rounds,
      lastAutoOptimize: this.rounds[this.rounds.length - 1]?.autoOptimize ?? null,
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
  iteration_options: IterationRunOptions | Record<string, unknown>;
  pending_generation_id: string | null;
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

function normalizePersonaMode(value: unknown): IterationPersonaMode | null {
  return value === "random_each_game" ||
    value === "fixed_per_run" ||
    value === "fixed_schedule"
    ? value
    : null;
}

function normalizePostRoundMode(value: unknown): IterationPostRoundMode | null {
  return value === "manual" ||
    value === "auto_optimize_wait_confirm" ||
    value === "auto_optimize_activate_continue"
    ? value
    : null;
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePersonas(content: string): AiPersonaContext[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("自动优化人格库不是合法 JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("自动优化人格库必须是 JSON 数组");
  }
  for (const [index, persona] of parsed.entries()) {
    if (!isRecord(persona) || typeof persona.id !== "string" || !persona.id.trim()) {
      throw new Error(`自动优化人格库第 ${index + 1} 项缺少有效 id`);
    }
    if (typeof persona.name !== "string" || !persona.name.trim()) {
      throw new Error(`自动优化人格库第 ${index + 1} 项缺少有效 name`);
    }
  }
  return parsed as AiPersonaContext[];
}

function extractTemplatePlaceholders(template: string): string[] {
  return Array.from(new Set(template.match(/\{\{[a-zA-Z0-9_]+\}\}/g) ?? []));
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
