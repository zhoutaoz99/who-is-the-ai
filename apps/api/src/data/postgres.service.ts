import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

@Injectable()
export class PostgresService implements OnModuleInit, OnModuleDestroy {
  private readonly pool: Pool;

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
        password_salt text NOT NULL,
        password_hash text NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      )
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
  }
}
