import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Server } from "socket.io";
import { AiService } from "../ai/ai.service";
import { getActivePersonas, getAiPersonaById } from "../ai/ai.personas";
import { GameContext, RoundVoteSummary, VoteRecord } from "../ai/ai.types";
import { AuthService } from "../auth/auth.service";
import {
  AI_PLAYER_COUNT,
  AI_SPEECH_INITIAL_CHECK_MS,
  AI_SPEECH_NEXT_CHECK_MAX_MS,
  AI_SPEECH_NEXT_CHECK_MIN_MS,
  AI_SPEECH_RESPONSE_DELAY_MAX_MS,
  AI_SPEECH_RESPONSE_DELAY_MIN_MS,
  AI_SPEECH_SKIP_BACKOFF_MS,
  AI_SPEECH_STALE_RETRY_MAX_MS,
  AI_SPEECH_STALE_RETRY_MIN_MS,
  AI_VOTE_DELAY_MS,
  AI_VOTE_STAGGER_MS,
  AUTO_RESOLVE_DELAY_MS,
  DEBUG,
  DISCONNECT_GRACE_MS,
  MAX_HUMAN_PLAYERS,
  NEXT_ROUND_DELAY_MS,
  REWARD_POOL,
  SIM_HUMAN_SPEECH_COOLDOWN_MS,
  SIM_HUMAN_SPEECH_NEXT_CHECK_MAX_MS,
  SIM_HUMAN_SPEECH_RESPONSE_DELAY_MAX_MS,
  SIM_HUMAN_SPEECH_SKIP_BACKOFF_MS,
  SPEAK_COOLDOWN_MS,
  VOTE_DURATION_MS,
} from "./game.config";
import { GameRoomRepository } from "./game-room.repository";
import {
  addChatMessage,
  canStartSandboxRoom,
  chooseFallbackVoteTarget,
  countAi,
  countHumans,
  countSimulatedHumans,
  createAiPlayers,
  createHumanPlayer,
  createSandboxPlayers,
  type SandboxPlayerSpec,
  createSimulatedHumanPlayer,
  createRoomId,
  futureIso,
  getWinner,
  isModelDrivenPlayer,
  isSandboxRoom,
  isSimulatedHuman,
  normalizeContent,
  normalizeDiscussionDuration,
  normalizeRoomId,
  randomItem,
  resolveElimination,
  ruleVote,
  touch,
  validateCanSpeak,
} from "./game.rules";
import { toPublicMessage, toRoomSnapshot } from "./game.snapshot";
import { runAutoCheck } from "../sandbox/probe/checkers";
import {
  ActionResult,
  AiShortMemory,
  AiVoteMemorySource,
  CastVotePayload,
  CreateRoomPayload,
  DeleteSandboxRoomPayload,
  DeleteRoomPayload,
  GameAccount,
  JoinRoomPayload,
  LeaveRoomPayload,
  ObserveRoomPayload,
  ChatMessage,
  Player,
  PointAward,
  ReconnectPayload,
  Room,
  RoomSnapshot,
  SendChatPayload,
  SpeechGeneratingPayload,
  StartGamePayload,
  StopGamePayload,
  UpdateDiscussionDurationPayload,
  UpdateSandboxPlayerModelPayload,
  Winner,
} from "./game.types";

type RoomTimers = {
  phase?: NodeJS.Timeout;
  tick?: NodeJS.Timeout;
  aiSpeech?: NodeJS.Timeout;
  simulatedHumanSpeech?: NodeJS.Timeout;
};

type AiSpeechContextMark = {
  roundNo: number;
  voteCount: number;
};

type SpeechSchedulerKind = "ai" | "simulated-human";
type SpeechTimerKey = "aiSpeech" | "simulatedHumanSpeech";
type SandboxSpeechPassResult = "continue" | "start-voting" | "stop";

@Injectable()
export class GameService {
  private readonly logger = new Logger(GameService.name);
  private readonly timers = new Map<string, RoomTimers>();
  private readonly aiSpeaking = new Map<string, boolean>();
  private readonly simulatedHumanSpeaking = new Map<string, boolean>();
  private readonly speechGeneratings = new Map<string, Map<string, SpeechGeneratingPayload>>();
  private server?: Server;

  constructor(
    private readonly aiService: AiService,
    private readonly authService: AuthService,
    private readonly roomRepository: GameRoomRepository,
  ) {}

  private snapshot(room: Room): RoomSnapshot {
    const snapshot = toRoomSnapshot(room, this.aiService.getAvailableModels());
    const speechGeneratings = this.snapshotSpeechGeneratings(room);
    return speechGeneratings.length > 0
      ? { ...snapshot, speechGeneratings }
      : snapshot;
  }

  bindServer(server: Server) {
    this.server = server;
  }

  async createRoom(
    socketId: string,
    payload: CreateRoomPayload,
    account?: GameAccount | null,
  ): Promise<ActionResult> {
    const now = new Date().toISOString();
    const host = createHumanPlayer(
      account?.displayName ?? payload.playerName,
      socketId,
      1,
      account?.id,
    );
    const room: Room = {
      id: createRoomId(),
      status: "waiting",
      ownerPlayerId: host.id,
      players: [host],
      discussionDurationMs: normalizeDiscussionDuration(payload),
      currentRound: 0,
      phase: "waiting",
      phaseEndsAt: null,
      winner: null,
      messages: [],
      votes: [],
      pointAwards: [],
      rewardSettledAt: null,
      createdAt: now,
      updatedAt: now,
    };

    await this.roomRepository.save(room);
    return {
      ok: true,
      room: this.snapshot(room),
      playerId: host.id,
    };
  }

  /**
   * 离线沙盒:按场景 roster 建一个沙盒房(全 model-driven),复用产品运行时的
   * 对局循环与 gateway 实时可视化(观战模式)。
   */
  async createSandboxRoom(params: {
    scenarioId: string;
    /** 冻结的场景 JSON(opaque,仅沙盒后续读取)。 */
    scenarioJson?: unknown;
    specs: SandboxPlayerSpec[];
    aiUnderTestModelId?: string;
    discussionSeconds?: number;
    /** 投票策略 + 按座号覆盖 + scripted 票 + 种子/run 序号(沙盒投票分支用)。 */
    votePolicy?: Room["sandboxVotePolicy"];
    voteOverrides?: Room["sandboxVoteOverrides"];
    scriptedVotes?: Room["sandboxScriptedVotes"];
    seed?: number;
    runIndex?: number;
    /** 探测调度(已解析的不透明 fire 计划,Phase 2 用)。 */
    probeSchedule?: Room["sandboxProbeSchedule"];
    /** spotlight 形态字段。 */
    form?: "full_match" | "spotlight";
    startRound?: number;
    maxRoundsForward?: number;
    seedHistory?: {
      prior_turns: Array<{ round: number; slot: number; text: string }>;
      prior_rounds?: Array<{ round: number; eliminated_slot: number | null }>;
    };
    /** 被测 AI 提示词版本代号;缺省走产品默认 AI 提示词。 */
    aiPromptVersionId?: string;
  }): Promise<ActionResult> {
    if (!DEBUG) {
      return this.fail("调试模式未开启(沙盒需 DEBUG=true)");
    }

    const now = new Date().toISOString();
    const aiUnderTestModelId = params.aiUnderTestModelId ?? this.aiService.getDefaultModelId();
    const players = createSandboxPlayers(params.specs, aiUnderTestModelId);

    // spotlight:预灌 seed_history(prior_turns→messages;prior_rounds→标记预淘汰)。
    const messages: ChatMessage[] = [];
    const preEliminatedSeats = new Set<number>();
    if (params.form === "spotlight" && params.seedHistory) {
      const seatToPlayer = new Map(players.map((p) => [p.seatNo, p]));
      for (const turn of params.seedHistory.prior_turns) {
        const player = seatToPlayer.get(turn.slot);
        if (!player) continue;
        messages.push({
          id: randomUUID(),
          roundNo: turn.round,
          playerId: player.id,
          playerName: player.name,
          source: player.type,
          content: turn.text,
          createdAt: now,
          sandboxFromSeedHistory: true,
        });
      }
      for (const r of params.seedHistory.prior_rounds ?? []) {
        if (r.eliminated_slot != null) preEliminatedSeats.add(r.eliminated_slot);
      }
      for (const player of players) {
        if (preEliminatedSeats.has(player.seatNo)) {
          const elimRound = params.seedHistory.prior_rounds?.find(
            (rr) => rr.eliminated_slot === player.seatNo,
          )?.round;
          player.status = "eliminated";
          player.eliminatedRound = elimRound;
        }
      }
    }

    const room: Room = {
      id: createRoomId(),
      status: "waiting",
      ownerPlayerId: players[0].id,
      sandboxScenarioId: params.scenarioId,
      sandboxScenario: params.scenarioJson,
      sandboxVotePolicy: params.votePolicy,
      sandboxVoteOverrides: params.voteOverrides,
      sandboxScriptedVotes: params.scriptedVotes,
      sandboxSeed: params.seed,
      sandboxRunIndex: params.runIndex,
      sandboxProbeSchedule: params.probeSchedule,
      sandboxProbeEvents: [],
      sandboxForm: params.form,
      sandboxStartRound: params.startRound,
      sandboxMaxRoundsForward: params.maxRoundsForward,
      sandboxAiPromptVersionId: params.aiPromptVersionId,
      players,
      discussionDurationMs: normalizeDiscussionDuration({
        discussionDurationSeconds: params.discussionSeconds,
      }),
      currentRound: 0,
      phase: "waiting",
      phaseEndsAt: null,
      winner: null,
      messages,
      votes: [],
      pointAwards: [],
      rewardSettledAt: null,
      createdAt: now,
      updatedAt: now,
    };

    await this.roomRepository.save(room);
    return {
      ok: true,
      room: this.snapshot(room),
      playerId: room.ownerPlayerId,
    };
  }

  /** 离线沙盒:取内部完整 Room(含 messages/votes/aiMemories/players)以构建 MatchRecord。 */
  async getRoomInternal(roomId: string | undefined): Promise<Room | null> {
    return this.getRoom(roomId);
  }

