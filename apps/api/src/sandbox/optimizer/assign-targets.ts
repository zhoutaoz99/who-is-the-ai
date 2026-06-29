// M4.7 外层靶子分配 assign_targets。《优化器模块》§2.5/§2.6。
// K 个候选的多样性不靠模型一次输出自造,而靠外层枚举 K 个互不相同的"靶子"(破绽×算子)。
// 策略:覆盖 top-N 弱点;最严重弱点配 2 个对路算子做 A/B;留 1 个自由探索名额(target=null);凑够 K。
//   - 对路算子 + 战绩排序见 operators.pickEditTypes(类型约束 + scoreboard)。
//   - 后果指标(margin 等,typeOfTarget=null)不可定向 → 自动跳过。

import type { WeakDimension } from "../aggregate/weak-dims";
import { pickEditTypes, typeOfTarget } from "./operators";
import type { EditType } from "./operators";
import type { OperatorScoreboard } from "./scoreboard";

export interface AssignedTarget {
  /** 要攻的破绽;null = 自由探索名额(让优化器自选)。 */
  assigned_target: string | null;
  /** 对路算子;自由名额或无对路算子时为空(让优化器自选)。 */
  assigned_edit_type: EditType | "";
}

/**
 * 分配 K 个靶子。weakDims 须已按 rank_score 排序(computeWeakDimensions 的输出即是)。
 * 最严重(第 0 个可定向)弱点派 2 个算子,其余各派 1 个,最后追加 1 个自由名额。
 * 无可定向弱点(全是后果指标)→ 只返回 1 个自由名额(回退到让优化器自选 / 上层用 margin)。
 */
export function assignTargets(
  weakDims: WeakDimension[],
  k: number,
  scoreboard: OperatorScoreboard,
): AssignedTarget[] {
  const targets: AssignedTarget[] = [];
  // 只在可定向(typeOfTarget 非 null)的弱点上派靶。
  const actionable = weakDims.filter((w) => typeOfTarget(w.metric) != null);

  let isFirst = true;
  for (const w of actionable) {
    if (targets.length >= k - 1) break; // 给自由名额留 1 个位
    const n = isFirst ? 2 : 1; // 最严重弱点配 2 个对路算子 A/B
    isFirst = false;
    const edits = pickEditTypes(w.metric, n, scoreboard);
    if (edits.length === 0) continue;
    for (const e of edits) {
      if (targets.length >= k - 1) break;
      targets.push({ assigned_target: w.metric, assigned_edit_type: e });
    }
  }

  // 自由探索名额(始终留 1 个,保留发现意外方向的可能)。
  targets.push({ assigned_target: null, assigned_edit_type: "" });
  return targets;
}
