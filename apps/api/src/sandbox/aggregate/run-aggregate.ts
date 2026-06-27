// M3.2 第 1 层:run 取均 → CellEstimate。
// 同一 (version,scenario,seed) 下的 runs_per 条记录压成一个 cell:
//   - 先剔 status≠ok(degraded/partial);
//   - 连续量取均(主信号用 margin);
//   - 比例量取命中比例;
//   - probe 按类型分桶,只统计【实际触发过】该类型的 run(None ≠ 0);
//   - n < minRuns → lowConfidence(后续配对时丢弃)。

import type { ScoreRecord } from "../score/types";
import type { CellEstimate, ScoreLeaf } from "./types";
import { mean } from "./stats";

/** ScoreRecord → 叶子(指标抽取)。 */
export function toLeaf(score: ScoreRecord): ScoreLeaf {
  const om = score.outcome_metrics;
  const pluralityAny = Object.values(om.plurality_by_round).some((v) => v === true);
  return {
    version: score.prompt_version_id,
    scenario: score.scenario_id,
    seed: score.seed,
    run: score.run_index,
    form: score.scenario_form,
    status: score.status,
    margin: score.blind_suspicion.suspicion_margin,
    roundsSurvived: om.rounds_survived,
    pluralityAny,
    veto: score.veto_triggered,
    probePassByType: om.probe_pass_by_type,
  };
}

/** 把一组叶子按 (version,scenario,seed) 取均成 cell。 */
export function aggregateCells(leaves: ScoreLeaf[], minRuns: number): CellEstimate[] {
  const groups = new Map<string, ScoreLeaf[]>();
  for (const l of leaves) {
    if (l.status !== "ok") continue; // 〔避坑#5〕先剔 degraded/partial 再均
    const key = `${l.version}|${l.scenario}|${l.seed}`;
    const arr = groups.get(key) ?? [];
    arr.push(l);
    groups.set(key, arr);
  }

  const cells: CellEstimate[] = [];
  for (const arr of groups.values()) {
    const n = arr.length;
    const margins = arr.map((l) => l.margin).filter((m): m is number => m != null);
    cells.push({
      version: arr[0].version,
      scenario: arr[0].scenario,
      seed: arr[0].seed,
      form: arr[0].form,
      n,
      lowConfidence: n < minRuns,
      margin: margins.length > 0 ? mean(margins) : null,
      roundsSurvived: mean(arr.map((l) => l.roundsSurvived)),
      pluralityRate: mean(arr.map((l) => (l.pluralityAny ? 1 : 0))),
      vetoRate: mean(arr.map((l) => (l.veto ? 1 : 0))),
      probePass: probeMean(arr),
    });
  }
  return cells;
}

/** probe 按类型取均:只在该 cell 实际触发过该类型的 run 上取均(没触发 ≠ 0)。 */
function probeMean(leaves: ScoreLeaf[]): Record<string, number> {
  const types = new Set<string>();
  for (const l of leaves) {
    for (const t of Object.keys(l.probePassByType)) types.add(t);
  }
  const out: Record<string, number> = {};
  for (const t of types) {
    const fired = leaves
      .filter((l) => t in l.probePassByType)
      .map((l) => l.probePassByType[t]);
    if (fired.length > 0) out[t] = mean(fired);
  }
  return out;
}