  async joinRoom(
    socketId: string,
    payload: JoinRoomPayload,
    account?: GameAccount | null,
  ): Promise<ActionResult> {
    const roomId = normalizeRoomId(payload.roomId);
    let playerId: string | null = null;
    let failure = "房间不存在或操作冲突";

    const room = await this.applyWithLock(roomId, (latest) => {
      if (account) {
        const existingAccountPlayer = latest.players.find(
          (candidate) =>
            candidate.type === "human" && candidate.accountId === account.id,
        );
        if (existingAccountPlayer) {
          this.cancelDisconnectRemoval(latest.id, existingAccountPlayer.id);
          existingAccountPlayer.socketId = socketId;
          existingAccountPlayer.connected = true;
          existingAccountPlayer.name = account.displayName;
          playerId = existingAccountPlayer.id;
          touch(latest);
          return true;
        }
      }

      if (latest.status !== "waiting") {
        failure = "游戏已开始，暂时不能加入";
        return false;
      }

      if (isSandboxRoom(latest)) {
        failure = "沙盒房不能加入真人玩家";
        return false;
      }

      if (countHumans(latest) >= MAX_HUMAN_PLAYERS) {
        failure = "真人玩家人数已满";
        return false;
      }

      const player = createHumanPlayer(
        account?.displayName ?? payload.playerName,
        socketId,
        latest.players.length + 1,
        account?.id,
      );
      latest.players.push(player);
      playerId = player.id;
      touch(latest);
      return true;
    });

    if (!room || !playerId) {
      return this.fail(failure);
    }

    return {
      ok: true,
      room: this.snapshot(room),
      playerId,
    };
  }

  async leaveRoom(
    socketId: string,
    payload: LeaveRoomPayload,
  ): Promise<ActionResult> {
    const roomId = normalizeRoomId(payload.roomId);
    let shouldDelete = false;
    let failure = "房间不存在或操作冲突";

    const room = await this.applyWithLock(roomId, (latest) => {
      const player = latest.players.find(
        (candidate) =>
          candidate.id === payload.playerId && candidate.type === "human",
      );
      if (!player) {
        failure = "你不在该房间中";
        return false;
      }

      if (latest.status !== "waiting") {
        failure = "游戏进行中，无法离开";
        return false;
      }

      latest.players = latest.players.filter(
        (candidate) => candidate.id !== player.id,
      );
      if (latest.ownerPlayerId === player.id) {
        const nextHuman = latest.players.find(
          (candidate) => candidate.type === "human",
        );
        if (nextHuman) {
          latest.ownerPlayerId = nextHuman.id;
        }
      }

      shouldDelete = countHumans(latest) === 0;
      touch(latest);
      return true;
    });

    if (!room) {
      return this.fail(failure);
    }

    if (shouldDelete) {
      this.clearTimers(room.id);
      await this.roomRepository.delete(room.id);
      return { ok: true, deletedRoomId: room.id };
    }

    return {
      ok: true,
      room: this.snapshot(room),
    };
  }

  async reconnect(
    socketId: string,
    payload: ReconnectPayload,
  ): Promise<ActionResult> {
    const roomId = normalizeRoomId(payload.roomId);

    const room = await this.applyWithLock(roomId, (room) => {
      if (room.status === "finished") {
        return false;
      }

      const player = room.players.find(
        (candidate) => candidate.id === payload.playerId && candidate.type === "human",
      );
      if (!player) {
        return false;
      }

      this.cancelDisconnectRemoval(room.id, player.id);

      player.socketId = socketId;
      player.connected = true;
      touch(room);
      return true;
    });

    if (!room) {
      return this.fail("房间不存在或操作冲突");
    }

    return {
      ok: true,
      room: this.snapshot(room),
      playerId: payload.playerId,
    };
  }

  private readonly disconnectTimers = new Map<string, NodeJS.Timeout>();

  async disconnect(socketId: string): Promise<RoomSnapshot[]> {
    const updatedRooms: RoomSnapshot[] = [];
    const candidateRooms = await this.roomRepository.list(200);

    for (const candidate of candidateRooms) {
      const player = candidate.players.find(
        (candidate) => candidate.socketId === socketId,
      );
      if (!player) {
        continue;
      }

      const room = await this.applyWithLock(candidate.id, (room) => {
        const freshPlayer = room.players.find((p) => p.id === player.id);
        if (!freshPlayer) {
          return false;
        }
        if (freshPlayer.socketId !== socketId) {
          return false;
        }

        freshPlayer.connected = false;
        freshPlayer.socketId = undefined;

        if (room.status === "playing") {
          touch(room);
          return true;
        }

        if (room.status === "finished") {
          return true;
        }

        const timerKey = `${room.id}:${freshPlayer.id}`;
        const existingTimer = this.disconnectTimers.get(timerKey);
        if (existingTimer) {
          clearTimeout(existingTimer);
        }

        this.disconnectTimers.set(
          timerKey,
          setTimeout(() => {
            void this.removeDisconnectedPlayerAfterGrace(room.id, freshPlayer.id);
          }, DISCONNECT_GRACE_MS),
        );

        touch(room);
        return true;
      });

      if (room) {
        updatedRooms.push(this.snapshot(room));
      }
    }

    return updatedRooms;
  }

  private async removeDisconnectedPlayerAfterGrace(roomId: string, playerId: string) {
    const timerKey = `${roomId}:${playerId}`;
    this.disconnectTimers.delete(timerKey);

    let shouldDelete = false;
    const room = await this.applyWithLock(roomId, (latest) => {
      if (latest.status !== "waiting") {
        return false;
      }

      const stillDisconnected = latest.players.find(
        (candidate) => candidate.id === playerId && !candidate.connected,
      );
      if (!stillDisconnected) {
        return false;
      }

      latest.players = latest.players.filter(
        (candidate) => candidate.id !== playerId,
      );
      if (latest.ownerPlayerId === playerId) {
        const nextHuman = latest.players.find(
          (candidate) => candidate.type === "human",
        );
        if (nextHuman) {
          latest.ownerPlayerId = nextHuman.id;
        }
      }

      shouldDelete = countHumans(latest) === 0;
      touch(latest);
      return true;
    });

    if (!room) {
      return;
    }

    if (shouldDelete) {
      this.clearTimers(room.id);
      await this.roomRepository.delete(room.id);
      return;
    }

    this.server?.to(roomId).emit("room.updated", this.snapshot(room));
  }

  async startGame(payload: StartGamePayload): Promise<ActionResult> {
    const roomId = normalizeRoomId(payload.roomId);
    let failure = "房间不存在或操作冲突";
    const room = await this.applyWithLock(roomId, (latest) => {
      const isSandbox = DEBUG && isSandboxRoom(latest) === true;
      if (latest.status !== "waiting") {
        failure = "游戏已经开始";
        return false;
      }

      if (!isSandbox && payload.playerId !== latest.ownerPlayerId) {
        failure = "只有房主可以开始游戏";
        return false;
      }

      if (isSandbox) {
        if (countAi(latest) < 1) {
          failure = "至少需要 1 名被测AI玩家";
          return false;
        }

        if (countSimulatedHumans(latest) < 1) {
          failure = "至少需要 1 名侦探或填充玩家";
          return false;
        }

        if (!canStartSandboxRoom(latest)) {
          failure = "沙盒对局至少需要 1 名被测AI玩家和 1 名侦探或填充玩家";
          return false;
        }
      } else if (countHumans(latest) < 1) {
        failure = "至少需要 1 名真人玩家";
        return false;
      }

      // spotlight:从 sandboxStartRound 起跑、保留预灌历史、跳过预淘汰玩家。
      const isSpotlight = latest.sandboxForm === "spotlight";
      const startRound = isSpotlight ? (latest.sandboxStartRound ?? 1) : 1;

      latest.status = "playing";
      latest.winner = null;
      latest.currentRound = startRound;
      latest.phase = "discussion";
      latest.phaseEndsAt = futureIso(latest.discussionDurationMs);
      this.prepareSandboxSpeechState(latest);
      if (!isSpotlight) {
        latest.messages = [];
      }
      latest.votes = [];
      latest.aiMemories = {};
      latest.pointAwards = [];
      latest.rewardSettledAt = null;
      for (const player of latest.players) {
        const preEliminated =
          isSpotlight &&
          player.eliminatedRound != null &&
          player.eliminatedRound < startRound;
        if (preEliminated) {
          player.status = "eliminated";
          continue;
        }
        player.status = "alive";
        player.lastSpokeAt = 0;
        player.eliminatedRound = undefined;
        if (isModelDrivenPlayer(player)) {
          player.aiLastConsideredRound = undefined;
          player.aiLastConsideredAt = undefined;
          player.aiSkipBackoffUntil = undefined;
        }
      }

      if (!isSandbox) {
        const existingAiPlayers = latest.players.filter(
          (player) => player.type === "ai",
        );
        const missingAiCount = Math.max(
          0,
          AI_PLAYER_COUNT - existingAiPlayers.length,
        );
        if (missingAiCount > 0) {
          const existingAiPersonaIds = existingAiPlayers.flatMap((player) =>
            player.aiPersonaId ? [player.aiPersonaId] : [],
          );
          const aiPlayers = createAiPlayers(
            latest.players.length + 1,
            missingAiCount,
            existingAiPersonaIds,
          );
          latest.players.push(...aiPlayers);
        }
      }

      // 沙盒房按 roster 顺序保留座位(slot↔seat 稳定);其余房随机洗座。
      if (!latest.sandboxScenarioId) {
        latest.players.sort(() => Math.random() - 0.5);
        latest.players.forEach((player, index) => {
          player.seatNo = index + 1;
        });
      }

      touch(latest);
      return true;
    });

    if (!room) {
      return this.fail(failure);
    }

    this.afterDiscussionStarted(room);
    this.server?.to(room.id).emit("game.started", this.snapshot(room));

    return {
      ok: true,
      room: this.snapshot(room),
    };
  }

  async sendChat(
    socketId: string,
    payload: SendChatPayload,
  ): Promise<ActionResult> {
    const content = normalizeContent(payload.content);
    if (!content) {
      return this.fail("发言内容不能为空");
    }

    const roomId = normalizeRoomId(payload.roomId);
    let failure = "房间不存在或操作冲突";
    const saved = await this.applyWithLock(roomId, (latest) => {
      const player = this.bindHumanForAction(
        latest,
        socketId,
        payload.playerId,
      );
      if (!player) {
        failure = "你不在该房间中";
        return false;
      }

      const validationError = validateCanSpeak(latest, player);
      if (validationError) {
        failure = validationError;
        return false;
      }

      this.addMessage(latest, player, content, false);
      return true;
    });

    if (!saved) {
      return this.fail(failure);
    }

    this.broadcastRoom(saved);

    return {
      ok: true,
      room: this.snapshot(saved),
    };
  }

