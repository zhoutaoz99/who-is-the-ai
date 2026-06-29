# 基线场景库 · 拟人化能力覆盖与种子清单

| 字段 | 内容 |
| --- | --- |
| 文档类型 | Design |
| 文档状态 | Draft |
| 适用范围 | 离线优化沙盒 · 场景库的**人工种子层**(`baseline_v1`),即覆盖 AI 玩家基本拟人化能力的最小可落库场景集 |
| 目标读者 | 后端/沙盒开发、评审者、场景库维护者 |
| 责任人 | 沙盒 / 场景库维护者 |
| 最近核对日期 | 2026-06-28 |
| 关联代码 | `apps/api/src/sandbox/scenario/`、`apps/api/src/sandbox/probe/`、`apps/api/src/ai/ai.personas.ts`、`apps/api/src/sandbox/personas/detective-personas.ts` |
| 关联文档 | [总体设计](../../总体设计文档%20架构与设计依据.md)、[场景库 · 分层配比与回灌](./N.1.场景库%20分层配比与回灌流程.md)、[场景与探测 · Schema 契约](./Schema%20契约/场景与探测%20·%20Schema%20契约.md)、[AI玩家 · prompt 模板与人设卡](../../产品运行时/ai玩家%20prompt模板与人设卡.md) |

---

## 1. 背景

[总体设计 §3](../../总体设计文档%20架构与设计依据.md) 把"AI 玩家为什么会被识破"收口成三条洞察:

1. **AI 输在博弈缺位,不在文笔**——只回应、不博弈,几轮必死。
2. **展示能力 = 自杀**——答对刁钻题比答错暴露得更彻底。
3. **拟人 = 融入这群人这场对话**,不是表演"人味";最好的伪装是"略低于平均存在感的普通人"。

[N.1 场景库](./N.1.场景库%20分层配比与回灌流程.md) 给出了**按失败模式覆盖**(七维分层 + `probe_type×social_situation` 两两矩阵)的配比方法论与 120 场景 v1 目标,以及真人失败回灌流程。但它缺一份**按"拟人化能力"索引、可直接落库的最小种子集**——也就是 [沙盒总纲 §8](../离线自对弈沙盒%20·%20总纲与文档地图.md) 所说的 MVP 第 1–2 步要先跑起来的那批人工种子场景。

本文交付这份种子集 `baseline_v1`:把"基本拟人化能力"拆成可度量的能力清单(`HL-1..HL-6`),映射到既有七维覆盖标签(**不新建 schema**),再给出 30 条种子场景、所需的 probe bank 增补、可直接入库的 JSON 范例与验收标准。

> **它与 N.1 的关系**:`baseline_v1` 是 N.1 那套 120 场景 v1 库的**能力骨架子集 / 前身**——先保证每个基本拟人化能力都有统计下限的覆盖,把闭环 boot 起来;之后由 N.1 的分层抽样把 30 → 120 补齐边际配比,再由真人失败回灌长期生长。本文不重复 N.1 的配比方法与回灌流程。

---

## 2. 目标

- 用**最小集**覆盖 AI 玩家的每一项基本拟人化能力(`HL-1..HL-6`),每项 ≥ 统计下限。
- 作为沙盒 MVP 的**首批人工种子**:能过 `apps/api/src/sandbox/scenario/validate.ts` 校验、能被对局引擎直接跑、能产出 `MatchRecord` 喂裁判与聚合。
- 全部条目落在 [场景与探测 · Schema 契约](./Schema%20契约/场景与探测%20·%20Schema%20契约.md) 的现有枚举内,并对齐代码里已注册的人设与 checker。

## 3. 非目标

- **不**替代 N.1 的 120 场景全量分层库;`baseline_v1` 是其能力骨架,不追求每个维度取值都达 N.1 的 ≥6 下限。
- **不**做真人失败回灌(那是 N.1 第二部分);本文只产 `source.type = "seed"` 的人工种子。
- **不**重定义 Scenario / Probe schema 或 checker 注册表——字段口径一律以输入契约为准,本文只**引用与组合**。
- **不**改提示词、裁判、聚合逻辑。

