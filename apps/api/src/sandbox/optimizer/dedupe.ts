// M4.5 去重:K 次独立单候选调用可能撞车,按 (target, edit_type) + 文本相似度去重。
// Phase 1 单候选不常触发;Phase 3(外层派 K 个靶子,M4.7)真正使用。依据《优化器》§2.5。

import type { PromptVersion } from "../orchestrator/prompt-version";

const SIMILARITY_THRESHOLD = 0.95;

export function isDuplicate(child: PromptVersion, existing: PromptVersion[]): boolean {
  const childKey = `${child.target_dimension ?? ""}|${child.edit_type ?? ""}`;
  for (const e of existing) {
    const eKey = `${e.target_dimension ?? ""}|${e.edit_type ?? ""}`;
    if (eKey === childKey && childKey !== "|") return true;
    if (bigramJaccard(child.prompt_text, e.prompt_text) >= SIMILARITY_THRESHOLD) return true;
  }
  return false;
}

/** 二元组 Jaccard 相似度(cheap,对中文按字符二元组)。 */
function bigramJaccard(a: string, b: string): number {
  const setA = bigrams(a);
  const setB = bigrams(b);
  if (setA.size === 0 || setB.size === 0) return a === b ? 1 : 0;
  let inter = 0;
  for (const g of setA) if (setB.has(g)) inter += 1;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

function bigrams(text: string): Set<string> {
  const set = new Set<string>();
  const s = text.replace(/\s+/g, "");
  for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2));
  return set;
}
