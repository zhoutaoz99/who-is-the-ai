import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import { AuthService } from "../auth/auth.service";
import { AuthenticatedAccount } from "../auth/auth.types";
import {
  CastVotePayload,
  CreateDebugAutoAiRoomPayload,
  CreateRoomPayload,
  DebugAddAiPayload,
  DebugDeleteAutoAiRoomPayload,
  DebugRemoveAiPayload,
  JoinRoomPayload,
  LeaveRoomPayload,
  ReconnectPayload,
  SendChatPayload,
  StartGamePayload,
  StopGamePayload,
  UpdateDiscussionDurationPayload,
} from "./game.types";
import { PostgresService } from "../data/postgres.service";
import { DEBUG } from "./game.config";
import { GameService } from "./game.service";

@WebSocketGateway({
  cors: {
    origin: "*",
  },
})
export class GameGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly gameService: GameService,
    private readonly authService: AuthService,
    private readonly postgres: PostgresService,
  ) {}

  afterInit(server: Server) {
    this.gameService.bindServer(server);
    void this.postgres.ready.then(() => this.gameService.recoverStuckRooms());
  }

  async handleConnection(client: Socket) {
    client.emit("server.ready", {
      debug: DEBUG,
      socketId: client.id,
      rooms: await this.gameService.listRooms(),
    });
  }

  async handleDisconnect(client: Socket) {
    const updatedRooms = await this.gameService.disconnect(client.id);
    for (const room of updatedRooms) {
      this.server.to(room.id).emit("room.updated", room);
    }
  }

  @SubscribeMessage("room.list")
  async handleListRooms() {
    return {
      ok: true,
      debug: DEBUG,
      rooms: await this.gameService.listRooms(),
    };
  }

  @SubscribeMessage("room.create")
  async handleCreateRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: CreateRoomPayload,
  ) {
    const authResult = await this.getAccount(payload?.authToken);
    if (!authResult.ok) {
      return authResult;
    }

    const result = await this.gameService.createRoom(
      client.id,
      payload ?? {},
      authResult.account,
    );
    if (result.room) {
      client.join(result.room.id);
      this.server.to(result.room.id).emit("room.updated", result.room);
    }
    return result;
  }

  @SubscribeMessage("debug.ai-room.create")
  async handleCreateDebugAutoAiRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: CreateDebugAutoAiRoomPayload,
  ) {
    const result = await this.gameService.createDebugAutoAiRoom(payload ?? {});
    if (result.room) {
      client.join(result.room.id);
      this.server.to(result.room.id).emit("room.updated", result.room);
    }
    return result;
  }

  @SubscribeMessage("room.join")
  async handleJoinRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: JoinRoomPayload,
  ) {
    const authResult = await this.getAccount(payload?.authToken);
    if (!authResult.ok) {
      return authResult;
    }

    const result = await this.gameService.joinRoom(
      client.id,
      payload ?? {},
      authResult.account,
    );
    if (result.room) {
      client.join(result.room.id);
      this.server.to(result.room.id).emit("room.updated", result.room);
    }
    return result;
  }

  @SubscribeMessage("room.leave")
  async handleLeaveRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: LeaveRoomPayload,
  ) {
    const result = await this.gameService.leaveRoom(client.id, payload ?? {});
    if (result.room) {
      client.leave(result.room.id);
      this.server.to(result.room.id).emit("room.updated", result.room);
    }
    return result;
  }

  @SubscribeMessage("room.reconnect")
  async handleReconnect(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: ReconnectPayload,
  ) {
    const result = await this.gameService.reconnect(client.id, payload ?? {});
    if (result.room) {
      client.join(result.room.id);
      this.server.to(result.room.id).emit("room.updated", result.room);
    }
    return result;
  }

  @SubscribeMessage("game.start")
  async handleStartGame(@MessageBody() payload: StartGamePayload) {
    return this.gameService.startGame(payload ?? {});
  }

  @SubscribeMessage("chat.send")
  async handleSendChat(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: SendChatPayload,
  ) {
    const result = await this.gameService.sendChat(client.id, payload ?? {});
    if (result.room) {
      client.join(result.room.id);
    }
    return result;
  }

  @SubscribeMessage("vote.cast")
  async handleCastVote(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: CastVotePayload,
  ) {
    const result = await this.gameService.castVote(client.id, payload ?? {});
    if (result.room) {
      client.join(result.room.id);
    }
    return result;
  }

  @SubscribeMessage("game.stop")
  async handleStopGame(@MessageBody() payload: StopGamePayload) {
    return this.gameService.stopGame(payload ?? {});
  }

  @SubscribeMessage("debug.ai.add")
  async handleDebugAddAi(@MessageBody() payload: DebugAddAiPayload) {
    return this.gameService.addDebugAi(payload ?? {});
  }

  @SubscribeMessage("debug.ai.remove")
  async handleDebugRemoveAi(@MessageBody() payload: DebugRemoveAiPayload) {
    return this.gameService.removeDebugAi(payload ?? {});
  }

  @SubscribeMessage("debug.ai-room.delete")
  async handleDebugDeleteAutoAiRoom(
    @MessageBody() payload: DebugDeleteAutoAiRoomPayload,
  ) {
    return this.gameService.deleteDebugAutoAiRoom(payload ?? {});
  }

  @SubscribeMessage("room.duration.update")
  async handleUpdateDiscussionDuration(
    @MessageBody() payload: UpdateDiscussionDurationPayload,
  ) {
    return this.gameService.updateDiscussionDuration(payload ?? {});
  }

  private async getAccount(authToken: string | undefined): Promise<
    | {
        ok: true;
        account: AuthenticatedAccount | null;
      }
    | {
        ok: false;
        error: string;
      }
  > {
    if (authToken === undefined) {
      return {
        ok: true,
        account: null,
      };
    }

    const account = await this.authService.getAccountByToken(authToken);
    if (!account) {
      return {
        ok: false,
        error: "登录状态已过期，请重新登录",
      };
    }

    return {
      ok: true,
      account,
    };
  }
}
