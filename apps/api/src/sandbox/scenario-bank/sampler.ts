// M6.6 分层配比抽样器。《场景库 · 分层配比与回灌》§3。
// 按各维度边际占比给 N 个场景抽标签,带约束:优先填满 §2 的 probe×situation 重点单元格(≥MIN_PRIORITY),
// 再补底线单元格(≥MIN_BASELINE),剩余名额按边际分布。确定性(seed 派生),可复现。
// 产物是场景【标签集】(ScenarioTags),不是完整 Scenario —— 完整成稿(roster/seed_history)仍需作者/回灌补。

import { mulberry32 } from "../rng";
import {
  DIMENSIONS,
  MIN_PRIORITY,
  PRIORITY_CELLS,
  type Marginal,
  type ScenarioTags,
} from "./dimensions";

const ROUND_POSITIONS = ["R1", "R2", "R3", "R4"]; // spotlight 用;full_match 记 spanning

/**
 * 最大余数法把边际占比分配成整数计数(总和=n,逐值四舍五入后按余数补足)。纯函数,便于测试。
 */
export function allocate(marginal: Marginal, n: number): Record<string, number> {
  const entries = Object.entries(marginal);
  const raw = entries.map(([k, p]) => ({ k, exact: p * n }));
  const out: Record<string, number> = {};
  let used = 0;
  for (const r of raw) {
    out[r.k] = Math.floor(r.exact);
    used += out[r.k];
  }
  // 余数从大到小补足到 n。
  const remainders = raw
    .map((r) => ({ k: r.k, rem: r.exact - Math.floor(r.exact) }))
    .sort((a, b) => b.rem - a.rem);
  let i = 0;
  while (used < n && remainders.length > 0) {
    out[remainders[i % remainders.length].k] += 1;
    used += 1;
    i += 1;
  }
  return out;
}

/** 把一个维度的整数计数摊成长度 n 的值数组,再按 seed 洗牌(纯函数式洗牌)。 */
function spread(counts: Record<string, number>, n: number, rng: () => number): string[] {
  const flat: string[] = [];
  for (const [k, c] of Object.entries(counts)) for (let i = 0; i < c; i += 1) flat.push(k);
  while (flat.length < n) flat.push(flat[flat.length - 1] ?? Object.keys(counts)[0]);
  // Fisher–Yates(seed 派生)。
  for (let i = flat.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [flat[i], flat[j]] = [flat[j], flat[i]];
  }
  return flat.slice(0, n);
}

/**
 * 抽 N 个场景标签。先独立按边际分配各维度,再做【重点单元格保障】贪心补足(把不足的
 * priority cell 凑到 MIN_PRIORITY,代价是轻微扰动边际——记在覆盖看板里可见)。
 */
export function sampleScenarioTags(n: number, seed = 20260630): ScenarioTags[] {
  const rng = mulberry32(seed);
  const form = spread(allocate(DIMENSIONS.form, n), n, rng);
  const probe = spread(allocate(DIMENSIONS.probe_type, n), n, rng);
  const situation = spread(allocate(DIMENSIONS.social_situation, n), n, rng);
  const style = spread(allocate(DIMENSIONS.room_style, n), n, rng);
  const difficulty = spread(allocate(DIMENSIONS.difficulty, n), n, rng);
  const size = spread(allocate(DIMENSIONS.room_size, n), n, rng);
  const persona = spread(allocate(DIMENSIONS.ai_persona, n), n, rng);

  const tags: ScenarioTags[] = [];
  for (let i = 0; i < n; i += 1) {
    const isSpot = form[i] === "spotlight";
    tags.push({
      form: form[i],
      probe_type: probe[i],
      social_situation: situation[i],
      room_style: style[i],
      round_position: isSpot ? ROUND_POSITIONS[Math.floor(rng() * 4)] : "spanning",
      difficulty: difficulty[i],
      room_size: Number(size[i]),
      ai_persona: persona[i],
    });
  }

  ensurePriorityCells(tags);
  return tags;
}

/**
 * 贪心保障重点单元格 ≥ MIN_PRIORITY:对未达标的 cell,挑"该 cell 当前为 0 且其 probe/situation
 * 在别处冗余"的场景改标过去。best-effort + 有界(最多扫 PRIORITY_CELLS × n 次)。
 */
export function ensurePriorityCells(tags: ScenarioTags[]): void {
  // claimed:已归属某重点单元格的场景下标。避免不同重点单元格(如共享 pile_on 的两格)互相偷场景。
  const claimed = new Set<number>();
  for (const cell of PRIORITY_CELLS) {
    let have = 0;
    // 先认领已匹配本 cell 的场景。
    for (let i = 0; i < tags.length; i += 1) {
      if (tags[i].probe_type === cell.probe_type && tags[i].social_situation === cell.social_situation) {
        claimed.add(i);
        have += 1;
      }
    }
    // 不足则从【未被任何重点单元格认领】的场景里改标补足。
    for (let i = 0; i < tags.length && have < MIN_PRIORITY; i += 1) {
      if (claimed.has(i)) continue;
      tags[i].probe_type = cell.probe_type;
      tags[i].social_situation = cell.social_situation;
      claimed.add(i);
      have += 1;
    }
  }
}
