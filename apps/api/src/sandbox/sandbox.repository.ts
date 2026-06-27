// 沙盒数据持久化仓储:把原 sandbox-out/ 文件存储(MatchRecord / ScoreRecord /
// paired_cache / GenerationEval / OrchestratorState / PromptVersion)统一迁到 Postgres。
// 模式对齐项目既有风格:每实体一张表,完整文档存 jsonb data 列(见 game_rooms.room_data /
// iteration_runs.rounds)。无状态,集中所有沙盒 SQL;各 store/service 注入本类。
// 元数据型(state / prompt-version)由各自 store 做内存缓存,文档型直接调用本类 async 方法。

import { Injectable } from "@nestjs/common";
import { PostgresService } from "../data/postgres.service";
import type { GenerationEval } from "./orchestrator/generation-eval";
import type { OrchestratorState } from "./orchestrator/state";
import type { PromptVersion, PromptVersionMeta } from "./orchestrator/prompt-version";
import type { MatchRecord } from "./match-record/types";
import type { ScoreRecord } from "./score/types";

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
}
