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
      ALTER TABLE ai_call_logs
      ADD COLUMN IF NOT EXISTS system_prompt text
    `);

    await this.query(`
      ALTER TABLE ai_call_logs
      ADD COLUMN IF NOT EXISTS reasoning text
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

    // --- AI 提示词版本管理(asset 版本 / 代 / active 指针)---
    await this.query(`
      CREATE TABLE IF NOT EXISTS ai_prompt_assets (
        id uuid PRIMARY KEY,
        asset_key text NOT NULL,
        version integer NOT NULL,
        content text NOT NULL,
        parent_version integer,
        note text,
        metadata jsonb,
        created_at timestamptz NOT NULL DEFAULT NOW(),
        UNIQUE (asset_key, version)
      )
    `);

    await this.query(`
      CREATE TABLE IF NOT EXISTS ai_prompt_generations (
        id text PRIMARY KEY,
        manifest jsonb NOT NULL,
        parent_id text,
        status text NOT NULL DEFAULT 'candidate',
        is_best boolean NOT NULL DEFAULT false,
        score jsonb,
        note text,
        created_at timestamptz NOT NULL DEFAULT NOW()
      )
    `);

    await this.query(`
      CREATE TABLE IF NOT EXISTS ai_prompt_state (
        id integer PRIMARY KEY DEFAULT 1,
        active_generation_id text,
        CONSTRAINT ai_prompt_state_singleton CHECK (id = 1)
      )
    `);

    // --- 评估尺子版本管理(asset 版本 / 代 / active 指针)---
    await this.query(`
      CREATE TABLE IF NOT EXISTS eval_prompt_assets (
        id uuid PRIMARY KEY,
        asset_key text NOT NULL,
        version integer NOT NULL,
        content text NOT NULL,
        parent_version integer,
        note text,
        metadata jsonb,
        created_at timestamptz NOT NULL DEFAULT NOW(),
        UNIQUE (asset_key, version)
      )
    `);

    await this.query(`
      CREATE TABLE IF NOT EXISTS eval_prompt_generations (
        id text PRIMARY KEY,
        manifest jsonb NOT NULL,
        parent_id text,
        status text NOT NULL DEFAULT 'candidate',
        is_best boolean NOT NULL DEFAULT false,
        score jsonb,
        note text,
        created_at timestamptz NOT NULL DEFAULT NOW()
      )
    `);

    await this.query(`
      CREATE TABLE IF NOT EXISTS eval_prompt_state (
        id integer PRIMARY KEY DEFAULT 1,
        active_generation_id text,
        CONSTRAINT eval_prompt_state_singleton CHECK (id = 1)
      )
    `);

    // --- 离线优化沙盒产物(原 sandbox-out/ 文件存储,迁到 DB;jsonb 存完整文档)---
    await this.query(`
      CREATE TABLE IF NOT EXISTS sandbox_match_records (
        match_id text PRIMARY KEY,
        data jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT NOW()
      )
    `);

    await this.query(`
      CREATE TABLE IF NOT EXISTS sandbox_score_records (
        score_id text PRIMARY KEY,
        match_id text NOT NULL,
        data jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT NOW()
      )
    `);

    await this.query(`
      CREATE INDEX IF NOT EXISTS sandbox_score_records_match_idx
      ON sandbox_score_records (match_id)
    `);

    await this.query(`
      CREATE TABLE IF NOT EXISTS sandbox_paired_cache (
        cache_key text PRIMARY KEY,
        data jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT NOW()
      )
    `);

    await this.query(`
      CREATE TABLE IF NOT EXISTS sandbox_generation_evals (
        generation_id text PRIMARY KEY,
        generation_no integer NOT NULL,
        data jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT NOW()
      )
    `);

    await this.query(`
      CREATE INDEX IF NOT EXISTS sandbox_generation_evals_no_idx
      ON sandbox_generation_evals (generation_no DESC)
    `);

    // 审计 trace 事件(🟡 LLM 原始 I/O / 🔴 聚合中间产物;默认不写,AUDIT_TRACE=1 才落)。
    await this.query(`
      CREATE TABLE IF NOT EXISTS sandbox_trace_events (
        id bigserial PRIMARY KEY,
        run_id text,
        match_id text,
        kind text NOT NULL,
        stage text,
        data jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT NOW()
      )
    `);

    await this.query(`
      CREATE INDEX IF NOT EXISTS sandbox_trace_events_match_idx
      ON sandbox_trace_events (match_id, created_at)
    `);

    await this.query(`
      CREATE INDEX IF NOT EXISTS sandbox_trace_events_run_idx
      ON sandbox_trace_events (run_id, created_at)
    `);

    await this.query(`
      CREATE TABLE IF NOT EXISTS sandbox_orchestrator_state (
        id integer PRIMARY KEY DEFAULT 1,
        data jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT sandbox_orchestrator_state_singleton CHECK (id = 1)
      )
    `);

    await this.query(`
      CREATE TABLE IF NOT EXISTS sandbox_prompt_versions (
        version_id text PRIMARY KEY,
        status text NOT NULL,
        prompt_text text NOT NULL,
        meta jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT NOW()
      )
    `);
  }
}
