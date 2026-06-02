import { Controller, Get, Param } from "@nestjs/common";
import { PostgresService } from "../data/postgres.service";
import { normalizeRoomId } from "../game/game.rules";
import { toRoomSnapshot } from "../game/game.snapshot";
import { Room } from "../game/game.types";
import { ReplayService } from "./replay.service";

interface RoomRow {
  room_data: Room;
}

@Controller("replay")
export class ReplayController {
  constructor(
    private readonly replayService: ReplayService,
    private readonly postgres: PostgresService,
  ) {}

  @Get(":roomId")
  async getReplay(@Param("roomId") roomId: string) {
    const normalized = normalizeRoomId(roomId);
    const result = await this.postgres.query<RoomRow>(
      "SELECT room_data FROM game_rooms WHERE id = $1",
      [normalized],
    );
    const room = result.rows[0]?.room_data ?? null;
    if (!room) {
      return { ok: false, error: "房间不存在", room: null, aiCallLogs: [] };
    }
    const snapshot = toRoomSnapshot(room);
    const aiCallLogs = await this.replayService.getAiCallLogs(normalized);
    return { ok: true, room: snapshot, aiCallLogs };
  }
}