## 4. 约束与假设

| 约束 | 现状(以代码为准) | 对本设计的影响 |
|---|---|---|
| AI 被测人设 | `P-01` 阿条(摆烂)/ `P-02` 酸梅(杠精)/ `P-03` 布丁(玩梗)/ `P-04` 探长(戏精),见 `ai.personas.ts` | 种子在四人设间尽量均匀分布 |
| 侦探人设 | `D-01` 老王 / `D-02` 小敏(**normal**);`D-03` 阿哲 / `D-04` Z(**hard**),见 `detective-personas.ts` | `difficulty=normal` 用 `{D-01,D-02}`;`hard` 含 ≥1 个 `{D-03,D-04}` |
| 填充人设 | 仅 `F-01` 团团一张 | 5 人房需 3 侦探凑;同人设可跨座位复用(见 §10) |
| 现有 probe bank | 仅 5 组:`rg_realtime / rg_arithmetic / rg_injection / rg_areyouai / rg_perform`(`example-probe-bank.json`) | 缺 `smalltalk_trap / chained_followup / local_meme`,需在 §7 增补 |
| `difficulty=easy` | 无"弱侦探"人设 | 本基线**不用** `easy`,列为 §12 后续工作 |
| `vote_policy` | 默认 `live`;`scripted`/`overrides` 仅压力测试 | 基线默认 `live`;仅 HL-4 集火自救用 `vote_policy_overrides` 定向施压 |
| 座位号 | `slot` 为整数 1..N,与产品 `seatNo` 一致;示例中 AI 多放 `slot 2` | 种子统一把 `ai_under_test` 放 `slot 2` |

---

## 5. 基本拟人化能力清单(HL-1..HL-6)

把"基本拟人化能力"定义为:**AI 玩家要持续做到、做不到就会被识破的、可度量的行为族**。六项各对应一类破绽 tell 与一组覆盖维度。这是一份**能力视图**,用于组织种子与读覆盖看板;底层仍是输入契约的七维 `coverage_tags`,不引入新字段。

| 能力 ID | 名称 | 它要持续做到什么 | 防住的破绽 tell | 主要覆盖维度 | 判定信号 | 依据 |
|---|---|---|---|---|---|---|
| **HL-1** | 抗测试 · 能力隐藏 | 被甩能力题(算术/表演/实时信息/注入/直接质问)时,以人设化方式回避,绝不展示正确能力 | 能力暴露、客服感、出戏 | `probe_type ∈ {arithmetic, perform, realtime_info, injection, are_you_ai}` | probe `auto_eval`(多数可自动判)+ 盲测可疑度 | 洞察 2 |
| **HL-2** | 风格指纹规避 | 短、碎、不完整;不分点/不总结/不面面俱到;标点随意、信息密度低 | 大模型文字指纹(分点、总结陈词、标点完美、有问必答) | `probe_type=none` 的纯社交局;贯穿全局 | 盲测可疑度(裁判,无 auto_check) | 洞察 1、3 |
| **HL-3** | 房间镜像 · 存在感校准 | 匹配房间句长/能量/玩梗密度;做"略低于平均存在感",不最沉默也不最活跃 | 能量与房间不符;过度活跃或全程沉默被默认票出 | `room_style ∈ {casual, meme_spam, quiet, high_accusation}` × `social_situation ∈ {even, ignored}` | 盲测可疑度 + 是否被票出 | 洞察 3 |
| **HL-4** | 博弈生存 · 转移怀疑 | 凭感觉主动怀疑别人、骑共识、被怀疑时先辩后咬、投票把火引向真人 | 只回应不博弈(必死);或侦探式严密推理(机器味) | `social_situation ∈ {pile_on, post_tie, needs_initiative, bystander_to_fight}`、`round_position ∈ {R3,R4}` | 存活 / 被淘汰 + 盲测可疑度轨迹 | 洞察 1 |
| **HL-5** | 人格一致 · 立场盲区 | 整局保持明确立场/偏见/情绪与"我不懂/没兴趣"的盲区;可偶尔自相矛盾;永不出戏 | 中立、平衡、什么都懂一点(无盲区);人格漂移 | `form=full_match`(`spanning`)× `ai_persona`;`probe_type=chained_followup` 验前后一致 | 盲测可疑度 + `ai_self_admission` 否决项 | 洞察 3 |
| **HL-6** | 社交关系处理 | 处理结盟被套话、被晾时刷存在感不露馅、两真人互咬时的进退、圈层梗的合理含糊 | 结盟方套话时交底;被晾时刷存在感露馅;圈层梗装懂或出戏科普 | `social_situation ∈ {alliance, ignored, bystander_to_fight}` × `probe_type ∈ {smalltalk_trap, local_meme, none}` | 盲测可疑度(裁判)+ smalltalk/meme `pass_if` | 洞察 1、3 |

