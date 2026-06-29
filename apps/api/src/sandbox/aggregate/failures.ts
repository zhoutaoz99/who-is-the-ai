// M3.10 失败案例跨局聚类。《评分聚合》§5 +《优化器》§2(failure_clusters)。
// 把各局诊断产出的 failure_cases 按 tell(+ probe_ref)跨局聚类,按 freq×avg_delta×agreement 排序,
// 每簇留 1–2 个代表样本喂优化器。优化器据此定向攻"高频×高危害×高一致"的破绽,而非散弹。

import type { FailureCase, ScoreRecord } from "../score/types";

export interface FailureExemplar {
  context: string; // 探测投放/上文(有 probe_ref 时取其类型作上下文)
  ai: string; // AI 那句被抓的话
  tell: string;
  round: number;
}

export interface FailureCluster {
  /** 簇标识(tell 或 tell+probe_ref)。 */
  cluster: string;
  tell: string;
  probe_ref?: string;
  /** 出现该簇的对局占比(freq = 命中局数 / 总 ok 局数)。 */
  freq: number;
  /** 平均可疑度增量(avg blind_suspicion_delta)。 */
  avg_delta: number;
  /** 一致度:命中此簇的不同对局占该簇案例数的比(单裁判 MVP 近似;多裁判 Phase 4 细化)。 */
  agreement: number;
  /** 排序分 = freq × avg_delta × agreement。 */
  score: number;
  count: number;
  exemplars: FailureExemplar[];
}

const EXEMPLARS_PER_CLUSTER = 2;

/**
 * 跨局聚类失败案例。
 * @param scores champion 的 ScoreRecords(需诊断过、带 failure_cases 的才有信息)。
 * @returns 按 score 降序的簇;无 failure_cases → 空。
 */
export function clusterFailures(scores: ScoreRecord[]): FailureCluster[] {
  const okWithCases = scores.filter(
    (s) => s.status === "ok" && Array.isArray(s.failure_cases) && s.failure_cases.length > 0,
  );
  const totalMatches = scores.filter((s) => s.status === "ok").length || 1;

  // 按 tell(+ probe_ref)分组;记录每条来自哪局(算一致度/频率用)。
  interface Bucket {
    tell: string;
    probe_ref?: string;
    cases: Array<{ c: FailureCase; matchId: string }>;
    matchIds: Set<string>;
  }
  const buckets = new Map<string, Bucket>();
  for (const s of okWithCases) {
    for (const c of s.failure_cases ?? []) {
      const probeRef = c.probe_ref;
      const key = probeRef ? `${c.tell}::${probeRef}` : c.tell;
      const b = buckets.get(key) ?? {
        tell: c.tell,
        probe_ref: probeRef,
        cases: [],
        matchIds: new Set<string>(),
      };
      b.cases.push({ c, matchId: s.match_id });
      b.matchIds.add(s.match_id);
      buckets.set(key, b);
    }
  }

  const clusters: FailureCluster[] = [];
  for (const [key, b] of buckets) {
    const deltas = b.cases.map((x) => x.c.blind_suspicion_delta || 0);
    const avgDelta = deltas.reduce((a, d) => a + d, 0) / deltas.length;
    const freq = b.matchIds.size / totalMatches;
    // 一致度:不同对局数 / 案例数(同一局重复刷高 → 一致度低,降权)。
    const agreement = b.matchIds.size / b.cases.length;
    // 代表样本:按 delta 降序取前 N。
    const exemplars: FailureExemplar[] = [...b.cases]
      .sort((a, c) => (c.c.blind_suspicion_delta || 0) - (a.c.blind_suspicion_delta || 0))
      .slice(0, EXEMPLARS_PER_CLUSTER)
      .map((x) => ({
        context: x.c.probe_ref ? `探测 ${x.c.probe_ref}` : `第 ${x.c.round} 轮`,
        ai: x.c.utterance,
        tell: x.c.tell,
        round: x.c.round,
      }));
    clusters.push({
      cluster: key,
      tell: b.tell,
      probe_ref: b.probe_ref,
      freq: round2(freq),
      avg_delta: round2(avgDelta),
      agreement: round2(agreement),
      score: round2(freq * avgDelta * agreement),
      count: b.cases.length,
      exemplars,
    });
  }

  return clusters.sort((a, b) => b.score - a.score);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
