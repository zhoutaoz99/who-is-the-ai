import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { PostgresService } from "../data/postgres.service";
import { AiPersonaContext } from "./ai.types";
import { DEFAULT_AI_PERSONAS, setActivePersonas } from "./ai.personas";
import {
  loadPrompt,
  readPromptFile,
  renderTemplateString,
} from "./prompt-loader";

/** 人格库在版本库中的 asset key(内容存 JSON)。 */
export const PERSONAS_ASSET_KEY = "ai-player/personas";

/** 受版本管理的文本模板(AI 玩家专用;sim-human/* 不纳入)。 */
export const TEXT_ASSET_KEYS = [
  "ai-player/system-speech-strategy.txt",
  "ai-player/system-speech-expression.txt",
  "ai-player/system-vote.txt",
  "ai-player/user-speech-strategy-template.txt",
  "ai-player/user-speech-expression-template.txt",
  "ai-player/user-vote-template.txt",
];

export const ALL_ASSET_KEYS = [...TEXT_ASSET_KEYS, PERSONAS_ASSET_KEY];

const SEED_GENERATION_ID = "gen-0001";

export type GenerationAssets = {
  generationId: string;
  /** 文本 asset key -> 正文(原始,未 trim)。 */
  prompts: Record<string, string>;
  personas: AiPersonaContext[];
};

export type GenerationSummary = {
  id: string;
  parentId: string | null;
  status: string;
  isBest: boolean;
  score: unknown;
  note: string | null;
  manifest: Record<string, number>;
  createdAt: string;
};

/**
 * DB 支撑的 AI 提示词版本库。
 * - active 代的 asset 正文常驻内存,供对局热路径同步访问(零额外延迟)。
 * - 历史代查询走异步 DB,仅供版本感知复盘使用。
 * - 回滚 = 改 active 指针(单行 UPDATE)后 reload。
 */
@Injectable()
export class PromptRegistry implements OnModuleInit {
  private readonly logger = new Logger(PromptRegistry.name);
  private activeGenerationId = SEED_GENERATION_ID;
  private activePrompts = new Map<string, string>();

  constructor(private readonly postgres: PostgresService) {}

  async onModuleInit(): Promise<void> {
    await this.postgres.ready;
    await this.seedIfEmpty();
    await this.loadActive();
  }

  // ---------- 热路径(同步)----------

  getActiveGenerationId(): string {
    return this.activeGenerationId;
  }

  /** 取一个 system/static 提示词(已 trim)。未载入时回退文件。 */
  getPrompt(key: string): string {
    const value = this.activePrompts.get(key);
    return value === undefined ? loadPrompt(key) : value.trim();
  }

  /** 渲染一个模板。未载入时回退文件。 */
  render(key: string, vars: Record<string, string>): string {
    const template = this.activePrompts.get(key);
    return renderTemplateString(
      template === undefined ? readPromptFile(key) : template,
      vars,
    );
  }

  // ---------- 载入 active ----------

  async loadActive(): Promise<void> {
    const genId = await this.readActivePointer();
    const assets = await this.getGenerationAssets(genId);
    this.activeGenerationId = assets.generationId;
    this.activePrompts = new Map(Object.entries(assets.prompts));
    setActivePersonas(assets.personas);
    this.logger.log(`已载入 active 提示词代: ${this.activeGenerationId}`);
  }

  private async readActivePointer(): Promise<string> {
    const res = await this.postgres.query<{
      active_generation_id: string | null;
    }>("SELECT active_generation_id FROM ai_prompt_state WHERE id = 1");
    return res.rows[0]?.active_generation_id ?? SEED_GENERATION_ID;
  }

  // ---------- 版本感知读取(异步)----------