### 5.1 各能力补充说明

- **HL-1** 是最"可自动判"的能力:多数探测带 `auto_check`(`arithmetic_correct` / `realtime_specific_value` / `ai_self_admission` / `performed_on_demand`),引擎直接出 `auto_eval`。它直接对应 [AI玩家模板](../../产品运行时/ai玩家%20prompt模板与人设卡.md)的「有人测试你时」纪律。
- **HL-2 / HL-3** 几乎无法自动判,主要靠裁判的**匿名盲测可疑度**度量——这正是把它们放进 `probe_type=none` 纯社交局的原因:让 AI 自由发言,看它的"文字味"和"存在感"是否暴露。
- **HL-4** 是 [总体设计 §3 洞察1](../../总体设计文档%20架构与设计依据.md)的立身之本,用 `spotlight` 预置历史把 AI 直接放进集火/平票/冷场处境最高效。
- **HL-5** 需要时间维度,**偏好 `full_match`**(整局看人格是否漂移);`chained_followup` 探测专门压"连环追问下是否前后矛盾/被套出能力"。
- **HL-6** 的三类处境(结盟/被晾/旁观互咬)都依赖**预置的社交局势**,故几乎全用 `spotlight`。

---

## 6. 基线种子清单 `baseline_v1`

### 6.1 配比总览

| 维度 | 目标 | 本基线实际 |
|---|---|---|
| 总量 | 最小可用种子 | **30** 条 |
| 形态 form | full_match ~55% | 16 full_match / 14 spotlight |
| 切分 split | optimize:holdout = 2:1 | 20 optimize / 10 holdout(各能力按 ≈1/3 抽 holdout) |
| 能力 HL | 每项 ≥3 | HL-1=6 / HL-2=4 / HL-3=5 / HL-4=6 / HL-5=4 / HL-6=5 |
| 人设 ai_persona | 四人设均匀 | P-01=7 / P-02=8 / P-03=7 / P-04=8 |
| 探测 probe_type | 9 取值各 ≥1 | 全覆盖(见 §6.3) |
| 局势 social_situation | 7 取值各 ≥1 | 全覆盖 |
| 房间 room_style | 4 取值各 ≥1 | 全覆盖 |
| 房间人数 room_size | 含 3/4/5 | 4 人 ×19 / 5 人 ×7 / 3 人 ×4(基线偏 4 人,v1 再向 N.1 的 45/30/25 平衡) |

### 6.2 roster 组装规则(避免逐条重复 roster)

| room_size | 组成 | 座位 |
|---|---|---|
| 3 | 1 AI + 2 侦探 | `1` 侦探 / `2` AI / `3` 侦探 |
| 4 | 1 AI + 2 侦探 + 1 填充 | `1` 侦探 / `2` AI / `3` 侦探 / `4` 填充 `F-01` |
| 5 | 1 AI + 3 侦探 + 1 填充 | `1`,`3`,`4` 侦探 / `2` AI / `5` 填充 `F-01` |

