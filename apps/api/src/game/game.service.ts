import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Server } from "socket.io";
import { AiService } from "../ai/ai.service";
import { GameContext, RoundVoteSummary, VoteRecord } from "../ai/ai.types";
import { AuthService } from "../auth/auth.service";
import { GameRoomRepository } from "./game-room.repository";
import {
  ActionResult,
  CastVotePayload,
  ChatMessage,
  CreateRoomPayload,
  GameAccount,
  GamePhase,
  JoinRoomPayload,
  LeaveRoomPayload,
  Player,
  PointAward,
  PlayerType,
  PublicVoteResult,
  ReconnectPayload,
  Room,
  RoomSnapshot,
  SendChatPayload,
  StartGamePayload,
  Vote,
  Winner,
} from "./game.types";

const MAX_HUMAN_PLAYERS = 5;
const AI_PLAYER_COUNT = 2;
const MAX_ROUNDS = 4;
const REWARD_POOL = 2000;
const DEFAULT_DISCUSSION_DURATION_MS = Number(process.env.ROUND_DURATION_MS ?? 300_000);
const MIN_DISCUSSION_DURATION_MS = 60_000;
const VOTE_DURATION_MS = Number(process.env.VOTE_DURATION_MS ?? 30_000);
const SPEAK_COOLDOWN_MS = 15_000;
const MESSAGE_LIMIT = 240;

const AI_NAMES = [
  "林舟",
  "陈默",
  "许知",
  "赵晨",
  "周言",
  "沈星",
  "陆白",
  "江野",
];