  /** 取某一代的全部 asset 正文 + 解析后的人格库。未知代回退文件 + 默认人格。 */
  async getGenerationAssets(generationId: string): Promise<GenerationAssets> {
    const genRes = await this.postgres.query<{
      manifest: Record<string, number>;
    }>("SELECT manifest FROM ai_prompt_generations WHERE id = $1", [
      generationId,
    ]);
    const manifest = genRes.rows[0]?.manifest;
    const prompts: Record<string, string> = {};
    let personas: AiPersonaContext[] = DEFAULT_AI_PERSONAS;

    if (!manifest) {
      this.logger.warn(`未知提示词代 ${generationId},回退当前文件 + 默认人格库`);
      for (const key of TEXT_ASSET_KEYS) prompts[key] = readPromptFile(key);
      return { generationId, prompts, personas };
    }

    for (const [key, version] of Object.entries(manifest)) {
      const content = await this.readAssetContent(key, version);
      if (key === PERSONAS_ASSET_KEY) {
        if (content) {
          try {
            personas = JSON.parse(content) as AiPersonaContext[];
          } catch {
            this.logger.warn(`人格库 v${version} 解析失败,回退默认人格库`);
          }
        }
      } else {
        prompts[key] = content ?? readPromptFile(key);
      }
    }
    // 补齐缺失的文本 asset
    for (const key of TEXT_ASSET_KEYS) {
      if (prompts[key] === undefined) prompts[key] = readPromptFile(key);
    }
    return { generationId, prompts, personas };
  }

  async readAssetContent(
    key: string,
    version: number,
  ): Promise<string | null> {
    const res = await this.postgres.query<{ content: string }>(
      "SELECT content FROM ai_prompt_assets WHERE asset_key = $1 AND version = $2",
      [key, version],
    );
    return res.rows[0]?.content ?? null;
  }

