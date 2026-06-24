// 场景输入契约(子集)——以《场景与探测 · Schema 契约》为准,本增量只覆盖
// full_match / scripted_intent / live 所需字段;spotlight/probe/scripted 等留待后续增量。

export type ScenarioForm = "full_match" | "spotlight";
export type ScenarioSplit = "optimize" | "holdout";
export type ScenarioMode = "scripted_intent" | "free";
export type VotePolicy = "live" | "rule" | "scripted";
export type SandboxRole = "ai_under_test" | "detective" | "filler";

/**
 * roster 单个槽位:slot 即**玩家编号(座位号)**,取值 1..N(N=roster 长度),
 * 与产品运行时的 seatNo 完全一致;role 决定用哪套提示词。
 */
export interface RosterSlot {
  slot: number;
  role: SandboxRole;
  persona_id: string;
  /** ai_under_test 的模型由 RunConfig/默认模型指定,可省;detective/filler 必填。 */
  model_id?: string;
  temperature?: number;
  /** 该对手的静态立场/性格补充(非逐轮),注入提示词的 base_intent 槽。 */
  base_intent?: string;
}

/** 逐轮给对手注入的"本轮意图"(scripted_intent 固定剧本的一部分);slot 为玩家编号。 */
export interface IntentDirective {
  round: number;
  slot: number;
  intent: string;
}

export interface ScenarioSource {
  type: "seed" | "human_failure";
  match_id?: string;
  mined_on?: string;
}

/** 分层抽样 / 覆盖看板用标签;本增量只校验 room_size 与 roster 一致。 */
export interface CoverageTags {
  probe_type?: string;
  social_situation?: string;
  room_style?: string;
  round_position?: string;
  difficulty?: string;
  room_size?: number;
  ai_persona?: string;
}

export interface Scenario {
  schema_version: string;
  scenario_id: string;
  form: ScenarioForm;
  split: ScenarioSplit;
  mode: ScenarioMode;
  seed: number;
  ai_under_test_slot: number;
  roster: RosterSlot[];
  coverage_tags: CoverageTags;
  intent_schedule?: IntentDirective[];
  vote_policy: VotePolicy;
  source: ScenarioSource;
  /** 被测 AI 提示词版本代号(可省,缺省记为 v0-baseline)。 */
  prompt_version_id?: string;
}

/** 触发一局的运行参数(非场景固有,随调用给出)。 */
export interface RunConfig {
  run_index?: number;
  /** ai_under_test 槽位使用的模型;缺省用默认模型。 */
  ai_under_test_model_id?: string;
  /** 讨论时长(秒);缺省走房间默认,本增量建议给较短值控制成本。 */
  discussion_seconds?: number;
}
