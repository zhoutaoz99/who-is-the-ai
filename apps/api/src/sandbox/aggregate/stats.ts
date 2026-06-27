// M3.5 统计原语:mean / bootstrap 置信区间 / Wilcoxon 符号秩近似 p。
// bootstrap 用种子化 mulberry32(可复现,不依赖 Math.random)——配对评测要可复现。
// 重采样单元是【场景】,回答"换一批场景这个结论还成不成立"(泛化性)。

import { mulberry32 } from "../rng";

export function mean(xs: number[]): number {
  if (xs.length === 0) return Number.NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/**
 * 非参数 bootstrap 估 95% CI:对场景级差值有放回重采样 nBoot 次,取 2.5/97.5 分位。
 * 空数组 → 返回跨 0 的区间(会判 inconclusive)。
 */
export function bootstrapCi(
  xs: number[],
  nBoot: number,
  rngSeed: number,
): [number, number] {
  const n = xs.length;
  if (n === 0) return [-Infinity, Infinity];
  const rng = mulberry32(rngSeed);
  const means = new Array<number>(nBoot);
  for (let b = 0; b < nBoot; b += 1) {
    let s = 0;
    for (let i = 0; i < n; i += 1) {
      s += xs[Math.floor(rng() * n)];
    }
    means[b] = s / n;
  }
  means.sort((a, b) => a - b);
  const lo = means[Math.min(means.length - 1, Math.floor(0.025 * nBoot))];
  const hi = means[Math.min(means.length - 1, Math.floor(0.975 * nBoot))];
  return [lo, hi];
}

/**
 * Wilcoxon 单样本符号秩检验(双侧),正态近似 + 平均秩处理结。
 * 仅作诊断 p(决策走 CI+MDE);n < minN 时返回 null。
 */
export function wilcoxonSignedRankP(xs: number[], minN = 10): number | null {
  const nonzero = xs.filter((x) => x !== 0);
  const n = nonzero.length;
  if (n < minN) return null;

  const signed = signedRanks(nonzero);
  const wPos = signed.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const meanW = (n * (n + 1)) / 4;
  const sdW = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24);
  if (sdW === 0) return null;
  const z = (wPos - meanW - 0.5) / sdW; // 0.5 连续性校正
  return 2 * (1 - normalCdf(Math.abs(z)));
}

/** 按 |值| 排名(结取平均秩),保留原值符号。 */
function signedRanks(values: number[]): number[] {
  const order = values
    .map((v, i) => ({ v, i }))
    .sort((a, b) => Math.abs(a.v) - Math.abs(b.v));
  const ranks = new Array<number>(values.length).fill(0);
  let i = 0;
  while (i < order.length) {
    let j = i;
    const absV = Math.abs(order[i].v);
    while (j < order.length && Math.abs(order[j].v) === absV) j += 1;
    const avgRank = (i + 1 + j) / 2; // 秩 i+1..j 的均值(1-indexed)
    for (let k = i; k < j; k += 1) {
      ranks[order[k].i] = order[k].v >= 0 ? avgRank : -avgRank;
    }
    i = j;
  }
  return ranks;
}

/** 标准正态 CDF,经 erf(Numerical Recipes 近似)。 */
function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function erf(x: number): number {
  const sign = x >= 0 ? 1 : -1;
  const ax = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-ax * ax);
  return sign * y;
}
