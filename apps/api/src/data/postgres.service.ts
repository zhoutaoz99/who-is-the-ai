import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

@Injectable()
export class PostgresService implements OnModuleInit, OnModuleDestroy {
  private readonly pool: Pool;
  private migrateResolve!: () => void;
  readonly ready = new Promise<void>((resolve) => {
    this.migrateResolve = resolve;
  });

  constructor() {
    const connectionString = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;

    this.pool = new Pool({
      connectionString,
      host: connectionString ? undefined : process.env.PGHOST ?? "127.0.0.1",
      port: connectionString ? undefined : Number(process.env.PGPORT ?? 5432),
      database: connectionString ? undefined : process.env.PGDATABASE ?? "ai_werewolf",
      user: connectionString ? undefined : process.env.PGUSER ?? "postgres",
      password: connectionString ? undefined : process.env.PGPASSWORD ?? "postgres",
      ssl:
        process.env.POSTGRES_SSL === "true"
          ? { rejectUnauthorized: false }
          : undefined,
    });
  }

  async onModuleInit() {
    await this.migrate();
    this.migrateResolve();
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, params);
  }

  async transaction<T>(callback: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async migrate() {
    await this.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        id uuid PRIMARY KEY,
        username varchar(20) NOT NULL UNIQUE,
        display_name varchar(16) NOT NULL,
        points integer NOT NULL DEFAULT 1000,
        games_played integer NOT NULL DEFAULT 0,
        games_won integer NOT NULL DEFAULT 0,
        password_salt text NOT NULL,
        password_hash text NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      )
    `);

    await this.query(`
      ALTER TABLE accounts
      ADD COLUMN IF NOT EXISTS games_played integer NOT NULL DEFAULT 0
    `);

    await this.query(`
      ALTER TABLE accounts
      ADD COLUMN IF NOT EXISTS games_won integer NOT NULL DEFAULT 0
    `);

    await this.query(`
      CREATE INDEX IF NOT EXISTS accounts_username_idx
      ON accounts (username)
    `);

    await this.query(`
      CREATE TABLE IF NOT EXISTS game_rooms (
        id varchar(16) PRIMARY KEY,
        status text NOT NULL,
        phase text NOT NULL,
        room_data jsonb NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      )
    `);

    await this.query(`
      CREATE INDEX IF NOT EXISTS game_rooms_updated_at_idx
      ON game_rooms (updated_at DESC)
    `);

    await this.query(`
      CREATE TABLE IF NOT EXISTS ai_call_logs (
        id uuid PRIMARY KEY,
        room_id varchar(16) NOT NULL,
        round_no integer NOT NULL,
        call_type text NOT NULL,
        ai_player_id text NOT NULL,
        ai_player_name text NOT NULL,
        ai_player_seat_no integer NOT NULL,
        user_prompt text NOT NULL,
        raw_response text NOT NULL,
        model_name text NOT NULL,
        temperature double precision NOT NULL,
        reasoning_effort text NOT NULL,
        created_at timestamptz NOT NULL
      )
    `);

    await this.query(`
      CREATE INDEX IF NOT EXISTS ai_call_logs_room_idx
      ON ai_call_logs (room_id, round_no, created_at)
    `);

    await this.query(`
      ALTER TABLE ai_call_logs
      ADD COLUMN IF NOT EXISTS template_prompt text
    `);

    await this.query(`
      ALTER TABLE ai_call_logs DROP COLUMN IF EXISTS system_prompt
    `);

    await this.query(`
      CREATE TABLE IF NOT EXISTS replay_exports (
        room_id varchar(16) PRIMARY KEY,
        data jsonb NOT NULL,
        include_skips boolean NOT NULL,
        include_user_prompt boolean NOT NULL,
        created_at timestamptz NOT NULL DEFAULT NOW(),
        updated_at timestamptz NOT NULL DEFAULT NOW()
      )
    `);
  }
}
