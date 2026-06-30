// 真人 pair 回灌管道(《真人校准 · 方案设计》§2/§3)。
// 把真人对局日志(MatchRecord 形态)按 prompt_version_id 聚合出真人值,
// 并与沙盒代理值(validated_metrics 里的 suspicion_margin)配成 CalibrationPair。
// 纯函数:真人数据的【采集/存储】在 calibration.service,这里只做对齐与聚合。

import type { MatchRecord } from "../match-record/types";
import type { CalibrationPair, CalibrationResult } from "./calibration";

/** 某版本在真人局里的聚合真人值。 */
export interface HumanVersionSummary {
  version: string;
  n_matches: number;
  /** 被票出率:该版本 AI 在真人局里被淘汰的比例。 */
  human_eliminated_rate: number;
  /** 指向 AI 票占比:真人投票里 target=AI 的票数 / 总票数(池化)。 */
  human_ai_vote_share: number;
}

/** 校准批次记录(spec §7),挂到 GenerationEval.human_calibration_ref。 */
export interface CalibrationRun {
  calibration_id: string;
  generation: number;
  data_source: "A_live" | "B_testbench" | "C_proxy";
  versions_included: string[];
  n_versions: number;
  human_matches_per_version_median: number;
  pairs: CalibrationPair[];
  correlation_proxy_vs_real: number | null;
  correlation_ci95: [number, number] | null;
  correlation_aux_voteshare: number | null;
  threshold: number;
  verdict: CalibrationResult["verdict"];
  residual_flags: CalibrationResult["residual_flags"];
  diagnosis: "judge_drift" | "weak_detectives" | null;
  actions_taken: string[];
  promotions_frozen: boolean;
  confounder_controls: string[];
  holdout_recheck: number | null;
  timestamp: string;
}

/** 把真人 MatchRecord 按版本聚合出真人值(被票出率 + 指向AI票占比)。spec §3。 */
export function summarizeHumanByVersion(matches: MatchRecord[]): Map<string, HumanVersionSummary> {
  const byVersion = new Map<
    string,
    { n: number; eliminated: number; aiVotes: number; totalVotes: number }
  >();
  for (const m of matches) {
    const v = m.prompt_version_id;
    if (!v) continue;
    const acc = byVersion.get(v) ?? { n: 0, eliminated: 0, aiVotes: 0, totalVotes: 0 };
    acc.n += 1;
    if (m.outcome?.reached_terminal === "ai_eliminated" || m.outcome?.ai_eliminated_round != null) {
      acc.eliminated += 1;
    }
    for (const vote of m.votes ?? []) {
      acc.totalVotes += 1;
      if (vote.target_slot === m.ai_under_test_slot) acc.aiVotes += 1;
    }
    byVersion.set(v, acc);
  }
  const out = new Map<string, HumanVersionSummary>();
  for (const [version, a] of byVersion) {
    out.set(version, {
      version,
      n_matches: a.n,
      human_eliminated_rate: a.n > 0 ? a.eliminated / a.n : 0,
      human_ai_vote_share: a.totalVotes > 0 ? a.aiVotes / a.totalVotes : 0,
    });
  }
  return out;
}

/** 从某版本 validated_metrics 抽 suspicion_margin 代理值(各 form 的 point 取均值)。 */
export function proxyMarginFromValidatedMetrics(
  vm: Record<string, unknown> | undefined | null,
): number | null {
  if (!vm) return null;
  const points: number[] = [];
  for (const [key, val] of Object.entries(vm)) {
    if (!key.endsWith(".blind_suspicion_margin")) continue;
    if (val && typeof val === "object" && "point" in val) {
      const p = (val as { point?: unknown }).point;
      if (typeof p === "number" && Number.isFinite(p)) points.push(p);
    }
  }
  if (points.length === 0) return null;
  return points.reduce((a, b) => a + b, 0) / points.length;
}

/** 配对:同一 version 同时有沙盒代理 + 足量真人局,才进 pairs。spec §3/§4。 */
export function buildCalibrationPairs(
  humanByVersion: Map<string, HumanVersionSummary>,
  proxyByVersion: Map<string, number | null>,
  opts: { minHumanMatchesPerVersion?: number } = {},
): { pairs: CalibrationPair[]; skipped: Array<{ version: string; reason: string }> } {
  const minHuman = opts.minHumanMatchesPerVersion ?? 1;
  const pairs: CalibrationPair[] = [];
  const skipped: Array<{ version: string; reason: string }> = [];
  for (const [version, human] of humanByVersion) {
    if (human.n_matches < minHuman) {
      skipped.push({ version, reason: `真人局不足(${human.n_matches}<${minHuman})` });
      continue;
    }
    const proxy = proxyByVersion.get(version);
    if (proxy == null) {
      skipped.push({ version, reason: "缺沙盒代理(validated_metrics 无 suspicion_margin)" });
      continue;
    }
    pairs.push({
      version,
      proxy_suspicion_margin: proxy,
      human_eliminated_rate: human.human_eliminated_rate,
      human_ai_vote_share: human.human_ai_vote_share,
    });
  }
  return { pairs, skipped };
}

/** 各版本真人局数的中位数(CalibrationRun 元信息)。 */
export function medianMatchesPerVersion(humanByVersion: Map<string, HumanVersionSummary>): number {
  const counts = [...humanByVersion.values()].map((h) => h.n_matches).sort((a, b) => a - b);
  if (counts.length === 0) return 0;
  const mid = Math.floor(counts.length / 2);
  return counts.length % 2 ? counts[mid] : (counts[mid - 1] + counts[mid]) / 2;
}
