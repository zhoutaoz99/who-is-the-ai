// M5.1 PromptVersion 记录 + 版本化存储。
// prompt_text 是 AI 玩家讨论系统提示词(含 {{persona}} 占位);其余为元数据。
// baseline(v0-baseline)用当前 ai-player/system-discussion.txt 播种。结构对齐《总纲 §5》PromptVersion。
// 持久化:Postgres(sandbox_prompt_versions:prompt_text 单列 + meta jsonb)。
// 存在大量同步读调用点(getChampion/getVersion/list 等),故采用【内存缓存 + 启动加载 +
// write-through】:init() 从 DB 全量装入,load/list 同步读内存,save/patch 同步写内存 + 触发 DB 写。
// 运行时 ai.service 取 prompt_text 经 SandboxRepository.loadPromptVersionText 直读 DB(带缓存)。

import { Injectable, Logger } from "@nestjs/common";
import { loadPrompt } from "../../ai/prompt-loader";
import { SandboxRepository } from "../sandbox.repository";

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
  private readonly logger = new Logger(PromptVersionStore.name);
  private cache = new Map<string, PromptVersion>();
  private initialized = false;

  constructor(private readonly repo: SandboxRepository) {}

  /** 启动加载:从 DB 全量装入内存(由 OrchestratorService.onModuleInit 调一次)。 */
  async init(): Promise<void> {
    if (this.initialized) return;
    const all = await this.repo.listPromptVersions();
    this.cache = new Map(all.map((v) => [v.version_id, v]));
    this.initialized = true;
  }

  save(v: PromptVersion): void {
    this.cache.set(v.version_id, v);
    void this.repo.upsertPromptVersion(v).catch((err) => {
      this.logger.warn(`prompt-version ${v.version_id} 落库失败: ${err instanceof Error ? err.message : err}`);
    });
  }

  load(id: string): PromptVersion | null {
    return this.cache.get(id) ?? null;
  }

  loadMeta(id: string): PromptVersionMeta | null {
    const v = this.cache.get(id);
    return v ? toMeta(v) : null;
  }

  list(): PromptVersionMeta[] {
    return [...this.cache.values()].map(toMeta);
  }

  patchStatus(
    id: string,
    patch: Partial<Pick<PromptVersion, "status" | "validated_metrics" | "eval_set_version">>,
  ): boolean {
    const v = this.cache.get(id);
    if (!v) return false;
    const updated = { ...v, ...patch };
    this.cache.set(id, updated);
    void this.repo.patchPromptVersionMeta(id, toMeta(updated)).catch((err) => {
      this.logger.warn(`prompt-version ${id} patch 落库失败: ${err instanceof Error ? err.message : err}`);
    });
    return true;
  }

  /** 若 v0-baseline 不存在,用当前 ai-player/system-discussion.txt 播种为 champion。 */
  seedBaselineIfMissing(): PromptVersion {
    const existing = this.cache.get(BASELINE_VERSION_ID);
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
