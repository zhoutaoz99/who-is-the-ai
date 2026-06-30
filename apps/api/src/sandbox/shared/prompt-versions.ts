// M0.7 沙盒裁判/优化器 prompt 版本化加载。
// 运行时优先读 eval_prompt_state 指向的 generation manifest;缺失则回退文件 prompt。

import { Injectable, Logger } from "@nestjs/common";
import { loadPrompt, renderTemplateString } from "../../ai/prompt-loader";
import { SandboxRepository, type EvalPromptAssetRow, type EvalPromptGenerationRow } from "../sandbox.repository";

export const SANDBOX_PROMPT_ASSETS = [
  "sandbox/judge/blind-suspicion-system.txt",
  "sandbox/judge/blind-suspicion-user.txt",
  "sandbox/judge/rubric-diagnostic-system.txt",
  "sandbox/judge/rubric-diagnostic-user.txt",
  "sandbox/optimizer/system-prompt-optimizer.txt",
  "sandbox/optimizer/user-prompt-optimizer-template.txt",
  "sandbox/optimizer/system-prompt-crossover.txt",
  "sandbox/optimizer/user-prompt-crossover-template.txt",
] as const;

export type SandboxPromptAssetKey = (typeof SANDBOX_PROMPT_ASSETS)[number];

export interface SandboxPromptAssetView {
  asset_key: string;
  active_version: number | null;
  source: "db" | "file";
  content: string;
  versions: Array<Omit<EvalPromptAssetRow, "content"> & { content?: string }>;
}

@Injectable()
export class SandboxPromptService {
  private readonly logger = new Logger(SandboxPromptService.name);
  private activeGeneration: EvalPromptGenerationRow | null | undefined;
  private contentCache = new Map<string, string>();

  constructor(private readonly repo: SandboxRepository) {}

  async load(assetKey: SandboxPromptAssetKey | string): Promise<string> {
    const generation = await this.getActiveGeneration();
    const version = generation?.manifest?.[assetKey];
    if (typeof version === "number") {
      const cacheKey = `${assetKey}@${version}`;
      const cached = this.contentCache.get(cacheKey);
      if (cached != null) return cached;
      const row = await this.repo.loadEvalPromptAsset(assetKey, version);
      if (row) {
        const text = row.content.trim();
        this.contentCache.set(cacheKey, text);
        return text;
      }
      this.logger.warn(`active eval prompt 缺失: ${assetKey}@${version},回退文件`);
    }
    return loadPrompt(assetKey);
  }

  async render(assetKey: SandboxPromptAssetKey | string, vars: Record<string, string>): Promise<string> {
    return renderTemplateString(await this.load(assetKey), vars);
  }

  async listAssets(): Promise<{ active_generation: EvalPromptGenerationRow | null; assets: SandboxPromptAssetView[] }> {
    const active = await this.getActiveGeneration();
    const rows = await this.repo.listEvalPromptAssets([...SANDBOX_PROMPT_ASSETS]);
    const byKey = new Map<string, EvalPromptAssetRow[]>();
    for (const row of rows) {
      const arr = byKey.get(row.asset_key) ?? [];
      arr.push(row);
      byKey.set(row.asset_key, arr);
    }
    const assets: SandboxPromptAssetView[] = [];
    for (const key of SANDBOX_PROMPT_ASSETS) {
      const activeVersion = active?.manifest?.[key] ?? null;
      const activeRow = typeof activeVersion === "number"
        ? (byKey.get(key) ?? []).find((r) => r.version === activeVersion)
        : undefined;
      assets.push({
        asset_key: key,
        active_version: activeVersion,
        source: activeRow ? "db" : "file",
        content: activeRow?.content ?? loadPrompt(key),
        versions: (byKey.get(key) ?? []).map(({ content: _content, ...meta }) => meta),
      });
    }
    return { active_generation: active ?? null, assets };
  }

  async createAssetVersion(
    assetKey: SandboxPromptAssetKey | string,
    content: string,
    opts: { note?: string; activate?: boolean } = {},
  ): Promise<{ asset: EvalPromptAssetRow; generation?: EvalPromptGenerationRow }> {
    assertKnownAsset(assetKey);
    const asset = await this.repo.createEvalPromptAssetVersion(assetKey, content, {
      note: opts.note,
      metadata: { sandbox_prompt: true },
    });
    if (!opts.activate) return { asset };
    const generation = await this.createGenerationWithPatch(
      { [assetKey]: asset.version },
      opts.note ?? `activate ${assetKey}@${asset.version}`,
    );
    return { asset, generation };
  }

  async createGenerationWithPatch(
    patch: Record<string, number>,
    note?: string,
  ): Promise<EvalPromptGenerationRow> {
    for (const key of Object.keys(patch)) assertKnownAsset(key);
    const active = await this.getActiveGeneration();
    const manifest: Record<string, number> = { ...(active?.manifest ?? {}), ...patch };
    const generation = await this.repo.upsertEvalPromptGeneration({
      id: `sandbox-eval-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      manifest,
      parent_id: active?.id ?? null,
      status: "active",
      is_best: false,
      score: null,
      note: note ?? null,
    });
    await this.repo.setActiveEvalPromptGeneration(generation.id);
    this.activeGeneration = generation;
    this.contentCache.clear();
    return generation;
  }

  async activateGeneration(id: string): Promise<EvalPromptGenerationRow> {
    const generation = await this.repo.loadEvalPromptGeneration(id);
    if (!generation) throw new Error(`eval prompt generation 不存在: ${id}`);
    await this.repo.setActiveEvalPromptGeneration(id);
    this.activeGeneration = generation;
    this.contentCache.clear();
    return generation;
  }

  async listGenerations(): Promise<EvalPromptGenerationRow[]> {
    return this.repo.listEvalPromptGenerations();
  }

  private async getActiveGeneration(): Promise<EvalPromptGenerationRow | null> {
    if (this.activeGeneration !== undefined) return this.activeGeneration;
    this.activeGeneration = await this.repo.loadActiveEvalPromptGeneration();
    return this.activeGeneration;
  }
}

function assertKnownAsset(assetKey: string): asserts assetKey is SandboxPromptAssetKey {
  if (!(SANDBOX_PROMPT_ASSETS as readonly string[]).includes(assetKey)) {
    throw new Error(`不允许的 sandbox prompt asset: ${assetKey}`);
  }
}
