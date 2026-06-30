// 沙盒数据持久化仓储:把原 sandbox-out/ 文件存储(MatchRecord / ScoreRecord /
// paired_cache / GenerationEval / OrchestratorState / PromptVersion)统一迁到 Postgres。
// 模式对齐项目既有风格:每实体一张表,完整文档存 jsonb data 列(见 game_rooms.room_data /
// iteration_runs.rounds)。无状态,集中所有沙盒 SQL;各 store/service 注入本类。
// 元数据型(state / prompt-version)由各自 store 做内存缓存,文档型直接调用本类 async 方法。

import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { PostgresService } from "../data/postgres.service";
import type { GenerationEval } from "./orchestrator/generation-eval";
import type { OrchestratorState } from "./orchestrator/state";
import type { PromptVersion, PromptVersionMeta } from "./orchestrator/prompt-version";
import type { MatchRecord } from "./match-record/types";
import type { ScoreRecord } from "./score/types";

export interface EvalPromptAssetRow {
  asset_key: string;
  version: number;
  content: string;
  parent_version?: number | null;
  note?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at?: string;
}

export interface EvalPromptGenerationRow {
  id: string;
  manifest: Record<string, number>;
  parent_id?: string | null;
  status: string;
  is_best: boolean;
  score?: Record<string, unknown> | null;
  note?: string | null;
  created_at?: string;
}

@Injectable()
export class SandboxRepository {
  constructor(private readonly postgres: PostgresService) {}

  private async ready(): Promise<void> {
    await this.postgres.ready;
  }

  // ===== MatchRecord =====

  async upsertMatchRecord(rec: MatchRecord): Promise<void> {
    await this.ready();
    await this.postgres.query(
      `INSERT INTO sandbox_match_records (match_id, data)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (match_id) DO UPDATE SET data = EXCLUDED.data`,
      [rec.match_id, JSON.stringify(rec)],
    );
  }

  async loadMatchRecord(matchId: string): Promise<MatchRecord | null> {
    await this.ready();
    const res = await this.postgres.query<{ data: MatchRecord }>(
      `SELECT data FROM sandbox_match_records WHERE match_id = $1`,
      [matchId],
    );
    return res.rows[0]?.data ?? null;
  }

  // ===== ScoreRecord =====

  async upsertScoreRecord(rec: ScoreRecord): Promise<void> {
    await this.ready();
    await this.postgres.query(
      `INSERT INTO sandbox_score_records (score_id, match_id, data)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (score_id) DO UPDATE SET data = EXCLUDED.data, match_id = EXCLUDED.match_id`,
      [rec.score_id, rec.match_id, JSON.stringify(rec)],
    );
  }

  async loadScoreByMatch(matchId: string): Promise<ScoreRecord | null> {
    await this.ready();
    const res = await this.postgres.query<{ data: ScoreRecord }>(
      `SELECT data FROM sandbox_score_records WHERE match_id = $1 LIMIT 1`,
      [matchId],
    );
    return res.rows[0]?.data ?? null;
  }

  // ===== paired_cache =====

  async loadCache(key: string): Promise<ScoreRecord[] | null> {
    await this.ready();
    const res = await this.postgres.query<{ data: ScoreRecord[] }>(
      `SELECT data FROM sandbox_paired_cache WHERE cache_key = $1`,
      [key],
    );
    return res.rows[0]?.data ?? null;
  }

  async saveCache(key: string, scores: ScoreRecord[]): Promise<void> {
    await this.ready();
    await this.postgres.query(
      `INSERT INTO sandbox_paired_cache (cache_key, data)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (cache_key) DO UPDATE SET data = EXCLUDED.data`,
      [key, JSON.stringify(scores)],
    );
  }

  // ===== GenerationEval =====

  async upsertGenerationEval(gen: GenerationEval): Promise<void> {
    await this.ready();
    await this.postgres.query(
      `INSERT INTO sandbox_generation_evals (generation_id, generation_no, data)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (generation_id) DO UPDATE SET data = EXCLUDED.data, generation_no = EXCLUDED.generation_no`,
      [gen.generation_id, gen.generation, JSON.stringify(gen)],
    );
  }

  async listGenerations(): Promise<GenerationEval[]> {
    await this.ready();
    const res = await this.postgres.query<{ data: GenerationEval }>(
      `SELECT data FROM sandbox_generation_evals ORDER BY generation_no DESC`,
    );
    return res.rows.map((r) => r.data);
  }

