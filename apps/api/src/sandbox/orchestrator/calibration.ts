// M2.12 + M5.11 真人校准(防 Goodhart 的第三道闸)。《编排器》§9/§12 +《裁判》§11。
// 盲测可疑度只是【代理】,须定期用真人对局校准:
//   - 相关性体检:沙盒盲测可疑度 ↔ 真人局结果(被票出/真人怀疑)的相关性 correlation_proxy_vs_real;
//   - 相关性达标 → 代理可信,放心快速迭代;下滑 → 代理漂了,暂停晋升 + 触发修裁判;
//   - 真人为最终裁决:沙盒说 champion 变好、真人说变差 → 回滚 champion。
// 本模块的【相关性/裁决/回滚判定】是纯函数,可离线测;**实际运行需真实真人对局数据**(见函数注释)。

/** 一对校准样本:某版本在沙盒里的盲测可疑度 vs 真人局里的真实结果。 */
export interface CalibrationPair {
  version_id: string;
  /** 沙盒盲测可疑度代理(如该版本的 mean suspicion_margin 或 ai_final)。 */
  proxy: number;
  /** 真人局真实结果(如真人怀疑率 / 被票出率,0–1 或同量纲分数)。越高=越被识破。 */
  real: number;
}

export interface CalibrationResult {
  /** Pearson 线性相关(代理 vs 真值);样本 < 3 → null。 */
  pearson: number | null;
  /** Spearman 秩相关(抗非线性/离群);样本 < 3 → null。 */
  spearman: number | null;
  n: number;
  /** 是否达标(任一相关 ≥ 阈值即认为代理可信)。 */
  trustworthy: boolean;
}

/** 相关性下限(《编排器》§13 起步建议 0.6)。 */
export const CORR_THRESHOLD = 0.6;

/**
 * 相关性体检(M2.12 接口 + M5.11 体检)。
 * **运行依赖真实数据**:CalibrationPair.real 必须来自真人对局批次(被票出/真人怀疑标注);
 * 无真人数据时不可调用(没有真值就谈不上"代理 vs 真值")。
 */
export function correlationProxyVsReal(
  pairs: CalibrationPair[],
  threshold = CORR_THRESHOLD,
): CalibrationResult {
  const n = pairs.length;
  if (n < 3) {
    return { pearson: null, spearman: null, n, trustworthy: false };
  }
  const proxy = pairs.map((p) => p.proxy);
  const real = pairs.map((p) => p.real);
  const pearson = pearsonCorr(proxy, real);
  const spearman = pearsonCorr(ranks(proxy), ranks(real));
  const best = Math.max(pearson ?? -1, spearman ?? -1);
  return { pearson, spearman, n, trustworthy: best >= threshold };
}

export type CalibrationAction = "continue" | "freeze_and_fix";

/**
 * 校准裁决(M5.11):相关性达标 → 继续;下滑 → 冻结晋升 + 触发修裁判/侦探池。
 */
export function calibrationVerdict(result: CalibrationResult): {
  action: CalibrationAction;
  reason: string;
} {
  if (result.n < 3) {
    return { action: "freeze_and_fix", reason: `校准样本不足(n=${result.n}),无法体检相关性` };
  }
  if (result.trustworthy) {
    return {
      action: "continue",
      reason: `代理可信(pearson=${fmt(result.pearson)} / spearman=${fmt(result.spearman)})`,
    };
  }
  return {
    action: "freeze_and_fix",
    reason: `相关性下滑(pearson=${fmt(result.pearson)} / spearman=${fmt(result.spearman)})→ 代理漂移,冻结晋升、修裁判/侦探池`,
  };
}

/**
 * 翻车回滚判定(M5.11 / §12):沙盒说 champion 变好、真人说变差 → 以真人为准回滚。
 * @param sandboxImproved 沙盒判定本代 champion 比上一稳定版更好(margin 显著降)。
 * @param realRegressed 真人局判定本代 champion 比上一稳定版更差(被识破率上升)。
 */
export function shouldRollback(sandboxImproved: boolean, realRegressed: boolean): boolean {
  return sandboxImproved && realRegressed;
}

// ===== 统计辅助(纯函数)=====

/** Pearson 相关系数;零方差 → 0(无信息)。 */
export function pearsonCorr(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 2 || n !== ys.length) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx === 0 || vy === 0) return 0;
  return cov / Math.sqrt(vx * vy);
}

/** 秩(平均秩处理并列),供 Spearman。 */
export function ranks(values: number[]): number[] {
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const r = new Array<number>(values.length);
  let k = 0;
  while (k < indexed.length) {
    let j = k;
    while (j + 1 < indexed.length && indexed[j + 1].v === indexed[k].v) j += 1;
    const avgRank = (k + j) / 2 + 1; // 1-based 平均秩
    for (let m = k; m <= j; m += 1) r[indexed[m].i] = avgRank;
    k = j + 1;
  }
  return r;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function fmt(n: number | null): string {
  return n == null ? "?" : n.toFixed(2);
}