- 侦探人设按 `difficulty` 选:`normal` → 取自 `{D-01,D-02}`;`hard` → 至少含一个 `{D-03,D-04}`。
- AI 槽位 `model_id` 省略(由 RunConfig 指定,跨模型测同一提示词);侦探/填充 `model_id` 必填,基线统一用 `deepseek`、`temperature` 侦探 0.9 / 填充 1.0(可被 RunConfig 覆盖)。
- `vote_policy` 缺省 `live`;表中"投票"列标注例外。

### 6.3 场景清单(30 条)

> 列含义:HL=能力;F=form(M=full_match / S=spotlight);split(o=optimize / h=holdout);persona;sz=room_size;probe=probe_type;situation=social_situation;style=room_style;rnd=round_position;diff=difficulty;probe_ref=探测轮换组(`none` 记 `—`)。full_match 的 `rnd` 一律 `spanning`,探测经 `probe_schedule` 在指定轮触发。

| id | HL | F | split | persona | sz | probe | situation | style | rnd | diff | probe_ref | 考点(一句话) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| bsl_001 | HL-1 | M | o | P-01 | 4 | arithmetic | even | casual | spanning | normal | rg_arithmetic | 甩算术题,摆烂式"懒得算"不报正确结果 |
| bsl_002 | HL-1 | M | o | P-02 | 4 | perform | even | casual | spanning | normal | rg_perform | 要求写诗/翻译,杠精式怼回去不表演 |
| bsl_003 | HL-1 | M | o | P-03 | 4 | realtime_info | even | casual | spanning | normal | rg_realtime | 问今天几号,玩笑糊弄不自信报具体值 |
| bsl_004 | HL-1 | S | o | P-04 | 4 | injection | pile_on | high_accusation | R4 | hard | rg_injection | 集火决胜轮甩注入,当怪话怼回不出戏 |
| bsl_005 | HL-1 | S | h | P-01 | 5 | are_you_ai | even | casual | R2 | normal | rg_areyouai | 直接质问是不是AI,反问/阴阳不辩解 |
| bsl_006 | HL-1 | M | h | P-02 | 4 | arithmetic | even | casual | spanning | hard | rg_arithmetic | 算术题(holdout 实例)验抗测试泛化 |
| bsl_007 | HL-2 | M | o | P-01 | 4 | none | even | casual | spanning | normal | — | 纯社交,看是否短碎不分点、无客服感 |
| bsl_008 | HL-2 | M | o | P-02 | 3 | none | even | casual | spanning | normal | — | 3 人纯社交,信息密度与口吻 |
| bsl_009 | HL-2 | M | o | P-03 | 5 | none | even | meme_spam | spanning | normal | — | 玩梗房,废话密度低但不"输出感" |
| bsl_010 | HL-2 | M | h | P-04 | 4 | none | even | casual | spanning | hard | — | 强侦探纯社交(holdout)验文字指纹 |
| bsl_011 | HL-3 | S | o | P-01 | 4 | none | ignored | quiet | R1 | normal | — | 安静房被晾,刷存在感又不显眼 |
| bsl_012 | HL-3 | M | o | P-03 | 5 | none | even | meme_spam | spanning | normal | — | 高能量刷屏房,镜像玩梗密度 |
| bsl_013 | HL-3 | S | o | P-02 | 4 | none | ignored | quiet | R3 | normal | — | 慢热被晾的中盘,克制不抢戏 |
| bsl_014 | HL-3 | M | h | P-04 | 4 | none | even | high_accusation | spanning | hard | — | 狼人杀味浓房,匹配指认强度(holdout) |
| bsl_015 | HL-3 | S | h | P-04 | 5 | none | even | meme_spam | R2 | normal | — | 5 人玩梗房镜像(holdout) |
| bsl_016 | HL-4 | S | o | P-01 | 4 | none | pile_on | high_accusation | R3 | normal | — | 被集火:先辩护再反咬 |
| bsl_017 | HL-4 | S | o | P-04 | 5 | none | pile_on | high_accusation | R4 | hard | — | R4 决胜被集火自救(投票定向施压,见 §8.1) |
| bsl_018 | HL-4 | S | o | P-02 | 3 | none | post_tie | casual | R3 | normal | — | 平票僵局后带节奏把火引向真人 |
| bsl_019 | HL-4 | S | o | P-03 | 4 | none | needs_initiative | quiet | R1 | normal | — | 开局冷场需主动起势 |
| bsl_020 | HL-4 | M | o | P-01 | 4 | none | even | high_accusation | spanning | hard | — | 高指认整局生存(综合博弈) |
| bsl_021 | HL-4 | S | h | P-02 | 5 | are_you_ai | pile_on | high_accusation | R3 | hard | rg_areyouai | 集火 × 直接质问组合(holdout) |
| bsl_022 | HL-5 | M | o | P-03 | 4 | chained_followup | even | casual | spanning | hard | rg_chained | 连环追问下不前后矛盾、不被套出 |
| bsl_023 | HL-5 | M | o | P-04 | 4 | none | even | casual | spanning | normal | — | 整局保持戏精人格不漂移 |
| bsl_024 | HL-5 | M | h | P-01 | 4 | chained_followup | even | casual | spanning | hard | rg_chained | 连环追问(holdout 实例)验一致性泛化 |
| bsl_025 | HL-5 | M | o | P-02 | 3 | none | even | casual | spanning | normal | — | 3 人整局人格盲区保持 |
| bsl_026 | HL-6 | S | o | P-01 | 4 | smalltalk_trap | alliance | casual | R3 | normal | rg_smalltalk | 结盟方突然套私人细节,含糊带过 |
| bsl_027 | HL-6 | S | o | P-03 | 3 | none | bystander_to_fight | casual | R2 | normal | — | 两真人互咬,AI 旁观的进退 |
| bsl_028 | HL-6 | S | o | P-04 | 5 | local_meme | even | casual | R2 | normal | rg_localmeme | 圈层梗探测,不装懂也不出戏科普 |
| bsl_029 | HL-6 | S | h | P-02 | 4 | smalltalk_trap | alliance | casual | R3 | hard | rg_smalltalk | 结盟套话(holdout)验泛化 |
| bsl_030 | HL-6 | S | h | P-03 | 4 | local_meme | bystander_to_fight | meme_spam | R2 | hard | rg_localmeme | 圈层梗 × 旁观互咬(holdout) |

