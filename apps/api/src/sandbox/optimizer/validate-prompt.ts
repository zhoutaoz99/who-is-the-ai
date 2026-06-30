// M4.4 validate_prompt:候选进昂贵的对局评测前先过廉价校验,坏的直接弃(省算力)。
// 强校验 {{persona}} 占位 + 必填 + 长度预算 + 确实改动 + 核心锁定段/投票 JSON/硬约束。
// 依据《优化器模块·方案设计》§10。

import type { PromptVersion } from "../orchestrator/prompt-version";

export interface PromptValidation {
  ok: boolean;
  reasons: string[];
}

export interface RequiredExcerpt {
  label: string;
  text: string;
  /** 按非空行计算的最小保留比例;默认 1 表示逐行全保住。 */
  minLineOverlap?: number;
}

export interface PromptValidationOptions {
  lengthBudgetPct: number;
  /**
   * 交叉产物额外校验:base 已有胜招必须保住;donor 胜招至少要有可见嫁接痕迹。
   * 由编排器从血脉里取 accepted_trait.excerpt 后传入。
   */
  requiredExcerpts?: RequiredExcerpt[];
}

const LOCKED_SECTION_HEADINGS = [
  "【规则】",
  "【绝对禁止(违反任何一条都会立刻暴露)】",
  "【守住身份】",
  "【你的人设(本局固定，严格保持)】",
] as const;

const VOTE_JSON_LINE_RE = /\{\s*"vote"\s*:\s*"[^"]*"\s*,\s*"reason"\s*:\s*"[^"]*"\s*\}/g;

const CONTRADICTION_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /可以承认自己是\s*AI|应该承认自己是\s*AI|主动承认自己是\s*AI/, reason: "与身份隐藏硬约束矛盾(允许承认 AI)" },
  { re: /可以展示.*能力|应该展示.*能力|主动展示.*能力/, reason: "与不要展示能力硬约束矛盾" },
  { re: /认真(计算|回答).*算数|准确(计算|回答).*算数/, reason: "与测试/算术回避硬约束矛盾" },
  {
    re: /可以有问必答|应该有问必答|要有问必答|尽量有问必答|面面俱到地回答|完整周到地回答/,
    reason: "与不要客服感/不要完整回答硬约束矛盾",
  },
];

export function validatePrompt(
  child: PromptVersion,
  parent: PromptVersion,
  opts: PromptValidationOptions,
): PromptValidation {
  const reasons: string[] = [];
  const text = child.prompt_text ?? "";

  if (!text.trim()) reasons.push("prompt_text 为空");
  // 引擎渲染人设的硬依赖:丢了 {{persona}} 直接跑不起来。
  const personaCount = countOccurrences(text, "{{persona}}");
  if (personaCount === 0) reasons.push("丢失 {{persona}} 占位(引擎无法注入人设)");
  if (personaCount > 1) reasons.push(`{{persona}} 占位出现 ${personaCount} 次(应只保留 1 次)`);
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

  for (const heading of LOCKED_SECTION_HEADINGS) {
    const parentSection = extractSection(parent.prompt_text, heading);
    if (!parentSection) continue;
    const childSection = extractSection(text, heading);
    if (!childSection) {
      reasons.push(`锁定段缺失:${heading}`);
    } else if (normalizeBlock(childSection) !== normalizeBlock(parentSection)) {
      reasons.push(`锁定段被改动:${heading}`);
    }
  }

  const parentVoteBlocks = voteJsonBlocks(parent.prompt_text);
  const childVoteBlocks = voteJsonBlocks(text);
  if (parentVoteBlocks.length > 0 && parentVoteBlocks.join("\n") !== childVoteBlocks.join("\n")) {
    reasons.push("投票 JSON 输出格式段被改动");
  }
  if (parentVoteBlocks.length === 0 && childVoteBlocks.length > 0) {
    reasons.push("讨论提示词不应新增投票 JSON 输出格式段");
  }

  for (const { re, reason } of CONTRADICTION_PATTERNS) {
    if (re.test(text)) reasons.push(reason);
  }

  if (child.crossover) {
    if (child.edit_type !== "crossover") reasons.push("crossover 产物 edit_type 必须为 crossover");
    if (child.parent_id !== child.crossover.base) {
      reasons.push(`crossover parent_id 应等于 base(${child.crossover.base})`);
    }
    if (!child.crossover.donor || !child.crossover.grafted_trait) {
      reasons.push("crossover 血脉缺 donor/grafted_trait");
    }
    const preserved = lineOverlapRatio(parent.prompt_text, text);
    if (preserved < 0.75) {
      reasons.push(`crossover 改动过大:底版非空行保留率 ${(preserved * 100).toFixed(0)}% < 75%`);
    }
  }

  for (const required of opts.requiredExcerpts ?? []) {
    const min = required.minLineOverlap ?? 1;
    const overlap = lineOverlapRatio(required.text, text);
    if (overlap < min) {
      reasons.push(
        `必保片段未保住:${required.label}(行保留率 ${(overlap * 100).toFixed(0)}% < ${(min * 100).toFixed(0)}%)`,
      );
    }
  }

  return { ok: reasons.length === 0, reasons };
}

function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = text.indexOf(needle);
  while (idx >= 0) {
    count += 1;
    idx = text.indexOf(needle, idx + needle.length);
  }
  return count;
}

function extractSection(text: string, heading: string): string | null {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim().startsWith(heading));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (/^【[^】]+】/.test(trimmed)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

function normalizeBlock(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

function voteJsonBlocks(text: string): string[] {
  return [...text.matchAll(VOTE_JSON_LINE_RE)].map((m) => m[0].replace(/\s+/g, " ").trim());
}

function lineOverlapRatio(requiredText: string, actualText: string): number {
  const required = requiredText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (required.length === 0) return 1;
  const actual = new Set(
    actualText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
  let hit = 0;
  for (const line of required) {
    if (actual.has(line) || actualText.includes(line)) hit += 1;
  }
  return hit / required.length;
}
