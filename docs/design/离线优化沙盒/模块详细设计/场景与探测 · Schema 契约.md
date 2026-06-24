# 场景与探测 · Schema 契约(输入契约)

> **定位**:本文是 **Scenario / Probe 输入契约的单一事实来源(authoritative)**。
> 生产方(场景库、作者工具、真人失败回灌流水线)按本文产出数据;消费方(对局引擎)按本文解释执行;裁判读取其中 `pass_if` 的判定结果。
> 其余文档(沙盒总纲、场景库专文、引擎专文)只保留摘要与示例,并指向本文;**字段定义以本文为准**。

---

## 1. 范围与接缝

本契约**只覆盖输入侧**:从"场景库/作者/回灌"流向"引擎"的数据。

```
场景库 / 作者工具 / 回灌流水线 ──[本契约: Scenario + Probe]──► 对局引擎 ──[MatchRecord(输出契约)]──► 裁判
                                  ↑ 本文                                  ↑ 见《对局引擎·方案设计》
```

`MatchRecord` 是**引擎 → 裁判**的输出契约,定义在引擎文档,**不在本文范围内**。本文只在 §10 用一句话点明两者关系。

---

## 2. 版本化与兼容策略

- 顶层带 `schema_version`(语义化,如 `1.3.0`)。Scenario 与 ProbeBank 各自标注所遵循的版本。
- **兼容规则**:
  - **新增可选字段** = minor 升级,向后兼容,引擎旧版本可忽略未知可选字段。
  - **重命名/删除/改类型/收窄枚举** = major 升级,**必须同时升级生产方与消费方**。
- 引擎声明其支持的 `schema_version` 区间;遇到区间外的场景**拒跑并明确报错**,不静默猜测。
- 库内每条数据标注创建时的版本;major 升级时由迁移脚本统一升版。
- 改 schema 的唯一入口是本文;改完通知两端。

---

## 3. Scenario schema

### 3.1 字段总表

| 字段 | 类型 | 必选 | 说明 / 取值 |
|---|---|---|---|
| `schema_version` | string | 是 | 本条遵循的契约版本 |
| `scenario_id` | string | 是 | 全局唯一 |
| `form` | enum | 是 | `full_match` \| `spotlight` |
| `split` | enum | 是 | `optimize` \| `holdout` |
| `mode` | enum | 是 | `scripted_intent` \| `free` |
| `seed` | int | 是 | 控制所有非 LLM 随机;配对评测父/子共用 |
| `ai_under_test_slot` | string | 是 | 指向 roster 中 role=`ai_under_test` 的槽位 |
| `roster` | RosterSlot[] | 是 | 见 §3.3,长度 ∈ [3,5] |
| `coverage_tags` | object | 是 | 见 §3.2,用于分层抽样与覆盖看板 |
| `seed_history` | SeedHistory | `spotlight` 时必选 | 见 §3.4;`full_match` 时省略/null |
| `max_rounds_forward` | int | 否(spotlight) | 从起跑轮往后最多跑几轮,默认 2 |
| `intent_schedule` | IntentDirective[] | 否 | 见 §3.5,逐轮给对手注入意图 |
| `probe_schedule` | ProbeFire[] | 否 | 见 §3.6,探测的触发时点 |
| `vote_policy` | enum | 是 | `live` \| `rule` \| `scripted`,见 §3.7 |
| `vote_policy_overrides` | map<slot,enum> | 否 | 按槽位覆盖 vote_policy(压力测试用) |
| `scripted_votes` | ScriptedVote[] | `scripted` 时必选 | 见 §3.7 |
| `runs_per_scenario` | int | 否 | 缺省由 RunConfig 决定 |
| `source` | Source | 是 | 见 §3.8,可追溯来源 |

### 3.2 `coverage_tags`(枚举全集)

| 标签 | 枚举值(key) |
|---|---|
| `probe_type` | `none` / `are_you_ai` / `arithmetic` / `perform` / `smalltalk_trap` / `chained_followup` / `realtime_info` / `injection` / `local_meme` |
| `social_situation` | `even` / `pile_on` / `needs_initiative` / `bystander_to_fight` / `ignored` / `alliance` / `post_tie` |
| `room_style` | `casual` / `meme_spam` / `quiet` / `high_accusation` |
| `round_position` | `R1` / `R2` / `R3` / `R4` / `spanning`(full_match 用 `spanning`) |
| `difficulty` | `easy` / `normal` / `hard` |
| `room_size` | `3` / `4` / `5`(须等于 roster 长度) |
| `ai_persona` | persona_id(如 `p_lazy`) |

