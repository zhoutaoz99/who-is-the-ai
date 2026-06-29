// M4.8 算子表 OPERATOR_MAP + 类型约束。《优化器模块》§2.6/§5。
// 把"对一个破绽该用哪个/哪两个算子"分两步定下来:
//   第一步 类型约束:每类破绽只有 2–3 个对路算子(直接把 7 选 N 砍到对路几个);
//   第二步 战绩排序(scoreboard.ts):在对路算子里按历史接受率排序,冷启动退默认优先级。

import type { OperatorScoreboard } from "./scoreboard";
import { winRate } from "./scoreboard";

export type EditType =
  | "add_negative_constraint"
  | "add_fewshot"
  | "remove_tell_inducer"
  | "reword_persona"
  | "strengthen_or_reorder"
  | "generalize_to_reflex"
  | "consolidate";

/** 破绽类型(target 归一化后的类别;探测各类统一归 "probe")。 */
export type TargetType =
  | "probe"
  | "结构化指纹"
  | "客服感"
  | "博弈参与"
  | "立场情绪"
  | "存在感"
  | "语言质感";

/** 破绽类型 → 对路算子(默认优先级从高到低)。不在表里的算子根本不派。 */
export const OPERATOR_MAP: Record<TargetType, EditType[]> = {
  probe: ["generalize_to_reflex", "add_fewshot", "add_negative_constraint"],
  结构化指纹: ["remove_tell_inducer", "add_negative_constraint"],
  客服感: ["remove_tell_inducer", "reword_persona"],
  博弈参与: ["add_fewshot", "strengthen_or_reorder"],
  立场情绪: ["reword_persona", "add_fewshot"],
  存在感: ["reword_persona", "strengthen_or_reorder"],
  语言质感: ["add_fewshot", "reword_persona"],
};

/**
 * 把一个 assigned_target 归一到破绽类型。
 * - "probe:realtime_info" / "probe_pass:arithmetic" / 任何探测类 → "probe"
 * - 八维诊断维度名(结构化指纹/客服感/…)→ 同名类型
 * - blind_suspicion_margin 等"后果指标"不是可定向破绽 → null(应留作上下文,不当靶子)
 */
export function typeOfTarget(target: string): TargetType | null {
  if (!target) return null;
  if (target.startsWith("probe:") || target.startsWith("probe_pass:")) return "probe";
  const t = target as TargetType;
  if (t in OPERATOR_MAP) return t;
  return null;
}

/**
 * 给一个破绽选 n 个 edit_type:先类型约束砍到对路算子,再按战绩排序(无数据保持默认优先级)。
 * @returns 最多 n 个 edit_type(主弱点 n=2 做 A/B,次要弱点 n=1)。无对路算子(后果指标)→ 空。
 */
export function pickEditTypes(
  target: string,
  n: number,
  scoreboard: OperatorScoreboard,
): EditType[] {
  const type = typeOfTarget(target);
  if (!type) return [];
  const cands = OPERATOR_MAP[type];
  // 稳定排序:按 (winRate desc, 默认优先级 asc) —— 无数据时 winRate 相等 → 退回默认顺序。
  const ranked = cands
    .map((e, i) => ({ e, i, wr: winRate(scoreboard, type, e) }))
    .sort((a, b) => (b.wr - a.wr) || (a.i - b.i))
    .map((x) => x.e);
  return ranked.slice(0, Math.max(0, n));
}
