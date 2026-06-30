// 真人校准(防 Goodhart 的第三道闸)。《真人校准 · 方案设计》§4/§6/§7 +《编排器》§9/§12 +《裁判》§11。
// 盲测可疑度只是【代理】,须定期用真人对局校准:
//   - 相关性体检(Spearman 秩相关 correlation_proxy_vs_real):沙盒 suspicion_margin ↔ 真人被票出率;
//   - 判定看【对版本 bootstrap 的 95% CI 下界】是否 ≥ 阈值(spec §4.1 头号坑:小样本不能只看点估计);
//   - 达标 → healthy,放心迭代;下滑 → drifting/broken,冻结晋升 + 修裁判/侦探;样本不足/无梯度 → low_confidence,只攒数据。
//   - 真人为最终裁决:沙盒说 champion 变好、真人说变差 → 回滚 champion。
// 本模块只做"代理 ↔ 真值"的纯函数体检与裁决;**实际运行需真实真人对局数据**(由 calibration.service 喂入)。

/** 一对校准样本(每个版本一行):同一版 champion 的沙盒代理值 vs 真人实测值。spec §3/§7。 */
export interface CalibrationPair {
  version: string;
  /** 沙盒代理:该版本在评测集上的聚合盲测可疑度 suspicion_margin(越大=沙盒越觉得像 AI)。 */
  proxy_suspicion_margin: number;
  /** 真人主指标:真人局里该版本 AI 被票出局的比例(越大=真人越识破)。 */
  human_eliminated_rate: number;
  /** 真人辅指标:真人投票里指向 AI 的票占比(连续、更早期、更灵敏)。 */
  human_ai_vote_share?: number;
}

export type CalibrationVerdict = "healthy" | "drifting" | "broken" | "low_confidence";
export type CalibrationAction = "continue" | "freeze_and_fix" | "hold";

export interface CalibrationResidual {
  version: string;
  note: string;
}

export interface CalibrationResult {
  /** Spearman ρ 点估计(主指标:margin ↔ 被票出率);样本不足 → null。 */
  correlation_proxy_vs_real: number | null;
  /** 对版本 bootstrap 的 95% CI;判定看下界。 */
  correlation_ci95: [number, number] | null;
  /** 辅:margin ↔ 指向AI票占比,交叉验证;缺辅数据 → null。 */
  correlation_aux_voteshare: number | null;
  n_versions: number;
  threshold: number;
  /** 沙盒分是否有足够梯度(全挤一起则秩无意义)。 */
  gradient_ok: boolean;
  verdict: CalibrationVerdict;
  /** 沙盒说强、真人却识破的版本(诊断漂移成因的最佳样本)。 */
  residual_flags: CalibrationResidual[];
}

/** 相关性下限(《编排器》§13 / spec §4 起步建议 0.6)。 */
export const CORR_THRESHOLD = 0.6;
/** 版本数下限:低于此标 low_confidence,不下结论(spec §105)。 */
export const MIN_VERSIONS = 6;
const BOOTSTRAP_N = 2000;

/**
 * 相关性体检(spec §4.1)。判定基于【bootstrap CI 下界】,不是点估计。
 * **运行依赖真实数据**:human_* 必须来自真人对局批次;无真人数据时配对为空 → low_confidence。
 */
export function correlationProxyVsReal(
  pairs: CalibrationPair[],
  opts: { threshold?: number; minVersions?: number; bootstrap?: number; seed?: number } = {},
): CalibrationResult {
  const threshold = opts.threshold ?? CORR_THRESHOLD;
  const minVersions = opts.minVersions ?? MIN_VERSIONS;
  const n = pairs.length;
  const proxy = pairs.map((p) => p.proxy_suspicion_margin);
  const human = pairs.map((p) => p.human_eliminated_rate);
  const gradient_ok = distinctCount(proxy) >= 3 && variance(proxy) > 1e-9;

  // 辅指标(指向 AI 票占比),仅当所有版本都带时才算。
  const voteShares = pairs.map((p) => p.human_ai_vote_share);
  const aux =
    voteShares.every((v) => typeof v === "number")
      ? spearman(proxy, voteShares as number[])
      : null;

  // 退化:版本不足 / 无梯度 → low_confidence,只攒数据。
  if (n < minVersions || !gradient_ok) {
    return {
      correlation_proxy_vs_real: n >= 2 ? spearman(proxy, human) : null,
      correlation_ci95: null,
      correlation_aux_voteshare: aux,
      n_versions: n,
      threshold,
      gradient_ok,
      verdict: "low_confidence",
      residual_flags: [],
    };
  }

  const rho = spearman(proxy, human);
  const ci = bootstrapSpearmanCi(proxy, human, opts.bootstrap ?? BOOTSTRAP_N, opts.seed ?? 1);
  const residual_flags = residualFlags(pairs);

  let verdict: CalibrationVerdict;
  if (rho == null || ci == null) {
    verdict = "low_confidence";
  } else if (ci[0] >= threshold) {
    verdict = "healthy"; // CI 下界达标
  } else if (ci[1] < threshold || rho <= 0) {
    verdict = "broken"; // 整段 CI 在阈值下,或负/脱钩
  } else {
    verdict = "drifting"; // 点估计偏低、CI 跨阈值
  }

  return {
    correlation_proxy_vs_real: rho,
    correlation_ci95: ci,
    correlation_aux_voteshare: aux,
    n_versions: n,
    threshold,
    gradient_ok,
    verdict,
    residual_flags,
  };
}

