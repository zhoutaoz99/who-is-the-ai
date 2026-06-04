import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Server } from "socket.io";
import { AiService } from "../ai/ai.service";
import { getAiPersonaById } from "../ai/ai.personas";
import { GameContext, RoundVoteSummary, VoteRecord } from "../ai/ai.types";
import { AuthService } from "../auth/auth.service";
import {
  AI_SPEECH_INITIAL_CHECK_MS,
  AI_SPEECH_NEXT_CHECK_MAX_MS,
  AI_SPEECH_NEXT_CHECK_MIN_MS,
  AI_SPEECH_RESPONSE_DELAY_MAX_MS,
  AI_SPEECH_RESPONSE_DELAY_MIN_MS,
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
  SPEAK_COOLDOWN_MS,
  VOTE_DURATION_MS,
} from "./game.config";
import { GameRoomRepository } from "./game-room.repository";
import {
  addChatMessage,
  chooseFallbackVoteTarget,
  countHumans,
  createAiPlayers,
  createHumanPlayer,
  createRoomId,
  futureIso,
  getWinner,
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
  CastVotePayload,
  CreateRoomPayload,
  GameAccount,
  JoinRoomPayload,
  LeaveRoomPayload,
  Player,
  PointAward,
  ReconnectPayload,
  Room,
  RoomSnapshot,
  SendChatPayload,
  StartGamePayload,
  StopGamePayload,
  Winner,
} from "./game.types";

type RoomTimers = {
  phase?: NodeJS.Timeout;
  tick?: NodeJS.Timeout;
  aiSpeech?: NodeJS.Timeout;
};

type AiSpeechContextMark = {
  roundNo: number;
  messageCount: number;
  lastMessageId: string | null;
  voteCount: number;
};

@Injectable()
export class GameService {
  private readonly logger = new Logger(GameService.name);
  private readonly timers = new Map<string, RoomTimers>();
  private readonly aiSpeaking = new Map<string, boolean>();
  private server?: Server;

