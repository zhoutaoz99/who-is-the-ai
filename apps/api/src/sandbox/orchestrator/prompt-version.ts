// M5.1 PromptVersion 记录 + 版本化存储(文件,MVP 不引 DB)。
// prompt_text 进 versions/<id>.prompt.txt(ai.service 经 prompt-loader.loadPromptVersionText 读取);
// 其余元数据进 versions/<id>.meta.json。baseline(v0-baseline)用当前 ai-player 提示词播种。
// 结构对齐《总纲 §5》PromptVersion。

import { Injectable } from "@nestjs/common";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadPrompt } from "../../ai/prompt-loader";

export type PromptVersionStatus = "candidate" | "accepted" | "rejected" | "champion";
export const BASELINE_VERSION_ID = "v0-baseline";

export interface PromptVersion {
  version_id: string;
  parent_id: string | null;
  prompt_text: string; // AI 玩家讨论系统提示词(含 {{persona}} 占位)
  persona_scope: "shared"; // MVP 只优化共享段
  status: PromptVersionStatus;
  hypothesis?: string;
  target_dimension?: string;
  edit_type?: string;
  created_by_generation?: number;
  validated_metrics?: Record<string, unknown>;
  eval_set_version?: string;
  created_at: string;
}

/** 元数据(prompt_text 之外,供排行榜/血脉展示)。 */
export type PromptVersionMeta = Omit<PromptVersion, "prompt_text">;

/** 去掉 prompt_text,只留元数据(接口返回/日志用,避免回传大段提示词)。 */
export function toMeta(v: PromptVersion): PromptVersionMeta {
  const { prompt_text: _omit, ...meta } = v;
  return meta;
}

@Injectable()
export class PromptVersionStore {
  private readonly dir: string;

  constructor() {
    const root = process.env.SANDBOX_OUT_DIR ?? join(process.cwd(), "sandbox-out");
    this.dir = join(root, "versions");
  }

  private promptPath(id: string): string {
    return join(this.dir, `${id}.prompt.txt`);
  }
  private metaPath(id: string): string {
    return join(this.dir, `${id}.meta.json`);
  }

  save(v: PromptVersion): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.promptPath(v.version_id), v.prompt_text, "utf-8");
    const { prompt_text: _omit, ...meta } = v;
    writeFileSync(this.metaPath(v.version_id), JSON.stringify(meta, null, 2), "utf-8");
  }

  load(id: string): PromptVersion | null {
    try {
      const meta = JSON.parse(readFileSync(this.metaPath(id), "utf-8")) as PromptVersionMeta;
      const prompt_text = readFileSync(this.promptPath(id), "utf-8");
      return { ...meta, prompt_text };
    } catch {
      return null;
    }
  }

  loadMeta(id: string): PromptVersionMeta | null {
    try {
      return JSON.parse(readFileSync(this.metaPath(id), "utf-8")) as PromptVersionMeta;
    } catch {
      return null;
    }
  }

  list(): PromptVersionMeta[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".meta.json"))
      .map((f) => JSON.parse(readFileSync(join(this.dir, f), "utf-8")) as PromptVersionMeta);
  }

  patchStatus(
    id: string,
    patch: Partial<Pick<PromptVersion, "status" | "validated_metrics" | "eval_set_version">>,
  ): boolean {
    const meta = this.loadMeta(id);
    if (!meta) return false;
    Object.assign(meta, patch);
    mkdirSync(dirname(this.metaPath(id)), { recursive: true });
    writeFileSync(this.metaPath(id), JSON.stringify(meta, null, 2), "utf-8");
    return true;
  }

  /** 若 v0-baseline 不存在,用当前 ai-player/system-discussion.txt 播种为 champion。 */
  seedBaselineIfMissing(): PromptVersion {
    const existing = this.load(BASELINE_VERSION_ID);
    if (existing) return existing;
    const baseline: PromptVersion = {
      version_id: BASELINE_VERSION_ID,
      parent_id: null,
      prompt_text: loadPrompt("ai-player/system-discussion.txt"),
      persona_scope: "shared",
      status: "champion",
      created_at: new Date().toISOString(),
    };
    this.save(baseline);
    return baseline;
  }
}
