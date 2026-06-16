import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PoolClient } from "pg";
import { PostgresService } from "../data/postgres.service";
import { renderTemplateString } from "./prompt-loader";
import type { GenerationSummary } from "./prompt-registry";

const EVAL_GENERATION_PREFIX = "eval-gen-";
const SEED_GENERATION_ID = `${EVAL_GENERATION_PREFIX}0001`;

export const REPLAY_SCORE_SYSTEM_ASSET_KEY =
  "replay-score/system-replay-score.txt";
export const REPLAY_SCORE_USER_ASSET_KEY =
  "replay-score/user-replay-score-template.txt";
export const AUTO_OPTIMIZE_SYSTEM_ASSET_KEY =
  "auto-optimize/system-prompt-optimizer.txt";
export const AUTO_OPTIMIZE_USER_ASSET_KEY =
  "auto-optimize/user-prompt-optimizer-template.txt";

export const EVAL_PROMPT_SOURCES = {
  [REPLAY_SCORE_SYSTEM_ASSET_KEY]: {
    filename: "system-replay-score.txt",
  },
  [REPLAY_SCORE_USER_ASSET_KEY]: {
    filename: "user-replay-score-template.txt",
  },
  [AUTO_OPTIMIZE_SYSTEM_ASSET_KEY]: {
    filename: "system-prompt-optimizer.txt",
  },
  [AUTO_OPTIMIZE_USER_ASSET_KEY]: {
    filename: "user-prompt-optimizer-template.txt",
  },
} as const satisfies Record<string, { filename: string }>;

export const EVAL_PROMPT_ASSET_KEYS = Object.keys(
  EVAL_PROMPT_SOURCES,
) as Array<keyof typeof EVAL_PROMPT_SOURCES>;

export type EvalPromptAssetKey = (typeof EVAL_PROMPT_ASSET_KEYS)[number];

export type EvalGenerationAssets = {
  generationId: string;
  assets: Record<string, string>;
};

/**
 * 评估尺子版本库。
 * - 管理打分/自动优化两类评估提示词。
 * - 运行时只读取 active 代,支持人工手动派生/激活/回滚。
 */
@Injectable()
export class EvalPromptRegistry implements OnModuleInit {
  private readonly logger = new Logger(EvalPromptRegistry.name);
  private activeGenerationId = SEED_GENERATION_ID;
  private activeAssets = new Map<string, string>();
  private evalPromptsDirCache: string | null = null;
  private evalPromptsDirResolved = false;

  constructor(private readonly postgres: PostgresService) {}

  async onModuleInit(): Promise<void> {
    await this.postgres.ready;
    await this.seedIfEmpty();
    await this.loadActive();
  }

  getActiveGenerationId(): string {
    return this.activeGenerationId;
  }

  getPrompt(key: EvalPromptAssetKey): string {
    const value = this.activeAssets.get(key);
    return value === undefined ? this.readSourceAsset(key).trim() : value.trim();
  }

  async getPromptForGeneration(
    generationId: string,
    key: EvalPromptAssetKey,
  ): Promise<string> {
    const assets = await this.getGenerationAssets(generationId);
    return (assets.assets[key] ?? this.readSourceAsset(key)).trim();
  }

  render(key: EvalPromptAssetKey, vars: Record<string, string>): string {
    const template = this.activeAssets.get(key);
    return renderTemplateString(
      template === undefined ? this.readSourceAsset(key) : template,
      vars,
    );
  }

  async renderForGeneration(
    generationId: string,
    key: EvalPromptAssetKey,
    vars: Record<string, string>,
  ): Promise<string> {
    const assets = await this.getGenerationAssets(generationId);
    return renderTemplateString(
      assets.assets[key] ?? this.readSourceAsset(key),
      vars,
    );
  }

