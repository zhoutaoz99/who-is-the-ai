// M6.7 optimize / holdout 分层切分(2:1,分布镜像)。《场景库 · 分层配比与回灌》§3 步骤 4。
// 按 (probe_type × social_situation) 分层,每层内 2:1 切到 optimize/holdout —— 这样 holdout 的维度
// 分布与 optimize 镜像(否则验收不公平)。确定性(seed 派生)。
// 注意:本函数只切【标签层】;真正的 probe 实例隔离(optimize 用一组、holdout 用从不出现的实例)
// 由 ProbeBank 的 split_exposure + resolveProbe 保证(见 probe-bank.ts / M6.8)。

import { mulberry32 } from "../rng";
import type { ScenarioTags } from "./dimensions";

export interface SplitResult<T> {
  optimize: T[];
  holdout: T[];
}

/**
 * 把已打标的场景按层 2:1 切分。
 * @param holdoutRatio holdout 占比(默认 1/3)。
 * @param stratumKey 分层键(默认 probe_type|social_situation)。
 */
export function splitOptimizeHoldout<T extends Pick<ScenarioTags, "probe_type" | "social_situation">>(
  tagged: T[],
  holdoutRatio = 1 / 3,
  seed = 20260630,
  stratumKey: (t: T) => string = (t) => `${t.probe_type}|${t.social_situation}`,
): SplitResult<T> {
  // 分层。
  const strata = new Map<string, T[]>();
  for (const t of tagged) {
    const k = stratumKey(t);
    const arr = strata.get(k) ?? [];
    arr.push(t);
    strata.set(k, arr);
  }

  const optimize: T[] = [];
  const holdout: T[] = [];
  const rng = mulberry32(seed);
  for (const arr of strata.values()) {
    // 层内洗牌后按比例切:holdout 取 round(len*ratio),其余进 optimize。
    const shuffled = [...arr];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const nHold = Math.round(shuffled.length * holdoutRatio);
    holdout.push(...shuffled.slice(0, nHold));
    optimize.push(...shuffled.slice(nHold));
  }
  return { optimize, holdout };
}

/**
 * 分布镜像偏差体检:逐层比较 optimize/holdout 的占比,返回最大偏差(应在阈值内)。
 * 纯函数,供切分后自检。
 */
export function distributionDrift<T extends Pick<ScenarioTags, "probe_type" | "social_situation">>(
  split: SplitResult<T>,
  dim: (t: T) => string = (t) => t.probe_type,
): number {
  const frac = (arr: T[]) => {
    const total = arr.length || 1;
    const m = new Map<string, number>();
    for (const t of arr) m.set(dim(t), (m.get(dim(t)) ?? 0) + 1);
    const out = new Map<string, number>();
    for (const [k, c] of m) out.set(k, c / total);
    return out;
  };
  const fo = frac(split.optimize);
  const fh = frac(split.holdout);
  const keys = new Set([...fo.keys(), ...fh.keys()]);
  let maxDrift = 0;
  for (const k of keys) maxDrift = Math.max(maxDrift, Math.abs((fo.get(k) ?? 0) - (fh.get(k) ?? 0)));
  return maxDrift;
}
