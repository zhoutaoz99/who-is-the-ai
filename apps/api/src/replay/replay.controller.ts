import { Body, Controller, Get, Param, Post, Res } from "@nestjs/common";
import { PostgresService } from "../data/postgres.service";
import { normalizeRoomId } from "../game/game.rules";
import { toRoomSnapshot } from "../game/game.snapshot";
import { Room } from "../game/game.types";
import { ReplayService } from "./replay.service";
import { ReplayAnalyzeRequest, ReplayExportSaveRequest } from "./replay.types";

interface RoomRow {
  room_data: Room;
}

interface StreamResponse {
  writableEnded: boolean;
  status(code: number): StreamResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
  flushHeaders(): void;
  on(event: "close", listener: () => void): void;
  off(event: "close", listener: () => void): void;
  write(chunk: string): void;
  end(): void;
}

@Controller("replay")
export class ReplayController {
  constructor(
    private readonly replayService: ReplayService,
    private readonly postgres: PostgresService,
  ) {}

  @Post("analyze")
  async streamAnalyzeReplay(
    @Body() body: ReplayAnalyzeRequest,
    @Res() res: StreamResponse,
  ) {
    if (!body?.replay) {
      res.status(400).json({ ok: false, error: "缺少复盘数据" });
      return;
    }

    const abortController = new AbortController();
    let completed = false;
    const abortOnClose = () => {
      if (!completed) {
        abortController.abort();
      }
    };
    res.on("close", abortOnClose);

    res.status(200);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    try {
      await this.replayService.streamReplayAnalysisExport(
        body.replay,
        (chunk) => {
          if (!res.writableEnded) {
            res.write(chunk);
          }
        },
        abortController.signal,
      );
    } catch (error) {
      if (!abortController.signal.aborted && !res.writableEnded) {
        const message = error instanceof Error ? error.message : String(error);
        res.write(`\n\n复盘分析失败：${message}`);
      }
    } finally {
      completed = true;
      res.off("close", abortOnClose);
      if (!res.writableEnded) {
        res.end();
      }
    }
  }

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
