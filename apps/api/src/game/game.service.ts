import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Server } from "socket.io";
import { AiService } from "../ai/ai.service";
import { PromptRegistry } from "../ai/prompt-registry";
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
  canStartDebugAutoAiRoom,
  chooseFallbackVoteTarget,
  countAi,
  countHumans,
  countSimulatedHumans,
  createAiPlayer,
  createAiPlayers,
  createDebugAutoAiPlayers,
  createHumanPlayer,
  createSimulatedHumanPlayer,
  createRoomId,
  futureIso,
  getWinner,
  isModelDrivenPlayer,
  isSimulatedHuman,
  normalizeContent,
  normalizeDiscussionDuration,
  normalizeRoomId,
  randomItem,
  resolveElimination,
  touch,
  validateCanSpeak,
} from "./game.rules";
import { toPublicMessage, toRoomSnapshot } from "./game.snapshot";
import {
  ActionResult,
  AiShortMemory,
  AiVoteMemorySource,
  CastVotePayload,
  CreateDebugAutoAiRoomPayload,
  CreateRoomPayload,
  DebugAddAiPayload,
  DebugDeleteAutoAiRoomPayload,
  DebugRemoveAiPayload,
  DebugUpdateModelPayload,
  DeleteRoomPayload,
  GameAccount,
  JoinRoomPayload,
  LeaveRoomPayload,
  ObserveRoomPayload,
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
  UpdateDebugAutoAiFastModePayload,
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
type DebugAutoAiSpeechPassResult = "continue" | "start-voting" | "stop";

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
    private readonly prompts: PromptRegistry,
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

  async createDebugAutoAiRoom(
    payload: CreateDebugAutoAiRoomPayload,
  ): Promise<ActionResult> {
    if (!DEBUG) {
      return this.fail("调试模式未开启");
    }

    const now = new Date().toISOString();
    const defaultModelId = this.aiService.getDefaultModelId();
    const aiPlayers = createDebugAutoAiPlayers(1, undefined, undefined, defaultModelId);
    const room: Room = {
      id: createRoomId(),
      status: "waiting",
      ownerPlayerId: aiPlayers[0].id,
      debugAutoAi: true,
      debugAutoAiFastMode: payload.fastMode === true,
      players: aiPlayers,
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
      playerId: room.ownerPlayerId,
    };
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

      if (latest.debugAutoAi) {
        failure = "自动对抗调试房不能加入真人玩家";
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
      const isDebugAutoAiRoom = DEBUG && latest.debugAutoAi === true;
      if (latest.status !== "waiting") {
        failure = "游戏已经开始";
        return false;
      }

      if (!isDebugAutoAiRoom && payload.playerId !== latest.ownerPlayerId) {
        failure = "只有房主可以开始游戏";
        return false;
      }

      if (isDebugAutoAiRoom) {
        if (countAi(latest) < 1) {
          failure = "至少需要 1 名 AI 玩家";
          return false;
        }

        if (countSimulatedHumans(latest) < 1) {
          failure = "至少需要 1 名模拟真人玩家";
          return false;
        }

        if (!canStartDebugAutoAiRoom(latest)) {
          failure = "自动对局至少需要 1 名 AI 和 1 名模拟真人";
          return false;
        }
      } else if (countHumans(latest) < 1) {
        failure = "至少需要 1 名真人玩家";
        return false;
      }

      latest.status = "playing";
      latest.promptGenerationId = this.prompts.getActiveGenerationId();
      latest.winner = null;
      latest.currentRound = 1;
      latest.phase = "discussion";
      latest.phaseEndsAt = futureIso(latest.discussionDurationMs);
      this.prepareDebugAutoAiSpeechState(latest);
      latest.messages = [];
      latest.votes = [];
      latest.aiMemories = {};
      latest.pointAwards = [];
      latest.rewardSettledAt = null;
      for (const player of latest.players) {
        player.status = "alive";
        player.lastSpokeAt = 0;
        player.eliminatedRound = undefined;
        if (isModelDrivenPlayer(player)) {
          player.aiLastConsideredRound = undefined;
          player.aiLastConsideredAt = undefined;
          player.aiSkipBackoffUntil = undefined;
        }
      }

      if (!isDebugAutoAiRoom) {
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

      latest.players.sort(() => Math.random() - 0.5);
      latest.players.forEach((player, index) => {
        player.seatNo = index + 1;
      });

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
      const isDebugAutoAiRoom = latest.debugAutoAi === true;
      if (latest.status !== "playing") {
        failure = "游戏未在进行中";
        return false;
      }

      if (!isDebugAutoAiRoom) {
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

  async addDebugAi(payload: DebugAddAiPayload): Promise<ActionResult> {
    if (!DEBUG) {
      return this.fail("调试模式未开启");
    }

    const roomId = normalizeRoomId(payload.roomId);
    let failure = "房间不存在或操作冲突";

    const room = await this.applyWithLock(roomId, (latest) => {
      const isDebugAutoAiRoom = latest.debugAutoAi === true;
      const playerType = payload.playerType === "human" ? "human" : "ai";
      const modelId = payload.modelId || (isDebugAutoAiRoom ? this.aiService.getDefaultModelId() : undefined);
      if (latest.status !== "waiting") {
        failure = "只能在等待房间添加调试玩家";
        return false;
      }

      if (!isDebugAutoAiRoom && payload.playerId !== latest.ownerPlayerId) {
        failure = "只有房主可以添加调试玩家";
        return false;
      }

      if (!isDebugAutoAiRoom && playerType !== "ai") {
        failure = "普通房间只能添加 AI 玩家";
        return false;
      }

      const existingAiCount = latest.players.filter(
        (player) => player.type === "ai",
      ).length;
      if (playerType === "ai" && !isDebugAutoAiRoom && existingAiCount >= AI_PLAYER_COUNT) {
        failure = "AI 名额已满";
        return false;
      }

      const nextSeatNo =
        Math.max(0, ...latest.players.map((player) => player.seatNo)) + 1;
      let player: Player;
      if (playerType === "ai") {
        const usedPersonaIds = new Set(
          latest.players.flatMap((player) =>
            player.aiPersonaId ? [player.aiPersonaId] : [],
          ),
        );
        const selectedPersona = payload.personaId
          ? getAiPersonaById(payload.personaId)
          : isDebugAutoAiRoom
            ? randomItem(getActivePersonas())
            : (getActivePersonas().find(
                (persona) => !usedPersonaIds.has(persona.id),
              ) ?? getActivePersonas()[0]);
        if (!selectedPersona) {
          failure = "AI 人格不存在";
          return false;
        }
        if (!isDebugAutoAiRoom && usedPersonaIds.has(selectedPersona.id)) {
          failure = "该 AI 人格已在房间中";
          return false;
        }

        player = createAiPlayer(
          nextSeatNo,
          selectedPersona.id,
          latest.players.map((candidate) => candidate.name),
          modelId,
        );
      } else {
        player = createSimulatedHumanPlayer(
          nextSeatNo,
          latest.players.map((candidate) => candidate.name),
          modelId,
        );
      }
      latest.players.push(player);
      if (
        isDebugAutoAiRoom &&
        !latest.players.some((candidate) => candidate.id === latest.ownerPlayerId)
      ) {
        latest.ownerPlayerId = player.id;
      }
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

  async removeDebugAi(payload: DebugRemoveAiPayload): Promise<ActionResult> {
    if (!DEBUG) {
      return this.fail("调试模式未开启");
    }

    const roomId = normalizeRoomId(payload.roomId);
    let failure = "房间不存在或操作冲突";

    const room = await this.applyWithLock(roomId, (latest) => {
      const isDebugAutoAiRoom = latest.debugAutoAi === true;
      if (latest.status !== "waiting") {
        failure = "只能在等待房间删除调试玩家";
        return false;
      }

      if (!isDebugAutoAiRoom && payload.playerId !== latest.ownerPlayerId) {
        failure = "只有房主可以删除调试玩家";
        return false;
      }

      const targetPlayerId = payload.targetPlayerId ?? payload.aiPlayerId;
      const target = latest.players.find(
        (player) =>
          player.id === targetPlayerId &&
          (isDebugAutoAiRoom ? isModelDrivenPlayer(player) : player.type === "ai"),
      );
      if (!target) {
        failure = "调试玩家不存在";
        return false;
      }

      latest.players = latest.players.filter((player) => player.id !== target.id);
      if (latest.ownerPlayerId === target.id) {
        latest.ownerPlayerId = latest.players[0]?.id ?? target.id;
      }
      latest.players
        .slice()
        .sort((a, b) => a.seatNo - b.seatNo)
        .forEach((player, index) => {
          player.seatNo = index + 1;
        });
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

  async updateDebugModel(payload: DebugUpdateModelPayload): Promise<ActionResult> {
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

  async deleteDebugAutoAiRoom(
    payload: DebugDeleteAutoAiRoomPayload,
  ): Promise<ActionResult> {
    if (!DEBUG) {
      return this.fail("调试模式未开启");
    }

    const room = await this.getRoom(payload.roomId);
    if (!room) {
      return this.fail("房间不存在");
    }

    if (!room.debugAutoAi) {
      return this.fail("只能删除自动对抗调试房");
    }

    if (room.status !== "waiting") {
      return this.fail("只能删除未开局的自动对抗调试房");
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

      const isDebugAutoAiRoom = latest.debugAutoAi === true;
      if (isDebugAutoAiRoom && !DEBUG) {
        failure = "调试模式未开启";
        return false;
      }

      if (!isDebugAutoAiRoom && payload.playerId !== latest.ownerPlayerId) {
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

  async updateDebugAutoAiFastMode(
    payload: UpdateDebugAutoAiFastModePayload,
  ): Promise<ActionResult> {
    const roomId = normalizeRoomId(payload.roomId);
    let failure = "房间不存在或操作冲突";

    const room = await this.applyWithLock(roomId, (latest) => {
      if (!DEBUG) {
        failure = "调试模式未开启";
        return false;
      }

      if (!latest.debugAutoAi) {
        failure = "只能修改自动对抗调试房";
        return false;
      }

      if (latest.status !== "waiting") {
        failure = "只能在开局前修改快速模式";
        return false;
      }

      latest.debugAutoAiFastMode = payload.fastMode === true;
      latest.debugAutoAiSpeech = undefined;
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
      this.prepareDebugAutoAiSpeechState(latest);
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
    if (room.debugAutoAi && room.debugAutoAiFastMode) {
      this.startDebugAutoAiSpeechLoop(room);
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
      latest.debugAutoAiSpeech = undefined;
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

  private startDebugAutoAiSpeechLoop(room: Room) {
    void this.runDebugAutoAiSpeechLoop(room.id, room.currentRound);
  }

  private async runDebugAutoAiSpeechLoop(
    roomId: string,
    roundNo: number,
  ) {
    while (true) {
      const room = await this.beginDebugAutoAiSpeechPass(roomId, roundNo);
      if (!room) {
        return;
      }

      const players = this.getDebugAutoAiSpeechPassPlayers(room);
      if (players.length === 0) {
        return;
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
            "自动对抗串行发言返回后对局已离开发言阶段或上下文失效",
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
          await this.markDebugAutoAiSpeechConsidered(
            roomId,
            freshPlayer.id,
            roundNo,
          );
          this.aiService.recordCalls(action.callRecords);
          this.emitSpeechDiscarded(roomId, freshPlayer, "skip", roundNo);
          continue;
        }

        const saved = await this.saveDebugAutoAiSpeech(
          roomId,
          freshPlayer.id,
          roundNo,
          action.content,
        );
        this.aiService.recordCalls(action.callRecords);
        if (saved) {
          this.clearSpeechGenerating(roomId, freshPlayer.id, roundNo);
          this.broadcastRoom(saved);
        } else {
          this.logDiscardedSpeech(
            roomId,
            freshPlayer,
            schedulerKind,
            roundNo,
            "自动对抗串行发言保存失败",
            action.content,
          );
          this.emitSpeechDiscarded(roomId, freshPlayer, "保存发言失败", roundNo);
          return;
        }
      }

      const passResult = await this.completeDebugAutoAiSpeechPass(
        roomId,
        roundNo,
      );
      if (passResult === "start-voting") {
        await this.startVotingById(roomId);
        return;
      }
      if (passResult === "stop") {
        return;
      }
    }
  }

  private async beginDebugAutoAiSpeechPass(
    roomId: string,
    roundNo: number,
  ): Promise<Room | null> {
    return this.applyWithLock(roomId, (latest) => {
      if (
        latest.status !== "playing" ||
        latest.phase !== "discussion" ||
        latest.currentRound !== roundNo ||
        !latest.debugAutoAi ||
        !latest.debugAutoAiFastMode
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
        this.getDebugAutoAiSpeechState(latest) ??
        {
          roundNo,
          startOffset: 0,
          passNo: 0,
        };
      latest.debugAutoAiSpeech = {
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

  private getDebugAutoAiSpeechPassPlayers(room: Room): Player[] {
    const players = room.players
      .filter((player) => isModelDrivenPlayer(player) && player.status === "alive")
      .sort((a, b) => a.seatNo - b.seatNo);
    if (players.length <= 1) {
      return players;
    }

    const state = this.getDebugAutoAiSpeechState(room);
    const startIndex = state
      ? state.startOffset % players.length
      : 0;
    return [
      ...players.slice(startIndex),
      ...players.slice(0, startIndex),
    ];
  }

  private getDebugAutoAiSpeechState(room: Room) {
    if (
      room.debugAutoAiSpeech &&
      room.debugAutoAiSpeech.roundNo === room.currentRound
    ) {
      return room.debugAutoAiSpeech;
    }

    return null;
  }

  private prepareDebugAutoAiSpeechState(room: Room) {
    if (!room.debugAutoAi || !room.debugAutoAiFastMode) {
      room.debugAutoAiSpeech = undefined;
      return;
    }

    const modelDrivenCount = room.players.filter(
      (player) => isModelDrivenPlayer(player) && player.status === "alive",
    ).length;
    room.debugAutoAiSpeech = {
      roundNo: room.currentRound,
      startOffset:
        modelDrivenCount > 0
          ? Math.floor(Math.random() * modelDrivenCount)
          : 0,
      passNo: 0,
      passInProgress: false,
    };
  }

  private async completeDebugAutoAiSpeechPass(
    roomId: string,
    roundNo: number,
  ): Promise<DebugAutoAiSpeechPassResult> {
    let result: DebugAutoAiSpeechPassResult = "stop";
    const saved = await this.applyWithLock(roomId, (latest) => {
      if (
        latest.status !== "playing" ||
        latest.phase !== "discussion" ||
        latest.currentRound !== roundNo ||
        !latest.debugAutoAi
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
        this.getDebugAutoAiSpeechState(latest) ??
        {
          roundNo,
          startOffset: 0,
          passNo: 0,
        };
      if (phaseEnded) {
        latest.debugAutoAiSpeech = {
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

      latest.debugAutoAiSpeech = {
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

  private async markDebugAutoAiSpeechConsidered(
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

  private async saveDebugAutoAiSpeech(
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

        if (room.debugAutoAi) {
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
            if (latestAfterModel?.debugAutoAi) {
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
            if (latestAfterModel.debugAutoAi) {
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
            if (room.debugAutoAi) {
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
              if (room.debugAutoAi) {
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
              if (room.debugAutoAi) {
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
      !room.debugAutoAi ||
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

    const context = this.buildGameContext(room, aiPlayer);
    const voteAction = await this.aiService.generateVote(context, aiPlayer.id);

    if (voteAction) {
      await this.castVoteForPlayer(room, aiPlayer, voteAction.targetPlayerId, {
        voteReason: voteAction.reason,
        voteSource: "model",
      });
      return;
    }

    const target = chooseFallbackVoteTarget(room, aiPlayer);
    if (target) {
      await this.castVoteForPlayer(room, aiPlayer, target.id, {
        voteSource: "fallback",
      });
    }
  }

  private buildGameContext(room: Room, aiPlayer: Player): GameContext {
    const alivePlayers = room.players
      .filter((p) => p.status === "alive")
      .map((p) => ({ id: p.id, seatNo: p.seatNo }));

    const seatMap = new Map(room.players.map((p) => [p.id, p.seatNo]));
    const recentMessages = room.messages
      .filter((m) => m.roundNo === room.currentRound)
      .map((m) => ({
        playerName: `${seatMap.get(m.playerId) ?? "?"}号位`,
        content: m.content,
      }));

    const historicalMessages = room.messages
      .filter((m) => m.roundNo < room.currentRound)
      .map((m) => ({
        roundNo: m.roundNo,
        playerName: `${seatMap.get(m.playerId) ?? "?"}号位`,
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
      myPersona: aiPlayer.type === "ai" ? getAiPersonaById(aiPlayer.aiPersonaId) : null,
      alivePlayers,
      recentMessages,
      historicalMessages,
      myLastSpeech: myLastMessage?.content ?? null,
      currentVoteCounts,
      voteHistory,
      shortMemory: room.aiMemories?.[aiPlayer.id] ?? null,
    };
  }

  private rememberAiVote(
    room: Room,
    voter: Player,
    target: Player,
    options?: { voteReason?: string; voteSource?: AiVoteMemorySource },
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
    options?: { voteReason?: string; voteSource?: AiVoteMemorySource },
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
