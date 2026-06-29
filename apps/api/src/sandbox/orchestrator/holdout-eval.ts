// M5.7 留出集复核闸(holdout_gate)。
// 子版本过【优化集接受闸】后,与 champion 在 holdout split 上再配对评测一次 —— 强制用
// 没见过的探测实例(holdout 场景 split=holdout → 引擎只解析 split_exposure=holdout/both 的 probe)。
// 意义双重(《编排器 §7.2》):①验【泛化】(学的是回避习惯,不是背了 optimize 的题);
//                          ②纠【选择偏差】(k 个里挑出的"赢家"是否真赢,而非配对里碰巧幸运)。
//
// 判据(比优化集略宽,holdout 样本通常更少,不强求同等显著):【方向一致 + 不显著变差】
//   - 方向一致:主指标 blind_suspicion_margin 在 holdout 上点估计仍朝改善方向(margin 下降 → point<0)。
//               背答案的改动在没见过的探测上不再降可疑度(point≥0)→ 方向不一致 → 拦下。
//   - 不显著变差:任何近真值信号(margin/存活/plurality/否决/各 probe 通过率)都不得【显著】回退
//               (verdict==='regressed' 即拦)。不要求 holdout 上也显著改善。

import type { Verdict } from "../aggregate/types";
import type { ValidationReport } from "../aggregate/validation";

export interface HoldoutDecision {
  decision: "pass" | "fail";
  reasons: string[];
  /** 主指标在 holdout 上的方向裁定(供记录)。 */
  marginVerdict: Verdict | null;
  /** 主指标 holdout 配对差(子 − 父;<0 为改善方向)。 */
  marginPoint: number | null;
  marginCi95: [number, number] | null;
}

/** 写入 GenerationEval 的 holdout 摘要(对齐《编排器 §11》child.holdout)。 */
export interface HoldoutSummary {
  eval_set: string;
  /** holdout 场景强制用没见过的探测实例(split=holdout 隔离保证)。 */
  held_out_probes: boolean;
  blind_suspicion_margin_paired_diff: number | null;
  ci95: [number, number] | null;
  /** 是否过留出闸(方向一致 + 不显著变差)。 */
  holds: boolean;
  reasons: string[];
}

/**
 * 留出集复核闸:输入是【子 vs 父在 holdout 上】的验证信号(与优化集同一套 buildValidation 产物)。
 * 无配对数据(buckets 空 / 无有效主指标)→ fail(无法复核泛化,保守拦下)。
 */
export function holdoutGate(report: ValidationReport): HoldoutDecision {
  if (report.buckets.length === 0) {
    return {
      decision: "fail",
      reasons: ["holdout 无配对数据(父子无共同 (scenario,seed),无法复核泛化)"],
      marginVerdict: null,
      marginPoint: null,
      marginCi95: null,
    };
  }

  const reasons: string[] = [];
  let pass = true;

  // 主指标(取首个有非空 point 的桶,供记录;方向一致逐桶判)。
  let marginVerdict: Verdict | null = null;
  let marginPoint: number | null = null;
  let marginCi95: [number, number] | null = null;
  let sawValidMargin = false;

  for (const bucket of report.buckets) {
    const m = bucket.metrics;
    const margin = m["blind_suspicion_margin"];

    // 方向一致:该桶有非空主指标点估计时,必须朝改善方向(margin 下降 → point<0)。
    if (margin && margin.point !== null) {
      sawValidMargin = true;
      if (marginVerdict === null) {
        marginVerdict = margin.verdict;
        marginPoint = margin.point;
        marginCi95 = margin.ci95;
      }
      if (margin.point >= 0) {
        pass = false;
        reasons.push(
          `[${bucket.form}] 主指标方向不一致(holdout margin point=${margin.point.toFixed(2)} ≥0,优化集的改善未在没见过的探测上泛化)`,
        );
      }
    }

    // 不显著变差:任何近真值信号显著回退即拦(holdout 上 verdict==='regressed')。
    for (const [key, summary] of Object.entries(m)) {
      if (summary.verdict === "regressed") {
        pass = false;
        reasons.push(`[${bucket.form}] ${key} 在 holdout 上显著回退(point=${summary.point ?? "-"})`);
      }
    }
  }

  // 没有任何有效主指标配对 → 无法判方向一致,保守拦下。
  if (!sawValidMargin) {
    pass = false;
    reasons.push("holdout 无有效主指标配对(blind_suspicion_margin 全部缺配对)");
  }

  return {
    decision: pass ? "pass" : "fail",
    reasons,
    marginVerdict,
    marginPoint,
    marginCi95,
  };
}

/** 由 holdout 验证信号 + 闸门结论装配 GenerationEval 用的 holdout 摘要。 */
export function buildHoldoutSummary(
  evalSet: string,
  report: ValidationReport,
  decision: HoldoutDecision,
): HoldoutSummary {
  return {
    eval_set: evalSet,
    held_out_probes: true,
    blind_suspicion_margin_paired_diff: decision.marginPoint,
    ci95: decision.marginCi95,
    holds: decision.decision === "pass",
    reasons: decision.reasons,
  };
}
