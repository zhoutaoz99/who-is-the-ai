// M3.3 / M3.4 / M3.6 / M3.8 —— 单指标配对做差管线(整套聚合的命门)。
// 严格自底向上,顺序不可换、不可跨层:
//   (scenario,seed) 配对做差 → scenario 收敛 → bootstrap 估 CI → MDE+CI 卡 verdict
// §7 避坑断言以结构保证 + 注释标注:
//   #1 N=场景数(不是对局数):scenario 收敛后 len = 场景数。
//   #2 严格自底向上:先做差再收敛,绝不先平均成版本均分再相减。
//   #3 父子同 seed:配对 key 含 seed,缺配对整对弃。
//   #4 probe None≠0:value 返回 null → 该 type 不参与。
//   #5 剔除低置信 cell / 缺配对:任一侧 lowConfidence 或缺值 → 丢。

import type { CellEstimate, MetricSpec, MetricSummary, Verdict } from "./types";
import { bootstrapCi, mean, wilcoxonSignedRankP } from "./stats";

interface DiffPoint {
  scenario: string;
  seed: number;
  value: number; // 子 − 父
}

/** 对一个指标跑完整管线,产出 MetricSummary。 */
export function summarizeMetric(
  parentCells: CellEstimate[],
  childCells: CellEstimate[],
  spec: MetricSpec,
  cfg: { nBoot: number; minWilcoxonN: number; rngSeed: number },
): MetricSummary {
  // —— 第 2 层:(scenario,seed) 配对做差 ——
  const parentByKey = new Map(parentCells.map((c) => [cellKey(c), c]));
  const diffs: DiffPoint[] = [];
  for (const c of childCells) {
    const p = parentByKey.get(cellKey(c));
    if (!p) continue; // 〔避坑#3/#5〕缺配对 → 整对弃,不单边凑
    if (c.lowConfidence || p.lowConfidence) continue; // 〔避坑#5〕低置信 cell 不入
    const cv = spec.value(c);
    const pv = spec.value(p);
    if (cv == null || pv == null) continue; // 〔避坑#4〕probe 没触发 → 不配对
    diffs.push({ scenario: c.scenario, seed: c.seed, value: cv - pv });
  }

  // —— 第 2.5 层:scenario 内收敛,锁定 N = 场景数 ——
  const byScenario = new Map<string, number[]>();
  for (const d of diffs) {
    const arr = byScenario.get(d.scenario) ?? [];
    arr.push(d.value);
    byScenario.set(d.scenario, arr);
  }
  const scenarioValues = [...byScenario.values()].map((arr) => mean(arr));
  const nScenarios = scenarioValues.length; // 〔避坑#1〕N = 场景数,不是 seed 数/对局数

  // —— 第 3 层:bootstrap 估 CI(+ Wilcoxon 近似 p) ——
  const point = scenarioValues.length > 0 ? mean(scenarioValues) : null;
  const ci95 =
    point != null && scenarioValues.length > 0
      ? bootstrapCi(scenarioValues, cfg.nBoot, cfg.rngSeed)
      : null;
  const p =
    scenarioValues.length >= cfg.minWilcoxonN
      ? wilcoxonSignedRankP(scenarioValues, cfg.minWilcoxonN)
      : null;

  // —— 第 4 层:MDE + CI → verdict ——
  const verdict = decideVerdict(point, ci95, spec.mde, spec.betterWhen);

  return {
    key: spec.key,
    nScenarios,
    nPairs: diffs.length,
    point,
    ci95,
    mde: spec.mde,
    p,
    verdict,
  };
}

function cellKey(c: CellEstimate): string {
  return `${c.scenario}|${c.seed}`; // 〔避坑#3〕配对 key 含 seed
}

/**
 * verdict:CI 不含 0(能与噪声区分)&& |point| ≥ MDE(够大)才脱离 inconclusive;
 * 方向由 betterWhen 决定(suspicion margin 越低越好 / 存活·探测通过率越高越好)。
 * 手气好的改动点估计可能为负但 CI 跨 0 → 死在 inconclusive。
 */
function decideVerdict(
  point: number | null,
  ci95: [number, number] | null,
  mde: number,
  betterWhen: "lower" | "higher",
): Verdict {
  if (point == null || ci95 == null) return "inconclusive";
  const [lo, hi] = ci95;
  const excludesZero = lo > 0 || hi < 0;
  const meetsMde = Math.abs(point) >= mde;
  if (!excludesZero || !meetsMde) return "inconclusive";
  const improved = betterWhen === "lower" ? point < 0 : point > 0;
  return improved ? "improved" : "regressed";
}
