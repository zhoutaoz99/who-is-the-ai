// F0 一代闭环的后台运行单元(active run)类型。
// 编排器把 runGenerationAuto 从阻塞调用改成后台 run:逐 phase 推进、逐局/逐 phase emit 进度,
// 在 confirm 模式下于 awaiting_confirmation 暂停等人 confirm。active_run 持久化进 state,重启可续(仅 awaiting 可续)。

import type { GateDecision } from "./gate";
import type { PromptValidation } from "../optimizer/validate-prompt";
import type { ValidationReport } from "../aggregate/validation";

export type RunPhase =
  | "evaluating_champion"
  | "optimizing"
  | "validating"
  | "evaluating_child"
  | "gating"
  | "awaiting_confirmation"
  | "settled";

export type RunMode = "auto" | "confirm";
export type RunDecision = "promoted" | "rejected" | "stopped";

/** 单局完成进度(过程可视化用)。 */
export interface MatchProgress {
  side: "champion" | "child";
  scenario_id: string;
  seed: number;
  run: number;
  margin: number | null;
  veto: boolean;
  status: string;
}

/** 优化器候选(供前台 review + 编辑后接受)。 */
export interface ActiveRunChild {
  version_id: string;
  target: string;
  edit_type: string;
  hypothesis?: string;
  diff_summary?: string;
  prompt_text: string;
}

export interface ActiveRun {
  run_id: string;
  phase: RunPhase;
  mode: RunMode;
  /** 本 run 将产生的代数号(= 当前 generation + 1)。 */
  generation: number;
  champion_id: string;
  plan_summary: {
    scenarios: string[];
    seedsPerScenario: number;
    runsPerSeed: number;
    evalSetVersion: string;
  };
  /** optimize+validate 后填充。 */
  child?: ActiveRunChild;
  /** gating 后填充。 */
  validation?: ValidationReport;
  gate?: GateDecision;
  /** validate_prompt 结果。 */
  validate?: PromptValidation;
  progress: {
    champion_done: number;
    champion_total: number;
    child_done: number;
    child_total: number;
    matches: MatchProgress[];
  };
  decision?: RunDecision;
  started_at: string;
  settled_at?: string;
  error?: string;
}

/** 人机确认结果(accept=晋升 / reject=拒绝;edited=编辑后接受的改后提示词)。 */
export interface ConfirmResult {
  accept: boolean;
  edited?: string;
}