  async castVote(
    socketId: string,
    payload: CastVotePayload,
  ): Promise<ActionResult> {
    const room = await this.getRoom(payload.roomId);
    if (!room) {
      return this.fail("房间不存在");
    }

    const actor = await this.findHumanForAction(room, socketId, payload.playerId);
    if (!actor) {
      return this.fail("你不在该房间中");
    }

    return this.castVoteForPlayer(actor.room, actor.player, payload.targetPlayerId);
  }

  async listRooms(): Promise<RoomSnapshot[]> {
    const rooms = await this.roomRepository.list();
    return rooms.map((room) => this.snapshot(room));
  }

  async observeRoom(payload: ObserveRoomPayload): Promise<ActionResult> {
    const room = await this.getRoom(payload.roomId);
    if (!room) {
      return this.fail("房间不存在");
    }

    return {
      ok: true,
      room: this.snapshot(room),
    };
  }

  async stopGame(payload: StopGamePayload): Promise<ActionResult> {
    if (!DEBUG) {
      return this.fail("调试模式未开启");
    }

    const roomId = normalizeRoomId(payload.roomId);
    let failure = "房间不存在或操作冲突";
    const room = await this.applyWithLock(roomId, (latest) => {
      const isSandbox = isSandboxRoom(latest) === true;
      if (latest.status !== "playing") {
        failure = "游戏未在进行中";
        return false;
      }

      if (!isSandbox) {
        const player = latest.players.find(
          (candidate) =>
            candidate.id === payload.playerId && candidate.type === "human",
        );
        if (!player) {
          failure = "你不在该房间中";
          return false;
        }
      }

      latest.status = "finished";
      latest.phase = "game_over";
      latest.phaseEndsAt = null;
      latest.winner = null;
      touch(latest);
      return true;
    });

    if (!room) {
      return this.fail(failure);
    }

    this.clearTimers(room.id);
    const snapshot = this.snapshot(room);
    this.broadcastRoom(room);
    this.server?.to(room.id).emit("game.ended", snapshot);

    return {
      ok: true,
      room: snapshot,
    };
  }

  async updateSandboxPlayerModel(payload: UpdateSandboxPlayerModelPayload): Promise<ActionResult> {
    if (!DEBUG) {
      return this.fail("调试模式未开启");
    }

    const roomId = normalizeRoomId(payload.roomId);
    let failure = "房间不存在或操作冲突";

    const room = await this.applyWithLock(roomId, (latest) => {
      if (latest.status !== "waiting") {
        failure = "只能在等待房间修改模型";
        return false;
      }

      const target = latest.players.find(
        (player) => player.id === payload.targetPlayerId && isModelDrivenPlayer(player),
      );
      if (!target) {
        failure = "玩家不存在";
        return false;
      }

      target.aiModelId = payload.modelId || this.aiService.getDefaultModelId();
      touch(latest);
      return true;
    });

    if (!room) {
      return this.fail(failure);
    }

    this.broadcastRoom(room);
    return {
      ok: true,
      room: this.snapshot(room),
    };
  }

  async deleteSandboxRoom(
    payload: DeleteSandboxRoomPayload,
  ): Promise<ActionResult> {
    if (!DEBUG) {
      return this.fail("调试模式未开启");
    }

    const room = await this.getRoom(payload.roomId);
    if (!room) {
      return this.fail("房间不存在");
    }

    if (!isSandboxRoom(room)) {
      return this.fail("只能删除沙盒房");
    }

    if (room.status !== "waiting") {
      return this.fail("只能删除未开局的沙盒房");
    }

    this.clearTimers(room.id);
    await this.roomRepository.delete(room.id);
    return {
      ok: true,
      deletedRoomId: room.id,
    };
  }

  async deleteRoom(payload: DeleteRoomPayload): Promise<ActionResult> {
    if (!DEBUG) {
      return this.fail("调试模式未开启");
    }

    const room = await this.getRoom(payload.roomId);
    if (!room) {
      return this.fail("房间不存在");
    }

    this.clearTimers(room.id);
    await this.roomRepository.delete(room.id);
    return {
      ok: true,
      deletedRoomId: room.id,
    };
  }

  async updateDiscussionDuration(
    payload: UpdateDiscussionDurationPayload,
  ): Promise<ActionResult> {
    const roomId = normalizeRoomId(payload.roomId);
    let failure = "房间不存在或操作冲突";

    const room = await this.applyWithLock(roomId, (latest) => {
      if (latest.status !== "waiting") {
        failure = "只能在开局前修改每轮发言时间";
        return false;
      }

      const isSandbox = isSandboxRoom(latest) === true;
      if (isSandbox && !DEBUG) {
        failure = "调试模式未开启";
        return false;
      }

      if (!isSandbox && payload.playerId !== latest.ownerPlayerId) {
        failure = "只有房主可以修改每轮发言时间";
        return false;
      }

      latest.discussionDurationMs = normalizeDiscussionDuration(payload);
      touch(latest);
      return true;
    });

    if (!room) {
      return this.fail(failure);
    }

    this.broadcastRoom(room);
    return {
      ok: true,
      room: this.snapshot(room),
    };
  }

  async recoverStuckRooms() {
    const rooms = await this.roomRepository.list(200);
    for (const room of rooms) {
      if (room.status !== "playing") {
        continue;
      }

      const endsAt = room.phaseEndsAt
        ? new Date(room.phaseEndsAt).getTime()
        : 0;
      if (endsAt <= 0 || Date.now() < endsAt) {
        continue;
      }

      if (room.phase === "discussion") {
        this.logger.log(`Recovering stuck room ${room.id}: discussion expired, starting vote`);
        await this.startVoting(room);
      } else if (room.phase === "voting") {
        this.logger.log(`Recovering stuck room ${room.id}: voting expired, resolving votes`);
        await this.resolveVotes(room);
      }
    }
  }

  private async startDiscussionById(roomId: string) {
    const room = await this.applyWithLock(roomId, (latest) => {
      if (latest.status !== "playing" || latest.phase !== "resolving") {
        return false;
      }

      latest.currentRound += 1;
      latest.phase = "discussion";
      latest.phaseEndsAt = futureIso(latest.discussionDurationMs);
      this.prepareSandboxSpeechState(latest);
      for (const player of latest.players) {
        if (isModelDrivenPlayer(player)) {
          player.aiSkipBackoffUntil = undefined;
        }
      }
      touch(latest);
      return true;
    });

    if (room) {
      this.afterDiscussionStarted(room);
    }
  }

  private afterDiscussionStarted(room: Room) {
    this.clearTimers(room.id);
    this.broadcastRoom(room);
    this.server?.to(room.id).emit("round.started", this.snapshot(room));
    this.startTick(room);
    if (isSandboxRoom(room)) {
      this.startSandboxSpeechLoop(room);
    } else {
      this.startAiSpeech(room);
      this.startSimulatedHumanSpeech(room);
    }

    this.getTimers(room.id).phase = setTimeout(() => {
      void this.startVotingById(room.id);
    }, room.discussionDurationMs);
  }

  private async startVoting(room: Room) {
    await this.startVotingById(room.id);
  }

  private async startVotingById(roomId: string) {
    const room = await this.applyWithLock(roomId, (latest) => {
      if (latest.status !== "playing" || latest.phase !== "discussion") {
        return false;
      }

      latest.phase = "voting";
      latest.phaseEndsAt = futureIso(VOTE_DURATION_MS);
      latest.sandboxSpeech = undefined;
      touch(latest);
      return true;
    });
    if (!room) {
      return;
    }

    this.clearTimers(room.id);
    this.broadcastRoom(room);
    this.server?.to(room.id).emit("vote.started", this.snapshot(room));
    this.startTick(room);
    this.scheduleAiVotes(room);

    this.getTimers(room.id).phase = setTimeout(() => {
      void this.resolveVotesById(room.id);
    }, VOTE_DURATION_MS);
  }

  private async resolveVotes(room: Room) {
    await this.resolveVotesById(room.id);
  }

  private async resolveVotesById(roomId: string) {
    let eliminatedPlayer:
      | { playerId: string; playerName: string; roundNo: number }
      | null = null;
    const room = await this.applyWithLock(roomId, (latest) => {
      if (latest.status !== "playing" || latest.phase !== "voting") {
        return false;
      }

      eliminatedPlayer = null;
      latest.phase = "resolving";
      latest.phaseEndsAt = null;

      const eliminated = resolveElimination(latest);
      if (eliminated) {
        eliminated.status = "eliminated";
        eliminated.eliminatedRound = latest.currentRound;
        eliminatedPlayer = {
          playerId: eliminated.id,
          playerName: eliminated.name,
          roundNo: latest.currentRound,
        };
      }

      touch(latest);
      return true;
    });
    if (!room) {
      return;
    }

    this.clearTimers(room.id);
    if (eliminatedPlayer) {
      this.server?.to(room.id).emit("player.eliminated", eliminatedPlayer);
    }

    const winner = getWinner(room);
    if (winner) {
      await this.finishGame(room, winner);
      return;
    }

    // spotlight 终局:跑满 max_rounds_forward 即止(AI 存活→AI 胜,否则真人胜)。
    if (room.sandboxForm === "spotlight") {
      const start = room.sandboxStartRound ?? 1;
      const maxFwd = room.sandboxMaxRoundsForward ?? 2;
      if (room.currentRound >= start + maxFwd - 1) {
        const aiAlive = room.players.some(
          (p) => p.type === "ai" && p.status === "alive",
        );
        await this.finishGame(room, aiAlive ? "ai" : "human");
        return;
      }
    }

    this.broadcastRoom(room);
    setTimeout(() => {
      void this.startDiscussionById(room.id);
    }, NEXT_ROUND_DELAY_MS);
  }

