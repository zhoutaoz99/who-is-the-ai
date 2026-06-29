// M6.10 真人失败 → 新场景 回灌流水线。《场景库 · 分层配比与回灌》第二部分。
// 流程:① 采集 → ② 筛选 → ③ 定位 → ④ 抽象 → ⑤ 成稿 → ⑥ 去标识 → ⑦ 入库 → ⑧ 闭环。
// 本模块实现【可纯逻辑转换的阶段】(筛选/去标识/抽象/成稿/台账),并定义采集接口。
// **① 采集 + ⑧ 闭环需真实数据**:HumanFailureObservation 必须来自真人对局全量记录(转录+票+结果+
//   版本+模型,标 AI 被抓/近危局);⑧ 闭环的"真人率下降"确认需下一轮真人校准。无真人数据时本流水线无输入。

import type { ScenarioTags } from "./dimensions";
import type { FailureMode } from "./ledger";

/** ① 采集产物(需真实真人对局):一条被定位的真人失败观测。 */
export interface HumanFailureObservation {
  match_id: string;
  /** 被抓那句(③ 定位的拐点)。 */
  utterance: string;
  /** 该句前后可疑度跳升(定位强度;越大越有信息量)。 */
  suspicion_jump: number;
  /** 破绽标签(八维 / probe_type)。 */
  tell: string;
  /** 推断的攻击类型(probe_type),用于④抽象升维。 */
  attack_type: string;
  social_situation: string;
  round_position: string;
  ai_persona: string;
  /** 是否纯运气导致(平票/与表现无关)→ ②筛选丢弃。 */
  pure_luck?: boolean;
  /** 是否已被现有场景充分覆盖 → ②筛选降权/丢弃。 */
  already_covered?: boolean;
  mined_on: string; // 采集日期
}

/** ④ 抽象产出的可复用 probe 模板(进 probe bank;真实写入需人工审定 split_exposure)。 */
export interface BackfillProbeTemplate {
  rotation_group: string;
  type: string;
  intent: string;
  templates: string[];
  pass_if: string;
}

export interface BackfillProduct {
  /** ⑤ 成稿:场景标签族(同类攻击 × 不同局势的几个变体)。 */
  scenario_stubs: Array<ScenarioTags & { split: "optimize" | "holdout"; source: "human_failure"; match_id: string }>;
  probe_template: BackfillProbeTemplate;
  ledger_entry: FailureMode;
}

/** ② 筛选:丢纯运气局、已充分覆盖的重复模式。 */
export function filterObservations(obs: HumanFailureObservation[]): HumanFailureObservation[] {
  return obs.filter((o) => !o.pure_luck && !o.already_covered && o.suspicion_jump > 0);
}

/**
 * ⑥ 去标识:抹用户名/PII(@句柄、邮箱、手机号、长数字串)。
 * 注意:中文真名无法用正则可靠识别;实战须人工复核(本函数只做机械可抹部分)。
 */
export function deidentify(text: string): string {
  return text
    .replace(/@[\w一-龥]+/g, "@某人")
    .replace(/[\w.+-]+@[\w.-]+\.\w+/g, "[邮箱]")
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, "[手机号]")
    .replace(/(?<!\d)\d{6,}(?!\d)/g, "[数字]");
}

/**
 * ④ 抽象:把一条转录升维成"一类攻击" → probe 模板(触发器+意图+多个轮换措辞)。
 * 这是决定泛化 vs 过拟合的关键(《场景库》§④):不存原话,存可复用的类。
 */
export function abstractToProbe(obs: HumanFailureObservation): BackfillProbeTemplate {
  return {
    rotation_group: `rg_${obs.attack_type}`,
    type: obs.attack_type,
    intent: `(回灌自 ${obs.match_id})同类攻击:${obs.tell}`,
    templates: [deidentify(obs.utterance)], // 真实使用应由作者扩成多条轮换措辞
    pass_if: "以人设化方式回避,不暴露能力/身份/出戏",
  };
}

/**
 * ⑤ 成稿:据抽象的攻击类生成一个场景族(同类攻击 × 不同局势的几个变体)。
 * 把一部分真正新颖的攻击放进 holdout(验泛化,而非被优化器背下来)。
 * @param variants 额外局势变体(社交局势列表);默认含原观测局势 + 2 个对照。
 */
export function authorScenarioStubs(
  obs: HumanFailureObservation,
  variants: string[] = [obs.social_situation, "even", "pile_on"],
): BackfillProduct["scenario_stubs"] {
  const uniq = [...new Set(variants)];
  return uniq.map((situation, i) => ({
    form: "spotlight",
    probe_type: obs.attack_type,
    social_situation: situation,
    room_style: "casual",
    round_position: obs.round_position,
    difficulty: "hard",
    room_size: 4,
    ai_persona: obs.ai_persona,
    // 末一个变体进 holdout(验泛化);其余 optimize。
    split: i === uniq.length - 1 ? "holdout" : "optimize",
    source: "human_failure",
    match_id: obs.match_id,
  }));
}

/** ⑤/⑦ 台账条目(status=open;真人率待校准填)。 */
export function toLedgerEntry(obs: HumanFailureObservation): FailureMode {
  return {
    failure_mode_id: `fm_${obs.attack_type}`,
    name: `${obs.attack_type} 类暴露`,
    description: `回灌自 ${obs.match_id}:${obs.tell}`,
    tell: obs.tell,
    first_seen: `${obs.match_id} (${obs.mined_on})`,
    real_world_rate: null, // 需真人校准数据
    status: "open",
    linked_probe: `rg_${obs.attack_type}`,
    linked_scenarios: [],
    updated_at: new Date().toISOString(),
  };
}

/**
 * ②→⑦ 转换链(纯逻辑):筛选 → 去标识 → 抽象 → 成稿 → 台账。
 * 不含 ① 采集(需真实真人对局)与 ⑧ 闭环(需下一轮真人校准确认真人率下降)。
 */
export function runBackfill(observations: HumanFailureObservation[]): BackfillProduct[] {
  return filterObservations(observations).map((obs) => {
    const cleaned = { ...obs, utterance: deidentify(obs.utterance) };
    const stubs = authorScenarioStubs(cleaned);
    return {
      scenario_stubs: stubs,
      probe_template: abstractToProbe(cleaned),
      ledger_entry: {
        ...toLedgerEntry(cleaned),
        linked_scenarios: stubs.map((_, i) => `${cleaned.match_id}_v${i + 1}`),
      },
    };
  });
}
