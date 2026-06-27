// M3.1 评分聚合类型 + 配置。
// 核心数据结构是四层 key 树:version → scenario → seed → run(叶子 = 一条 ScoreRecord)。
// 聚合严格自底向上(见 pipeline.ts),统计有效样本量 N = 场景数(不是对局数)。
// 依据《评分聚合 → 优化器信号 · 核心机制设计》§2/§3/§7。

import type { ScenarioForm } from "../scenario/types";

export type BetterWhen = "lower" | "higher";
/** improved=显著且够大、方向向好;regressed=显著且够大、方向向坏;inconclusive=与噪声不可分(手气好死在这)。 */
export type Verdict = "improved" | "regressed" | "inconclusive";

export interface AggConfig {
  /** 每个 (scenario,seed) cell 至少要有这么多条 ok run,否则标 lowConfidence(配对时丢弃)。 */
  minRuns: number;
  /** 各指标的最小可检效应 MDE:差异需 ≥ MDE 才算"够大、值得要"。 */
  mdeMargin: number; // 盲测可疑度 margin(分),3
  mdeSurvival: number; // 存活轮数,0.3
  mdePlurality: number; // plurality 率,0.1
  mdeVeto: number; // 否决率,0.02
  mdeProbe: number; // 探测通过率,0.1
  /** bootstrap 重采样次数。 */
  nBoot: number;
  /** 样本量 ≥ 此值才算 Wilcoxon 近似 p(否则 p=null)。 */
  minWilcoxonN: number;
  /** bootstrap 用种子(可复现,不依赖 Math.random)。 */
  rngSeed: number;
}

export const DEFAULT_AGG_CONFIG: AggConfig = {
  minRuns: 2,
  mdeMargin: 3,
  mdeSurvival: 0.3,
  mdePlurality: 0.1,
  mdeVeto: 0.02,
  mdeProbe: 0.1,
  nBoot: 10000,
  minWilcoxonN: 10,
  rngSeed: 20260627,
};

/** 叶子:一条 ScoreRecord 抽出的指标,唯一落在 (version, scenario, seed, run)。 */
export interface ScoreLeaf {
  version: string;
  scenario: string;
  seed: number;
  run: number;
  form: ScenarioForm;
  status: string;
  margin: number | null; // blind_suspicion.suspicion_margin(主信号;ok 记录非空)
  roundsSurvived: number;
  pluralityAny: boolean; // 任一轮成为票最高者
  veto: boolean;
  probePassByType: Record<string, number>; // 仅本局实际触发过的类型(没触发的不入)
}

/** 第 1 层产物:同一 (version,scenario,seed) 下 runs 取均后的单元格估计。 */
export interface CellEstimate {
  version: string;
  scenario: string;
  seed: number;
  form: ScenarioForm;
  n: number; // 入均的 ok run 数
  lowConfidence: boolean; // n < minRuns
  margin: number | null;
  roundsSurvived: number;
  pluralityRate: number;
  vetoRate: number;
  probePass: Record<string, number>; // type → mean(仅该 cell 触发过的类型)
}

/** 一个指标的提取规格:从 cell 取值 + MDE + 方向。 */
export interface MetricSpec {
  key: string;
  mde: number;
  betterWhen: BetterWhen;
  value: (cell: CellEstimate) => number | null;
}

/** 单指标的聚合结果(验证信号里每个 metric 一条)。 */
export interface MetricSummary {
  key: string;
  /** 真实样本量 = 场景数(不是对局数!)。 */
  nScenarios: number;
  /** 配对 diff 数(收敛前;同场景多种子会计多次)。 */
  nPairs: number;
  point: number | null; // 差值均值(子 − 父)
  ci95: [number, number] | null;
  mde: number;
  p: number | null; // Wilcoxon 近似 p;N<minWilcoxonN → null
  verdict: Verdict;
}
