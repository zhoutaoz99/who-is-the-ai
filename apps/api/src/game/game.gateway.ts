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

  constructor(private readonly gameService: GameService) {}

  afterInit(server: Server) {
    this.gameService.bindServer(server);
  }

  handleConnection(client: Socket) {
    client.emit("server.ready", {
      socketId: client.id,
      rooms: this.gameService.listRooms(),
    });
  }

  handleDisconnect(client: Socket) {
    const updatedRooms = this.gameService.disconnect(client.id);
    for (const room of updatedRooms) {
      this.server.to(room.id).emit("room.updated", room);
    }
  }

  @SubscribeMessage("room.list")
  handleListRooms() {
    return {
      ok: true,
      rooms: this.gameService.listRooms(),
    };
  }

  @SubscribeMessage("room.create")
  handleCreateRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: CreateRoomPayload,
  ) {
    const result = this.gameService.createRoom(client.id, payload ?? {});
    if (result.room) {
      client.join(result.room.id);
      this.server.to(result.room.id).emit("room.updated", result.room);
    }
    return result;
  }

  @SubscribeMessage("room.join")
  handleJoinRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: JoinRoomPayload,
  ) {
    const result = this.gameService.joinRoom(client.id, payload ?? {});
    if (result.room) {
      client.join(result.room.id);
      this.server.to(result.room.id).emit("room.updated", result.room);
    }
    return result;
  }

  @SubscribeMessage("room.leave")
  handleLeaveRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: LeaveRoomPayload,
  ) {
    const result = this.gameService.leaveRoom(client.id, payload ?? {});
    if (result.room) {
      client.leave(result.room.id);
      this.server.to(result.room.id).emit("room.updated", result.room);
    }
    return result;
  }

  @SubscribeMessage("room.reconnect")
  handleReconnect(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: ReconnectPayload,
  ) {
    const result = this.gameService.reconnect(client.id, payload ?? {});
    if (result.room) {
      client.join(result.room.id);
      this.server.to(result.room.id).emit("room.updated", result.room);
    }
    return result;
  }

  @SubscribeMessage("game.start")
  handleStartGame(@MessageBody() payload: StartGamePayload) {
    return this.gameService.startGame(payload ?? {});
  }

  @SubscribeMessage("chat.send")
  handleSendChat(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: SendChatPayload,
  ) {
    return this.gameService.sendChat(client.id, payload ?? {});
  }

  @SubscribeMessage("vote.cast")
  handleCastVote(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: CastVotePayload,
  ) {
    return this.gameService.castVote(client.id, payload ?? {});
  }
}
