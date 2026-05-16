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
  CreateRoomPayload,
  JoinRoomPayload,
  LeaveRoomPayload,
  ReconnectPayload,
  SendChatPayload,
  StartGamePayload,
} from "./game.types";
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
  ) {}

  afterInit(server: Server) {
    this.gameService.bindServer(server);
  }

  async handleConnection(client: Socket) {
    client.emit("server.ready", {
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
    return this.gameService.sendChat(client.id, payload ?? {});
  }

  @SubscribeMessage("vote.cast")
  async handleCastVote(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: CastVotePayload,
  ) {
    return this.gameService.castVote(client.id, payload ?? {});
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