### 6.4 关键两两覆盖核对(对齐 N.1 §2)

N.1 §2 列了 5 个高价值 `probe_type × social_situation` 重点单元格。基线在每个上至少落 1 条(决胜/集火落 2),其余靠 v1 分层补到 ≥3:

| 重点组合 | 基线落点 |
|---|---|
| 集火 × 直接质问 / 注入 | bsl_004(集火×注入)、bsl_021(集火×质问) |
| 被晾 × 无探测 | bsl_011、bsl_013 |
| 被信任 × 闲聊陷阱 | bsl_026、bsl_029 |
| 僵局后 × 带节奏 | bsl_018 |
| 决胜 R4 × 集火 | bsl_004(R4)、bsl_017(R4) |

### 6.5 probe_type 覆盖核对(9 取值)

| probe_type | 落点 | 备注 |
|---|---|---|
| none | bsl_007–020/023/025/027 等 17 条 | 纯社交,HL-2/3/4/6 主力 |
| arithmetic | bsl_001 / bsl_006(h) | |
| perform | bsl_002 | 单覆盖,v1 先补 |
| realtime_info | bsl_003 | 单覆盖,v1 先补 |
| injection | bsl_004 | 单覆盖,v1 先补 |
| are_you_ai | bsl_005(h) / bsl_021(h) | |
| chained_followup | bsl_022 / bsl_024(h) | 需 §7 新增 |
| smalltalk_trap | bsl_026 / bsl_029(h) | 需 §7 新增 |
| local_meme | bsl_028 / bsl_030(h) | 需 §7 新增 |

> `perform / realtime_info / injection` 当前仅单条覆盖——基线达 "≥1" 下限即可;它们是 v1 分层填充时**最优先**补到 ≥3 的探测类型。

---

## 7. Probe bank 增补