  constructor(
    private readonly aiService: AiService,
    private readonly authService: AuthService,
    private readonly roomRepository: GameRoomRepository,
  ) {}

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
      room: toRoomSnapshot(room),
      playerId: host.id,
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
      room: toRoomSnapshot(room),
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
      return { ok: true };
    }

    return {
      ok: true,
      room: toRoomSnapshot(room),
    };
  }

  async reconnect(
    socketId: string,
    payload: ReconnectPayload,
  ): Promise<ActionResult> {
    const roomId = normalizeRoomId(payload.roomId);

    const room = await this.applyWithLock(roomId, (room) => {
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
      room: toRoomSnapshot(room),
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

        if (room.status === "playing" || room.status === "finished") {
          touch(room);
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
        updatedRooms.push(toRoomSnapshot(room));
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

    this.server?.to(roomId).emit("room.updated", toRoomSnapshot(room));
  }

  async startGame(payload: StartGamePayload): Promise<ActionResult> {
    const roomId = normalizeRoomId(payload.roomId);
    let failure = "房间不存在或操作冲突";
    const room = await this.applyWithLock(roomId, (latest) => {
      if (latest.status !== "waiting") {
        failure = "游戏已经开始";
        return false;
      }

      if (payload.playerId !== latest.ownerPlayerId) {
        failure = "只有房主可以开始游戏";
        return false;
      }

      if (countHumans(latest) < 1) {
        failure = "至少需要 1 名真人玩家";
        return false;
      }

      latest.status = "playing";
      latest.winner = null;
      latest.currentRound = 1;
      latest.phase = "discussion";
      latest.phaseEndsAt = futureIso(latest.discussionDurationMs);
      latest.messages = [];
      latest.votes = [];
      latest.pointAwards = [];
      latest.rewardSettledAt = null;
      for (const player of latest.players) {
        player.status = "alive";
        player.lastSpokeAt = 0;
        player.eliminatedRound = undefined;
      }

      const aiPlayers = createAiPlayers(latest.players.length + 1);
      latest.players.push(...aiPlayers);

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
    this.server?.to(room.id).emit("game.started", toRoomSnapshot(room));

    return {
      ok: true,
      room: toRoomSnapshot(room),
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
      room: toRoomSnapshot(saved),
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
    return rooms.map((room) => toRoomSnapshot(room));
  }

  async stopGame(payload: StopGamePayload): Promise<ActionResult> {
    if (!DEBUG) {
      return this.fail("调试模式未开启");
    }

    const roomId = normalizeRoomId(payload.roomId);
    let failure = "房间不存在或操作冲突";
    const room = await this.applyWithLock(roomId, (latest) => {
      if (latest.status !== "playing") {
        failure = "游戏未在进行中";
        return false;
      }

      const player = latest.players.find(
        (candidate) =>
          candidate.id === payload.playerId && candidate.type === "human",
      );
      if (!player) {
        failure = "你不在该房间中";
        return false;
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
    const snapshot = toRoomSnapshot(room);
    this.broadcastRoom(room);
    this.server?.to(room.id).emit("game.ended", snapshot);

    return {
      ok: true,
      room: snapshot,
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
    this.server?.to(room.id).emit("round.started", toRoomSnapshot(room));
    this.startTick(room);
    this.startAiSpeech(room.id);

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
      touch(latest);
      return true;
    });
    if (!room) {
      return;
    }

    this.clearTimers(room.id);
    this.broadcastRoom(room);
    this.server?.to(room.id).emit("vote.started", toRoomSnapshot(room));
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
    const snapshot = toRoomSnapshot(saved);
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

  private startAiSpeech(roomId: string) {
    const scheduleNext = (delayMs = AI_SPEECH_INITIAL_CHECK_MS) => {
      this.getTimers(roomId).aiSpeech = setTimeout(async () => {
        const room = await this.getRoom(roomId);
        if (!room) {
          return;
        }

        if (room.phase !== "discussion") {
          return;
        }

        // Prevent concurrent AI speech for the same room
        if (this.aiSpeaking.get(room.id)) {
          scheduleNext(AI_SPEECH_NEXT_CHECK_MIN_MS);
          return;
        }

        const aiPlayers = room.players.filter(
          (player) => player.type === "ai" && player.status === "alive",
        );
        const candidates = aiPlayers.filter(
          (player) => Date.now() - player.lastSpokeAt >= SPEAK_COOLDOWN_MS,
        );

        if (candidates.length === 0) {
          scheduleNext(AI_SPEECH_NEXT_CHECK_MIN_MS);
          return;
        }

        const aiPlayer = randomItem(candidates);
        const contextMark = this.markAiSpeechContext(room);
        const decisionStartedAt = Date.now();
        let nextDelayMs: number | null = AI_SPEECH_NEXT_CHECK_MIN_MS;
        this.aiSpeaking.set(room.id, true);
        try {
          const context = this.buildGameContext(room, aiPlayer);
          const action = await this.aiService.generateSpeech(context);
          nextDelayMs = this.clampAiNextCheckDelay(action.nextCheckAfterMs);

          const latestAfterModel = await this.getRoom(room.id);
          if (
            !latestAfterModel ||
            latestAfterModel.status !== "playing" ||
            latestAfterModel.phase !== "discussion" ||
            latestAfterModel.currentRound !== contextMark.roundNo
          ) {
            nextDelayMs = null;
            return;
          }

          if (this.hasNewAiSpeechContext(latestAfterModel, contextMark)) {
            nextDelayMs = this.randomAiStaleRetryDelay();
            return;
          }

          if (action.type === "speak") {
            const elapsedMs = Date.now() - decisionStartedAt;
            const targetDelayMs = this.clampAiResponseDelay(
              action.targetResponseDelayMs,
            );
            const remainingDelayMs = Math.max(0, targetDelayMs - elapsedMs);
            if (remainingDelayMs > 0) {
              await this.delay(remainingDelayMs);
            }

            let staleAtSave = false;
            const saved = await this.applyWithLock(room.id, (latest) => {
              if (
                latest.status !== "playing" ||
                latest.phase !== "discussion" ||
                latest.currentRound !== contextMark.roundNo
              ) {
                return false;
              }

              const freshAiPlayer = latest.players.find(
                (player) =>
                  player.id === aiPlayer.id &&
                  player.type === "ai" &&
                  player.status === "alive",
              );
              if (!freshAiPlayer) {
                return false;
              }

              if (this.hasNewAiSpeechContext(latest, contextMark)) {
                staleAtSave = true;
                return false;
              }

              this.addMessage(latest, freshAiPlayer, action.content, false);
              return true;
            });

            if (staleAtSave) {
              nextDelayMs = this.randomAiStaleRetryDelay();
              return;
            }

            if (saved) {
              this.broadcastRoom(saved);
            }
          }
        } finally {
          this.aiSpeaking.set(room.id, false);
          if (nextDelayMs != null) {
            const latest = await this.getRoom(room.id);
            if (latest?.status === "playing" && latest.phase === "discussion") {
              scheduleNext(nextDelayMs);
            }
          }
        }
      }, delayMs);
    };

    scheduleNext();
  }

  private markAiSpeechContext(room: Room): AiSpeechContextMark {
    const lastMessage = room.messages[room.messages.length - 1];
    return {
      roundNo: room.currentRound,
      messageCount: room.messages.length,
      lastMessageId: lastMessage?.id ?? null,
      voteCount: room.votes.length,
    };
  }

  private hasNewAiSpeechContext(
    room: Room,
    mark: AiSpeechContextMark,
  ): boolean {
    const lastMessage = room.messages[room.messages.length - 1];
    return (
      room.currentRound !== mark.roundNo ||
      room.messages.length !== mark.messageCount ||
      (lastMessage?.id ?? null) !== mark.lastMessageId ||
      room.votes.length !== mark.voteCount
    );
  }

  private clampAiNextCheckDelay(delayMs: number): number {
    return Math.min(
      AI_SPEECH_NEXT_CHECK_MAX_MS,
      Math.max(AI_SPEECH_NEXT_CHECK_MIN_MS, delayMs),
    );
  }

  private clampAiResponseDelay(delayMs: number): number {
    return Math.min(
      AI_SPEECH_RESPONSE_DELAY_MAX_MS,
      Math.max(AI_SPEECH_RESPONSE_DELAY_MIN_MS, delayMs),
    );
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
      (player) => player.type === "ai" && player.status === "alive",
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
        player.type === "ai" &&
        player.status === "alive",
    );
    if (!aiPlayer) {
      return;
    }

    const context = this.buildGameContext(room, aiPlayer);
    const voteAction = await this.aiService.generateVote(context, aiPlayer.id);

    if (voteAction) {
      await this.castVoteForPlayer(room, aiPlayer, voteAction.targetPlayerId);
      return;
    }

    const target = chooseFallbackVoteTarget(room, aiPlayer);
    if (target) {
      await this.castVoteForPlayer(room, aiPlayer, target.id);
    }
  }

  private buildGameContext(room: Room, aiPlayer: Player): GameContext {
    const alivePlayers = room.players
      .filter((p) => p.status === "alive")
      .map((p) => ({ id: p.id, seatNo: p.seatNo }));

    const seatMap = new Map(room.players.map((p) => [p.id, p.seatNo]));

    const recentMessages = room.messages
      .filter((m) => m.roundNo === room.currentRound)
      .slice(-20)
      .map((m) => ({
        playerName: m.playerId === aiPlayer.id ? "你" : `${seatMap.get(m.playerId) ?? "?"}号位`,
        content: m.content,
        isSelf: m.playerId === aiPlayer.id,
      }));

    const historicalMessages = room.messages
      .filter((m) => m.roundNo < room.currentRound)
      .map((m) => ({
        roundNo: m.roundNo,
        playerName: m.playerId === aiPlayer.id ? "你" : `${seatMap.get(m.playerId) ?? "?"}号位`,
        content: m.content,
        isSelf: m.playerId === aiPlayer.id,
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
      mySeatNo: aiPlayer.seatNo,
      myPersona: getAiPersonaById(aiPlayer.aiPersonaId),
      alivePlayers,
      recentMessages,
      historicalMessages,
      myLastSpeech: myLastMessage?.content ?? null,
      currentVoteCounts,
      voteHistory,
    };
  }

  private async castVoteForPlayer(
    room: Room,
    voter: Player,
    targetPlayerId?: string,
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
      touch(latest);
      return true;
    });

    if (!saved) {
      return this.fail("投票失败，请重试");
    }

    const snapshot = toRoomSnapshot(saved);
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
    this.server?.to(room.id).emit("room.updated", toRoomSnapshot(room));
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

    this.timers.set(roomId, {});
    this.aiSpeaking.delete(roomId);
  }

  private fail(error: string): ActionResult {
    return {
      ok: false,
      error,
    };
  }
}