/**
 * 校准裁决 → 编排器动作(spec §6)。
 * healthy → continue;drifting/broken → freeze_and_fix;low_confidence → hold(不冻不解,只攒数据)。
 */
export function calibrationVerdict(result: CalibrationResult): {
  action: CalibrationAction;
  reason: string;
} {
  const r = fmt(result.correlation_proxy_vs_real);
  const ci = result.correlation_ci95
    ? `[${fmt(result.correlation_ci95[0])},${fmt(result.correlation_ci95[1])}]`
    : "n/a";
  switch (result.verdict) {
    case "healthy":
      return { action: "continue", reason: `代理可信(ρ=${r},CI95=${ci} 下界≥${result.threshold})` };
    case "drifting":
      return { action: "freeze_and_fix", reason: `代理疑漂(ρ=${r},CI95=${ci} 跨阈值)→ 冻结晋升、修裁判/侦探` };
    case "broken":
      return { action: "freeze_and_fix", reason: `代理脱钩(ρ=${r},CI95=${ci} 整段低于阈值/负相关)→ 冻结晋升、修裁判/侦探` };
    case "low_confidence":
    default:
      return {
        action: "hold",
        reason: `低置信(n=${result.n_versions},梯度=${result.gradient_ok})→ 只攒数据,不冻结不解冻`,
      };
  }
}

/**
 * 翻车回滚判定(spec §6):沙盒说 champion 变好、真人说变差 → 以真人为准回滚。
 */
export function shouldRollback(sandboxImproved: boolean, realRegressed: boolean): boolean {
  return sandboxImproved && realRegressed;
}

// ===== 统计(纯函数)=====

/** Spearman 秩相关 = 对两列的秩做 Pearson(并列取平均秩,通用式)。spec §4.1。 */
export function spearman(xs: number[], ys: number[]): number | null {
  if (xs.length < 2 || xs.length !== ys.length) return null;
  return pearsonCorr(ranks(xs), ranks(ys));
}

/** 对版本做 bootstrap(有放回重采),返回 ρ 的 95% CI。spec §4.1。 */
export function bootstrapSpearmanCi(
  xs: number[],
  ys: number[],
  nBoot = BOOTSTRAP_N,
  seed = 1,
): [number, number] | null {
  const n = xs.length;
  if (n < 3) return null;
  const rand = mulberry32(seed);
  const rhos: number[] = [];
  for (let b = 0; b < nBoot; b += 1) {
    const px: number[] = [];
    const py: number[] = [];
    for (let i = 0; i < n; i += 1) {
      const k = Math.floor(rand() * n);
      px.push(xs[k]);
      py.push(ys[k]);
    }
    const r = spearman(px, py);
    if (r != null && Number.isFinite(r)) rhos.push(r);
  }
  if (rhos.length === 0) return null;
  rhos.sort((a, b) => a - b);
  return [percentile(rhos, 2.5), percentile(rhos, 97.5)];
}

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

/** 残差体检:沙盒可疑度排名低(显得像人)但真人识破率排名高 的版本(Goodhart 具体案例)。 */
function residualFlags(pairs: CalibrationPair[]): CalibrationResidual[] {
  const n = pairs.length;
  if (n < 3) return [];
  const proxyRank = ranks(pairs.map((p) => p.proxy_suspicion_margin));
  const humanRank = ranks(pairs.map((p) => p.human_eliminated_rate));
  const flags: CalibrationResidual[] = [];
  for (let i = 0; i < n; i += 1) {
    // 秩差超过半数版本 → 显著脱钩。沙盒排名低、真人排名高 = 沙盒漏判。
    const diff = humanRank[i] - proxyRank[i];
    if (diff >= n / 2) {
      flags.push({
        version: pairs[i].version,
        note: `沙盒可疑度排名低(${fmt(proxyRank[i])})但真人识破排名高(${fmt(humanRank[i])}),疑裁判/侦探漏判`,
      });
    }
  }
  return flags;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length;
}
function distinctCount(xs: number[]): number {
  return new Set(xs).size;
}
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
/** 确定性 PRNG(bootstrap 可复现)。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function fmt(n: number | null): string {
  return n == null ? "?" : n.toFixed(2);
}