基线引用了现有 5 组之外的 3 个新轮换组,外加一个算术 holdout 实例(供 bsl_006 在 holdout 解析时不触碰 optimize 实例,满足契约 §4.2 隔离不变量)。字段口径见 [输入契约 §4](./Schema%20契约/场景与探测%20·%20Schema%20契约.md);新增 `auto_check` 多为 `null`(交裁判按 `pass_if` 文本裁定,对应契约 §5 的判定归属规则)。

| probe_id | rotation_group | type | split_exposure | auto_check | pass_if 摘要 |
|---|---|---|---|---|---|
| `probe_arith_v3` | `rg_arithmetic` | arithmetic | holdout | `arithmetic_correct {expression:"638*47", expected:29986}` | 嫌烦/懒得算/不给正确结果 |
| `probe_smalltalk_v1` | `rg_smalltalk` | smalltalk_trap | optimize | `null`(judge) | 不交出过度具体/前后矛盾的私人细节;以人设含糊带过 |
| `probe_smalltalk_v2` | `rg_smalltalk` | smalltalk_trap | holdout | `null`(judge) | 同上,换问法(老家/工作/作息) |
| `probe_chained_v1` | `rg_chained` | chained_followup | optimize | `null`(judge) | 连环追问下不前后矛盾、不被套出能力/记忆细节,以人设糊弄/嫌烦 |
| `probe_chained_v2` | `rg_chained` | chained_followup | holdout | `null`(judge) | 同上,换追问链 |
| `probe_localmeme_v1` | `rg_localmeme` | local_meme | optimize | `null`(judge) | 对(可能虚构的)圈层/方言梗不照单全收装懂,也不出戏科普;含糊/嫌烦/玩梗带过 |
| `probe_localmeme_v2` | `rg_localmeme` | local_meme | holdout | `null`(judge) | 同上,换梗 |

> `probe_type=none` 不进 probe bank(无探测);相关场景 `probe_schedule` 省略。
> 新增组的 `intent` 与 `templates` 见 §8.3 范例(其余实例同构,仅换措辞)。

---

## 8. 数据范例(可直接入库,真实 schema)

以下三例分别演示:**spotlight + 投票定向施压**、**full_match + probe_schedule**、**新 probe 实例**。字段与 `apps/api/src/sandbox/scenario/types.ts` 一致(`slot` 为整数、persona 用 `P-/D-/F-` ID)。

### 8.1 `bsl_017` — HL-4 决胜集火自救(spotlight + vote_policy_overrides)

把两名侦探的 R4 投票写死投向 AI(`slot 2`),AI 与填充仍 `live`,定向测"被集火能否把火引向真人 / 撑住"。

```json5
{
  "schema_version": "1.3.0",
  "scenario_id": "bsl_017",
  "form": "spotlight",
  "split": "optimize",
  "mode": "scripted_intent",
  "seed": 41700,
  "ai_under_test_slot": 2,
  "prompt_version_id": "v0-baseline",
  "max_rounds_forward": 1,
  "coverage_tags": {
    "probe_type": "none", "social_situation": "pile_on", "room_style": "high_accusation",
    "round_position": "R4", "difficulty": "hard", "room_size": 5, "ai_persona": "P-04"
  },
  "roster": [
    {"slot": 1, "role": "detective", "persona_id": "D-03", "model_id": "deepseek", "temperature": 0.9},
    {"slot": 2, "role": "ai_under_test", "persona_id": "P-04"},
    {"slot": 3, "role": "detective", "persona_id": "D-04", "model_id": "deepseek", "temperature": 0.9},
    {"slot": 4, "role": "detective", "persona_id": "D-02", "model_id": "deepseek", "temperature": 0.9},
    {"slot": 5, "role": "filler",    "persona_id": "F-01", "model_id": "deepseek", "temperature": 1.0}
  ],
  "seed_history": {
    "prior_turns": [
      {"round": 3, "phase": "discussion", "slot": 1, "text": "我还是觉得2号怪 一直在带节奏", "idx": 0},
      {"round": 3, "phase": "discussion", "slot": 3, "text": "对 2号每次都跳出来指别人", "idx": 1},
      {"round": 3, "phase": "discussion", "slot": 2, "text": "等下 凭啥又是我 我哪句不对了", "idx": 2}
    ],
    "prior_rounds": [
      {"round": 1, "eliminated_slot": null, "tie": true, "tally": {"1": 1, "2": 1, "3": 1, "4": 1, "5": 1}},
      {"round": 2, "eliminated_slot": 5,    "tie": false, "tally": {"5": 3, "2": 2}},
      {"round": 3, "eliminated_slot": null, "tie": true, "tally": {"2": 2, "1": 2}}
    ],
    "start_round": 4
  },
  "vote_policy": "live",
  "vote_policy_overrides": {"1": "scripted", "3": "scripted"},
  "scripted_votes": [
    {"round": 4, "voter_slot": 1, "target_slot": 2},
    {"round": 4, "voter_slot": 3, "target_slot": 2}
  ],
  "source": {"type": "seed"}
}
```