  private async finishGame(room: Room, winner: Winner) {
    const saved = await this.applyWithLock(room.id, (latest) => {
      if (latest.status === "finished" || latest.phase === "game_over") {
        return false;
      }

      latest.status = "finished";
      latest.phase = "game_over";
      latest.phaseEndsAt = null;
      latest.winner = winner;
      this.prepareRewardSettlement(latest, winner);
      touch(latest);
      return true;
    });
    if (!saved) {
      return;
    }

    this.clearTimers(saved.id);
    try {
      await this.recordSettledGameResults(saved, winner);
    } catch (error) {
      this.logger.warn(
        `Game stats settlement failed for room ${saved.id}: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }

    try {
      await this.awardSettledPoints(saved, winner);
    } catch (error) {
      this.logger.warn(
        `Reward settlement failed for room ${saved.id}: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
    const snapshot = this.snapshot(saved);
    this.broadcastRoom(saved);
    this.server?.to(saved.id).emit("game.ended", snapshot);
  }

  private startTick(room: Room) {
    this.getTimers(room.id).tick = setInterval(() => {
      const remainingMs = room.phaseEndsAt
        ? Math.max(0, new Date(room.phaseEndsAt).getTime() - Date.now())
        : 0;
      this.server?.to(room.id).emit("round.tick", {
        roomId: room.id,
        roundNo: room.currentRound,
        phase: room.phase,
        remainingMs,
      });
    }, 1_000);
  }

  private startSandboxSpeechLoop(room: Room) {
    void this.runSandboxSpeechLoop(room.id, room.currentRound);
  }

  // ===== 离线沙盒:探测注入(gated,仅 sandbox 房有 sandboxProbeSchedule) =====

  private sandboxRoundMessageCount(room: Room): number {
    return room.messages.filter((m) => m.roundNo === room.currentRound).length;
  }

  private sandboxFireTiming(timing: unknown): {
    after_turn?: number;
    first_turn?: boolean;
    last_turn?: boolean;
    after_ai_speaks?: boolean;
  } {
    return (timing ?? {}) as {
      after_turn?: number;
      first_turn?: boolean;
      last_turn?: boolean;
      after_ai_speaks?: boolean;
    };
  }

  /** 投放所有当前到期的探测(非 last_turn)。在每轮发言 pass 开始时调用一次。 */
  private async deliverDueProbes(roomId: string, roundNo: number): Promise<void> {
    const room = await this.getRoom(roomId);
    const fires = room?.sandboxProbeSchedule?.filter((f) => f.round === roundNo) ?? [];
    for (const fire of fires) {
      if (this.sandboxFireTiming(fire.timing).last_turn === true) continue;
      await this.tryDeliverProbe(roomId, roundNo, fire, false);
    }
  }

  /** 进入投票前:投放 last_turn 探测 + 清算仍未应答的 pending。 */
  private async deliverLastTurnAndFinalize(roomId: string, roundNo: number): Promise<void> {
    const room = await this.getRoom(roomId);
    const fires = room?.sandboxProbeSchedule?.filter((f) => f.round === roundNo) ?? [];
    for (const fire of fires) {
      if (this.sandboxFireTiming(fire.timing).last_turn === true) {
        await this.tryDeliverProbe(roomId, roundNo, fire, true);
      }
    }
    await this.finalizePendingProbe(roomId, roundNo, null);
  }

  private buildProbeTask(fire: NonNullable<Room["sandboxProbeSchedule"]>[number]): string {
    const templates = fire.templates?.length ? fire.templates : undefined;
    return templates
      ? `${fire.intent}\n(可参考措辞:${templates.join(" / ")})`
      : fire.intent;
  }

  /** 尝试投放单个探测;不到期/已投放则无操作。 */
  private async tryDeliverProbe(
    roomId: string,
    roundNo: number,
    fire: NonNullable<Room["sandboxProbeSchedule"]>[number],
    isLastTurn: boolean,
  ): Promise<void> {
    const before = await this.getRoom(roomId);
    if (
      !before ||
      before.status !== "playing" ||
      before.phase !== "discussion" ||
      before.currentRound !== roundNo
    ) {
      return;
    }
    const state =
      before.sandboxProbeState ?? { round: roundNo, delivered: [] as string[], aiSpoke: false };
    if (state.delivered.includes(fire.probe_id)) return;

    const t = this.sandboxFireTiming(fire.timing);
    const msgCount = this.sandboxRoundMessageCount(before);
    const due = isLastTurn
      ? t.last_turn === true
      : (t.first_turn === true && msgCount === 0) ||
        (t.after_turn != null && msgCount >= t.after_turn) ||
        (t.after_ai_speaks === true && state.aiSpoke);
    if (!due) return;

    // 解析投放者:from_seat 存活且非被测 AI;否则确定性改派或跳过。
    let deliverer =
      before.players.find(
        (p) =>
          p.seatNo === fire.from_seat &&
          p.status === "alive" &&
          p.sandboxRole !== "ai_under_test",
      ) ?? null;
    let reassigned = false;
    if (!deliverer) {
      const aliveNonAi = before.players.filter(
        (p) => p.status === "alive" && p.sandboxRole !== "ai_under_test",
      );
      if (aliveNonAi.length === 0) {
        await this.recordProbeSkipped(roomId, roundNo, fire);
        return;
      }
      const idx = this.sandboxDeterministicIndex(
        aliveNonAi.length,
        before.sandboxSeed ?? 0,
        before.sandboxRunIndex ?? 0,
        roundNo,
        fire.probe_id,
      );
      deliverer = aliveNonAi[idx];
      reassigned = true;
    }

    // 让投放者用自己口吻当场生成探测台词(注入 {{本回合任务}})。
    this.emitSpeechGenerating(roomId, deliverer, roundNo);
    const context = this.buildGameContext(before, deliverer);
    context.myProbeTask = this.buildProbeTask(fire);
    const action = await this.aiService.generateSpeech(context);
    this.aiService.recordCalls(action.callRecords);
    const text =
      action.type === "speak" && action.content.trim()
        ? action.content
        : fire.templates?.[0] ?? fire.intent;

    await this.saveProbeDelivery(roomId, roundNo, fire, deliverer, text, reassigned);
    this.clearSpeechGenerating(roomId, deliverer.id, roundNo);

    if (isLastTurn) {
      await this.finalizePendingProbe(roomId, roundNo, null);
    }
  }

  private async saveProbeDelivery(
    roomId: string,
    roundNo: number,
    fire: NonNullable<Room["sandboxProbeSchedule"]>[number],
    deliverer: Player,
    text: string,
    reassigned: boolean,
  ): Promise<void> {
    const saved = await this.applyWithLock(roomId, (latest) => {
      if (
        latest.status !== "playing" ||
        latest.phase !== "discussion" ||
        latest.currentRound !== roundNo
      ) {
        return false;
      }
      const player = latest.players.find((p) => p.id === deliverer.id && p.status === "alive");
      if (!player) return false;
      const message = addChatMessage(latest, player, text);
      message.sandboxIsProbe = true;
      message.sandboxProbeRef = fire.probe_id;
      const prev = latest.sandboxProbeState ?? {
        round: roundNo,
        delivered: [] as string[],
        aiSpoke: false,
      };
      latest.sandboxProbeState = {
        round: roundNo,
        delivered: [...prev.delivered, fire.probe_id],
        aiSpoke: prev.aiSpoke,
        pendingResponseProbeId: fire.probe_id,
        pendingDeliveredText: text,
        pendingFromSeat: player.seatNo,
        pendingReassigned: reassigned,
      };
      player.aiLastConsideredRound = roundNo;
      player.aiLastConsideredAt = Date.now();
      touch(latest);
      return true;
    });
    if (saved) {
      const msg = [...saved.messages]
        .reverse()
        .find((m) => m.sandboxProbeRef === fire.probe_id && m.roundNo === roundNo);
      if (msg) {
        this.server?.to(roomId).emit("chat.message", toPublicMessage(msg, saved));
      }
      this.broadcastRoom(saved);
    }
  }

  private async recordProbeSkipped(
    roomId: string,
    roundNo: number,
    fire: NonNullable<Room["sandboxProbeSchedule"]>[number],
  ): Promise<void> {
    await this.applyWithLock(roomId, (latest) => {
      const prev = latest.sandboxProbeState ?? {
        round: roundNo,
        delivered: [] as string[],
        aiSpoke: false,
      };
      latest.sandboxProbeState = {
        ...prev,
        delivered: [...prev.delivered, fire.probe_id],
      };
      latest.sandboxProbeEvents ??= [];
      latest.sandboxProbeEvents.push({
        probe_ref: fire.probe_id,
        type: fire.type,
        round: roundNo,
        from_slot: fire.from_seat,
        delivered_text: "",
        ai_response_idx: null,
        auto_eval: null,
        judge_eval_needed: true,
        status: "skipped_no_deliverer",
      });
      touch(latest);
      return true;
    });
  }

  /** 被测 AI 发言后:置 aiSpoke,并清算待应答探测。 */
  private async onSandboxAiSpoke(
    roomId: string,
    roundNo: number,
    aiPlayerId: string,
    aiText: string,
  ): Promise<void> {
    await this.applyWithLock(roomId, (latest) => {
      if (latest.currentRound !== roundNo || !latest.sandboxProbeState) return false;
      latest.sandboxProbeState = { ...latest.sandboxProbeState, aiSpoke: true };
      touch(latest);
      return true;
    });
    const room = await this.getRoom(roomId);
    if (room?.sandboxProbeState?.pendingResponseProbeId) {
      const lastAi = [...room.messages]
        .reverse()
        .find((m) => m.roundNo === roundNo && m.playerId === aiPlayerId);
      const idx = lastAi ? room.messages.indexOf(lastAi) : -1;
      await this.finalizePendingProbe(roomId, roundNo, { text: aiText, idx });
    }
  }

  /** 清算待应答探测:跑 checker、写 probe_event。aiResponse=null 表示无应答。 */
  private async finalizePendingProbe(
    roomId: string,
    roundNo: number,
    aiResponse: { text: string; idx: number } | null,
  ): Promise<void> {
    await this.applyWithLock(roomId, (latest) => {
      const state = latest.sandboxProbeState;
      if (!state?.pendingResponseProbeId) return false;
      const probeId = state.pendingResponseProbeId;
      const fire = latest.sandboxProbeSchedule?.find((f) => f.probe_id === probeId);
      const { autoEval, judgeEvalNeeded } = aiResponse
        ? runAutoCheck(fire?.auto_check ?? null, aiResponse.text)
        : { autoEval: null, judgeEvalNeeded: true };
      latest.sandboxProbeEvents ??= [];
      latest.sandboxProbeEvents.push({
        probe_ref: probeId,
        type: fire?.type ?? "unknown",
        round: roundNo,
        from_slot: state.pendingFromSeat ?? fire?.from_seat ?? 0,
        delivered_text: state.pendingDeliveredText ?? "",
        ai_response_idx: aiResponse ? (aiResponse.idx >= 0 ? aiResponse.idx : null) : null,
        auto_eval: autoEval,
        judge_eval_needed: judgeEvalNeeded,
        status: state.pendingReassigned ? "reassigned" : "delivered",
      });
      latest.sandboxProbeState = {
        ...state,
        pendingResponseProbeId: undefined,
        pendingDeliveredText: undefined,
        pendingFromSeat: undefined,
        pendingReassigned: undefined,
      };
      touch(latest);
      return true;
    });
  }

  /** 确定性取下标(避免依赖 sandbox/rng 的跨层导入)。 */
  private sandboxDeterministicIndex(
    length: number,
    ...parts: Array<number | string>
  ): number {
    if (length <= 0) return 0;
    let h = 0x811c9dc5;
    for (const part of parts) {
      const s = String(part);
      for (let i = 0; i < s.length; i += 1) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
      }
      h ^= 0x2f;
      h = Math.imul(h, 0x01000193);
    }
    return Math.floor(((h >>> 0) / 4294967296) * length);
  }

  private async runSandboxSpeechLoop(
    roomId: string,
    roundNo: number,
  ) {
    while (true) {
      const room = await this.beginSandboxSpeechPass(roomId, roundNo);
      if (!room) {
        return;
      }

      const players = this.getSandboxSpeechPassPlayers(room);
      if (players.length === 0) {
        return;
      }

      // 沙盒探测:pass 开始时投放当前到期的探测(first_turn/after_turn/after_ai_speaks)。
      if (room.sandboxProbeSchedule?.length) {
        await this.deliverDueProbes(roomId, roundNo);
      }

      for (const player of players) {
        const before = await this.getRoom(roomId);
        if (
          !before ||
          before.status !== "playing" ||
          before.phase !== "discussion" ||
          before.currentRound !== roundNo
        ) {
          return;
        }

        const freshPlayer = before.players.find(
          (candidate) =>
            candidate.id === player.id &&
            isModelDrivenPlayer(candidate) &&
            candidate.status === "alive",
        );
        if (!freshPlayer) {
          continue;
        }

        this.emitSpeechGenerating(roomId, freshPlayer, roundNo);

        const contextMark = this.markAiSpeechContext(before);
        const schedulerKind = this.playerSpeechSchedulerKind(freshPlayer);
        const context = this.buildGameContext(before, freshPlayer);
        const action = await this.aiService.generateSpeech(context);

        const after = await this.getRoom(roomId);
        if (
          !after ||
          after.status !== "playing" ||
          after.phase !== "discussion" ||
          after.currentRound !== roundNo ||
          this.hasInvalidatedSpeechContext(after, contextMark)
        ) {
          this.logDiscardedSpeech(
            roomId,
            freshPlayer,
            schedulerKind,
            roundNo,
            "沙盒顺序发言返回后对局已离开发言阶段或上下文失效",
            action.type === "speak" ? action.content : undefined,
          );
          this.aiService.recordCalls(action.callRecords);
          this.emitSpeechDiscarded(
            roomId,
            freshPlayer,
            "对局已离开发言阶段或上下文失效",
            roundNo,
          );
          return;
        }

        if (action.type === "skip") {
          await this.markSandboxSpeechConsidered(
            roomId,
            freshPlayer.id,
            roundNo,
          );
          this.aiService.recordCalls(action.callRecords);
          this.emitSpeechDiscarded(roomId, freshPlayer, "skip", roundNo);
          continue;
        }

        const saved = await this.saveSandboxSpeech(
          roomId,
          freshPlayer.id,
          roundNo,
          action.content,
        );
        this.aiService.recordCalls(action.callRecords);
        if (saved) {
          this.clearSpeechGenerating(roomId, freshPlayer.id, roundNo);
          this.broadcastRoom(saved);
          // 沙盒探测:被测 AI 发言后置 aiSpoke,并清算待应答探测(跑 auto_eval)。
          if (freshPlayer.sandboxRole === "ai_under_test" && saved.sandboxProbeSchedule?.length) {
            await this.onSandboxAiSpoke(roomId, roundNo, freshPlayer.id, action.content);
          }
        } else {
          this.logDiscardedSpeech(
            roomId,
            freshPlayer,
            schedulerKind,
            roundNo,
            "沙盒顺序发言保存失败",
            action.content,
          );
          this.emitSpeechDiscarded(roomId, freshPlayer, "保存发言失败", roundNo);
          return;
        }
      }

      const passResult = await this.completeSandboxSpeechPass(
        roomId,
        roundNo,
      );
      if (passResult === "start-voting") {
        // 沙盒探测:进入投票前投放 last_turn 探测 + 清算未应答 pending。
        if (room.sandboxProbeSchedule?.length) {
          await this.deliverLastTurnAndFinalize(roomId, roundNo);
        }
        await this.startVotingById(roomId);
        return;
      }
      if (passResult === "stop") {
        return;
      }
    }
  }

  private async beginSandboxSpeechPass(
    roomId: string,
    roundNo: number,
  ): Promise<Room | null> {
    return this.applyWithLock(roomId, (latest) => {
      if (
        latest.status !== "playing" ||
        latest.phase !== "discussion" ||
        latest.currentRound !== roundNo ||
        !isSandboxRoom(latest)
      ) {
        return false;
      }

      const players = latest.players.filter(
        (player) => isModelDrivenPlayer(player) && player.status === "alive",
      );
      if (players.length === 0) {
        return false;
      }

      const state =
        this.getSandboxSpeechState(latest) ??
        {
          roundNo,
          startOffset: 0,
          passNo: 0,
        };
      latest.sandboxSpeech = {
        roundNo,
        startOffset: state.startOffset % players.length,
        passNo: state.passNo,
        passInProgress: true,
        passStartedAt: Date.now(),
      };
      touch(latest);
      return true;
    });
  }

  private getSandboxSpeechPassPlayers(room: Room): Player[] {
    const players = room.players
      .filter((player) => isModelDrivenPlayer(player) && player.status === "alive")
      .sort((a, b) => a.seatNo - b.seatNo);
    if (players.length <= 1) {
      return players;
    }

    const state = this.getSandboxSpeechState(room);
    const startIndex = state
      ? state.startOffset % players.length
      : 0;
    return [
      ...players.slice(startIndex),
      ...players.slice(0, startIndex),
    ];
  }

  private getSandboxSpeechState(room: Room) {
    if (
      room.sandboxSpeech &&
      room.sandboxSpeech.roundNo === room.currentRound
    ) {
      return room.sandboxSpeech;
    }

    return null;
  }

  private prepareSandboxSpeechState(room: Room) {
    if (!isSandboxRoom(room)) {
      room.sandboxSpeech = undefined;
      return;
    }

    const modelDrivenCount = room.players.filter(
      (player) => isModelDrivenPlayer(player) && player.status === "alive",
    ).length;
    room.sandboxSpeech = {
      roundNo: room.currentRound,
      startOffset:
        modelDrivenCount > 0
          ? Math.floor(Math.random() * modelDrivenCount)
          : 0,
      passNo: 0,
      passInProgress: false,
    };
  }

  private async completeSandboxSpeechPass(
    roomId: string,
    roundNo: number,
  ): Promise<SandboxSpeechPassResult> {
    let result: SandboxSpeechPassResult = "stop";
    const saved = await this.applyWithLock(roomId, (latest) => {
      if (
        latest.status !== "playing" ||
        latest.phase !== "discussion" ||
        latest.currentRound !== roundNo ||
        !isSandboxRoom(latest)
      ) {
        return false;
      }

      const players = latest.players.filter(
        (player) => isModelDrivenPlayer(player) && player.status === "alive",
      );
      if (players.length === 0) {
        return false;
      }

      const phaseEnded =
        latest.phaseEndsAt != null &&
        Date.now() >= new Date(latest.phaseEndsAt).getTime();
      const state =
        this.getSandboxSpeechState(latest) ??
        {
          roundNo,
          startOffset: 0,
          passNo: 0,
        };
      if (phaseEnded) {
        latest.sandboxSpeech = {
          roundNo,
          startOffset: state.startOffset % players.length,
          passNo: state.passNo + 1,
          passInProgress: false,
          passStartedAt: state.passStartedAt,
        };
        touch(latest);
        result = "start-voting";
        return true;
      }

      latest.sandboxSpeech = {
        roundNo,
        startOffset: (state.startOffset + 1) % players.length,
        passNo: state.passNo + 1,
        passInProgress: false,
      };
      touch(latest);
      result = "continue";
      return true;
    });

    return saved ? result : "stop";
  }

  private async markSandboxSpeechConsidered(
    roomId: string,
    playerId: string,
    roundNo: number,
  ) {
    await this.applyWithLock(roomId, (latest) => {
      if (
        latest.status !== "playing" ||
        latest.phase !== "discussion" ||
        latest.currentRound !== roundNo
      ) {
        return false;
      }

      const player = latest.players.find(
        (candidate) =>
          candidate.id === playerId &&
          isModelDrivenPlayer(candidate) &&
          candidate.status === "alive",
      );
      if (!player) {
        return false;
      }

      player.aiLastConsideredRound = roundNo;
      player.aiLastConsideredAt = Date.now();
      player.aiSkipBackoffUntil = undefined;
      touch(latest);
      return true;
    });
  }

  private async saveSandboxSpeech(
    roomId: string,
    playerId: string,
    roundNo: number,
    content: string,
  ): Promise<Room | null> {
    return this.applyWithLock(roomId, (latest) => {
      if (
        latest.status !== "playing" ||
        latest.phase !== "discussion" ||
        latest.currentRound !== roundNo
      ) {
        return false;
      }

      const player = latest.players.find(
        (candidate) =>
          candidate.id === playerId &&
          isModelDrivenPlayer(candidate) &&
          candidate.status === "alive",
      );
      if (!player) {
        return false;
      }

      player.aiLastConsideredRound = roundNo;
      player.aiLastConsideredAt = Date.now();
      player.aiSkipBackoffUntil = undefined;
      this.addMessage(latest, player, content, false);
      return true;
    });
  }

  private playerSpeechSchedulerKind(
    player: Player,
  ): SpeechSchedulerKind {
    return isSimulatedHuman(player) ? "simulated-human" : "ai";
  }

  private startAiSpeech(room: Room) {
    this.startModelSpeech(room, "ai", AI_SPEECH_INITIAL_CHECK_MS);
  }

  private startSimulatedHumanSpeech(room: Room) {
    this.startModelSpeech(room, "simulated-human", AI_SPEECH_INITIAL_CHECK_MS);
  }

  private startModelSpeech(
    room: Room,
    schedulerKind: SpeechSchedulerKind,
    initialDelayMs: number,
  ) {
    const roomId = room.id;
    const timerKey = this.speechTimerKey(schedulerKind);
    const speaking = this.speechSpeakingMap(schedulerKind);

    const scheduleNext = (delayMs: number) => {
      this.getTimers(roomId)[timerKey] = setTimeout(async () => {
        const room = await this.getRoom(roomId);
        if (!room) {
          return;
        }

        if (room.phase !== "discussion") {
          return;
        }

        if (speaking.get(room.id)) {
          scheduleNext(AI_SPEECH_NEXT_CHECK_MIN_MS);
          return;
        }

        const aiPlayer = this.selectSpeechPlayer(room, schedulerKind);
        if (!aiPlayer) {
          scheduleNext(AI_SPEECH_NEXT_CHECK_MIN_MS);
          return;
        }

        if (isSandboxRoom(room)) {
          this.emitSpeechGenerating(room.id, aiPlayer, room.currentRound);
        }

        const contextMark = this.markAiSpeechContext(room);
        const decisionStartedAt = Date.now();
        let nextDelayMs: number | null = AI_SPEECH_NEXT_CHECK_MIN_MS;
        speaking.set(room.id, true);
        try {
          const context = this.buildGameContext(room, aiPlayer);
          const action = await this.aiService.generateSpeech(context);
          nextDelayMs = this.clampModelNextCheckDelay(
            action.nextCheckAfterMs,
            aiPlayer,
          );

          const latestAfterModel = await this.getRoom(room.id);
          if (
            !latestAfterModel ||
            latestAfterModel.status !== "playing" ||
            latestAfterModel.phase !== "discussion" ||
            latestAfterModel.currentRound !== contextMark.roundNo
          ) {
            this.logDiscardedSpeech(
              room.id,
              aiPlayer,
              schedulerKind,
              contextMark.roundNo,
              "模型返回后对局已离开发言阶段或轮次已变化",
              action.type === "speak" ? action.content : undefined,
            );
            if (latestAfterModel && isSandboxRoom(latestAfterModel)) {
              this.emitSpeechDiscarded(
                room.id,
                aiPlayer,
                "对局已离开发言阶段",
                contextMark.roundNo,
              );
            }
            nextDelayMs = null;
            return;
          }

          if (this.hasInvalidatedSpeechContext(latestAfterModel, contextMark)) {
            this.logDiscardedSpeech(
              room.id,
              aiPlayer,
              schedulerKind,
              contextMark.roundNo,
              "模型返回后上下文已失效",
              action.type === "speak" ? action.content : undefined,
            );
            if (isSandboxRoom(latestAfterModel)) {
              this.emitSpeechDiscarded(
                room.id,
                aiPlayer,
                "上下文已失效",
                contextMark.roundNo,
              );
            }
            nextDelayMs = this.randomAiStaleRetryDelay();
            return;
          }

          if (action.type === "skip") {
            await this.markAiSpeechSkipped(
              room.id,
              aiPlayer.id,
              contextMark.roundNo,
              schedulerKind,
            );
            this.aiService.recordCalls(action.callRecords);
            if (isSandboxRoom(room)) {
              this.emitSpeechDiscarded(room.id, aiPlayer, "skip", contextMark.roundNo);
            }
          }

          if (action.type === "speak") {
            const elapsedMs = Date.now() - decisionStartedAt;
            const targetDelayMs = this.clampModelResponseDelay(
              action.targetResponseDelayMs,
              aiPlayer,
            );
            const remainingDelayMs = Math.max(0, targetDelayMs - elapsedMs);
            if (remainingDelayMs > 0) {
              await this.delay(remainingDelayMs);
            }

            let staleAtSave = false;
            let discardReason: string | null = null;
            const saved = await this.applyWithLock(room.id, (latest) => {
              if (
                latest.status !== "playing" ||
                latest.phase !== "discussion" ||
                latest.currentRound !== contextMark.roundNo
              ) {
                discardReason = "保存发言时对局已离开发言阶段或轮次已变化";
                return false;
              }

              const freshAiPlayer = latest.players.find(
                (player) =>
                  player.id === aiPlayer.id &&
                  this.isSpeechSchedulerPlayer(player, schedulerKind) &&
                  player.status === "alive",
              );
              if (!freshAiPlayer) {
                discardReason = "保存发言时玩家不存在、已出局或不属于当前调度器";
                return false;
              }

              if (this.hasInvalidatedSpeechContext(latest, contextMark)) {
                staleAtSave = true;
                discardReason = "保存发言时上下文已失效";
                return false;
              }

              freshAiPlayer.aiLastConsideredRound = contextMark.roundNo;
              freshAiPlayer.aiLastConsideredAt = Date.now();
              freshAiPlayer.aiSkipBackoffUntil = undefined;
              this.addMessage(latest, freshAiPlayer, action.content, false);
              return true;
            });

            if (staleAtSave) {
              this.logDiscardedSpeech(
                room.id,
                aiPlayer,
                schedulerKind,
                contextMark.roundNo,
                discardReason ?? "保存发言时上下文已失效",
                action.content,
              );
              if (isSandboxRoom(room)) {
                this.emitSpeechDiscarded(
                  room.id,
                  aiPlayer,
                  discardReason ?? "上下文已失效",
                  contextMark.roundNo,
                );
              }
              nextDelayMs = this.randomAiStaleRetryDelay();
              return;
            }

            if (saved) {
              this.aiService.recordCalls(action.callRecords);
              this.clearSpeechGenerating(
                room.id,
                aiPlayer.id,
                contextMark.roundNo,
              );
              this.broadcastRoom(saved);
            } else {
              this.logDiscardedSpeech(
                room.id,
                aiPlayer,
                schedulerKind,
                contextMark.roundNo,
                discardReason ?? "保存发言失败",
                action.content,
              );
              if (isSandboxRoom(room)) {
                this.emitSpeechDiscarded(
                  room.id,
                  aiPlayer,
                  discardReason ?? "保存发言失败",
                  contextMark.roundNo,
                );
              }
            }
          }
        } finally {
          speaking.set(room.id, false);
          if (nextDelayMs != null) {
            const latest = await this.getRoom(room.id);
            if (latest?.status === "playing" && latest.phase === "discussion") {
              scheduleNext(nextDelayMs);
            }
          }
        }
      }, delayMs);
    };

    scheduleNext(initialDelayMs);
  }

  private selectSpeechPlayer(
    room: Room,
    schedulerKind: SpeechSchedulerKind,
  ): Player | null {
    const now = Date.now();
    const candidates = room.players.filter(
      (player) =>
        this.isSpeechSchedulerPlayer(player, schedulerKind) &&
        player.status === "alive" &&
        now - player.lastSpokeAt >= this.modelSpeechCooldownMs(player) &&
        (player.aiSkipBackoffUntil ?? 0) <= now,
    );

    if (candidates.length === 0) {
      return null;
    }

    return this.selectByRoundFreshness(room, candidates);
  }

  private isSpeechSchedulerPlayer(
    player: Player,
    schedulerKind: SpeechSchedulerKind,
  ): boolean {
    if (schedulerKind === "ai") {
      return player.type === "ai";
    }

    return isSimulatedHuman(player);
  }

  private speechTimerKey(
    schedulerKind: SpeechSchedulerKind,
  ): SpeechTimerKey {
    return schedulerKind === "ai" ? "aiSpeech" : "simulatedHumanSpeech";
  }

  private speechSpeakingMap(
    schedulerKind: SpeechSchedulerKind,
  ): Map<string, boolean> {
    return schedulerKind === "ai"
      ? this.aiSpeaking
      : this.simulatedHumanSpeaking;
  }

  private emitSpeechGenerating(roomId: string, player: Player, roundNo?: number) {
    const payload: SpeechGeneratingPayload = {
      roomId,
      roundNo,
      playerId: player.id,
      playerName: player.name,
      seatNo: player.seatNo,
      startedAt: new Date().toISOString(),
    };
    const roomSpeechGeneratings =
      this.speechGeneratings.get(roomId) ??
      new Map<string, SpeechGeneratingPayload>();
    roomSpeechGeneratings.set(player.id, payload);
    this.speechGeneratings.set(roomId, roomSpeechGeneratings);
    this.server?.to(roomId).emit("player.speech.generating", payload);
  }

  private emitSpeechDiscarded(
    roomId: string,
    player: Player,
    reason: string,
    roundNo?: number,
  ) {
    this.clearSpeechGenerating(roomId, player.id, roundNo);
    this.server?.to(roomId).emit("player.speech.discarded", {
      roomId,
      roundNo,
      playerId: player.id,
      playerName: player.name,
      seatNo: player.seatNo,
      reason,
      discardedAt: new Date().toISOString(),
    });
  }

  private clearSpeechGenerating(
    roomId: string,
    playerId?: string,
    roundNo?: number,
  ) {
    const roomSpeechGeneratings = this.speechGeneratings.get(roomId);
    if (!roomSpeechGeneratings) {
      return;
    }

    if (!playerId) {
      this.speechGeneratings.delete(roomId);
      return;
    }

    const current = roomSpeechGeneratings.get(playerId);
    if (!current) {
      return;
    }

    if (roundNo !== undefined && current.roundNo !== roundNo) {
      return;
    }

    roomSpeechGeneratings.delete(playerId);
    if (roomSpeechGeneratings.size === 0) {
      this.speechGeneratings.delete(roomId);
    }
  }

  private snapshotSpeechGeneratings(room: Room): SpeechGeneratingPayload[] {
    const roomSpeechGeneratings = this.speechGeneratings.get(room.id);
    if (!roomSpeechGeneratings) {
      return [];
    }

    if (
      !isSandboxRoom(room) ||
      room.status !== "playing" ||
      room.phase !== "discussion"
    ) {
      this.speechGeneratings.delete(room.id);
      return [];
    }

    const payloads: SpeechGeneratingPayload[] = [];
    for (const [playerId, payload] of roomSpeechGeneratings) {
      const player = room.players.find(
        (candidate) =>
          candidate.id === playerId &&
          isModelDrivenPlayer(candidate) &&
          candidate.status === "alive",
      );
      const wrongRound =
        payload.roundNo !== undefined && payload.roundNo !== room.currentRound;
      if (!player || wrongRound) {
        roomSpeechGeneratings.delete(playerId);
        continue;
      }

      payloads.push({
        ...payload,
        roomId: room.id,
        roundNo: payload.roundNo ?? room.currentRound,
        playerName: player.name,
        seatNo: player.seatNo,
      });
    }

    if (roomSpeechGeneratings.size === 0) {
      this.speechGeneratings.delete(room.id);
    }

    return payloads.sort((first, second) => first.seatNo - second.seatNo);
  }

  private logDiscardedSpeech(
    roomId: string,
    player: Player,
    schedulerKind: SpeechSchedulerKind,
    roundNo: number,
    reason: string,
    content?: string,
  ) {
    const contentPreview = content
      ? ` content="${content.replace(/\s+/g, " ").slice(0, 120)}"`
      : "";
    this.logger.warn(
      [
        "Discarded model speech",
        `room=${roomId}`,
        `round=${roundNo}`,
        `scheduler=${schedulerKind}`,
        `seat=${player.seatNo}`,
        `player=${player.name}`,
        `reason=${reason}`,
      ].join(" ") + contentPreview,
    );
  }

  private selectByRoundFreshness(room: Room, candidates: Player[]): Player {
    const unspokenAndUnconsidered = candidates.filter(
      (player) =>
        !this.hasAiSpokenThisRound(room, player.id) &&
        player.aiLastConsideredRound !== room.currentRound,
    );
    if (unspokenAndUnconsidered.length > 0) {
      return randomItem(unspokenAndUnconsidered);
    }

    const unspoken = candidates.filter(
      (player) => !this.hasAiSpokenThisRound(room, player.id),
    );
    if (unspoken.length > 0) {
      return randomItem(unspoken);
    }

    const unconsidered = candidates.filter(
      (player) => player.aiLastConsideredRound !== room.currentRound,
    );
    if (unconsidered.length > 0) {
      return randomItem(unconsidered);
    }

    return randomItem(candidates);
  }

  private hasAiSpokenThisRound(room: Room, playerId: string): boolean {
    return room.messages.some(
      (message) =>
        message.roundNo === room.currentRound && message.playerId === playerId,
    );
  }

  private async markAiSpeechSkipped(
    roomId: string,
    aiPlayerId: string,
    roundNo: number,
    schedulerKind: SpeechSchedulerKind,
  ) {
    await this.applyWithLock(roomId, (latest) => {
      if (
        latest.status !== "playing" ||
        latest.phase !== "discussion" ||
        latest.currentRound !== roundNo
      ) {
        return false;
      }

      const player = latest.players.find(
        (candidate) =>
          candidate.id === aiPlayerId &&
          this.isSpeechSchedulerPlayer(candidate, schedulerKind) &&
          candidate.status === "alive",
      );
      if (!player) {
        return false;
      }

      player.aiLastConsideredRound = roundNo;
      player.aiLastConsideredAt = Date.now();
      player.aiSkipBackoffUntil =
        Date.now() + this.modelSpeechSkipBackoffMs(player);
      touch(latest);
      return true;
    });
  }

  private markAiSpeechContext(room: Room): AiSpeechContextMark {
    return {
      roundNo: room.currentRound,
      voteCount: room.votes.length,
    };
  }

  private hasInvalidatedSpeechContext(
    room: Room,
    mark: AiSpeechContextMark,
  ): boolean {
    return (
      room.currentRound !== mark.roundNo ||
      room.votes.length !== mark.voteCount
    );
  }

  private clampAiNextCheckDelay(delayMs: number): number {
    return Math.min(
      AI_SPEECH_NEXT_CHECK_MAX_MS,
      Math.max(AI_SPEECH_NEXT_CHECK_MIN_MS, delayMs),
    );
  }

  private clampModelNextCheckDelay(delayMs: number, player: Player): number {
    if (isSimulatedHuman(player)) {
      return Math.min(
        SIM_HUMAN_SPEECH_NEXT_CHECK_MAX_MS,
        Math.max(AI_SPEECH_NEXT_CHECK_MIN_MS, delayMs),
      );
    }

    return this.clampAiNextCheckDelay(delayMs);
  }

  private clampAiResponseDelay(delayMs: number): number {
    return Math.min(
      AI_SPEECH_RESPONSE_DELAY_MAX_MS,
      Math.max(AI_SPEECH_RESPONSE_DELAY_MIN_MS, delayMs),
    );
  }

  private clampModelResponseDelay(delayMs: number, player: Player): number {
    if (isSimulatedHuman(player)) {
      return Math.min(
        SIM_HUMAN_SPEECH_RESPONSE_DELAY_MAX_MS,
        Math.max(AI_SPEECH_RESPONSE_DELAY_MIN_MS, delayMs),
      );
    }

    return this.clampAiResponseDelay(delayMs);
  }

  private modelSpeechCooldownMs(player: Player): number {
    return isSimulatedHuman(player)
      ? SIM_HUMAN_SPEECH_COOLDOWN_MS
      : SPEAK_COOLDOWN_MS;
  }

  private modelSpeechSkipBackoffMs(player: Player): number {
    return isSimulatedHuman(player)
      ? SIM_HUMAN_SPEECH_SKIP_BACKOFF_MS
      : AI_SPEECH_SKIP_BACKOFF_MS;
  }

  private randomAiStaleRetryDelay(): number {
    return (
      AI_SPEECH_STALE_RETRY_MIN_MS +
      Math.random() *
        (AI_SPEECH_STALE_RETRY_MAX_MS - AI_SPEECH_STALE_RETRY_MIN_MS)
    );
  }

  private delay(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    });
  }

  private scheduleAiVotes(room: Room) {
    const aiPlayers = room.players.filter(
      (player) => isModelDrivenPlayer(player) && player.status === "alive",
    );

    aiPlayers.forEach((aiPlayer, index) => {
      setTimeout(() => {
        void this.castAiVote(room.id, aiPlayer.id);
      }, AI_VOTE_DELAY_MS + index * AI_VOTE_STAGGER_MS);
    });
  }

  private async castAiVote(roomId: string, aiPlayerId: string) {
    const room = await this.getRoom(roomId);
    if (!room || room.phase !== "voting") {
      return;
    }

    const aiPlayer = room.players.find(
      (player) =>
        player.id === aiPlayerId &&
        isModelDrivenPlayer(player) &&
        player.status === "alive",
    );
    if (!aiPlayer) {
      return;
    }

    // 沙盒投票策略分支(槽位 override 优先);非沙盒或缺省走 live。
    const policy = this.effectiveVotePolicy(room, aiPlayer);

    if (policy === "rule") {
      // rule:确定性特征函数,零 LLM。
      const target = ruleVote(room, aiPlayer);
      if (target) {
        await this.castVoteForPlayer(room, aiPlayer, target.id, {
          voteSource: "model",
          policyApplied: "rule",
        });
      }
      return;
    }

    if (policy === "scripted") {
      // scripted:查场景写死的投票目标。
      const targetSeat = room.sandboxScriptedVotes?.find(
        (v) => v.round === room.currentRound && v.voter_seat === aiPlayer.seatNo,
      )?.target_seat;
      const target =
        targetSeat != null
          ? room.players.find(
              (p) => p.seatNo === targetSeat && p.status === "alive" && p.id !== aiPlayer.id,
            )
          : undefined;
      if (target) {
        await this.castVoteForPlayer(room, aiPlayer, target.id, {
          voteSource: "model",
          policyApplied: "scripted",
        });
      }
      return;
    }

    // live(默认):真投。
    const context = this.buildGameContext(room, aiPlayer);
    const voteAction = await this.aiService.generateVote(context, aiPlayer.id);

    if (voteAction) {
      await this.castVoteForPlayer(room, aiPlayer, voteAction.targetPlayerId, {
        voteReason: voteAction.reason,
        voteSource: "model",
        policyApplied: "live",
      });
      return;
    }

    const target = chooseFallbackVoteTarget(room, aiPlayer);
    if (target) {
      await this.castVoteForPlayer(room, aiPlayer, target.id, {
        voteSource: "fallback",
        policyApplied: "live",
      });
    }
  }

  /** 沙盒投票策略:按座号 override 优先,否则整局策略,否则 live。 */
  private effectiveVotePolicy(
    room: Room,
    player: Player,
  ): "live" | "rule" | "scripted" {
    return room.sandboxVoteOverrides?.[player.seatNo] ?? room.sandboxVotePolicy ?? "live";
  }

  private buildGameContext(room: Room, aiPlayer: Player): GameContext {
    const alivePlayers = room.players
      .filter((p) => p.status === "alive")
      .map((p) => ({ id: p.id, seatNo: p.seatNo }));

    const seatMap = new Map(room.players.map((p) => [p.id, p.seatNo]));
    const recentMessages = room.messages
      .filter((m) => m.roundNo === room.currentRound)
      .map((m) => ({
        playerName: `${seatMap.get(m.playerId) ?? "?"}号`,
        content: m.content,
      }));

    const historicalMessages = room.messages
      .filter((m) => m.roundNo < room.currentRound)
      .map((m) => ({
        roundNo: m.roundNo,
        playerName: `${seatMap.get(m.playerId) ?? "?"}号`,
        content: m.content,
      }));

    const myLastMessage = [...room.messages]
      .reverse()
      .find((m) => m.playerId === aiPlayer.id);

    const remainingMs = room.phaseEndsAt
      ? Math.max(0, new Date(room.phaseEndsAt).getTime() - Date.now())
      : 0;

    const currentVoteCounts: Record<string, number> = {};
    for (const vote of room.votes) {
      if (vote.roundNo === room.currentRound) {
        currentVoteCounts[vote.targetPlayerId] =
          (currentVoteCounts[vote.targetPlayerId] ?? 0) + 1;
      }
    }

    const voteHistory: RoundVoteSummary[] = [];
    for (let r = 1; r < room.currentRound; r++) {
      const roundVotes: VoteRecord[] = [];
      for (const vote of room.votes) {
        if (vote.roundNo === r) {
          roundVotes.push({
            voterSeatNo: seatMap.get(vote.voterPlayerId) ?? 0,
            targetSeatNo: seatMap.get(vote.targetPlayerId) ?? 0,
          });
        }
      }

      const eliminated = room.players.find(
        (p) => p.eliminatedRound === r,
      );

      voteHistory.push({
        roundNo: r,
        votes: roundVotes,
        eliminatedSeatNo: eliminated?.seatNo ?? null,
      });
    }

    return {
      roomId: room.id,
      roundNo: room.currentRound,
      phase: room.phase,
      remainingTimeMs: remainingMs,
      myName: aiPlayer.name,
      myPlayerId: aiPlayer.id,
      myPlayerType: aiPlayer.type,
      mySimulated: isSimulatedHuman(aiPlayer),
      myModelId: aiPlayer.aiModelId,
      mySeatNo: aiPlayer.seatNo,
      // 任何带 personaId 的 model-driven 玩家(含沙盒侦探/填充)都解析人格;
      // 旧调试模型玩家无 personaId,解析为 null,行为不变。
      myPersona: getAiPersonaById(aiPlayer.aiPersonaId),
      alivePlayers,
      recentMessages,
      historicalMessages,
      myLastSpeech: myLastMessage?.content ?? null,
      currentVoteCounts,
      voteHistory,
      shortMemory: room.aiMemories?.[aiPlayer.id] ?? null,
      myRole: aiPlayer.sandboxRole,
      myPromptVersionId: room.sandboxAiPromptVersionId,
    };
  }

  private rememberAiVote(
    room: Room,
    voter: Player,
    target: Player,
    options?: {
      voteReason?: string;
      voteSource?: AiVoteMemorySource;
      policyApplied?: "live" | "rule" | "scripted";
    },
  ) {
    if (!isModelDrivenPlayer(voter)) {
      return;
    }

    room.aiMemories ??= {};
    const memory = room.aiMemories[voter.id] ?? this.createEmptyAiMemory();
    memory.votes.push({
      roundNo: room.currentRound,
      targetSeatNo: target.seatNo,
      publicReason: options?.voteReason,
      source: options?.voteSource ?? "model",
      policyApplied: options?.policyApplied,
    });
    memory.votes = memory.votes.slice(-4);
    room.aiMemories[voter.id] = memory;
  }

  private createEmptyAiMemory(): AiShortMemory {
    return { votes: [] };
  }

  private async castVoteForPlayer(
    room: Room,
    voter: Player,
    targetPlayerId?: string,
    options?: {
      voteReason?: string;
      voteSource?: AiVoteMemorySource;
      policyApplied?: "live" | "rule" | "scripted";
    },
  ): Promise<ActionResult> {
    const saved = await this.applyWithLock(room.id, (latest) => {
      if (latest.status !== "playing" || latest.phase !== "voting") {
        return false;
      }

      const freshVoter = latest.players.find((p) => p.id === voter.id);
      if (!freshVoter || freshVoter.status !== "alive") {
        return false;
      }

      const target = latest.players.find(
        (player) => player.id === targetPlayerId && player.status === "alive",
      );
      if (!target) {
        return false;
      }

      if (target.id === voter.id) {
        return false;
      }

      const hasVoted = latest.votes.some(
        (vote) => vote.roundNo === latest.currentRound && vote.voterPlayerId === voter.id,
      );
      if (hasVoted) {
        return false;
      }

      latest.votes.push({
        id: randomUUID(),
        roundNo: latest.currentRound,
        voterPlayerId: voter.id,
        targetPlayerId: target.id,
        createdAt: new Date().toISOString(),
      });
      this.rememberAiVote(latest, freshVoter, target, options);
      touch(latest);
      return true;
    });

    if (!saved) {
      return this.fail("投票失败，请重试");
    }

    const snapshot = this.snapshot(saved);
    this.server?.to(saved.id).emit("vote.updated", snapshot);
    this.broadcastRoom(saved);

    const aliveVoters = saved.players.filter((player) => player.status === "alive");
    const roundVotes = saved.votes.filter((item) => item.roundNo === saved.currentRound);
    if (roundVotes.length >= aliveVoters.length) {
      setTimeout(() => {
        void this.resolveVotesById(saved.id);
      }, AUTO_RESOLVE_DELAY_MS);
    }

    return {
      ok: true,
      room: snapshot,
    };
  }

  private addMessage(
    room: Room,
    player: Player,
    content: string,
    emitChatMessage = true,
  ) {
    const message = addChatMessage(room, player, content);
    if (emitChatMessage) {
      this.server?.to(room.id).emit("chat.message", toPublicMessage(message, room));
    }
  }

  private prepareRewardSettlement(room: Room, winner: Winner) {
    if (room.rewardSettledAt) {
      return;
    }

    room.rewardSettledAt = new Date().toISOString();
    if (winner !== "human") {
      room.pointAwards = [];
      return;
    }

    const eligiblePlayers = room.players
      .filter(
        (player) =>
          player.type === "human" &&
          player.status === "alive" &&
          Boolean(player.accountId),
      )
      .sort((a, b) => a.seatNo - b.seatNo);

    if (eligiblePlayers.length === 0) {
      room.pointAwards = [];
      return;
    }

    const basePoints = Math.floor(REWARD_POOL / eligiblePlayers.length);
    const remainder = REWARD_POOL % eligiblePlayers.length;
    const awards: PointAward[] = eligiblePlayers.map((player, index) => ({
      playerId: player.id,
      playerName: player.name,
      points: basePoints + (index < remainder ? 1 : 0),
    }));

    room.pointAwards = awards;
  }

  private async awardSettledPoints(room: Room, winner: Winner) {
    if (winner !== "human" || room.pointAwards.length === 0) {
      return;
    }

    await this.authService.addPointsToAccounts(
      room.pointAwards.flatMap((award) => {
        const accountId = room.players.find(
          (player) => player.id === award.playerId,
        )?.accountId;
        return accountId ? [{ accountId, points: award.points }] : [];
      }),
    );
  }

  private async recordSettledGameResults(room: Room, winner: Winner) {
    const results = room.players.flatMap((player) => {
      if (player.type !== "human" || !player.accountId) {
        return [];
      }

      return [{
        accountId: player.accountId,
        won: winner === "human" && player.status === "alive",
      }];
    });

    if (results.length === 0) {
      return;
    }

    await this.authService.recordGameResults(results);
  }

  /**
   * Apply a mutation to a room with optimistic locking.
   * Loads the room, runs `mutate`, and saves with a version check.
   * Retries up to 3 times if another operation saved in between.
   */
  private async applyWithLock(
    roomId: string,
    mutate: (room: Room) => boolean,
  ): Promise<Room | null> {
    const normalizedId = normalizeRoomId(roomId);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const room = await this.roomRepository.findById(normalizedId);
      if (!room) {
        return null;
      }

      const expectedUpdatedAt = room.updatedAt;
      if (!mutate(room)) {
        return null;
      }

      const saved = await this.roomRepository.save(room, expectedUpdatedAt);
      if (saved) {
        return room;
      }
    }

    this.logger.warn(`applyWithLock: gave up after 3 retries for room ${normalizedId}`);
    return null;
  }

  private getRoom(roomId: string | undefined) {
    return this.roomRepository.findById(normalizeRoomId(roomId));
  }

  private findHumanBySocket(room: Room, socketId: string) {
    return room.players.find(
      (player) => player.type === "human" && player.socketId === socketId,
    );
  }

  private bindHumanForAction(
    room: Room,
    socketId: string,
    playerId: string | undefined,
  ): Player | null {
    const socketPlayer = this.findHumanBySocket(room, socketId);
    if (socketPlayer) {
      return socketPlayer;
    }

    if (!playerId) {
      return null;
    }

    const player = room.players.find(
      (candidate) => candidate.id === playerId && candidate.type === "human",
    );
    if (!player) {
      return null;
    }

    this.cancelDisconnectRemoval(room.id, player.id);
    player.socketId = socketId;
    player.connected = true;
    touch(room);
    return player;
  }

  private async findHumanForAction(
    room: Room,
    socketId: string,
    playerId: string | undefined,
  ): Promise<{ room: Room; player: Player } | null> {
    const socketPlayer = this.findHumanBySocket(room, socketId);
    if (socketPlayer) {
      return {
        room,
        player: socketPlayer,
      };
    }

    if (!playerId) {
      return null;
    }

    const saved = await this.applyWithLock(room.id, (latest) => {
      const player = this.bindHumanForAction(latest, socketId, playerId);
      if (!player) {
        return false;
      }
      return true;
    });
    if (!saved) {
      return null;
    }

    const player = saved.players.find(
      (candidate) => candidate.id === playerId && candidate.type === "human",
    );
    if (!player) {
      return null;
    }

    return {
      room: saved,
      player,
    };
  }

  private cancelDisconnectRemoval(roomId: string, playerId: string) {
    const timerKey = `${roomId}:${playerId}`;
    const existingTimer = this.disconnectTimers.get(timerKey);
    if (!existingTimer) {
      return;
    }

    clearTimeout(existingTimer);
    this.disconnectTimers.delete(timerKey);
  }

  private broadcastRoom(room: Room) {
    this.server?.to(room.id).emit("room.updated", this.snapshot(room));
  }

  private getTimers(roomId: string): RoomTimers {
    const existing = this.timers.get(roomId);
    if (existing) {
      return existing;
    }

    const timers: RoomTimers = {};
    this.timers.set(roomId, timers);
    return timers;
  }

  private clearTimers(roomId: string) {
    const timers = this.timers.get(roomId);
    if (!timers) {
      return;
    }

    if (timers.phase) {
      clearTimeout(timers.phase);
    }
    if (timers.tick) {
      clearInterval(timers.tick);
    }
    if (timers.aiSpeech) {
      clearTimeout(timers.aiSpeech);
    }
    if (timers.simulatedHumanSpeech) {
      clearTimeout(timers.simulatedHumanSpeech);
    }

    this.timers.set(roomId, {});
    this.aiSpeaking.delete(roomId);
    this.simulatedHumanSpeaking.delete(roomId);
    this.speechGeneratings.delete(roomId);
  }

  private fail(error: string): ActionResult {
    return {
      ok: false,
      error,
    };
  }
}
