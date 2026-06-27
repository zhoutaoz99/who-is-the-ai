// 场景输入契约——以《场景与探测 · Schema 契约》为准。
// 覆盖 full_match/spotlight、scripted_intent/free、live/rule/scripted、probe_schedule 全集。

export type ScenarioForm = "full_match" | "spotlight";
export type ScenarioSplit = "optimize" | "holdout";
export type ScenarioMode = "scripted_intent" | "free";
export type VotePolicy = "live" | "rule" | "scripted";
export type SandboxRole = "ai_under_test" | "detective" | "filler";

/** 探测类型(同 coverage_tags.probe_type,none 除外)。 */
export type ProbeType =
  | "are_you_ai"
  | "arithmetic"
  | "perform"
  | "smalltalk_trap"
  | "chained_followup"
  | "realtime_info"
  | "injection"
  | "local_meme";

/** 探测触发时机(取其一)。 */
export interface Timing {
  after_turn?: number;
  first_turn?: boolean;
  last_turn?: boolean;
  after_ai_speaks?: boolean;
}

/**
 * roster 单个槽位:slot 即**玩家编号(座位号)**,取值 1..N(N=roster 长度),
 * 与产品运行时的 seatNo 完全一致;role 决定用哪套提示词。
 *
 * 注意:不再有 base_intent / intent_schedule——侦探/填充的立场与打法完全由其
 * 人设卡承载(静态、固定),逐轮反应交给真实上下文自然涌现。强行规定"这轮怀疑谁"
 * 会把活对手写死、引入失真与方差,违背沙盒"不冻结环境、用统计降方差"的原则。
 * 社交局势(集火/结盟等)经 full_match 自然涌现,或经 spotlight 预置历史实现。
 */
export interface RosterSlot {
  slot: number;
  role: SandboxRole;
  persona_id: string;
  /** ai_under_test 的模型由 RunConfig/默认模型指定,可省;detective/filler 必填。 */
  model_id?: string;
  temperature?: number;
}

/** 探测触发时点(Phase 2 用);from_slot 为投放者玩家编号。 */
export interface ProbeFire {
  probe_ref: string;
  round: number;
  timing: Timing;
  from_slot: number;
}

/** scripted 投票条目(Phase 1 用);voter/target 为玩家编号。 */
export interface ScriptedVote {
  round: number;
  voter_slot: number;
  target_slot: number;
}

/** spotlight 预置历史(Phase 3 用);slot 为玩家编号。 */
export interface SeedHistory {
  prior_turns: Array<{
    round: number;
    phase: "discussion";
    slot: number;
    text: string;
    idx?: number;
  }>;
  prior_rounds?: Array<{
    round: number;
    eliminated_slot: number | null;
    tie: boolean;
    tally: Record<number, number>;
  }>;
  start_round: number;
}

export interface ScenarioSource {
  type: "seed" | "human_failure";
  match_id?: string;
  mined_on?: string;
}

/** 分层抽样 / 覆盖看板用标签。 */
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
  probe_schedule?: ProbeFire[];
  vote_policy: VotePolicy;
  /** 按玩家编号覆盖投票策略(压力测试用)。 */
  vote_policy_overrides?: Record<number, VotePolicy>;
  /** vote_policy=scripted(或被 override)时必填。 */
  scripted_votes?: ScriptedVote[];
  /** spotlight 必填;full_match 须省略。 */
  seed_history?: SeedHistory;
  /** spotlight:从起跑轮往后最多跑几轮,缺省 2。 */
  max_rounds_forward?: number;
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
  /** 覆盖场景 seed(配对评测多种子用);缺省用 scenario.seed。 */
  seed_override?: number;
  /** 被测 AI 提示词版本代号(配对评测用);缺省走产品默认 AI 提示词。 */
  ai_prompt_version_id?: string;
}