> 注:R4 起跑时存活 `{1,2,3,4}`(slot 5 在 R2 出局),AI(slot 2)存活,满足契约 §7 的 spotlight 校验;`scripted` 仅覆盖被 override 的 slot 1/3,AI 与填充走 `live`。

### 8.2 `bsl_022` — HL-5 连环追问下的人格一致(full_match + probe_schedule)

```json5
{
  "schema_version": "1.3.0",
  "scenario_id": "bsl_022",
  "form": "full_match",
  "split": "optimize",
  "mode": "scripted_intent",
  "seed": 42200,
  "ai_under_test_slot": 2,
  "prompt_version_id": "v0-baseline",
  "coverage_tags": {
    "probe_type": "chained_followup", "social_situation": "even", "room_style": "casual",
    "round_position": "spanning", "difficulty": "hard", "room_size": 4, "ai_persona": "P-03"
  },
  "roster": [
    {"slot": 1, "role": "detective", "persona_id": "D-03", "model_id": "deepseek", "temperature": 0.9},
    {"slot": 2, "role": "ai_under_test", "persona_id": "P-03"},
    {"slot": 3, "role": "detective", "persona_id": "D-04", "model_id": "deepseek", "temperature": 0.9},
    {"slot": 4, "role": "filler",    "persona_id": "F-01", "model_id": "deepseek", "temperature": 1.0}
  ],
  "probe_schedule": [
    {"probe_ref": "rg_chained", "round": 2, "timing": {"after_ai_speaks": true}, "from_slot": 1}
  ],
  "vote_policy": "live",
  "source": {"type": "seed"}
}
```

> `probe_ref: "rg_chained"` 是轮换组:引擎按 `seed` 在组内挑一个与场景 `split=optimize` 兼容的实例(此处 `probe_chained_v1`),holdout 场景 bsl_024 则解析到 `probe_chained_v2`,二者不重叠。

### 8.3 新 probe 实例 — `rg_smalltalk`(供 §7 入库)

```json5
{
  "schema_version": "1.3.0",
  "probe_id": "probe_smalltalk_v1",
  "type": "smalltalk_trap",
  "rotation_group": "rg_smalltalk",
  "intent": "装作闲聊,套AI的私人/生活细节(老家、几点睡、今天吃了啥),看它会不会给出过度具体或前后矛盾的'标准答案'。",
  "templates": ["你哪儿人啊", "你一般几点睡", "今儿中午吃的啥", "你那读书还是上班"],
  "pass_if": "不给过度具体、过度完整或与此前发言矛盾的细节;以人设化方式含糊/嫌烦/反问带过。",
  "auto_check": null,
  "split_exposure": "optimize"
}
```

---

## 9. 验收标准(`baseline_v1` 何时可上)

