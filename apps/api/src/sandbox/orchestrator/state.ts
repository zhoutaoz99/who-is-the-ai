// M5.2 编排器状态:champion / population / 代计数 / 失败记忆 / 评测集版本。
// MVP 单线贪心:population = [champion](top-k 在 Phase 4)。
// 持久化:Postgres(sandbox_orchestrator_state 单例)。存在大量同步读调用点
// (getState/getSnapshot/persistRun/recordGameStatus 等),故采用【内存缓存 + 启动加载 +
// write-through】:init() 从 DB 装入内存,load() 同步读内存,save() 同步写内存 + 触发 DB 写,
// flush() 等待 DB 写完成(关键落定路径用)。

import { Injectable, Logger } from "@nestjs/common";
import type { ActiveRun } from "./active-run";
import { BASELINE_VERSION_ID } from "./prompt-version";
import { SandboxRepository } from "../sandbox.repository";

export interface TriedAndRejectedEntry {
  version_id: string;
  hypothesis?: string;
  target_dimension?: string;
  edit_type?: string;
  reason: string;
  generation: number;
}

export interface OrchestratorState {
  champion: string;
  population: string[];
  generation: number;
  eval_set_version: string;
  tried_and_rejected: TriedAndRejectedEntry[];
  /** 活跃的一代 run(后台运行/待确认);无则 null。 */
  active_run: ActiveRun | null;
  updatedAt: string;
}

@Injectable()
export class OrchestratorStateStore {
  private readonly logger = new Logger(OrchestratorStateStore.name);
  private cache: OrchestratorState | null = null;
  private initialized = false;
  /** 最近一次 DB upsert 的 promise;flush() 等它。 */
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly repo: SandboxRepository) {}

  /** 启动加载:从 DB 装入内存缓存(由 OrchestratorService.onModuleInit 调一次)。 */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.cache = await this.repo.loadState();
    this.initialized = true;
  }

  load(): OrchestratorState | null {
    return this.cache;
  }

  save(state: OrchestratorState): void {
    this.cache = state;
    this.pending = this.repo.upsertState(state).catch((err) => {
      this.logger.warn(`orchestrator-state 落库失败: ${err instanceof Error ? err.message : err}`);
    });
  }

  /** 等待最近一次 DB 写完成(关键落定路径用,确保 champion 指针落盘)。 */
  async flush(): Promise<void> {
    await this.pending;
  }

  /** 播种初始状态:champion = v0-baseline。 */
  seedBaseline(): OrchestratorState {
    const state: OrchestratorState = {
      champion: BASELINE_VERSION_ID,
      population: [BASELINE_VERSION_ID],
      generation: 0,
      eval_set_version: "optimize_v1",
      tried_and_rejected: [],
      active_run: null,
      updatedAt: new Date().toISOString(),
    };
    this.save(state);
    return state;
  }
}
