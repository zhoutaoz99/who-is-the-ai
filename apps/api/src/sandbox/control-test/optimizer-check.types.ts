// 优化器自检(零对局)运行态 + 单坑结果类型。
// 验证链:挖坑 → 真优化器提案 → L0 机械有效 + L1 瞄准命中 + L2′ 覆盖判定(子代是否恢复具体处理)。

export type OptHoleStatus = "pending" | "proposing" | "judging" | "done" | "failed";

export interface OptCoverage {
  covered: boolean;
  /** 命中的原句(judge/keyword 给出)。 */
  quote?: string;
  /** 判定来源:judge=LLM 概念级 / keyword=关键词兜底(judge 调用失败时)。 */
  method: "judge" | "keyword";
}

export interface OptHoleResult {
  hole_id: string;
  target: string;
  probe_type: string;
  status: OptHoleStatus;
  child_version_id?: string;
  /** L0 机械有效性(validate_prompt)。 */
  validate?: { ok: boolean; reasons: string[] };
  /** L1 瞄准命中:child.target_dimension == 挖的坑 target。 */
  target_hit?: boolean;
  /** 坑深自检:挖坑后的种子是否仍被判"已覆盖"(true=浅坑,通用规则兜底)。 */
  seed_covered?: boolean;
  /** L2′ 子代覆盖判定。 */
  coverage?: OptCoverage;
  hypothesis?: string;
  edit_type?: string;
  diff_summary?: string;
  /** L0 && L1 && coverage.covered。 */
  pass: boolean;
  notes: string[];
  error?: string;
}

export type OptCheckPhase = "running" | "settled";

export interface OptimizerCheckRun {
  run_id: string;
  phase: OptCheckPhase;
  base_version_id: string;
  optimizer_model_id?: string;
  judge_model_id?: string;
  current_hole?: string;
  holes: OptHoleResult[];
  overall_pass?: boolean;
  decision?: "done" | "stopped";
  error?: string;
  started_at: string;
  settled_at?: string;
}