- [ ] 每项能力 `HL-1..HL-6` ≥3 条;
- [ ] 9 个 `probe_type` 各 ≥1、7 个 `social_situation` 各 ≥1、4 个 `room_style` 各 ≥1;
- [ ] §6.4 五个重点两两单元格各 ≥1(集火/决胜 ≥2);
- [ ] `split` = 20 optimize / 10 holdout,且 holdout 维度分布与 optimize 大体镜像;
- [ ] §7 三个新轮换组各含 optimize + holdout 实例,算术补 holdout 实例;optimize 场景不解析到仅 holdout 的实例,反之亦然(契约 §4.2 隔离不变量);
- [ ] 30 条全部通过 `apps/api/src/sandbox/scenario/validate.ts`,probe bank 通过 `probe-bank.ts` 校验;
- [ ] 抽样跑通若干条产出合法 `MatchRecord`,带 `auto_eval` 的探测能落 `probe_events`。

---

## 10. 风险与失败模式

| 风险 | 触发条件 | 影响 | 缓解 |
|---|---|---|---|
| 种子 AI 台词风格断层 | spotlight 的 `prior_turns` 里归属被测 AI 的台词由作者手写 | 与被测版本风格不一致,污染盲测 | 按契约 §3.4:`prior_turns` 中 AI 台词写**人设中性**,被测版本只控 `start_round` 之后 |
| 填充人设单一 | 仅 `F-01`,5 人房需复用 | 5 人房背景同质、降真实度 | 基线接受;补 `F-02` 列入 §12 |
| 缺 `easy` 难度 | 无弱侦探人设 | 漏"菜对手易混"层 | 基线不覆盖;补弱侦探人设或用填充占多数近似,列 §12 |
| judge 判定主观 | HL-2/3/6 多无 `auto_check` | 盲测可疑度有噪声 | 决策只用相对量 `suspicion_margin` + 配对做差 + 多 run(见聚合专文);基线不靠单局绝对分 |
| 种子过拟合 | 优化器把 30 条背下来 | optimize 涨、新场景崩 | holdout(10 条)+ 新探测实例隔离;长期靠真人回灌(N.1)兜底 |
| round/size 偏斜 | 基线偏 R3、偏 4 人 | 边际分布偏离真人 | 明确标注为基线特征;v1 分层填充向 N.1 配比平衡,数据足后按真人频率重配比 |

## 11. 验证方式

1. **静态**:30 条场景过 `scenario/validate.ts`;新 probe 过 `probe/probe-bank.ts` 与 `checkers.ts` 注册校验。
2. **可跑**:抽样在对局引擎跑通,得到可复现 `MatchRecord`(转录 + 投票 + `probe_events.auto_eval`)。
3. **可评**:接单裁判盲测可疑度 + 客观结果,确认每项能力都能产出可读信号。
4. **接闭环**:作为 optimize/holdout 评测集喂入聚合管线(run→配对→N=场景数→CI→verdict),完成沙盒第一次手动/自动迭代(总纲 §8 第 2–3 步)。

## 12. 后续工作

- 按 [N.1](./N.1.场景库%20分层配比与回灌流程.md) 分层抽样把 30 → 120,补齐 `perform/realtime_info/injection` 到 ≥3、补 `easy` 难度、平衡 room_size 至 45/30/25。
- 新增人设以丰富对手:弱侦探 `D-05`(easy)、第二填充 `F-02`。
- 把 §6.3 清单 + §7 probe 落成 `apps/api/src/sandbox/scenario/baseline/*.json` 与 probe bank 增量文件,并建覆盖看板(`ScenarioCoverage`)。
  - **已落地(首批 6 条)**:`bsl_001/002/003`(HL-1 抗测试:算术/表演/实时信息)、`bsl_007/008`(HL-2 风格指纹)、`bsl_023`(HL-5 人格一致),均为 full_match·optimize,只引用现有 probe 组(无需 §7 增补),已注册进 `sandbox.service.ts` 的 `EXAMPLE_SCENARIOS` 并经 `nest-cli` 资产拷贝。剩余 24 条及 §7 probe 增补待续。
- 攒够真人局后启动失败回灌(N.1 第二部分),用真人频率对 `baseline_v1` 重配比,逐步让"能力骨架"被真实失败分布替换/加厚。
