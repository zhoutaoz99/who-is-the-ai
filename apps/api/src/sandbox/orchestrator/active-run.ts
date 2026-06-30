// F0 一代闭环的后台运行单元(active run)类型。
// 编排器把 runGenerationAuto 从阻塞调用改成后台 run:逐 phase 推进、逐局/逐 phase emit 进度,
// 在 confirm 模式下于 awaiting_confirmation 暂停等人 confirm。active_run 持久化进 state,重启可续(仅 awaiting 可续)。

import type { GateDecision } from "./gate";
import type { HoldoutDecision } from "./holdout-eval";
import type { PromptValidation } from "../optimizer/validate-prompt";
import type { ValidationReport } from "../aggregate/validation";

export type RunPhase =
  | "evaluating_champion"
  | "optimizing"
  | "validating"
  | "evaluating_child"
  | "gating"
  | "evaluating_holdout"
  | "awaiting_confirmation"
  | "settled";

export type RunMode = "auto" | "confirm";
export type RunDecision = "promoted" | "rejected" | "stopped";

/** 对局生命周期状态(对齐旧 iteration 的 pending→running→scoring→finished/failed)。 */
export type GameStatus = "pending" | "running" | "scoring" | "finished" | "failed";

/**
 * 单局进度(过程可视化用)。以 (side, scenario_id, seed, run) 为稳定 key,
 * 跨 pending→running→scoring→finished/failed 增量更新(前端按 key 就地 upsert)。
 * running 阶段带对局内细节(phase/当前轮/AI 存活),finished 阶段带 margin/veto。
 */
export interface GameItem {
  side: "champion" | "child";
  /** 多候选一代时,child 侧对局所属的候选版本。champion 侧为空。 */
  child_id?: string;
  scenario_id: string;
  seed: number;
  run: number;
  status: GameStatus;
  room_id?: string;
  /** 完成态:用于回看打分详情(按 match_id 从 DB 读 ScoreRecord)。 */
  match_id?: string;
  error?: string;
  /** 进行中:对局内实时细节(由 runMatch 的 onProgress 回调折算)。 */
  phase?: string;
  current_round?: number;
  ai_alive?: number;
  ai_total?: number;
  /** 完成态:盲测可疑度 margin + 是否触发否决。 */
  margin?: number | null;
  veto?: boolean;
}

/** 发给编排器的状态补丁(paired-eval 不知道 side,由编排器绑定)。 */
export type GameStatusPatch = Omit<GameItem, "side">;

/** 对局内实时细节(不含 key 字段与 status;由调用方补)。 */
export type GameDetail = Partial<
  Omit<GameItem, "side" | "scenario_id" | "seed" | "run" | "status">
>;

/** paired-eval 内部 publish 的更新补丁:必带 status,detail 可选(key 由 publish 绑定)。 */
export type GameStatusUpdate = { status: GameStatus } & GameDetail;

/** 优化器候选(供前台 review + 编辑后接受)。 */
export interface ActiveRunChild {
  version_id: string;
  based_on?: string;
  crossover?: {
    base: string;
    donor: string;
    grafted_trait: string;
  };
  target: string;
  edit_type: string;
  hypothesis?: string;
  diff_summary?: string;
  prompt_text: string;
  validate?: PromptValidation;
  validation?: ValidationReport;
  gate?: GateDecision;
  holdout?: HoldoutRun;
  decision?: "promoted" | "rejected";
  score?: number | null;
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
    /** 本 run 的完整配置(刷新/重连后前台回显用;与上面计划字段一起持久化进 state)。 */
    discussionSeconds?: number;
    judgeModelId?: string;
    judgeModelIds?: string[];
    diagnose?: boolean;
    costTier?: string;
    optimizerModelId?: string;
    assignedTarget?: string;
  };
  /** 所有候选;旧前台兼容字段 child 始终指向当前评测/选中的候选。 */
  children?: ActiveRunChild[];
  selected_child_id?: string;
  /** optimize+validate 后填充。 */
  child?: ActiveRunChild;
  /** gating 后填充(优化集闸门)。 */
  validation?: ValidationReport;
  gate?: GateDecision;
  /** 留出集复核(M5.7);仅过优化集闸时填充。null 表示未配置 holdout(跳过)。 */
  holdout?: HoldoutRun;
  /** validate_prompt 结果。 */
  validate?: PromptValidation;
  progress: {
    champion_done: number;
    champion_total: number;
    child_done: number;
    child_total: number;
    games: GameItem[];
  };
  decision?: RunDecision;
  started_at: string;
  settled_at?: string;
  error?: string;
}

/** 留出集复核进度 + 结论(过程可视化 + 落定决策用)。 */
export interface HoldoutRun {
  eval_set: string;
  /** 留出集逐局进度(独立于优化集 games[],side 同样区分 champion/child)。 */
  champion_total: number;
  champion_done: number;
  child_total: number;
  child_done: number;
  games: GameItem[];
  /** 复核完成后填充。 */
  validation?: ValidationReport;
  decision?: HoldoutDecision;
}

/** 人机确认结果(accept=晋升 / reject=拒绝;edited=编辑后接受的改后提示词)。 */
export interface ConfirmResult {
  accept: boolean;
  edited?: string;
}
