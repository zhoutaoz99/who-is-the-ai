// M4.10 tried_and_rejected 全局记忆压缩 + M4.11 假设验证回环。《优化器模块》§7/§11。
// 压缩:历史会膨胀,按 (edit_type, target) 聚成"死路类别"喂优化器,而非逐条原文。
// 假设回环:编排器评测后对照子版本 hypothesis —— 目标维度是否真按预测改善?
//   推翻(改了别处/target 没动/引发回退)→ 写进 tried_and_rejected,优化器下次换思路。

import type { ValidationReport } from "../aggregate/validation";
import type { TriedAndRejectedEntry } from "../orchestrator/state";

/** 压缩后的"死路类别"(喂优化器的 tried_and_rejected)。 */
export interface TriedCluster {
  edit_type: string;
  target: string;
  /** 该类被否次数。 */
  count: number;
  /** 最近一次所在代。 */
  last_gen: number;
  /** 代表性结论(取最近一条 reason)。 */
  result: string;
}

/**
 * 按 (edit_type, target) 聚类压缩。同类只喂一条"死路类别"(带次数 + 最近结论),
 * 而非逐条原文 —— 防上下文膨胀,也更清楚"哪个方向反复失败"。
 */
export function compressTried(entries: TriedAndRejectedEntry[]): TriedCluster[] {
  const groups = new Map<string, TriedCluster>();
  for (const e of entries) {
    const editType = e.edit_type ?? "(未标算子)";
    const target = e.target_dimension ?? "(未标靶子)";
    const key = `${editType}|${target}`;
    const prev = groups.get(key);
    if (!prev) {
      groups.set(key, {
        edit_type: editType,
        target,
        count: 1,
        last_gen: e.generation,
        result: e.reason,
      });
    } else {
      prev.count += 1;
      if (e.generation >= prev.last_gen) {
        prev.last_gen = e.generation;
        prev.result = e.reason; // 取最近一代的结论
      }
    }
  }
  // 按"反复失败次数"降序(最该避开的死路排前),次数同则按最近代。
  return [...groups.values()].sort(
    (a, b) => b.count - a.count || b.last_gen - a.last_gen,
  );
}

export interface HypothesisCheck {
  /** 目标维度是否如预测改善(target 指标 improved;rubric/后果指标回退看主 margin)。 */
  held: boolean;
  note: string;
}

/**
 * M4.11 假设验证:对照 child 的 target 在配对验证信号里是否真改善。
 * - target = "probe:X" → 看 validation 的 "probe_pass:X" verdict==improved。
 * - target = rubric 维度(诊断维,不在决策验证信号里)或 margin/后果指标 → 回退看主 margin。
 * - 无配对数据 → held=false(无法证实,按推翻处理,促优化器换思路)。
 */
export function evaluateHypothesis(
  target: string | undefined,
  validation: ValidationReport,
): HypothesisCheck {
  const bucket = validation.buckets[0];
  if (!bucket) return { held: false, note: "无配对数据,假设无法证实" };

  const marginVerdict = bucket.metrics["blind_suspicion_margin"]?.verdict;
  let metricKey: string | null = null;
  if (target && (target.startsWith("probe:") || target.startsWith("probe_pass:"))) {
    const type = target.split(":")[1];
    metricKey = `probe_pass:${type}`;
  }

  if (metricKey && bucket.metrics[metricKey]) {
    const v = bucket.metrics[metricKey].verdict;
    return {
      held: v === "improved",
      note: `目标 ${target} 验证 verdict=${v}(主 margin=${marginVerdict ?? "?"})`,
    };
  }
  // 无法直接核对 target(rubric 维 / 后果指标)→ 用主 margin 代理。
  return {
    held: marginVerdict === "improved",
    note: `target ${target ?? "?"} 不在决策验证信号内,以主 margin verdict=${marginVerdict ?? "?"} 代理`,
  };
}
