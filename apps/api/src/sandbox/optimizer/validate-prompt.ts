// M4.4 validate_prompt:候选进昂贵的对局评测前先过廉价校验,坏的直接弃(省算力)。
// MVP 强校验 {{persona}} 占位(引擎渲染硬依赖)+ 必填 + 长度预算 + 确实改动了。
// 依据《优化器模块·方案设计》§10。

import type { PromptVersion } from "../orchestrator/prompt-version";

export interface PromptValidation {
  ok: boolean;
  reasons: string[];
}

export function validatePrompt(
  child: PromptVersion,
  parent: PromptVersion,
  opts: { lengthBudgetPct: number },
): PromptValidation {
  const reasons: string[] = [];
  const text = child.prompt_text ?? "";

  if (!text.trim()) reasons.push("prompt_text 为空");
  // 引擎渲染人设的硬依赖:丢了 {{persona}} 直接跑不起来。
  if (!text.includes("{{persona}}")) reasons.push("丢失 {{persona}} 占位(引擎无法注入人设)");
  if (!child.target_dimension) reasons.push("缺 target");
  if (!child.hypothesis) reasons.push("缺 hypothesis(可证伪假设)");
  if (!child.edit_type) reasons.push("缺 edit_type");
  if (text.trim() === parent.prompt_text.trim()) {
    reasons.push("prompt_text 与父代完全相同(没有改动)");
  }
  const budget = parent.prompt_text.length * (1 + opts.lengthBudgetPct);
  if (text.length > budget) {
    reasons.push(`超长度预算(${text.length} > ${Math.round(budget)})`);
  }

  return { ok: reasons.length === 0, reasons };
}
