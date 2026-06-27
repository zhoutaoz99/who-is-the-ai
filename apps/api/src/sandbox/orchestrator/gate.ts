// M5.5 接受闸门(优化集):决策只用近真值信号(可疑度 + 否决 + 客观结果),不用诊断量表。
// 过闸(全满足):主指标 blind_suspicion_margin 显著改善(improved) AND
//   否决不升 / 存活不退 / plurality 不退 / 关键探测不退(任一均不许 regressed)。
// 依据《编排器 §7.1》《评分聚合 §3.6》。

import type { Verdict } from "../aggregate/types";
import type { ValidationReport } from "../aggregate/validation";

export interface GateDecision {
  decision: "promote" | "reject";
  reasons: string[];
  /** 主指标 verdict(供 GenerationEval 记录)。 */
  marginVerdict: Verdict | null;
}

export function optimizeGate(report: ValidationReport): GateDecision {
  if (report.buckets.length === 0) {
    return {
      decision: "reject",
      reasons: ["无配对数据(父子无共同 (scenario,seed))"],
      marginVerdict: null,
    };
  }

  const reasons: string[] = [];
  let pass = true;
  let marginVerdict: Verdict | null = null;

  for (const bucket of report.buckets) {
    const m = bucket.metrics;
    const margin = m["blind_suspicion_margin"];
    if (marginVerdict === null) marginVerdict = margin?.verdict ?? null;

    // 主信号:可疑度必须【显著】下降(仅"不退"不够——只接受真实增益)。
    if (!margin || margin.verdict !== "improved") {
      pass = false;
      reasons.push(
        `[${bucket.form}] 主指标 blind_suspicion_margin 未显著改善(verdict=${margin?.verdict ?? "missing"}, point=${margin?.point ?? "-"})`,
      );
    }
    // 其余近真值信号:不许退步(inconclusive 可,regressed 不可)。
    if (m["veto_rate"]?.verdict === "regressed") {
      pass = false;
      reasons.push(`[${bucket.form}] veto_rate 上升`);
    }
    if (m["rounds_survived"]?.verdict === "regressed") {
      pass = false;
      reasons.push(`[${bucket.form}] rounds_survived 退步`);
    }
    if (m["plurality_rate"]?.verdict === "regressed") {
      pass = false;
      reasons.push(`[${bucket.form}] plurality_rate 退步(更常成最可疑)`);
    }
    for (const [key, summary] of Object.entries(m)) {
      if (key.startsWith("probe_pass:") && summary.verdict === "regressed") {
        pass = false;
        reasons.push(`[${bucket.form}] ${key} 退步`);
      }
    }
  }

  return { decision: pass ? "promote" : "reject", reasons, marginVerdict };
}
