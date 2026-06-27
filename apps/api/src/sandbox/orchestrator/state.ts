// M5.2 编排器状态:champion / population / 代计数 / 失败记忆 / 评测集版本。
// MVP 单线贪心:population = [champion](top-k 在 Phase 4)。文件持久化 orchestrator-state.json。

import { Injectable } from "@nestjs/common";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ActiveRun } from "./active-run";
import { BASELINE_VERSION_ID } from "./prompt-version";

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
  private readonly file: string;

  constructor() {
    const root = process.env.SANDBOX_OUT_DIR ?? join(process.cwd(), "sandbox-out");
    this.file = join(root, "orchestrator-state.json");
  }

  load(): OrchestratorState | null {
    if (!existsSync(this.file)) return null;
    try {
      return JSON.parse(readFileSync(this.file, "utf-8")) as OrchestratorState;
    } catch {
      return null;
    }
  }

  save(state: OrchestratorState): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(state, null, 2), "utf-8");
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