  async getGeneration(id: string): Promise<GenerationEval | null> {
    await this.ready();
    const res = await this.postgres.query<{ data: GenerationEval }>(
      `SELECT data FROM sandbox_generation_evals WHERE generation_id = $1`,
      [id],
    );
    return res.rows[0]?.data ?? null;
  }

  /** 删除一条历史代记录(纯历史日志,删除不影响当前迭代状态)。 */
  async deleteGeneration(id: string): Promise<void> {
    await this.ready();
    await this.postgres.query(
      `DELETE FROM sandbox_generation_evals WHERE generation_id = $1`,
      [id],
    );
  }

  // ===== OrchestratorState(单例 id=1)=====

  async loadState(): Promise<OrchestratorState | null> {
    await this.ready();
    const res = await this.postgres.query<{ data: OrchestratorState }>(
      `SELECT data FROM sandbox_orchestrator_state WHERE id = 1`,
    );
    return res.rows[0]?.data ?? null;
  }

  async upsertState(state: OrchestratorState): Promise<void> {
    await this.ready();
    await this.postgres.query(
      `INSERT INTO sandbox_orchestrator_state (id, data, updated_at)
       VALUES (1, $1::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [JSON.stringify(state)],
    );
  }

  // ===== PromptVersion(prompt_text 单列,便于 ai.service 运行时读取;meta 存其余字段)=====

  async listPromptVersions(): Promise<PromptVersion[]> {
    await this.ready();
    const res = await this.postgres.query<{ prompt_text: string; meta: PromptVersionMeta }>(
      `SELECT prompt_text, meta FROM sandbox_prompt_versions`,
    );
    return res.rows.map((r) => ({ ...r.meta, prompt_text: r.prompt_text }));
  }

  async loadPromptVersion(id: string): Promise<PromptVersion | null> {
    await this.ready();
    const res = await this.postgres.query<{ prompt_text: string; meta: PromptVersionMeta }>(
      `SELECT prompt_text, meta FROM sandbox_prompt_versions WHERE version_id = $1`,
      [id],
    );
    const row = res.rows[0];
    return row ? { ...row.meta, prompt_text: row.prompt_text } : null;
  }

  /** ai.service 运行时按 version_id 取提示词正文(原 prompt-loader.loadPromptVersionText)。 */
  async loadPromptVersionText(id: string): Promise<string | null> {
    await this.ready();
    const res = await this.postgres.query<{ prompt_text: string }>(
      `SELECT prompt_text FROM sandbox_prompt_versions WHERE version_id = $1`,
      [id],
    );
    return res.rows[0]?.prompt_text ?? null;
  }

  async upsertPromptVersion(v: PromptVersion): Promise<void> {
    await this.ready();
    const { prompt_text, ...meta } = v;
    await this.postgres.query(
      `INSERT INTO sandbox_prompt_versions (version_id, status, prompt_text, meta)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (version_id) DO UPDATE SET status = EXCLUDED.status, prompt_text = EXCLUDED.prompt_text, meta = EXCLUDED.meta`,
      [v.version_id, v.status, prompt_text, JSON.stringify(meta)],
    );
  }

  /** patchStatus 用:整体覆盖 meta(含 status) + 同步 status 列。 */
  async patchPromptVersionMeta(id: string, meta: PromptVersionMeta): Promise<void> {
    await this.ready();
    await this.postgres.query(
      `UPDATE sandbox_prompt_versions SET status = $2, meta = $3::jsonb WHERE version_id = $1`,
      [id, meta.status, JSON.stringify(meta)],
    );
  }

  /** 删除一个提示词版本(terminate 回滚本次候选用)。 */
  async deletePromptVersion(id: string): Promise<void> {
    await this.ready();
    await this.postgres.query(
      `DELETE FROM sandbox_prompt_versions WHERE version_id = $1`,
      [id],
    );
  }

  // ===== Sandbox judge / optimizer prompt assets(复用 eval_prompt_* 版本表)=====

  async listEvalPromptAssets(assetKeys?: string[]): Promise<EvalPromptAssetRow[]> {
    await this.ready();
    const rows = assetKeys && assetKeys.length > 0
      ? await this.postgres.query<EvalPromptAssetRow>(
          `SELECT asset_key, version, content, parent_version, note, metadata, created_at
           FROM eval_prompt_assets
           WHERE asset_key = ANY($1)
           ORDER BY asset_key ASC, version DESC`,
          [assetKeys],
        )
      : await this.postgres.query<EvalPromptAssetRow>(
          `SELECT asset_key, version, content, parent_version, note, metadata, created_at
           FROM eval_prompt_assets
           ORDER BY asset_key ASC, version DESC`,
        );
    return rows.rows;
  }

  async loadEvalPromptAsset(assetKey: string, version: number): Promise<EvalPromptAssetRow | null> {
    await this.ready();
    const res = await this.postgres.query<EvalPromptAssetRow>(
      `SELECT asset_key, version, content, parent_version, note, metadata, created_at
       FROM eval_prompt_assets
       WHERE asset_key = $1 AND version = $2`,
      [assetKey, version],
    );
    return res.rows[0] ?? null;
  }

  async createEvalPromptAssetVersion(
    assetKey: string,
    content: string,
    opts: { parentVersion?: number; note?: string; metadata?: Record<string, unknown> | null } = {},
  ): Promise<EvalPromptAssetRow> {
    await this.ready();
    const latest = await this.postgres.query<{ version: number }>(
      `SELECT version FROM eval_prompt_assets WHERE asset_key = $1 ORDER BY version DESC LIMIT 1`,
      [assetKey],
    );
    const version = (latest.rows[0]?.version ?? 0) + 1;
    const res = await this.postgres.query<EvalPromptAssetRow>(
      `INSERT INTO eval_prompt_assets (id, asset_key, version, content, parent_version, note, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       RETURNING asset_key, version, content, parent_version, note, metadata, created_at`,
      [
        randomUUID(),
        assetKey,
        version,
        content,
        opts.parentVersion ?? latest.rows[0]?.version ?? null,
        opts.note ?? null,
        JSON.stringify(opts.metadata ?? null),
      ],
    );
    return res.rows[0];
  }

  async listEvalPromptGenerations(): Promise<EvalPromptGenerationRow[]> {
    await this.ready();
    const res = await this.postgres.query<EvalPromptGenerationRow>(
      `SELECT id, manifest, parent_id, status, is_best, score, note, created_at
       FROM eval_prompt_generations
       ORDER BY created_at DESC`,
    );
    return res.rows;
  }

  async loadEvalPromptGeneration(id: string): Promise<EvalPromptGenerationRow | null> {
    await this.ready();
    const res = await this.postgres.query<EvalPromptGenerationRow>(
      `SELECT id, manifest, parent_id, status, is_best, score, note, created_at
       FROM eval_prompt_generations
       WHERE id = $1`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  async loadActiveEvalPromptGeneration(): Promise<EvalPromptGenerationRow | null> {
    await this.ready();
    const state = await this.postgres.query<{ active_generation_id: string | null }>(
      `SELECT active_generation_id FROM eval_prompt_state WHERE id = 1`,
    );
    const id = state.rows[0]?.active_generation_id;
    return id ? this.loadEvalPromptGeneration(id) : null;
  }

  async upsertEvalPromptGeneration(
    generation: Omit<EvalPromptGenerationRow, "created_at">,
  ): Promise<EvalPromptGenerationRow> {
    await this.ready();
    const res = await this.postgres.query<EvalPromptGenerationRow>(
      `INSERT INTO eval_prompt_generations (id, manifest, parent_id, status, is_best, score, note)
       VALUES ($1, $2::jsonb, $3, $4, $5, $6::jsonb, $7)
       ON CONFLICT (id) DO UPDATE
       SET manifest = EXCLUDED.manifest,
           parent_id = EXCLUDED.parent_id,
           status = EXCLUDED.status,
           is_best = EXCLUDED.is_best,
           score = EXCLUDED.score,
           note = EXCLUDED.note
       RETURNING id, manifest, parent_id, status, is_best, score, note, created_at`,
      [
        generation.id,
        JSON.stringify(generation.manifest),
        generation.parent_id ?? null,
        generation.status,
        generation.is_best,
        JSON.stringify(generation.score ?? null),
        generation.note ?? null,
      ],
    );
    return res.rows[0];
  }

  async setActiveEvalPromptGeneration(id: string): Promise<void> {
    await this.ready();
    await this.postgres.query(
      `INSERT INTO eval_prompt_state (id, active_generation_id)
       VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET active_generation_id = EXCLUDED.active_generation_id`,
      [id],
    );
  }
}
