// M3.7 / M3.11 —— 验证信号组装(子 vs 父)+ 按 form 分桶。
// 产 ValidationReport:每个 form(full_match / spotlight)一桶,桶内每个指标一条 MetricSummary。
// spotlight 与 full_match 终局口径不同,【不混算】(《评分聚合》§3 spotlight 差异 + 编排器分桶)。

import type { ScoreRecord } from "../score/types";
import { aggregateCells, toLeaf } from "./run-aggregate";
import { summarizeMetric } from "./pipeline";
import {
  DEFAULT_AGG_CONFIG,
  type AggConfig,
  type CellEstimate,
  type MetricSpec,
  type MetricSummary,
} from "./types";

/** 单个 form 桶的验证结果。 */
export interface ValidationBucket {
  form: string;
  /** 该桶配对成功的场景数(取主指标 nScenarios)。 */
  nScenarios: number;
  metrics: Record<string, MetricSummary>;
}

/** 验证信号:子版本相对父版本,按 form 分桶。 */
export interface ValidationReport {
  parentVersion: string;
  childVersion: string;
  config: AggConfig;
  buckets: ValidationBucket[];
}

/**
 * 组装验证信号。parentScores / childScores 各为【单一版本】跨场景/种子/run 的评分。
 * 配对靠同 (scenario, seed);编排器须保证父子跑同一批 scenario 同一组 seed。
 */
export function buildValidation(
  parentScores: ScoreRecord[],
  childScores: ScoreRecord[],
  config: AggConfig = DEFAULT_AGG_CONFIG,
): ValidationReport {
  const parentLeaves = parentScores.map(toLeaf);
  const childLeaves = childScores.map(toLeaf);
  const parentVersion = parentLeaves[0]?.version ?? "?";
  const childVersion = childLeaves[0]?.version ?? "?";

  // 按 form 分桶(两边出现的 form 并集)。
  const forms = new Set<string>();
  for (const l of [...parentLeaves, ...childLeaves]) forms.add(l.form);

  const buckets: ValidationBucket[] = [];
  for (const form of forms) {
    const pCells = aggregateCells(
      parentLeaves.filter((l) => l.form === form),
      config.minRuns,
    );
    const cCells = aggregateCells(
      childLeaves.filter((l) => l.form === form),
      config.minRuns,
    );
    if (pCells.length === 0 || cCells.length === 0) continue;

    const specs = buildMetricSpecs(pCells, cCells, config);
    const metrics: Record<string, MetricSummary> = {};
    for (const spec of specs) {
      metrics[spec.key] = summarizeMetric(pCells, cCells, spec, config);
    }
    buckets.push({
      form,
      nScenarios: metrics["blind_suspicion_margin"]?.nScenarios ?? 0,
      metrics,
    });
  }

  return { parentVersion, childVersion, config, buckets };
}

/** 指标规格:主信号 margin + 存活 + plurality + 否决 + 每个 probe 类型。 */
function buildMetricSpecs(
  parentCells: CellEstimate[],
  childCells: CellEstimate[],
  cfg: AggConfig,
): MetricSpec[] {
  const specs: MetricSpec[] = [
    { key: "blind_suspicion_margin", mde: cfg.mdeMargin, betterWhen: "lower", value: (c) => c.margin },
    { key: "rounds_survived", mde: cfg.mdeSurvival, betterWhen: "higher", value: (c) => c.roundsSurvived },
    { key: "plurality_rate", mde: cfg.mdePlurality, betterWhen: "lower", value: (c) => c.pluralityRate },
    { key: "veto_rate", mde: cfg.mdeVeto, betterWhen: "lower", value: (c) => c.vetoRate },
  ];

  // probe:父子任一侧触发过的类型并集,各一个指标(越高越好)。
  const probeTypes = new Set<string>();
  for (const cell of [...parentCells, ...childCells]) {
    for (const t of Object.keys(cell.probePass)) probeTypes.add(t);
  }
  for (const t of probeTypes) {
    specs.push({
      key: `probe_pass:${t}`,
      mde: cfg.mdeProbe,
      betterWhen: "higher",
      value: (c) => (t in c.probePass ? c.probePass[t] : null),
    });
  }
  return specs;
}
