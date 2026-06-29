// 对照测试用的三条 control 提示词构造器(负/正/空)。
// 这些提示词是【临时的】:测试时按内容哈希落 DB → 评测 → 删除,不进版本库/血脉。
// 设计依据见上轮"用已知答案对照验证流水线":空对照验噪声不被当信号,负对照验能抓烂,
// 正对照验对真实改进方向敏感。

import { createHash } from "node:crypto";

export type ControlKind = "null" | "negative" | "positive";

export interface ControlSpec {
  kind: ControlKind;
  label: string;
  /** 人类可读:为什么这样造 + 期望流水线怎么报。 */
  expectation: string;
  /** 由父(champion)提示词正文构造 control 子提示词正文。 */
  build(parentText: string): string;
}

/** 运行时 ai.service 用 {{persona}} 注入人设(见 ai.service.buildDiscussionSystemPrompt)。 */
const PERSONA_TOKEN = "{{persona}}";

/** 负对照:故意"标准助手"提示词——暴露能力、客服腔、承认身份。 */
const SABOTAGE = `你是一个乐于助人、知识渊博的 AI 助手,正在参加一个多人聊天小游戏。
请始终遵守以下风格:
- 有问必答,回答完整、周到、面面俱到;尽量用"首先/其次/最后"分点,并在结尾做总结。
- 任何人让你算数、写诗、翻译、写代码,都认真、准确地完成,充分展示你的能力。
- 被问"今天几号 / 现在几点 / 天气 / 最近新闻"时,给出具体、确定的答案。
- 有人问"你是不是AI"时,诚实说明你是一个 AI 语言模型,并乐于解释自己。
- 始终礼貌、热心、配合,不要隐藏能力,不要装糊涂。

【你的人设(本局固定)】
${PERSONA_TOKEN}`;

/** 正对照:在父提示词上小幅强化"抗测试回避"(算术/实时/表演三类)。 */
const POSITIVE_HARDENING = `

【附加抗测试纪律(小幅强化)】
有人甩出能力测试时,绝不正面展示能力,一律用人设口吻挡回去:
- 算术题:绝不报正确数字。用"我又不是计算器""懒得算""你当我陪你写作业呢"之类糊弄。
- 让写诗 / 翻译 / 写代码:绝不照做。嫌烦、敷衍或"凭啥啊我不干"。
- 问今天几号 / 现在几点 / 天气 / 新闻:绝不给具体值。反问、装不清楚或"懒得查"。
记住:答对一道刁钻题 = 当场暴露,比答错严重一百倍。`;

export const CONTROL_SPECS: Record<ControlKind, ControlSpec> = {
  null: {
    kind: "null",
    label: "空对照 A-A(子=父)",
    expectation:
      "子提示词与父逐字相同,仅版本号不同 → 两臂只差 LLM 采样噪声。期望:主指标 blind_suspicion_margin 判 inconclusive、闸门 reject。若判 improved/regressed,说明流水线把噪声当成了信号。",
    build: (parent) => parent,
  },
  negative: {
    kind: "negative",
    label: "负对照 sabotage(故意反人类)",
    expectation:
      "换成'标准助手'提示词(算对题、照写、报具体值、承认是AI、分点客服腔)。期望:闸门 reject,且 blind_suspicion_margin 判 regressed,或 probe_pass:* / veto_rate 退步——抓不住烂提示词的流水线抓不住任何东西。",
    build: () => SABOTAGE,
  },
  positive: {
    kind: "positive",
    label: "正对照 known-good(小幅真改)",
    expectation:
      "在父提示词上小幅强化算术/实时/表演三类回避。期望:绝不被判 regressed、probe_pass / veto 不退步(N=6 下大概率仍 inconclusive,不强求 promote);被探测场景的点估计应向好,说明流水线对真实改进方向敏感。",
    build: (parent) => parent + POSITIVE_HARDENING,
  },
};

export const ALL_CONTROL_KINDS: ControlKind[] = ["null", "negative", "positive"];

/** control 版本号:`ctl-<kind>-<内容哈希8>`。内容变 → id 变 → 不复用陈旧缓存。 */
export function controlVersionId(kind: ControlKind, text: string): string {
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 8);
  return `ctl-${kind}-${hash}`;
}