type RoomTimers = {
  phase?: NodeJS.Timeout;
  tick?: NodeJS.Timeout;
  aiSpeech?: NodeJS.Timeout;
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
    const host = this.createHumanPlayer(
      account?.displayName ?? payload.playerName,
      socketId,
      1,
      account?.id,
    );
    const aiPlayers = this.createAiPlayers(2);
    const room: Room = {
      id: this.createRoomId(),
      status: "waiting",
      ownerPlayerId: host.id,
      players: [host, ...aiPlayers],
      discussionDurationMs: this.normalizeDiscussionDuration(payload),
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
      room: this.toSnapshot(room),
      playerId: host.id,
    };
  }

  async joinRoom(
    socketId: string,
    payload: JoinRoomPayload,
    account?: GameAccount | null,
  ): Promise<ActionResult> {
    const roomId = this.normalizeRoomId(payload.roomId);
    const room = await this.roomRepository.findById(roomId);

    if (!room) {
      return this.fail("房间不存在");
    }

    if (account) {
      const existingAccountPlayer = room.players.find(
        (candidate) =>
          candidate.type === "human" && candidate.accountId === account.id,
      );
      if (existingAccountPlayer) {
        this.cancelDisconnectRemoval(room.id, existingAccountPlayer.id);
        existingAccountPlayer.socketId = socketId;
        existingAccountPlayer.connected = true;
        existingAccountPlayer.name = account.displayName;
        this.touch(room);
        await this.roomRepository.save(room);

        return {
          ok: true,
          room: this.toSnapshot(room),
          playerId: existingAccountPlayer.id,
        };
      }
    }

    if (room.status !== "waiting") {
      return this.fail("游戏已开始，暂时不能加入");
    }

    const humanCount = this.countHumans(room);
    if (humanCount >= MAX_HUMAN_PLAYERS) {
      return this.fail("真人玩家人数已满");
    }

    const player = this.createHumanPlayer(
      account?.displayName ?? payload.playerName,
      socketId,
      room.players.length + 1,
      account?.id,
    );
    room.players.push(player);
    this.touch(room);
    await this.roomRepository.save(room);

    return {
      ok: true,
      room: this.toSnapshot(room),
      playerId: player.id,
    };
  }

  async leaveRoom(
    socketId: string,
    payload: LeaveRoomPayload,
  ): Promise<ActionResult> {
    const roomId = this.normalizeRoomId(payload.roomId);
    const room = await this.roomRepository.findById(roomId);

    if (!room) {
      return this.fail("房间不存在");
    }

    const player = room.players.find(
      (candidate) => candidate.id === payload.playerId && candidate.type === "human",
    );
    if (!player) {
      return this.fail("你不在该房间中");
    }

    if (room.status !== "waiting") {
      return this.fail("游戏进行中，无法离开");
    }

    room.players = room.players.filter((candidate) => candidate.id !== player.id);
    if (room.ownerPlayerId === player.id) {
      const nextHuman = room.players.find((candidate) => candidate.type === "human");
      if (nextHuman) {
        room.ownerPlayerId = nextHuman.id;
      }
    }

    if (this.countHumans(room) === 0) {
      this.clearTimers(room.id);
      await this.roomRepository.delete(room.id);
      return { ok: true };
    }

    this.touch(room);
    await this.roomRepository.save(room);
    return {
      ok: true,
      room: this.toSnapshot(room),
    };
  }

  async reconnect(
    socketId: string,
    payload: ReconnectPayload,
  ): Promise<ActionResult> {
    const roomId = this.normalizeRoomId(payload.roomId);
    const room = await this.roomRepository.findById(roomId);

    if (!room) {
      return this.fail("房间不存在");
    }

    const player = room.players.find(
      (candidate) => candidate.id === payload.playerId && candidate.type === "human",
    );
    if (!player) {
      return this.fail("玩家不存在于该房间");
    }

    this.cancelDisconnectRemoval(room.id, player.id);

    player.socketId = socketId;
    player.connected = true;
    this.touch(room);
    await this.roomRepository.save(room);

    return {
      ok: true,
      room: this.toSnapshot(room),
      playerId: player.id,
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

      // Reload the room fresh to avoid overwriting concurrent changes (e.g. new messages)
      const room = await this.roomRepository.findById(candidate.id);
      if (!room) {
        continue;
      }

      const freshPlayer = room.players.find((p) => p.id === player.id);
      if (!freshPlayer) {
        continue;
      }

      freshPlayer.connected = false;
      freshPlayer.socketId = undefined;

      if (room.status === "playing" || room.status === "finished") {
        this.touch(room);
        await this.roomRepository.save(room);
        updatedRooms.push(this.toSnapshot(room));
        continue;
      }

      // Waiting room: schedule removal after 30s if player doesn't reconnect
      const timerKey = `${room.id}:${freshPlayer.id}`;
      const existingTimer = this.disconnectTimers.get(timerKey);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      this.disconnectTimers.set(
        timerKey,
        setTimeout(() => {
          void this.removeDisconnectedPlayerAfterGrace(room.id, freshPlayer.id);
        }, 30_000),
      );

      this.touch(room);
      await this.roomRepository.save(room);
      updatedRooms.push(this.toSnapshot(room));
    }

    return updatedRooms;
  }

  private async removeDisconnectedPlayerAfterGrace(roomId: string, playerId: string) {
    const timerKey = `${roomId}:${playerId}`;
    this.disconnectTimers.delete(timerKey);

    const currentRoom = await this.roomRepository.findById(roomId);
    if (!currentRoom || currentRoom.status !== "waiting") {
      return;
    }

    const stillDisconnected = currentRoom.players.find(
      (candidate) => candidate.id === playerId && !candidate.connected,
    );
    if (!stillDisconnected) {
      return;
    }

    currentRoom.players = currentRoom.players.filter(
      (candidate) => candidate.id !== playerId,
    );
    if (currentRoom.ownerPlayerId === playerId) {
      const nextHuman = currentRoom.players.find(
        (candidate) => candidate.type === "human",
      );
      if (nextHuman) {
        currentRoom.ownerPlayerId = nextHuman.id;
      }
    }

    if (this.countHumans(currentRoom) === 0) {
      this.clearTimers(currentRoom.id);
      await this.roomRepository.delete(currentRoom.id);
      this.server?.to(roomId).emit("room.updated", this.toSnapshot(currentRoom));
      return;
    }

    this.touch(currentRoom);
    await this.roomRepository.save(currentRoom);
    this.server?.to(roomId).emit("room.updated", this.toSnapshot(currentRoom));
  }

  async startGame(payload: StartGamePayload): Promise<ActionResult> {
    const room = await this.getRoom(payload.roomId);
    if (!room) {
      return this.fail("房间不存在");
    }

    if (room.status !== "waiting") {
      return this.fail("游戏已经开始");
    }

    if (payload.playerId !== room.ownerPlayerId) {
      return this.fail("只有房主可以开始游戏");
    }

    if (this.countHumans(room) < 1) {
      return this.fail("至少需要 1 名真人玩家");
    }

    room.status = "playing";
    room.winner = null;
    room.currentRound = 0;
    room.messages = [];
    room.votes = [];
    room.pointAwards = [];
    room.rewardSettledAt = null;
    for (const player of room.players) {
      player.status = "alive";
      player.lastSpokeAt = 0;
      player.eliminatedRound = undefined;
    }

    await this.startDiscussion(room);
    this.server?.to(room.id).emit("game.started", this.toSnapshot(room));

    return {
      ok: true,
      room: this.toSnapshot(room),
    };
  }

  async sendChat(
    socketId: string,
    payload: SendChatPayload,
  ): Promise<ActionResult> {
    const room = await this.getRoom(payload.roomId);
    if (!room) {
      return this.fail("房间不存在");
    }

    const player = this.findHumanBySocket(room, socketId);
    if (!player) {
      return this.fail("你不在该房间中");
    }

    const validationError = this.validateCanSpeak(room, player);
    if (validationError) {
      return this.fail(validationError);
    }

    const content = this.normalizeContent(payload.content);
    if (!content) {
      return this.fail("发言内容不能为空");
    }

    this.addMessage(room, player, content);
    await this.roomRepository.save(room);
    this.broadcastRoom(room);

    return {
      ok: true,
      room: this.toSnapshot(room),
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

    const player = this.findHumanBySocket(room, socketId);
    if (!player) {
      return this.fail("你不在该房间中");
    }

    return this.castVoteForPlayer(room, player, payload.targetPlayerId);
  }

  async listRooms(): Promise<RoomSnapshot[]> {
    const rooms = await this.roomRepository.list();
    return rooms.map((room) => this.toSnapshot(room));
  }

  private async startDiscussion(room: Room) {
    this.clearTimers(room.id);
    room.currentRound += 1;
    room.phase = "discussion";
    room.phaseEndsAt = this.futureIso(room.discussionDurationMs);
    this.touch(room);
    await this.roomRepository.save(room);

    this.broadcastRoom(room);
    this.server?.to(room.id).emit("round.started", this.toSnapshot(room));
    this.startTick(room);
    this.startAiSpeech(room.id);

    this.getTimers(room.id).phase = setTimeout(() => {
      void this.startVotingById(room.id);
    }, room.discussionDurationMs);
  }

  private async startVotingById(roomId: string) {
    const room = await this.getRoom(roomId);
    if (!room || room.status !== "playing") {
      return;
    }

    await this.startVoting(room);
  }

  private async startVoting(room: Room) {
    this.clearTimers(room.id);
    room.phase = "voting";
    room.phaseEndsAt = this.futureIso(VOTE_DURATION_MS);
    this.touch(room);
    await this.roomRepository.save(room);

    this.broadcastRoom(room);
    this.server?.to(room.id).emit("vote.started", this.toSnapshot(room));
    this.startTick(room);
    this.scheduleAiVotes(room);

    this.getTimers(room.id).phase = setTimeout(() => {
      void this.resolveVotesById(room.id);
    }, VOTE_DURATION_MS);
  }

  private async resolveVotesById(roomId: string) {
    const room = await this.getRoom(roomId);
    if (!room) {
      return;
    }

    await this.resolveVotes(room);
  }

  private async resolveVotes(room: Room) {
    this.clearTimers(room.id);
    if (room.phase === "game_over" || room.status === "finished") {
      return;
    }

    room.phase = "resolving";
    room.phaseEndsAt = null;

    const eliminatedPlayer = this.resolveElimination(room);
    if (eliminatedPlayer) {
      eliminatedPlayer.status = "eliminated";
      eliminatedPlayer.eliminatedRound = room.currentRound;
      this.server?.to(room.id).emit("player.eliminated", {
        playerId: eliminatedPlayer.id,
        playerName: eliminatedPlayer.name,
        roundNo: room.currentRound,
      });
    }

    const winner = this.getWinner(room);
    if (winner) {
      await this.finishGame(room, winner);
      return;
    }

    this.touch(room);
    await this.roomRepository.save(room);
    this.broadcastRoom(room);

    setTimeout(() => {
      void this.startNextDiscussion(room.id);
    }, 3_000);
  }

  private async startNextDiscussion(roomId: string) {
    const room = await this.getRoom(roomId);
    if (room?.status === "playing") {
      await this.startDiscussion(room);
    }
  }

  private async finishGame(room: Room, winner: Winner) {
    room.status = "finished";
    room.phase = "game_over";
    room.phaseEndsAt = null;
    room.winner = winner;
    await this.settleRewards(room, winner);
    this.touch(room);
    this.clearTimers(room.id);
    await this.roomRepository.save(room);
    const snapshot = this.toSnapshot(room);
    this.broadcastRoom(room);
    this.server?.to(room.id).emit("game.ended", snapshot);
  }

  private resolveElimination(room: Room): Player | null {
    const votes = room.votes.filter((vote) => vote.roundNo === room.currentRound);
    if (votes.length === 0) {
      return null;
    }

    const voteCounts = new Map<string, number>();
    for (const vote of votes) {
      voteCounts.set(vote.targetPlayerId, (voteCounts.get(vote.targetPlayerId) ?? 0) + 1);
    }

    const sorted = Array.from(voteCounts.entries()).sort((a, b) => b[1] - a[1]);
    const [topTargetId, topCount] = sorted[0];
    const isTie = sorted.length > 1 && sorted[1][1] === topCount;
    if (isTie) {
      return null;
    }

    return room.players.find((player) => player.id === topTargetId && player.status === "alive") ?? null;
  }

  private getWinner(room: Room): Winner {
    const aliveAiCount = room.players.filter(
      (player) => player.type === "ai" && player.status === "alive",
    ).length;
    const aliveHumanCount = room.players.filter(
      (player) => player.type === "human" && player.status === "alive",
    ).length;

    if (aliveAiCount === 0) {
      return "human";
    }

    if (aliveHumanCount === 0) {
      return "ai";
    }

    if (room.currentRound >= MAX_ROUNDS) {
      return aliveAiCount > 0 ? "ai" : "human";
    }

    return null;
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
    this.getTimers(roomId).aiSpeech = setInterval(async () => {
      const room = await this.getRoom(roomId);
      if (!room) {
        return;
      }

      if (room.phase !== "discussion") {
        return;
      }

      // Prevent concurrent AI speech for the same room
      if (this.aiSpeaking.get(room.id)) {
        return;
      }

      const aiPlayers = room.players.filter(
        (player) => player.type === "ai" && player.status === "alive",
      );
      const candidates = aiPlayers.filter(
        (player) => Date.now() - player.lastSpokeAt >= SPEAK_COOLDOWN_MS,
      );

      if (candidates.length === 0 || Math.random() > 0.55) {
        return;
      }

      const aiPlayer = this.randomItem(candidates);
      this.aiSpeaking.set(room.id, true);
      try {
        const context = this.buildGameContext(room, aiPlayer);
        const action = await this.aiService.generateSpeech(context);
        this.logger.log(
          `[${aiPlayer.name}] Action: ${action.type}${action.type === "speak" ? ` "${action.content}"` : ""}`,
        );

        if (action.type === "speak") {
          this.addMessage(room, aiPlayer, action.content);
          await this.roomRepository.save(room);
          this.broadcastRoom(room);
        }
      } finally {
        this.aiSpeaking.set(room.id, false);
      }
    }, 6_000);
  }

  private scheduleAiVotes(room: Room) {
    const aiPlayers = room.players.filter(
      (player) => player.type === "ai" && player.status === "alive",
    );

    aiPlayers.forEach((aiPlayer, index) => {
      setTimeout(() => {
        void this.castAiVote(room.id, aiPlayer.id);
      }, 1_500 + index * 1_200);
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
      this.logger.log(
        `[${aiPlayer.name}] Vote: target=${voteAction.targetPlayerId} reason="${voteAction.reason ?? ""}"`,
      );
      await this.castVoteForPlayer(room, aiPlayer, voteAction.targetPlayerId);
      return;
    }

    this.logger.log(`[${aiPlayer.name}] Vote: LLM returned null, using fallback`);
    const target = this.chooseFallbackVoteTarget(room, aiPlayer);
    if (target) {
      await this.castVoteForPlayer(room, aiPlayer, target.id);
    }
  }

  private chooseFallbackVoteTarget(room: Room, aiPlayer: Player): Player | null {
    const aliveHumans = room.players.filter(
      (player) => player.type === "human" && player.status === "alive",
    );
    if (aliveHumans.length > 0) {
      return this.randomItem(aliveHumans);
    }

    const fallbackTargets = room.players.filter(
      (player) => player.id !== aiPlayer.id && player.status === "alive",
    );
    return fallbackTargets.length > 0 ? this.randomItem(fallbackTargets) : null;
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
      roundNo: room.currentRound,
      phase: room.phase,
      remainingTimeMs: remainingMs,
      myName: aiPlayer.name,
      mySeatNo: aiPlayer.seatNo,
      alivePlayers,
      recentMessages,
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
    if (room.status !== "playing" || room.phase !== "voting") {
      return this.fail("当前不在投票阶段");
    }

    if (voter.status !== "alive") {
      return this.fail("已出局玩家不能投票");
    }

    const target = room.players.find(
      (player) => player.id === targetPlayerId && player.status === "alive",
    );
    if (!target) {
      return this.fail("投票目标无效");
    }

    if (target.id === voter.id) {
      return this.fail("不能投给自己");
    }

    const hasVoted = room.votes.some(
      (vote) => vote.roundNo === room.currentRound && vote.voterPlayerId === voter.id,
    );
    if (hasVoted) {
      return this.fail("本轮已经投过票");
    }

    const vote: Vote = {
      id: randomUUID(),
      roundNo: room.currentRound,
      voterPlayerId: voter.id,
      targetPlayerId: target.id,
      createdAt: new Date().toISOString(),
    };
    room.votes.push(vote);
    this.touch(room);
    await this.roomRepository.save(room);

    const snapshot = this.toSnapshot(room);
    this.server?.to(room.id).emit("vote.updated", snapshot);
    this.broadcastRoom(room);

    const aliveVoters = room.players.filter((player) => player.status === "alive");
    const roundVotes = room.votes.filter((item) => item.roundNo === room.currentRound);
    if (roundVotes.length >= aliveVoters.length) {
      setTimeout(() => {
        void this.resolveVotesById(room.id);
      }, 500);
    }

    return {
      ok: true,
      room: snapshot,
    };
  }

  private addMessage(room: Room, player: Player, content: string) {
    const message: ChatMessage = {
      id: randomUUID(),
      roundNo: room.currentRound,
      playerId: player.id,
      playerName: player.name,
      source: player.type,
      content,
      createdAt: new Date().toISOString(),
    };

    player.lastSpokeAt = Date.now();
    room.messages.push(message);
    this.touch(room);
    this.server?.to(room.id).emit("chat.message", this.publicMessage(message, room));
  }

  private validateCanSpeak(room: Room, player: Player): string | null {
    if (room.status !== "playing" || room.phase !== "discussion") {
      return "当前不在发言阶段";
    }

    if (player.status !== "alive") {
      return "已出局玩家不能发言";
    }

    const remainingMs = SPEAK_COOLDOWN_MS - (Date.now() - player.lastSpokeAt);
    if (remainingMs > 0) {
      return `发言冷却中，请等待 ${Math.ceil(remainingMs / 1000)} 秒`;
    }

    return null;
  }

  private toSnapshot(room: Room): RoomSnapshot {
    const revealTypes = room.status === "finished";
    return {
      id: room.id,
      status: room.status,
      ownerPlayerId: room.ownerPlayerId,
      players: room.players
        .slice()
        .sort((a, b) => a.seatNo - b.seatNo)
        .map((player) => ({
          id: player.id,
          name: player.name,
          status: player.status,
          seatNo: player.seatNo,
          connected: player.connected,
          eliminatedRound: player.eliminatedRound,
          revealedType: revealTypes ? player.type : undefined,
        })),
      currentRound: room.currentRound,
      phase: room.phase,
      phaseEndsAt: room.phaseEndsAt,
      winner: room.winner,
      messages: room.messages.slice(-80).map((message) => this.publicMessage(message, room)),
      voteCounts: this.getVoteCounts(room),
      voteResults: this.getPublicVoteResults(room),
      pointAwards: room.pointAwards,
      config: {
        maxHumanPlayers: MAX_HUMAN_PLAYERS,
        aiPlayerCount: AI_PLAYER_COUNT,
        maxRounds: MAX_ROUNDS,
        discussionDurationMs: room.discussionDurationMs,
        voteDurationMs: VOTE_DURATION_MS,
        speakCooldownMs: SPEAK_COOLDOWN_MS,
        rewardPool: REWARD_POOL,
      },
      canStart: room.status === "waiting" && this.countHumans(room) >= 1,
      updatedAt: room.updatedAt,
    };
  }

  private publicMessage(message: ChatMessage, room: Room) {
    return {
      id: message.id,
      roundNo: message.roundNo,
      playerId: message.playerId,
      playerName: message.playerName,
      content: message.content,
      createdAt: message.createdAt,
      source: room.status === "finished" ? message.source : undefined,
    };
  }

  private getVoteCounts(room: Room): Record<string, number> {
    if (!this.isVoteResultPublic(room, room.currentRound)) {
      return {};
    }

    const counts: Record<string, number> = {};
    for (const vote of room.votes) {
      if (vote.roundNo !== room.currentRound) {
        continue;
      }
      counts[vote.targetPlayerId] = (counts[vote.targetPlayerId] ?? 0) + 1;
    }
    return counts;
  }

  private getPublicVoteResults(room: Room): PublicVoteResult[] {
    return room.votes
      .filter((vote) => this.isVoteResultPublic(room, vote.roundNo))
      .map((vote) => ({
        id: vote.id,
        roundNo: vote.roundNo,
        voterPlayerId: vote.voterPlayerId,
        targetPlayerId: vote.targetPlayerId,
        createdAt: vote.createdAt,
      }));
  }

  private isVoteResultPublic(room: Room, roundNo: number) {
    if (room.status === "finished" || room.phase === "game_over") {
      return true;
    }

    if (roundNo < room.currentRound) {
      return true;
    }

    return room.currentRound === roundNo && room.phase === "resolving";
  }

  private async settleRewards(room: Room, winner: Winner) {
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

    await this.authService.addPointsToAccounts(
      awards.flatMap((award, index) => {
        const accountId = eligiblePlayers[index].accountId;
        return accountId ? [{ accountId, points: award.points }] : [];
      }),
    );

    room.pointAwards = awards;
  }

  private createHumanPlayer(
    playerName: string | undefined,
    socketId: string,
    seatNo: number,
    accountId?: string,
  ): Player {
    return {
      id: randomUUID(),
      accountId,
      socketId,
      name: this.normalizePlayerName(playerName),
      type: "human",
      status: "alive",
      seatNo,
      lastSpokeAt: 0,
      connected: true,
    };
  }

  private createAiPlayers(startSeatNo: number): Player[] {
    const names = [...AI_NAMES].sort(() => Math.random() - 0.5);
    return Array.from({ length: AI_PLAYER_COUNT }, (_, index) => ({
      id: randomUUID(),
      name: names[index] ?? `玩家${startSeatNo + index}`,
      type: "ai" as PlayerType,
      status: "alive" as const,
      seatNo: startSeatNo + index,
      lastSpokeAt: 0,
      connected: true,
    }));
  }

  private createRoomId() {
    return randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase();
  }

  private normalizeRoomId(roomId: string | undefined) {
    return (roomId ?? "").trim().toUpperCase();
  }

  private normalizePlayerName(playerName: string | undefined) {
    const name = (playerName ?? "").trim();
    return name.slice(0, 16) || `玩家${Math.floor(Math.random() * 9000) + 1000}`;
  }

  private normalizeContent(content: string | undefined) {
    return (content ?? "").trim().slice(0, MESSAGE_LIMIT);
  }

  private normalizeDiscussionDuration(payload: CreateRoomPayload) {
    const minutes = Number(payload.discussionDurationMinutes);
    if (!Number.isFinite(minutes)) {
      return Math.max(DEFAULT_DISCUSSION_DURATION_MS, MIN_DISCUSSION_DURATION_MS);
    }

    return Math.max(Math.floor(minutes), 1) * 60_000;
  }

  private getRoom(roomId: string | undefined) {
    return this.roomRepository.findById(this.normalizeRoomId(roomId));
  }

  private findHumanBySocket(room: Room, socketId: string) {
    return room.players.find(
      (player) => player.type === "human" && player.socketId === socketId,
    );
  }

  private countHumans(room: Room) {
    return room.players.filter((player) => player.type === "human").length;
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

  private futureIso(durationMs: number) {
    return new Date(Date.now() + durationMs).toISOString();
  }

  private touch(room: Room) {
    room.updatedAt = new Date().toISOString();
  }

  private broadcastRoom(room: Room) {
    this.server?.to(room.id).emit("room.updated", this.toSnapshot(room));
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
      clearInterval(timers.aiSpeech);
    }

    this.timers.set(roomId, {});
    this.aiSpeaking.delete(roomId);
  }

  private randomItem<T>(items: T[]): T {
    return items[Math.floor(Math.random() * items.length)];
  }

  private fail(error: string): ActionResult {
    return {
      ok: false,
      error,
    };
  }
}
