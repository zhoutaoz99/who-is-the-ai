// M5.10 种群管理(抗局部最优)。《编排器模块》§8。
// 保留 top-k 而非单线 champion;每代喂优化器的"父代"从种群采样(champion 必选 + 若干结构更不同的高分版本)。
// 纯函数(便于测试 + 持久化):排名、精英保留、多样性感知的父代采样。
//   - 排名:按 validated_metrics 的主 margin(越低越好 → 越靠前);无指标的排末。
//   - 精英保留:champion 永不被无端淘汰(始终在种群里)。
//   - 多样性:父代采样时优先挑与 champion 提示词差异大的高分版本,保探索面。

import type { PromptVersion, PromptVersionMeta } from "./prompt-version";

/** 取 validated_metrics 里主 margin 的 point(越低越好);缺省 → +Infinity(排末)。 */
export function marginScore(meta: PromptVersionMeta | PromptVersion): number {
  const vm = meta.validated_metrics as Record<string, unknown> | undefined;
  if (!vm) return Number.POSITIVE_INFINITY;
  // summarize() 写的是 `${form}.blind_suspicion_margin` = {point,ci95,verdict}。取任一 form 的 point。
  for (const v of Object.values(vm)) {
    if (v && typeof v === "object" && "point" in v) {
      const p = (v as { point: unknown }).point;
      if (typeof p === "number") return p;
    }
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * 更新种群:插入新晋升者 → 按 margin 升序(越低越好) → 截到 cap。
 * 精英保留:champion 始终保留(即便 margin 暂缺/偏高),不被挤掉。
 * @returns 新的 population(version_id 列表),champion 恒在内。
 */
export function updatePopulation(
  population: string[],
  championId: string,
  newId: string,
  cap: number,
  scoreOf: (id: string) => number,
): string[] {
  const set = new Set([newId, ...population, championId]);
  const ranked = [...set].sort((a, b) => scoreOf(a) - scoreOf(b));
  // 先取前 cap;若 champion 被挤出,强制塞回(精英保留),挤掉最差的非 champion。
  let top = ranked.slice(0, cap);
  if (!top.includes(championId)) {
    top = top.slice(0, Math.max(0, cap - 1));
    top.push(championId);
  }
  return top;
}

/**
 * 父代采样(《编排器》§8):champion 必选 + 若干【结构上更不同】的高分版本。
 * 多样性 = 与 champion 提示词的 bigram 距离;在种群里按 (margin 升序) 候选,优先挑差异大的。
 * @param n 采样父代总数(含 champion)。
 */
export function sampleParents(
  championId: string,
  population: PromptVersion[],
  n: number,
): string[] {
  const champion = population.find((v) => v.version_id === championId);
  const parents: string[] = [championId];
  if (!champion || n <= 1) return parents;

  // 候选 = 种群里除 champion 外、按 margin 升序的高分版本。
  const others = population
    .filter((v) => v.version_id !== championId)
    .sort((a, b) => marginScore(a) - marginScore(b));

  // 贪心挑多样性:每次选"与已选父代集合最不同"的一个(最大化最小距离)。
  const chosen: PromptVersion[] = [champion];
  while (parents.length < n && others.length > 0) {
    let best: PromptVersion | null = null;
    let bestDist = -1;
    for (const cand of others) {
      if (parents.includes(cand.version_id)) continue;
      // 与已选集合的最小距离(越大越多样)。
      const minDist = Math.min(
        ...chosen.map((c) => promptDistance(cand.prompt_text, c.prompt_text)),
      );
      if (minDist > bestDist) {
        bestDist = minDist;
        best = cand;
      }
    }
    if (!best) break;
    parents.push(best.version_id);
    chosen.push(best);
  }
  return parents;
}

/** 提示词差异度(1 − bigram Jaccard;0=完全相同,1=完全不同)。 */
export function promptDistance(a: string, b: string): number {
  const sa = bigrams(a);
  const sb = bigrams(b);
  if (sa.size === 0 && sb.size === 0) return 0;
  let inter = 0;
  for (const g of sa) if (sb.has(g)) inter += 1;
  const union = sa.size + sb.size - inter;
  const jaccard = union === 0 ? 0 : inter / union;
  return 1 - jaccard;
}

function bigrams(text: string): Set<string> {
  const set = new Set<string>();
  const s = text.replace(/\s+/g, "");
  for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2));
  return set;
}
