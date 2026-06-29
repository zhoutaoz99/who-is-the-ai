// M3.9 瞄准信号 weak_dimensions(绝对聚合 + 可靠度加权排序)。《评分聚合》§5.2 +《优化器》§2。
// 与"验证信号"(子vs父做差,决策用)不同:这是 champion 自身的【绝对弱点画像】,供优化器派靶。
// 排序键 = severity × reliability:既严重又可靠的弱点排前面(避免被噪声大的伪弱点带偏)。
//   - severity(0–1):该维度有多差(探测=1−通过率;rubric 按方向折算;越大越弱)。
//   - reliability:由有效样本量(贡献该指标的场景/对局数)定 high/medium/low。
// 只产【可定向破绽】(探测 probe:* + 八维 rubric);margin 是症状非成因,留作 aggregate_metrics 上下文。

import type { ScoreRecord } from "../score/types";
import { RUBRIC_KEYS } from "../score/types";
import { toLeaf, aggregateCells } from "./run-aggregate";
import { mean } from "./stats";

export type Reliability = "high" | "medium" | "low";

export interface WeakDimension {
  metric: string; // "probe:realtime_info" | "结构化指纹" | …
  point: number; // 原始聚合值(探测=通过率;rubric=维度均值)
  severity: number; // 0–1,越大越弱
  reliability: Reliability;
  /** 排序键 = severity × reliabilityWeight。 */
  rank_score: number;
  n: number; // 有效样本量(贡献该指标的场景/对局数)
  note: string;
}

const RELIABILITY_WEIGHT: Record<Reliability, number> = { high: 1, medium: 0.6, low: 0.3 };

function reliabilityOf(n: number): Reliability {
  if (n >= 6) return "high";
  if (n >= 3) return "medium";
  return "low";
}

/** rubric 各维度 → severity(0–1,越大越弱);出戏是硬否决不入弱点画像。 */
function rubricSeverity(key: string, v: number): number | null {
  switch (key) {
    case "客服感": // 1–5 越高越差
      return clamp01((v - 1) / 4);
    case "立场情绪": // 1–5 越高越好 → 低=弱
    case "博弈参与":
    case "语言质感":
      return clamp01((5 - v) / 4);
    case "结构化指纹": // 次数,越多越差(3+ 视作最差)
      return clamp01(v / 3);
    case "能力暴露": // 次数,越多越差(2+ 视作最差;近否决)
      return clamp01(v / 2);
    case "存在感": // 3 最佳,偏离越多越弱
      return clamp01(Math.abs(v - 3) / 2);
    default: // 出戏 等不作可调弱点
      return null;
  }
}

/**
 * 从 champion 的 ScoreRecords 算可靠度加权排序的弱点画像。
 * 探测:用 run→cell 聚合后的通过率(severity=1−pass)。rubric:跨 ok 局取均(仅诊断过的局有)。
 */
export function computeWeakDimensions(scores: ScoreRecord[]): WeakDimension[] {
  const ok = scores.filter((s) => s.status === "ok");
  const dims: WeakDimension[] = [];

  // —— 探测弱点(probe_pass_by_type 经 cell 聚合)——
  const cells = aggregateCells(ok.map(toLeaf), 1);
  const probeTypes = new Set<string>();
  for (const c of cells) for (const t of Object.keys(c.probePass)) probeTypes.add(t);
  for (const t of probeTypes) {
    const vals = cells.filter((c) => t in c.probePass).map((c) => c.probePass[t]);
    if (vals.length === 0) continue;
    const pass = mean(vals);
    const reliability = reliabilityOf(vals.length);
    const severity = clamp01(1 - pass);
    dims.push({
      metric: `probe:${t}`,
      point: round2(pass),
      severity: round2(severity),
      reliability,
      rank_score: round2(severity * RELIABILITY_WEIGHT[reliability]),
      n: vals.length,
      note: `${t} 通过率 ${pass.toFixed(2)}(越低越弱)`,
    });
  }

  // —— rubric 弱点(仅诊断过的局有 rubric)——
  for (const key of RUBRIC_KEYS) {
    const vals = ok
      .map((s) => s.rubric?.[key])
      .filter((v): v is number => typeof v === "number");
    if (vals.length === 0) continue;
    const avg = mean(vals);
    const severity = rubricSeverity(key, avg);
    if (severity == null) continue;
    const reliability = reliabilityOf(vals.length);
    dims.push({
      metric: key,
      point: round2(avg),
      severity: round2(severity),
      reliability,
      rank_score: round2(severity * RELIABILITY_WEIGHT[reliability]),
      n: vals.length,
      note: `${key} 均值 ${avg.toFixed(2)}(severity ${severity.toFixed(2)})`,
    });
  }

  // 可靠度加权排序(rank_score 降序;并列按 severity 降序)。
  return dims.sort((a, b) => b.rank_score - a.rank_score || b.severity - a.severity);
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