  // ---------- 版本库写操作 ----------

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
       FROM ai_prompt_generations ORDER BY created_at`,
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

  /**
   * 从某一来源代(默认当前 active)派生新代:把 changedAssets 里的每个 asset
   * bump 一个新版本,manifest 继承其余;新代默认 candidate(不自动激活)。
   */
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
      if (!ALL_ASSET_KEYS.includes(key)) {
        throw new Error(`不支持的 asset key: ${key}`);
      }
    }
    const fromGenId = opts.fromGenId ?? (await this.readActivePointer());
    const base = await this.postgres.query<{
      manifest: Record<string, number>;
    }>("SELECT manifest FROM ai_prompt_generations WHERE id = $1", [fromGenId]);
    const baseManifest = base.rows[0]?.manifest;
    if (!baseManifest) throw new Error(`未知的来源代: ${fromGenId}`);

    return this.postgres.transaction(async (client) => {
      const manifest: Record<string, number> = { ...baseManifest };
      for (const [key, content] of Object.entries(opts.changedAssets)) {
        const vres = await client.query<{ max: number | null }>(
          "SELECT MAX(version) AS max FROM ai_prompt_assets WHERE asset_key = $1",
          [key],
        );
        const nextVersion = Number(vres.rows[0]?.max ?? 0) + 1;
        await client.query(
          `INSERT INTO ai_prompt_assets
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
        `INSERT INTO ai_prompt_generations
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

  /** 切换 active 代(含回滚),并热重载内存缓存。 */
  async setActive(generationId: string): Promise<void> {
    const exists = await this.postgres.query(
      "SELECT 1 FROM ai_prompt_generations WHERE id = $1",
      [generationId],
    );
    if (!exists.rowCount) throw new Error(`未知的代: ${generationId}`);
    await this.postgres.transaction(async (client) => {
      await client.query(
        "UPDATE ai_prompt_generations SET status='archived' WHERE status='active'",
      );
      await client.query(
        "UPDATE ai_prompt_generations SET status='active' WHERE id=$1",
        [generationId],
      );
      await client.query(
        `INSERT INTO ai_prompt_state (id, active_generation_id) VALUES (1,$1)
         ON CONFLICT (id) DO UPDATE SET active_generation_id = EXCLUDED.active_generation_id`,
        [generationId],
      );
    });
    await this.loadActive();
  }

  async markBest(generationId: string): Promise<void> {
    await this.postgres.transaction(async (client) => {
      await client.query(
        "UPDATE ai_prompt_generations SET is_best=false WHERE is_best=true",
      );
      await client.query(
        "UPDATE ai_prompt_generations SET is_best=true WHERE id=$1",
        [generationId],
      );
    });
  }

  async writeScore(generationId: string, score: unknown): Promise<void> {
    await this.postgres.query(
      "UPDATE ai_prompt_generations SET score=$2 WHERE id=$1",
      [generationId, JSON.stringify(score)],
    );
  }

  /**
   * 删除某一代。
   * - 存在子代时不允许删除(谱系完整性)。
   * - 删除的若是 active 代,先回退到其父代(若无父代则拒绝,避免系统无 active)。
   * - 仅删除代记录本身;asset 版本可能被其他代共享,故不连带删除。
   */
  async deleteGeneration(generationId: string): Promise<void> {
    const becameActive = await this.postgres.transaction(async (client) => {
      const genRes = await client.query<{
        parent_id: string | null;
        status: string;
      }>(
        "SELECT parent_id, status FROM ai_prompt_generations WHERE id = $1",
        [generationId],
      );
      const gen = genRes.rows[0];
      if (!gen) throw new Error(`未知的代: ${generationId}`);

      const childRes = await client.query(
        "SELECT 1 FROM ai_prompt_generations WHERE parent_id = $1 LIMIT 1",
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
          "UPDATE ai_prompt_generations SET status='archived' WHERE status='active'",
        );
        await client.query(
          "UPDATE ai_prompt_generations SET status='active' WHERE id=$1",
          [gen.parent_id],
        );
        await client.query(
          `INSERT INTO ai_prompt_state (id, active_generation_id) VALUES (1,$1)
           ON CONFLICT (id) DO UPDATE SET active_generation_id = EXCLUDED.active_generation_id`,
          [gen.parent_id],
        );
      }

      await client.query("DELETE FROM ai_prompt_generations WHERE id=$1", [
        generationId,
      ]);
      return rolledBackTo;
    });

    // 若删除的是 active 代,重载内存缓存到回退后的父代。
    if (becameActive) {
      await this.loadActive();
      this.logger.log(
        `已删除 active 代 ${generationId},回退激活到父代 ${becameActive}`,
      );
    } else {
      this.logger.log(`已删除代 ${generationId}`);
    }
  }

  // ---------- 播种 ----------

  private async seedIfEmpty(): Promise<void> {
    const res = await this.postgres.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM ai_prompt_assets",
    );
    if (Number(res.rows[0]?.count ?? "0") > 0) return;

    this.logger.log("播种 AI 提示词版本库 gen-0001(来自当前文件 + 默认人格库)");
    await this.postgres.transaction(async (client) => {
      const manifest: Record<string, number> = {};
      for (const key of TEXT_ASSET_KEYS) {
        await client.query(
          `INSERT INTO ai_prompt_assets
            (id, asset_key, version, content, parent_version, note, created_at)
           VALUES ($1,$2,1,$3,NULL,$4,NOW())`,
          [randomUUID(), key, readPromptFile(key), "seed from file"],
        );
        manifest[key] = 1;
      }
      await client.query(
        `INSERT INTO ai_prompt_assets
          (id, asset_key, version, content, parent_version, note, created_at)
         VALUES ($1,$2,1,$3,NULL,$4,NOW())`,
        [
          randomUUID(),
          PERSONAS_ASSET_KEY,
          JSON.stringify(DEFAULT_AI_PERSONAS, null, 2),
          "seed from DEFAULT_AI_PERSONAS",
        ],
      );
      manifest[PERSONAS_ASSET_KEY] = 1;

      await client.query(
        `INSERT INTO ai_prompt_generations
          (id, manifest, parent_id, status, is_best, note, created_at)
         VALUES ($1,$2,NULL,'active',true,$3,NOW())`,
        [SEED_GENERATION_ID, JSON.stringify(manifest), "seed generation"],
      );
      await client.query(
        `INSERT INTO ai_prompt_state (id, active_generation_id) VALUES (1,$1)
         ON CONFLICT (id) DO UPDATE SET active_generation_id = EXCLUDED.active_generation_id`,
        [SEED_GENERATION_ID],
      );
    });
  }

  private async nextGenerationId(client: PoolClient): Promise<string> {
    const res = await client.query<{ id: string }>(
      "SELECT id FROM ai_prompt_generations WHERE id ~ '^gen-[0-9]+$'",
    );
    let max = 0;
    for (const row of res.rows) {
      const n = Number(row.id.slice(4));
      if (Number.isFinite(n) && n > max) max = n;
    }
    return `gen-${String(max + 1).padStart(4, "0")}`;
  }
}
