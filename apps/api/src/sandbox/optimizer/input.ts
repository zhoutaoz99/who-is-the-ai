// M4.1 优化器输入契约组装器。
// 喂精选诊断(不喂原始转录):当前提示词 + 指定靶子 + champion 弱点画像 + 失败聚类 + 失败记忆 + 长度预算。
// 依据《优化器模块·方案设计》§2。弱点画像用 M3.9 computeWeakDimensions(可靠度加权排序),
// 失败聚类用 M3.10 clusterFailures,失败记忆用 M4.10 compressTried(按死路类别压缩)。

import { clusterFailures, type FailureCluster } from "../aggregate/failures";
import { aggregateCells, toLeaf } from "../aggregate/run-aggregate";
import { mean } from "../aggregate/stats";
import { computeWeakDimensions, type WeakDimension } from "../aggregate/weak-dims";
import type { PromptVersion } from "../orchestrator/prompt-version";
import type { TriedAndRejectedEntry } from "../orchestrator/state";
import type { ScoreRecord } from "../score/types";
import { compressTried } from "./tried-and-rejected";

export type { WeakDimension } from "../aggregate/weak-dims";

/** AI 玩家提示词里不许动的核心段(优化器须保留,validate 强校验 {{persona}})。 */
export const LOCKED_SECTIONS: string[] = [
  "{{persona}} 占位(必须一字不动保留,否则引擎无法注入人设)",
  "【规则】段与【绝对禁止】段的核心约束(可加强,不可削弱或删除)",
];

/** champion 在 eval 集上的绝对弱点画像 + 失败聚类(瞄准信号)。 */
export interface ChampionProfile {
  nScenarios: number;
  meanMargin: number | null;
  vetoRate: number;
  probePassByType: Record<string, number>;
  /** 可靠度加权排序的弱点(M3.9);供 assign_targets 派靶。 */
  weakDimensions: WeakDimension[];
  /** 跨局失败聚类(M3.10);仅诊断过的局有。 */
  failureClusters: FailureCluster[];
}

export interface OptimizerInput {
  task: string;
  current_version: { version_id: string; prompt_text: string; persona_scope: string };
  locked_sections: string[];
  assigned_target: string;
  assigned_edit_type: string;
  weak_dimensions: WeakDimension[];
  aggregate_metrics: {
    blind_suspicion_margin: { mean: number | null };
    veto_rate: number;
    probe_pass_by_type: Record<string, number>;
  };
  failure_clusters: unknown[]; // MVP 空(M3.10 失败聚类在 Phase 3)
  tried_and_rejected: Array<{ edit_type?: string; target?: string; result: string; gen: number }>;
  persona_scope: string;
  length_budget: string;
  constraints: string[];
}

/** 从 champion 的 ScoreRecords 算绝对弱点画像 + 失败聚类(瞄准信号)。 */
export function championProfile(scores: ScoreRecord[]): ChampionProfile {
  const leaves = scores.map(toLeaf).filter((l) => l.status === "ok");
  const cells = aggregateCells(leaves, 1);
  const scenarioSet = new Set(cells.map((c) => c.scenario));

  const margins = cells.map((c) => c.margin).filter((m): m is number => m != null);
  const meanMargin = margins.length > 0 ? mean(margins) : null;
  const vetoRate = cells.length > 0 ? mean(cells.map((c) => c.vetoRate)) : 0;

  const probeTypes = new Set<string>();
  for (const c of cells) for (const t of Object.keys(c.probePass)) probeTypes.add(t);
  const probePassByType: Record<string, number> = {};
  for (const t of probeTypes) {
    const vals = cells.filter((c) => t in c.probePass).map((c) => c.probePass[t]);
    if (vals.length > 0) probePassByType[t] = mean(vals);
  }

  // M3.9 可靠度加权排序的弱点(探测 + 八维 rubric);M3.10 跨局失败聚类。
  // 无可定向弱点时 weakDimensions 为空,assignTargets 回退自由名额 / 上层用 margin。
  return {
    nScenarios: scenarioSet.size,
    meanMargin,
    vetoRate,
    probePassByType,
    weakDimensions: computeWeakDimensions(scores),
    failureClusters: clusterFailures(scores),
  };
}

/** 组装一次单候选调用的优化器输入。 */
export function buildOptimizerInput(
  champion: PromptVersion,
  profile: ChampionProfile,
  assignedTarget: string,
  assignedEditType: string | undefined,
  triedAndRejected: TriedAndRejectedEntry[],
): OptimizerInput {
  return {
    task: "优化《谁是AI》AI 玩家系统提示词:针对指定靶子改一处,降可疑度、不触发否决",
    current_version: {
      version_id: champion.version_id,
      prompt_text: champion.prompt_text,
      persona_scope: champion.persona_scope,
    },
    locked_sections: LOCKED_SECTIONS,
    assigned_target: assignedTarget,
    assigned_edit_type: assignedEditType ?? "",
    weak_dimensions: profile.weakDimensions,
    aggregate_metrics: {
      blind_suspicion_margin: { mean: profile.meanMargin },
      veto_rate: profile.vetoRate,
      probe_pass_by_type: profile.probePassByType,
    },
    // M3.10 与本靶子相关优先(此处全量喂,优化器自行聚焦;§2 每簇 1–2 代表)。
    failure_clusters: profile.failureClusters,
    // M4.10 按死路类别压缩(非逐条原文),防上下文膨胀。
    tried_and_rejected: compressTried(triedAndRejected).map((t) => ({
      edit_type: t.edit_type,
      target: t.target,
      result: `${t.result}(此类已被否 ${t.count} 次)`,
      gen: t.last_gen,
    })),
    persona_scope: champion.persona_scope,
    length_budget: `不超过当前长度 +15%(当前约 ${champion.prompt_text.length} 字)`,
    constraints: [
      "只针对 assigned_target 改一处",
      "给可证伪假设",
      "小步定向改不要整段重写",
      "目标是降可疑度/修破绽,不是刷某个评分",
      "修探测类优先写成通用回避反射,别背具体答案",
      "保留 {{persona}} 占位与锁定段",
    ],
  };
}
