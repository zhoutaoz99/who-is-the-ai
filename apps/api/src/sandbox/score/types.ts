// ScoreRecord —— 把一局 MatchRecord 变成可比较、可诊断的分数。
// 以《裁判评分模块 · 方案设计》§9 为准。本增量(Phase 1 MVP)只产出【决策信号层】:
// 客观结果指标 + 盲测可疑度(suspicion_margin)+ 否决项。
// 诊断层(rubric / humanness_composite / failure_cases)随《诊断评分》提示词在 Phase 2 接入。

import type { ScenarioForm } from "../scenario/types";

export const SCORE_RECORD_SCHEMA_VERSION = "1.3.0";

/** ok=正常;partial=裁判调用/解析部分失败(缺失字段不参与聚合);degraded=来源对局 degraded。 */
export type ScoreStatus = "ok" | "partial" | "degraded";

/** 单裁判对某玩家的盲测判定。 */
export interface BlindAssessment {
  player: string; // 匿名标签(玩家1…玩家N)
  ai_probability: number; // 0–100
  reason: string;
}

/** 单轮可疑度切片;MVP 局末一次只有一条(评估轮),逐轮轨迹在 Phase 2 补全。 */
export interface RoundSuspicion {
  round: number;
  scores: Record<string, number>; // 标签 → 概率
  ai_score: number | null;
}

export interface BlindSuspicion {
  per_round: RoundSuspicion[];
  ai_final: number | null;
  /** 被测 AI 在存活玩家里的可疑度排名,1 = 最可疑;并列取并列名次。 */
  suspicion_rank: number | null;
  /** ai_score − 其余存活玩家中的最高分(>0 表示 AI 是最可疑的那个,危险)。 */
  suspicion_margin: number | null;
}

/** 客观结果指标(纯计算,真值)。 */
export interface OutcomeMetrics {
  rounds_survived: number;
  eliminated_round: number | null;
  won: boolean;
  reached_terminal: string;
  /** 被测 AI 每轮被投票数。 */
  votes_received_by_round: Record<number, number>;
  /** 每轮被测 AI 是否成为票最高者(致命事件)。 */
  plurality_by_round: Record<number, boolean>;
  /** 按 probe_type 聚合的通过率;仅统计引擎 auto_eval 已判定的类型(None≠0)。 */
  probe_pass_by_type: Record<string, number>;
}

/** 诊断失败案例(《诊断评分》产出)。 */
export interface FailureCase {
  round: number;
  phase?: string;
  utterance: string;
  tell: string;
  note: string;
  blind_suspicion_delta: number;
  probe_ref?: string;
}

/** judge_eval_needed 探测的裁判裁定(M2.9;auto_check=null 的表演/出戏类)。 */
export interface ProbeVerdict {
  probe_id: string;
  type: string;
  result: "pass" | "fail";
  reason: string;
}

/** 八维诊断量表的键(《裁判评分模块》§5;顺序固定供组装/校验)。 */
export const RUBRIC_KEYS = [
  "客服感",
  "结构化指纹",
  "能力暴露",
  "立场情绪",
  "博弈参与",
  "出戏",
  "语言质感",
  "存在感",
] as const;
export type RubricKey = (typeof RUBRIC_KEYS)[number];

export interface ScoreRecord {
  schema_version: string;
  score_id: string; // s_<match_id>
  match_id: string;
  prompt_version_id: string;
  scenario_id: string;
  scenario_form: ScenarioForm; // 决策分桶用(spotlight/full_match 不混算)
  seed: number; // 本局种子(配对做差用,随 MatchRecord 透传)
  run_index: number; // 同场景多 run 的序号(四层 key 树叶子定位)
  judges: string[]; // 参评裁判模型 id;MVP 单裁判只有 1 个,失败为空
  judge_agreement: number | null; // 多裁判一致度;MVP 单裁判 → null
  outcome_metrics: OutcomeMetrics;
  blind_suspicion: BlindSuspicion;
  // —— 诊断信号(M2.6/2.7/2.9;仅 diagnose 时填充,默认空)——
  rubric?: Record<string, number>;
  humanness_composite?: number; // 仅看板趋势,非决策(《裁判》§5)
  /** judge_eval_needed 探测的裁判裁定(M2.9)。 */
  probe_verdicts?: ProbeVerdict[];
  /** 逐轮可疑度轨迹里跳升最大的轮(失败定位,M2.6);未诊断 → null。 */
  failure_round?: number | null;
  veto_triggered: boolean; // 硬否决:身份暴露类探测判 fail / 诊断 出戏=1
  failure_cases?: FailureCase[];
  status: ScoreStatus;
  errors?: string[];
  timestamp: string;
}
