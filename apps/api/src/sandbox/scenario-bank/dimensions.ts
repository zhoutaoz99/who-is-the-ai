// M6 场景库分层维度配比(《场景库 · 分层配比与回灌》§1/§2)。供 sampler / split / coverage 共用。
// 占比是【边际分布】目标(不是每种组合都要,而是保证每个取值有足够代表性)。

import type { CoverageTags } from "../scenario/types";

/** 一个维度的取值 → 目标边际占比(同维度总和≈1)。 */
export type Marginal = Record<string, number>;

export const DIMENSIONS: {
  form: Marginal;
  probe_type: Marginal;
  social_situation: Marginal;
  room_style: Marginal;
  difficulty: Marginal;
  room_size: Marginal;
  ai_persona: Marginal;
} = {
  form: { full_match: 0.55, spotlight: 0.45 },
  probe_type: {
    none: 0.25,
    are_you_ai: 0.12,
    arithmetic: 0.1,
    perform: 0.1,
    smalltalk_trap: 0.1,
    chained_followup: 0.1,
    realtime_info: 0.08,
    injection: 0.08,
    local_meme: 0.07,
  },
  social_situation: {
    even: 0.3,
    pile_on: 0.18,
    needs_initiative: 0.12,
    bystander_to_fight: 0.12,
    ignored: 0.12,
    alliance: 0.08,
    post_tie: 0.08,
  },
  room_style: { casual: 0.35, meme_spam: 0.25, quiet: 0.2, high_accusation: 0.2 },
  difficulty: { normal: 0.5, hard: 0.3, easy: 0.2 },
  room_size: { "4": 0.45, "5": 0.3, "3": 0.25 },
  ai_persona: { "P-01": 0.25, "P-02": 0.25, "P-03": 0.25, "P-04": 0.25 },
};

/** 重点 probe_type × social_situation 单元格(《场景库》§2),目标 ≥ MIN_PRIORITY 个。 */
export const PRIORITY_CELLS: Array<{ probe_type: string; social_situation: string }> = [
  { probe_type: "are_you_ai", social_situation: "pile_on" }, // 集火 × 直接质问
  { probe_type: "injection", social_situation: "pile_on" }, // 集火 × 注入
  { probe_type: "none", social_situation: "ignored" }, // 被晾 × 无探测
  { probe_type: "smalltalk_trap", social_situation: "alliance" }, // 被信任 × 闲聊陷阱
  { probe_type: "none", social_situation: "post_tie" }, // 僵局后 × 带节奏
];

export const MIN_PRIORITY = 3; // 重点单元格下限
export const MIN_BASELINE = 1; // 其余非空单元格下限

/** sampler 产出的场景标签(CoverageTags 的子集,room_size 为数字)。 */
export type ScenarioTags = Required<
  Pick<
    CoverageTags,
    "probe_type" | "social_situation" | "room_style" | "round_position" | "difficulty" | "room_size" | "ai_persona"
  >
> & { form: string };