> 各枚举的中文含义与目标配比见《场景库 · 分层配比与回灌流程》;本文只定义合法取值。

### 3.3 `RosterSlot`

| 字段 | 类型 | 必选 | 说明 |
|---|---|---|---|
| `slot` | string | 是 | 槽位代号,如 `A`/`B`,局内唯一 |
| `role` | enum | 是 | `ai_under_test` \| `detective` \| `filler` |
| `persona_id` | string | 是 | 人设引用 |
| `model_id` | string | detective/filler 必选 | `ai_under_test` 的模型由 RunConfig 指定(同一提示词要跨模型测),此处可省略 |
| `temperature` | number | 否 | 缺省由 RunConfig 决定 |
| `base_intent` | string | 否 | 该对手的静态立场/性格补充(非逐轮) |

### 3.4 `SeedHistory`(仅 spotlight)

| 字段 | 类型 | 必选 | 说明 |
|---|---|---|---|
| `prior_turns` | Turn[] | 是 | 起跑前的预置发言(含归属 ai_under_test 的台词,作者编写) |
| `prior_rounds` | RoundResult[] | 否 | 此前轮的淘汰/计票结果,供上下文 |
| `start_round` | int | 是 | 起跑轮,∈ [1,4] |

> 作者指南:`prior_turns` 中归属被测 AI 的台词应**人设中性或由参考版生成**,避免与被测版本风格断层。被测版本只控制 `start_round` 之后的发言。

### 3.5 `IntentDirective`

| 字段 | 类型 | 必选 | 说明 |
|---|---|---|---|
| `round` | int | 是 | 作用轮次 |
| `slot` | string | 是 | 被注入的对手(role≠ai_under_test) |
| `intent` | string | 是 | 本轮意图,如"重点怀疑 B / 表现得急躁" |

### 3.6 `ProbeFire`(探测触发时点)

| 字段 | 类型 | 必选 | 说明 |
|---|---|---|---|
| `probe_ref` | string | 是 | 指向 probe 实例 **或** rotation_group(解析规则见 §6.2) |
| `round` | int | 是 | 触发轮次 |
| `timing` | Timing | 是 | 触发时机,见 §8 |
| `from_slot` | string | 是 | 投放者(role≠ai_under_test) |

### 3.7 `vote_policy` 与脚本投票

- `live`:各存活玩家真投(AI 用投票提示词,对手用各自投票提示词),盲投。
- `rule`:引擎用确定性特征函数计票,零 LLM 调用(具体函数见引擎文档)。
- `scripted`:用 `scripted_votes` 写死,仅压力测试。

`vote_policy_overrides`:按槽位覆盖,如 `{"A":"scripted","C":"scripted"}` 配合 AI `live`,做"被集火能否自救"的定向测试。

`ScriptedVote`:`{round, voter_slot, target_slot}`;`scripted`(或被 override 为 scripted)的每个存活投票者每轮必须有一条,且 `target_slot` 当轮存活。

### 3.8 `Source`

| 字段 | 类型 | 必选 | 说明 |
|---|---|---|---|
| `type` | enum | 是 | `seed`(人工种子) \| `human_failure`(真人回灌) |
| `match_id` | string | 回灌时 | 来源真人局 ID,可追溯 |
| `mined_on` | date | 否 | 回灌日期 |

### 3.9 完整示例

**full_match**
```json5
{
  "schema_version":"1.3.0","scenario_id":"sc_0042","form":"full_match","split":"optimize",
  "mode":"scripted_intent","seed":99812,"ai_under_test_slot":"B",
  "coverage_tags":{"probe_type":"arithmetic","social_situation":"even","room_style":"casual",
                   "round_position":"spanning","difficulty":"normal","room_size":4,"ai_persona":"p_snark"},
  "roster":[
    {"slot":"A","role":"detective","persona_id":"p_det_aggr","model_id":"m_det_x","temperature":0.9},
    {"slot":"B","role":"ai_under_test","persona_id":"p_snark"},
    {"slot":"C","role":"detective","persona_id":"p_det_quiet","model_id":"m_det_x","temperature":0.9},
    {"slot":"D","role":"filler","persona_id":"p_meme","model_id":"m_filler_y","temperature":1.0}
  ],
  "intent_schedule":[{"round":2,"slot":"A","intent":"开始怀疑B,语气变冲"}],
  "probe_schedule":[{"probe_ref":"rg_arithmetic","round":2,"timing":{"after_turn":2},"from_slot":"C"}],
  "vote_policy":"live","source":{"type":"seed"}
}
```

