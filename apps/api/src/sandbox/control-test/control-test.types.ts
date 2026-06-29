// 对照测试的运行态 + 报告类型(后台流式 run,过程可视化用)。

import type { Verdict } from "../aggregate/types";
import type { GateDecision } from "../orchestrator/gate";
import type { ControlKind } from "./control-prompts";

/** 单个指标在某 form 桶里的精简视图。 */
export interface MetricView {
  key: string;
  point: number | null; // 子 − 父
  ci95: [number, number] | null;
  verdict: Verdict;
}

/** 一个 form 桶的精简视图。 */
export interface BucketView {
  form: string;
  nScenarios: number;
  margin: MetricView | null; // blind_suspicion_margin(主信号)
  rounds_survived: MetricView | null;
  plurality_rate: MetricView | null;
  veto_rate: MetricView | null;
  probe_pass: MetricView[]; // 每个触发过的 probe 类型一条
}

/** 单条对照的结果。 */
export interface ControlResult {
  kind: ControlKind;
  label: string;
  child_version_id: string;
  expectation: string;
  gate: GateDecision;
  buckets: BucketView[];
  /** 该对照是否如预期(验证的是【流水线机器】对不对,不是 AI 好不好)。 */
  pass: boolean;
  /** 未通过 / 需注意的说明。 */
  notes: string[];
}

/** 对局生命周期状态(对齐 paired-eval)。 */
export type ControlGameStatus = "pending" | "running" | "scoring" | "finished" | "failed";

/**
 * 单局进度(过程可视化用)。以 (side, scenario_id, seed, run) 为稳定 key。
 * side = "parent"(champion 基线)| control kind("null"/"negative"/"positive")。
 */
export interface ControlGameItem {
  side: string;
  scenario_id: string;
  seed: number;
  run: number;
  status: ControlGameStatus;
  room_id?: string;
  match_id?: string;
  error?: string;
  phase?: string;
  current_round?: number;
  ai_alive?: number;
  ai_total?: number;
  margin?: number | null;
  veto?: boolean;
}

export type ControlTestPhase = "evaluating_parent" | "running_controls" | "settled";
export type ControlTestDecision = "done" | "stopped";

/** 对照测试运行态(内存;前台快照 + 流式增量都读它)。 */
export interface ControlTestRun {
  run_id: string;
  phase: ControlTestPhase;
  set_id: string;
  eval_set_version: string;
  parent_version_id: string;
  plan: { scenarios: string[]; seedsPerScenario: number; runsPerSeed: number };
  kinds: ControlKind[];
  /** 当前正在评测的对照(running_controls 阶段)。 */
  current_kind?: ControlKind;
  /** 父 + 各对照的逐局进度(按 side×scenario×seed×run upsert)。 */
  games: ControlGameItem[];
  /** 已完成对照的结果(逐条追加)。 */
  controls: ControlResult[];
  caveats: string[];
  overall_pass?: boolean;
  decision?: ControlTestDecision;
  error?: string;
  started_at: string;
  settled_at?: string;
}