  async loadActive(): Promise<void> {
    const genId = await this.readActivePointer();
    const assets = await this.getGenerationAssets(genId);
    this.activeGenerationId = assets.generationId;
    this.activeAssets = new Map(Object.entries(assets.assets));
    this.logger.log(`已载入 active 评估尺子代: ${this.activeGenerationId}`);
  }

  private async readActivePointer(): Promise<string> {
    const res = await this.postgres.query<{
      active_generation_id: string | null;
    }>("SELECT active_generation_id FROM eval_prompt_state WHERE id = 1");
    return res.rows[0]?.active_generation_id ?? SEED_GENERATION_ID;
  }

  async getGenerationAssets(generationId: string): Promise<EvalGenerationAssets> {
    const genRes = await this.postgres.query<{
      manifest: Record<string, number>;
    }>("SELECT manifest FROM eval_prompt_generations WHERE id = $1", [generationId]);
    const manifest = genRes.rows[0]?.manifest;
    const assets: Record<string, string> = {};

    if (!manifest) {
      this.logger.warn(`未知评估尺子代 ${generationId},回退当前文件`);
      for (const key of EVAL_PROMPT_ASSET_KEYS) assets[key] = this.readSourceAsset(key);
      return { generationId, assets };
    }

    for (const key of EVAL_PROMPT_ASSET_KEYS) {
      const version = Number(manifest[key]);
      if (!Number.isFinite(version) || version <= 0) continue;
      const content = await this.readAssetContent(key, version);
      assets[key] = content ?? this.readSourceAsset(key);
    }
    for (const key of EVAL_PROMPT_ASSET_KEYS) {
      if (assets[key] === undefined) assets[key] = this.readSourceAsset(key);
    }
    return { generationId, assets };
  }

  async readAssetContent(key: string, version: number): Promise<string | null> {
    const res = await this.postgres.query<{ content: string }>(
      "SELECT content FROM eval_prompt_assets WHERE asset_key = $1 AND version = $2",
      [key, version],
    );
    return res.rows[0]?.content ?? null;
  }

  async listGenerations(): Promise<GenerationSummary[]> {
    const res = await this.postgres.query<{
      id: string;
      manifest: Record<string, number>;
      parent_id: string | null;
      status: string;
      is_best: boolean;
      score: unknown;
      note: string | null;
      created_at: string;
    }>(
      `SELECT id, manifest, parent_id, status, is_best, score, note, created_at
       FROM eval_prompt_generations ORDER BY created_at`,
    );
    return res.rows.map((r) => ({
      id: r.id,
      parentId: r.parent_id,
      status: r.status,
      isBest: r.is_best,
      score: r.score,
      note: r.note,
      manifest: r.manifest,
      createdAt: r.created_at,
    }));
  }

