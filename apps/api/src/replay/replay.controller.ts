import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { PostgresService } from "../data/postgres.service";
import { normalizeRoomId } from "../game/game.rules";
import { toRoomSnapshot } from "../game/game.snapshot";
import { Room } from "../game/game.types";
import { buildReplayExportData } from "./replay-export.builder";
import { ReplayService } from "./replay.service";
import { ReplayExportSaveRequest } from "./replay.types";

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

  /**
   * 服务端构建并返回该房间的 replay 导出 JSON(结构与 replay-*.json 一致,
   * 额外带 promptGenerationId),供无头评估闭环拉取。无需前端参与。
   */
  @Get(":roomId/export")
  async buildReplayExport(
    @Param("roomId") roomId: string,
    @Query("includeSkips") includeSkips?: string,
    @Query("includeUserPrompt") includeUserPrompt?: string,
    @Query("profile") profile?: string,
  ) {
    const normalized = normalizeRoomId(roomId);
    const result = await this.postgres.query<RoomRow>(
      "SELECT room_data FROM game_rooms WHERE id = $1",
      [normalized],
    );
    const room = result.rows[0]?.room_data ?? null;
    if (!room) {
      return { ok: false, error: "房间不存在" };
    }
    const snapshot = toRoomSnapshot(room);
    const aiCallLogs = await this.replayService.getAiCallLogs(normalized);
    const data = buildReplayExportData(snapshot, aiCallLogs, {
      includeSkips: includeSkips !== "false",
      includeUserPrompt: includeUserPrompt === "true",
      promptGenerationId: room.promptGenerationId,
      profile: profile === "audit" ? "audit" : "full",
    });
    return { ok: true, data };
  }

  @Get("export/:roomId")
  async getReplayExport(@Param("roomId") roomId: string) {
    const normalized = normalizeRoomId(roomId);
    const record = await this.replayService.getReplayExport(normalized);
    if (!record) {
      return { ok: true, exists: false };
    }
    return {
      ok: true,
      exists: true,
      data: record.data,
      includeSkips: record.includeSkips,
      includeUserPrompt: record.includeUserPrompt,
    };
  }

  @Post("export/:roomId")
  async saveReplayExport(
    @Param("roomId") roomId: string,
    @Body() body: ReplayExportSaveRequest,
  ) {
    if (!body || body.data === undefined || body.data === null) {
      return { ok: false, error: "缺少导出数据" };
    }
    if (
      typeof body.includeSkips !== "boolean" ||
      typeof body.includeUserPrompt !== "boolean"
    ) {
      return { ok: false, error: "缺少开关参数" };
    }

    const normalized = normalizeRoomId(roomId);
    await this.replayService.saveReplayExport(
      normalized,
      body.data,
      body.includeSkips,
      body.includeUserPrompt,
    );
    return { ok: true };
  }
}
