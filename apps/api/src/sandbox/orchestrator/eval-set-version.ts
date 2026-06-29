// M5.12 评测集版本化 + 重基线纪律。《编排器模块》§10。
// 关键纪律:不同 eval_set 版本上的分数【不可直接比较】;每个版本的 validated_metrics 必须标注其 eval_set 版本。
// 升级评测集后:champion 需在新集上【重新基线化】,paired_cache 失效重算。
//   - paired_cache 失效是【自动】的:cacheKey 内嵌 evalSetVersion(见 paired-eval.cacheKey),
//     新版本天然落到不同 key,旧 key 永不再命中(无害,可选清理)。
//   - 本模块提供"可比性守卫"与"是否需重基线"的纯判定,防"v1 上 46 分 vs v2 上 44 分"被误读成进步。

import type { PromptVersionMeta } from "./prompt-version";

/** 是否需要重基线:state 当前 eval_set 版本与目标评测集版本不同 → 需在新版本上重跑 champion。 */
export function rebaselineRequired(
  currentEvalSetVersion: string,
  targetEvalSetVersion: string,
): boolean {
  return currentEvalSetVersion !== targetEvalSetVersion;
}

/**
 * validated_metrics 是否与当前评测集版本可比:仅当该版本的指标【标注的 eval_set 版本】等于当前版本。
 * 跨版本不可直接比较(排行榜/晋升判断须先确认同版本)。
 */
export function metricsComparable(
  meta: PromptVersionMeta,
  currentEvalSetVersion: string,
): boolean {
  return meta.eval_set_version === currentEvalSetVersion;
}

/**
 * 重基线计划:升级评测集后要做的事(供编排器执行)。
 * - champion 在新版本上重新评测(产生新版本下的 validated_metrics);
 * - 旧版本 paired_cache 标记为 stale(可清理;不清也无害,因 key 不再命中)。
 */
export interface RebaselinePlan {
  championId: string;
  fromEvalSetVersion: string;
  toEvalSetVersion: string;
  /** 跨版本不可比的提示语,写进日志/前台避免误读。 */
  note: string;
}

export function planRebaseline(
  championId: string,
  fromVersion: string,
  toVersion: string,
): RebaselinePlan {
  return {
    championId,
    fromEvalSetVersion: fromVersion,
    toEvalSetVersion: toVersion,
    note: `评测集 ${fromVersion} → ${toVersion}:跨版本分数不可直接比较;champion 需在 ${toVersion} 上重基线,旧 paired_cache 失效。`,
  };
}