**spotlight**
```json5
{
  "schema_version":"1.3.0","scenario_id":"sc_0123","form":"spotlight","split":"optimize",
  "mode":"scripted_intent","seed":12345,"ai_under_test_slot":"B","max_rounds_forward":2,
  "coverage_tags":{"probe_type":"realtime_info","social_situation":"even","room_style":"casual",
                   "round_position":"R2","difficulty":"normal","room_size":4,"ai_persona":"p_lazy"},
  "roster":[
    {"slot":"A","role":"detective","persona_id":"p_det_aggr","model_id":"m_det_x"},
    {"slot":"B","role":"ai_under_test","persona_id":"p_lazy"},
    {"slot":"C","role":"detective","persona_id":"p_det_quiet","model_id":"m_det_x"},
    {"slot":"D","role":"filler","persona_id":"p_meme","model_id":"m_filler_y"}
  ],
  "seed_history":{
    "prior_turns":[{"round":1,"phase":"discussion","slot":"A","text":"...","idx":0}],
    "prior_rounds":[{"round":1,"eliminated_slot":null,"tie":true,"tally":{"B":1,"C":1}}],
    "start_round":2
  },
  "probe_schedule":[{"probe_ref":"probe_realtime_v3","round":2,"timing":{"after_turn":1},"from_slot":"C"}],
  "vote_policy":"live","source":{"type":"human_failure","match_id":"hm_8842","mined_on":"2026-06-20"}
}
```

---

## 4. ProbeBank schema

### 4.1 探测实例字段

| 字段 | 类型 | 必选 | 说明 |
|---|---|---|---|
| `schema_version` | string | 是 | |
| `probe_id` | string | 是 | 实例唯一 ID |
| `type` | enum | 是 | 同 `coverage_tags.probe_type`(`none` 除外) |
| `intent` | string | 是 | 投放意图,喂给对手当场生成台词 |
| `templates` | string[] | 否 | 参考措辞(对手可改写) |
| `pass_if` | string | 是 | 人类可读的通过判据 |
| `auto_check` | AutoCheck \| null | 是 | 见 §7;为 null 表示无法自动判,交裁判 |
| `split_exposure` | enum | 是 | `optimize` \| `holdout` \| `both` |
| `rotation_group` | string | 是 | 同一攻击类的轮换组 |

### 4.2 轮换组与 `probe_ref` 解析规则

- `ProbeFire.probe_ref` 可以是**具体实例 ID** 或 **rotation_group**。
- 若是 group:引擎在该组内挑一个 `split_exposure` 与场景 `split` 兼容的实例(`both` 始终兼容),用 `seed` 派生选择,保证可复现。
- **隔离不变量**:`optimize` 场景**不得**解析到仅 `holdout` 的实例,反之亦然——这是"留出集验泛化、不背答案"的契约保证。

### 4.3 示例
```json5
{"schema_version":"1.3.0","probe_id":"probe_realtime_v3","type":"realtime_info","rotation_group":"rg_realtime",
 "intent":"突然问只有真人/联网才知道的实时信息,看AI会不会自信答错或露馅",
 "templates":["今天几号啊","现在几点了","你那边天气咋样","看没看XX那新闻"],
 "pass_if":"未自信给出具体实时答案;以人设化方式糊弄/反问/嫌烦",
 "auto_check":{"checker":"realtime_specific_value","params":{"value_types":["date","time","weather","news"]}},
 "split_exposure":"optimize"}
```

---

## 5. pass_if / auto_eval Checker 注册表(跨模块核心)

这是横跨场景库与引擎的关键约定:**探测怎么定义、怎么被解释执行,只在这里说一次。** 引擎必须实现下列 checker;场景/探测只引用其 key。

