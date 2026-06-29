// M6.9 覆盖看板 ScenarioCoverage。《场景库 · 分层配比与回灌》§3 步骤 6 + §4 验收。
// 实时显示:每个维度取值的覆盖数 + probe_type×social_situation 两两矩阵的空格,缺哪补哪。
// 纯函数(吃已打标场景标签,产报表),供前台/CLI 看板与 v1 库验收用。

import {
  DIMENSIONS,
  MIN_BASELINE,
  MIN_PRIORITY,
  PRIORITY_CELLS,
  type ScenarioTags,
} from "./dimensions";

export interface DimCoverage {
  dimension: string;
  /** 取值 → 实际计数。 */
  counts: Record<string, number>;
  /** 边际占比下覆盖数低于下限的取值(N.1 §4:如 ≥6)。 */
  under_min: string[];
}

export interface MatrixCell {
  probe_type: string;
  social_situation: string;
  count: number;
  /** 是否重点单元格(§2)。 */
  priority: boolean;
  /** 是否达标(重点 ≥MIN_PRIORITY;否则 ≥MIN_BASELINE)。 */
  ok: boolean;
}

export interface ScenarioCoverage {
  total: number;
  dimensions: DimCoverage[];
  /** probe×situation 两两矩阵(只列出现过 + 重点单元格)。 */
  matrix: MatrixCell[];
  /** 未达标的重点单元格(< MIN_PRIORITY)。 */
  priority_gaps: Array<{ probe_type: string; social_situation: string; count: number }>;
}

const DIM_FIELDS: Array<keyof typeof DIMENSIONS> = [
  "form",
  "probe_type",
  "social_situation",
  "room_style",
  "difficulty",
  "room_size",
  "ai_persona",
];

/** @param perValueMin 每取值覆盖下限(v1 验收建议 6;冒烟/基线可传 1)。 */
export function computeCoverage(tags: ScenarioTags[], perValueMin = MIN_BASELINE): ScenarioCoverage {
  const total = tags.length;

  const dimensions: DimCoverage[] = DIM_FIELDS.map((field) => {
    const counts: Record<string, number> = {};
    for (const t of tags) {
      const v = String((t as Record<string, unknown>)[field]);
      counts[v] = (counts[v] ?? 0) + 1;
    }
    // under_min:该维度【应出现】的取值(配比表里占比>0)但覆盖数 < 下限。
    const under: string[] = [];
    for (const v of Object.keys(DIMENSIONS[field])) {
      if ((counts[v] ?? 0) < perValueMin) under.push(v);
    }
    return { dimension: field, counts, under_min: under };
  });

  // probe×situation 矩阵:统计所有出现过的组合 + 所有重点单元格(即使为 0)。
  const cellCount = new Map<string, number>();
  for (const t of tags) {
    cellCount.set(`${t.probe_type}|${t.social_situation}`, (cellCount.get(`${t.probe_type}|${t.social_situation}`) ?? 0) + 1);
  }
  const prioritySet = new Set(PRIORITY_CELLS.map((c) => `${c.probe_type}|${c.social_situation}`));
  const keys = new Set<string>([...cellCount.keys(), ...prioritySet]);
  const matrix: MatrixCell[] = [];
  for (const key of keys) {
    const [probe_type, social_situation] = key.split("|");
    const count = cellCount.get(key) ?? 0;
    const priority = prioritySet.has(key);
    matrix.push({
      probe_type,
      social_situation,
      count,
      priority,
      ok: count >= (priority ? MIN_PRIORITY : MIN_BASELINE),
    });
  }
  matrix.sort((a, b) => Number(b.priority) - Number(a.priority) || b.count - a.count);

  const priority_gaps = PRIORITY_CELLS.map((c) => ({
    ...c,
    count: cellCount.get(`${c.probe_type}|${c.social_situation}`) ?? 0,
  })).filter((c) => c.count < MIN_PRIORITY);

  return { total, dimensions, matrix, priority_gaps };
}