  async createGeneration(opts: {
    fromGenId?: string;
    changedAssets: Record<string, string>;
    note?: string;
  }): Promise<GenerationSummary> {
    const changedKeys = Object.keys(opts.changedAssets);
    if (changedKeys.length === 0) {
      throw new Error("createGeneration 需要至少一个 changedAssets");
    }
    for (const key of changedKeys) {
      if (!EVAL_PROMPT_ASSET_KEYS.includes(key as EvalPromptAssetKey)) {
        throw new Error(`不支持的 asset key: ${key}`);
      }
    }
    const fromGenId = opts.fromGenId ?? (await this.readActivePointer());
    const base = await this.postgres.query<{
      manifest: Record<string, number>;
    }>("SELECT manifest FROM eval_prompt_generations WHERE id = $1", [fromGenId]);
    const baseManifest = base.rows[0]?.manifest;
    if (!baseManifest) throw new Error(`未知的来源代: ${fromGenId}`);
    const baseAssets = await this.getGenerationAssets(fromGenId);
    const effectiveChangedAssets = Object.fromEntries(
      Object.entries(opts.changedAssets).filter(
        ([key, content]) => content !== (baseAssets.assets[key] ?? ""),
      ),
    );
    if (Object.keys(effectiveChangedAssets).length === 0) {
      throw new Error("未检测到实际内容变更");
    }

    return this.postgres.transaction(async (client) => {
      const manifest: Record<string, number> = {};
      for (const key of EVAL_PROMPT_ASSET_KEYS) {
        const version = Number(baseManifest[key]);
        if (Number.isFinite(version) && version > 0) manifest[key] = version;
      }
      for (const [key, content] of Object.entries(effectiveChangedAssets)) {
        const vres = await client.query<{ max: number | null }>(
          "SELECT MAX(version) AS max FROM eval_prompt_assets WHERE asset_key = $1",
          [key],
        );
        const nextVersion = Number(vres.rows[0]?.max ?? 0) + 1;
        await client.query(
          `INSERT INTO eval_prompt_assets
            (id, asset_key, version, content, parent_version, note, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
          [
            randomUUID(),
            key,
            nextVersion,
            content,
            baseManifest[key] ?? null,
            opts.note ?? null,
          ],
        );
        manifest[key] = nextVersion;
      }
      const newGenId = await this.nextGenerationId(client);
      const createdAt = new Date().toISOString();
      await client.query(
        `INSERT INTO eval_prompt_generations
          (id, manifest, parent_id, status, is_best, note, created_at)
         VALUES ($1,$2,$3,'candidate',false,$4,$5)`,
        [newGenId, JSON.stringify(manifest), fromGenId, opts.note ?? null, createdAt],
      );
      return {
        id: newGenId,
        parentId: fromGenId,
        status: "candidate",
        isBest: false,
        score: null,
        note: opts.note ?? null,
        manifest,
        createdAt,
      };
    });
  }

  async setActive(generationId: string): Promise<void> {
    const exists = await this.postgres.query(
      "SELECT 1 FROM eval_prompt_generations WHERE id = $1",
      [generationId],
    );
    if (!exists.rowCount) throw new Error(`未知的代: ${generationId}`);
    await this.postgres.transaction(async (client) => {
      await client.query(
        "UPDATE eval_prompt_generations SET status='archived' WHERE status='active'",
      );
      await client.query(
        "UPDATE eval_prompt_generations SET status='active' WHERE id=$1",
        [generationId],
      );
      await client.query(
        `INSERT INTO eval_prompt_state (id, active_generation_id) VALUES (1,$1)
         ON CONFLICT (id) DO UPDATE SET active_generation_id = EXCLUDED.active_generation_id`,
        [generationId],
      );
    });
    await this.loadActive();
  }

  async deleteGeneration(generationId: string): Promise<void> {
    const becameActive = await this.postgres.transaction(async (client) => {
      const genRes = await client.query<{
        parent_id: string | null;
        status: string;
      }>(
        "SELECT parent_id, status FROM eval_prompt_generations WHERE id = $1",
        [generationId],
      );
      const gen = genRes.rows[0];
      if (!gen) throw new Error(`未知的代: ${generationId}`);

      const childRes = await client.query(
        "SELECT 1 FROM eval_prompt_generations WHERE parent_id = $1 LIMIT 1",
        [generationId],
      );
      if ((childRes.rowCount ?? 0) > 0) {
        throw new Error("该版本存在子版本,不允许删除");
      }

      let rolledBackTo: string | null = null;
      if (gen.status === "active") {
        if (!gen.parent_id) {
          throw new Error("无法删除:该激活版本无父代可回退,请先激活其他版本");
        }
        rolledBackTo = gen.parent_id;
        await client.query(
          "UPDATE eval_prompt_generations SET status='archived' WHERE status='active'",
        );
        await client.query(
          "UPDATE eval_prompt_generations SET status='active' WHERE id=$1",
          [gen.parent_id],
        );
        await client.query(
          `INSERT INTO eval_prompt_state (id, active_generation_id) VALUES (1,$1)
           ON CONFLICT (id) DO UPDATE SET active_generation_id = EXCLUDED.active_generation_id`,
          [gen.parent_id],
        );
      }

      await client.query("DELETE FROM eval_prompt_generations WHERE id=$1", [
        generationId,
      ]);
      return rolledBackTo;
    });

    if (becameActive) {
      await this.loadActive();
      this.logger.log(
        `已删除 active 评估尺子代 ${generationId},回退激活到父代 ${becameActive}`,
      );
    } else {
      this.logger.log(`已删除评估尺子代 ${generationId}`);
    }
  }

  private async seedIfEmpty(): Promise<void> {
    const res = await this.postgres.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM eval_prompt_assets",
    );
    if (Number(res.rows[0]?.count ?? "0") > 0) return;

    this.logger.log(`播种评估尺子版本库 ${SEED_GENERATION_ID}(来自当前文件)`);
    await this.postgres.transaction(async (client) => {
      const manifest: Record<string, number> = {};
      for (const key of EVAL_PROMPT_ASSET_KEYS) {
        await client.query(
          `INSERT INTO eval_prompt_assets
            (id, asset_key, version, content, parent_version, note, created_at)
           VALUES ($1,$2,1,$3,NULL,$4,NOW())`,
          [randomUUID(), key, this.readSourceAsset(key), "seed from file"],
        );
        manifest[key] = 1;
      }

      await client.query(
        `INSERT INTO eval_prompt_generations
          (id, manifest, parent_id, status, is_best, note, created_at)
         VALUES ($1,$2,NULL,'active',false,$3,NOW())`,
        [SEED_GENERATION_ID, JSON.stringify(manifest), "seed generation"],
      );
      await client.query(
        `INSERT INTO eval_prompt_state (id, active_generation_id) VALUES (1,$1)
         ON CONFLICT (id) DO UPDATE SET active_generation_id = EXCLUDED.active_generation_id`,
        [SEED_GENERATION_ID],
      );
    });
  }

  private async nextGenerationId(client: PoolClient): Promise<string> {
    const res = await client.query<{ id: string }>(
      `SELECT id FROM eval_prompt_generations WHERE id ~ '^${EVAL_GENERATION_PREFIX}[0-9]+$'`,
    );
    let max = 0;
    for (const row of res.rows) {
      const n = Number(row.id.slice(EVAL_GENERATION_PREFIX.length));
      if (Number.isFinite(n) && n > max) max = n;
    }
    return `${EVAL_GENERATION_PREFIX}${String(max + 1).padStart(4, "0")}`;
  }

  private readSourceAsset(key: EvalPromptAssetKey): string {
    const source = EVAL_PROMPT_SOURCES[key];
    if (!source) throw new Error(`未知评估尺子 asset: ${key}`);
    return this.readEvalPromptFile(source.filename);
  }

  private readEvalPromptFile(filename: string): string {
    const override =
      filename === "system-replay-score.txt"
        ? process.env.EVAL_SCORE_PROMPT_PATH?.trim()
        : null;
    if (override && existsSync(override)) {
      return readFileSync(override, "utf-8");
    }
    return readFileSync(join(this.resolveEvalPromptsDir(), filename), "utf-8");
  }

  private resolveEvalPromptsDir(): string {
    if (this.evalPromptsDirResolved) return this.evalPromptsDirCache!;
    this.evalPromptsDirResolved = true;
    const dirs = [
      process.env.EVAL_PROMPTS_DIR?.trim(),
      join(process.cwd(), "eval", "prompts"),
      join(process.cwd(), "..", "eval", "prompts"),
      join(__dirname, "..", "..", "..", "..", "eval", "prompts"),
    ].filter(Boolean) as string[];
    this.evalPromptsDirCache =
      dirs.find((d) => existsSync(join(d, "system-replay-score.txt"))) ?? null;
    if (!this.evalPromptsDirCache) {
      throw new Error(`找不到 eval/prompts 目录(含评估尺子),已尝试: ${dirs.join(", ")}`);
    }
    return this.evalPromptsDirCache;
  }
}
