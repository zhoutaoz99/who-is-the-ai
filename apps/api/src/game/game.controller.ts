import { Controller, Get, Param } from "@nestjs/common";
import { GameRoomRepository } from "./game-room.repository";
import { normalizeRoomId } from "./game.rules";
import { toRoomSnapshot } from "./game.snapshot";

@Controller("rooms")
export class GameController {
  constructor(private readonly roomRepository: GameRoomRepository) {}

  @Get(":roomId")
  async getRoom(@Param("roomId") roomId: string) {
    const normalized = normalizeRoomId(roomId);
    const room = await this.roomRepository.findById(normalized);
    if (!room) {
      return { ok: false, error: "房间不存在" };
    }
    return { ok: true, room: toRoomSnapshot(room) };
  }
}
