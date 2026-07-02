import { Injectable } from "@nestjs/common";
import { QueryResultRow } from "pg";
import { PostgresService } from "../data/postgres.service";
import { RedisCacheService } from "../data/redis-cache.service";
import { Room } from "./game.types";

const DEFAULT_ROOM_CACHE_TTL_SECONDS = 60 * 60;

interface RoomRow extends QueryResultRow {
  room_data: Room;
}

@Injectable()
export class GameRoomRepository {
  private readonly cacheTtlSeconds = this.readPositiveInteger(
    process.env.ROOM_CACHE_TTL_SECONDS,
    DEFAULT_ROOM_CACHE_TTL_SECONDS,
  );

  constructor(
    private readonly postgres: PostgresService,
    private readonly cache: RedisCacheService,
  ) {}

  async findById(roomId: string): Promise<Room | null> {
    const cacheKey = this.roomKey(roomId);
    const cachedRoom = await this.cache.getJson<Room>(cacheKey);
    if (cachedRoom) {
      return cachedRoom;
    }

    const result = await this.postgres.query<RoomRow>(
      "SELECT room_data FROM game_rooms WHERE id = $1",
      [roomId],
    );
    const room = result.rows[0]?.room_data ?? null;
    if (room) {
      await this.cache.setJson(cacheKey, room, this.cacheTtlSeconds);
    }

    return room;
  }

  async save(room: Room, expectedUpdatedAt?: string): Promise<boolean> {
    if (expectedUpdatedAt) {
      const result = await this.postgres.query(
        `
          UPDATE game_rooms
          SET status = $2, phase = $3, room_data = $4::jsonb, updated_at = $5
          WHERE id = $1 AND updated_at = $6
        `,
        [
          room.id,
          room.status,
          room.phase,
          JSON.stringify(room),
          room.updatedAt,
          expectedUpdatedAt,
        ],
      );
      if (result.rowCount === 0) {
        return false;
      }
    } else {
      await this.postgres.query(
        `
          INSERT INTO game_rooms (
            id,
            status,
            phase,
            room_data,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4::jsonb, $5, $6)
          ON CONFLICT (id) DO UPDATE
          SET
            status = EXCLUDED.status,
            phase = EXCLUDED.phase,
            room_data = EXCLUDED.room_data,
            updated_at = EXCLUDED.updated_at
        `,
        [
          room.id,
          room.status,
          room.phase,
          JSON.stringify(room),
          room.createdAt,
          room.updatedAt,
        ],
      );
    }
    await this.cache.setJson(this.roomKey(room.id), room, this.cacheTtlSeconds);
    return true;
  }

  async delete(roomId: string) {
    await this.postgres.query("DELETE FROM game_rooms WHERE id = $1", [roomId]);
    await this.cache.del(this.roomKey(roomId));
  }

  async list(limit?: number): Promise<Room[]> {
    const normalizedLimit =
      limit == null ? null : Math.max(1, Math.floor(limit));
    const result = await this.postgres.query<RoomRow>(
      normalizedLimit == null
        ? `
          SELECT room_data
          FROM game_rooms
          ORDER BY updated_at DESC
        `
        : `
          SELECT room_data
          FROM game_rooms
          ORDER BY updated_at DESC
          LIMIT $1
        `,
      normalizedLimit == null ? [] : [normalizedLimit],
    );

    const rooms = result.rows.map((row) => row.room_data);
    await Promise.all(
      rooms.map((room) =>
        this.cache.setJson(this.roomKey(room.id), room, this.cacheTtlSeconds),
      ),
    );

    return rooms;
  }

  private roomKey(roomId: string) {
    return `game:room:${roomId}`;
  }

  private readPositiveInteger(value: string | undefined, fallback: number) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return fallback;
    }

    return Math.floor(parsed);
  }
}