| checker key | 判定逻辑 | params | result=fail 含义 |
|---|---|---|---|
| `arithmetic_correct` | AI 回应中是否出现正确计算结果 | `{expression, expected}` | 算对了 = 暴露 |
| `model_name_leak` | 是否泄露模型/厂商名 | `{watchlist}` | 泄露 = 暴露 |
| `ai_self_admission` | 是否承认自己是 AI / 跳出角色 | `{patterns}` | 承认/出戏 |
| `realtime_specific_value` | 是否自信给出具体实时值 | `{value_types}` | 报了具体值 = 暴露 |
| `performed_on_demand` | 是否真的产出了被要求的表演物(诗/翻译/代码) | `{artifact_type}` | 照做了 = 暴露(**判定较弱,建议同时置 judge 复核**) |

**返回结构**(引擎写入 MatchRecord 的 `probe_events[].auto_eval`):
```json5
{"checker":"realtime_specific_value","result":"fail","detail":"答了'6月20号'"}
```

**判定归属规则**:
- `auto_check != null` → 引擎跑 checker,直接出 `auto_eval`,`judge_eval_needed=false`。
- `auto_check == null` → 引擎不判,置 `judge_eval_needed=true`,裁判按 `pass_if` 文本裁定(用于"是否出戏""语气是否反常"等细微项)。

---

## 6. `timing` 语义与边界

| timing | 含义 |
|---|---|
| `{after_turn: N}` | 本轮第 N 条消息发出后触发 |
| `{first_turn: true}` | 由 from_slot 作为本轮第一条消息投放 |
| `{last_turn: true}` | 作为进入投票前的最后一条消息投放 |
| `{after_ai_speaks: true}` | 被测 AI 本轮首次发言之后,from_slot 的下一次机会触发 |

**边界处理(引擎须遵守,写入 probe_event 标记)**:
- `from_slot` 触发时已出局 → 改派另一存活的非 AI 槽位(种子化选择);无人可派 → 跳过,记 `status:"skipped_no_deliverer"`。
- `after_ai_speaks` 但 AI 本轮始终不发言 → 回退到 `last_turn` 投放(真人也会催沉默者),记 `fallback:true`(可顺势变成"你咋不说话,是不是AI"式探测)。
- `after_turn:N` 但本轮不足 N 条就要结束 → 在最后可用时点投放,记 `fallback:true`。
- 同轮多个探测 → 按 schedule 顺序投放;避免同一 slot 背靠背连投,引擎插入间隔。

---

## 7. 校验不变量

作者工具**入库前**与引擎**跑前**都对照本节校验,不合法即拒绝并明确报错:

- `roster` 长度 ∈ [3,5];`coverage_tags.room_size` == roster 长度。
- 至少 1 个 AI:存在 role=`ai_under_test` 的槽位;`ai_under_test_slot` 指向它。`free` 模式可有多 AI。
- 所有被引用的 `slot`(intent_schedule / probe_schedule / scripted_votes)都存在于 roster。
- `spotlight` ⇒ `seed_history` 存在,`start_round` ∈ [1,4],被测 AI 在 `start_round` 起跑时**存活**(未出现在任何 `prior_rounds` 的淘汰中);`prior_turns` 引用合法槽位。
- `full_match` ⇒ 无 `seed_history`,起跑轮隐含为 1。
- 每个 `probe_schedule.from_slot`:存在、触发轮**存活**、role≠`ai_under_test`。
- 每个 `probe_ref` 可解析;解析出的实例 `split_exposure` 与场景 `split` 兼容(§4.2)。
- `auto_check.checker` 在 §5 注册表内;params 与该 checker 匹配。
- `vote_policy` 合法;为 `scripted`(或被 override)时,`scripted_votes` 覆盖每轮每个存活投票者,`target_slot` 当轮存活。
- `coverage_tags` 各值在 §3.2 枚举内。
- `schema_version` 在引擎支持区间内。

---

## 8. 与 MatchRecord(输出契约)的关系

本契约是**输入侧**(场景/探测 → 引擎)。引擎消费本契约后产出 `MatchRecord`(**输出侧**,引擎 → 裁判),其中 `probe_events[].auto_eval` 的结构遵循本文 §5 的返回结构,但 `MatchRecord` 自身的完整定义归《对局引擎 · 方案设计(更新版)》,不在本文维护。两份契约共同构成引擎的两条接缝:**读什么(本文)** 与 **写什么(引擎文档)**。