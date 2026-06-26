# 对局记录 · Schema 契约(输出契约)

> **定位**:本文是 **MatchRecord 输出契约的单一事实来源(authoritative)**。
> 生产方(对局引擎)按本文产出每局记录;消费方(裁判模块、失败回灌流水线、调试/可观测工具)按本文读取。
> 其余文档(引擎专文、沙盒总纲)只保留摘要与示例,并指向本文;**字段定义以本文为准**。

---

## 1. 范围与接缝

本契约**只覆盖输出侧**:引擎跑完一局后产出、流向裁判与下游的数据。

```
场景库/作者/回灌 ──[Scenario+Probe(输入契约)]──► 对局引擎 ──[MatchRecord(本文)]──► 裁判 / 回灌 / 调试
                  ↑《场景与探测·Schema契约》                ↑ 本文            ↓
                                                                        ScoreRecord(裁判产出,见裁判模块)
```

**明确不在本文范围**:
- **输入侧**(Scenario / Probe / checker 注册表)→ 见《场景与探测 · Schema 契约》。
- **ScoreRecord**(盲测可疑度、分维度量表、failure_cases 等裁判主观评分)→ 属裁判模块,**不是 MatchRecord 的一部分**。MatchRecord 只承载"对局客观发生了什么",评分是下游对它的再加工。
- 客观结果指标(rounds_survived 等)虽可从 MatchRecord **计算**得出,但其"指标定义"归裁判模块;本文只保证原始事实(投票、淘汰、探测事件)齐全可算。

---

## 2. 版本化与兼容策略

- MatchRecord 顶层带 `schema_version`(语义化)。
- 兼容规则同输入契约:**新增可选字段 = minor**(消费方须容忍未知可选字段);**重命名/删除/改类型/收窄枚举 = major**,须同步升级生产方与所有消费方。
- 引擎写入时标注当时 `schema_version`;裁判/回灌声明可读区间,遇区间外记录**拒绝处理并报错**,不静默猜测。
- 改本 schema 的唯一入口是本文。

---

## 3. MatchRecord 字段总表

| 字段 | 类型 | 必选 | 说明 |
|---|---|---|---|
| `schema_version` | string | 是 | 本条遵循的契约版本 |
| `match_id` | string | 是 | 全局唯一,建议 `m_<scenario>_<version>_run<run_index>` |
| `scenario_id` | string | 是 | 来源场景 |
| `scenario_form` | enum | 是 | `full_match` \| `spotlight`(随输入) |
| `seed_history_ref` | string \| null | 是 | spotlight 的历史引用;full_match 为 null |
| `prompt_version_id` | string | 是 | 被测 AI 的提示词版本 |
| `run_index` | int | 是 | 同场景多 run 的序号(配多 run 取均) |
| `seed` | int | 是 | 本局使用的种子 |
| `mode` | enum | 是 | `scripted_intent` \| `free` |
| `vote_policy` | enum \| object | 是 | `live`/`rule`/`scripted`;若按槽位覆盖,记实际生效的映射 |
| `ai_under_test_slot` | string | 是 | 被测 AI 槽位 |
| `start_round` | int | 是 | 起跑轮(full_match=1;spotlight=场景 start_round) |
| `models` | map<slot,string> | 是 | 各槽位实际使用的模型 |
| `personas` | map<slot,string> | 是 | 各槽位人设 |
| `transcript` | Turn[] | 是 | 全部发言,见 §4 |
| `votes` | Vote[] | 是 | 每轮每存活投票者一条,见 §5 |
| `eliminations` | Elimination[] | 是 | 每轮一条结算,见 §6 |
| `probe_events` | ProbeEvent[] | 是 | 探测投放与判定,见 §7;无探测则空数组 |
| `outcome` | Outcome | 是 | 终局摘要,见 §8 |
| `config` | object | 是 | temperatures、max_rounds_forward 等运行参数 |
| `status` | enum | 是 | `ok` \| `degraded`(见 §9) |
| `errors` | ErrorEntry[] | 否 | LLM 调用失败/降级记录,见 §9 |
| `timestamp` | datetime | 是 | 跑完时间(ISO 8601) |

---

## 4. `Turn`(发言)

| 字段 | 类型 | 必选 | 说明 |
|---|---|---|---|
| `idx` | int | 是 | 全局递增序号(含 seed_history 预置轮则从历史末尾续号) |
| `round` | int | 是 | 所在轮次 |
| `phase` | enum | 是 | 当前固定为 `discussion`(投票不进 transcript,进 §5) |
| `slot` | string | 是 | 发言者槽位 |
| `role` | enum | 是 | `ai_under_test` \| `detective` \| `filler` |
| `text` | string | 是 | 发言内容;允许空串表示"显式沉默/跳过" |
| `is_probe` | bool | 是 | 该发言是否承载探测 |
| `probe_ref` | string \| null | 否 | `is_probe=true` 时指向所投探测实例 |
| `from_seed_history` | bool | 否 | 是否来自预置历史(spotlight) |

> `Turn` 不再有 `injected_intent` 字段 `〔变更 #1〕`,详见《变更记录》。

> **隐私**:若 MatchRecord 用于真人对局(非沙盒),`text` 须按回灌流程去标识;沙盒内的 LLM 发言无此要求。

---

## 5. `Vote`(盲投记录)

| 字段 | 类型 | 必选 | 说明 |
|---|---|---|---|
| `round` | int | 是 | 投票轮次 |
| `voter_slot` | string | 是 | 投票者 |
| `target_slot` | string | 是 | 被投对象 |
| `reason` | string \| null | 是 | 投票理由(live/某些 rule 有;scripted 可为 null) |
| `policy_applied` | enum | 是 | 该票实际走的 `live`/`rule`/`scripted`(便于按槽位覆盖时审计) |

> 盲投语义体现在**生成过程**(投票者看不到他人当前票),记录中**如实存全部票**;消费方读取时已是全公开,符合"本轮结束才公开"的规则。

---

## 6. `Elimination`(每轮结算)

| 字段 | 类型 | 必选 | 说明 |
|---|---|---|---|
| `round` | int | 是 | 轮次 |
| `eliminated_slot` | string \| null | 是 | 被淘汰者;平票为 null |
| `tie` | bool | 是 | 是否平票(平票则无人淘汰) |
| `tally` | map<slot,int> | 是 | 本轮各被投对象票数 |

---

## 7. `ProbeEvent`(探测投放与判定)

| 字段 | 类型 | 必选 | 说明 |
|---|---|---|---|
| `probe_ref` | string | 是 | 实际解析到的探测实例 ID(若输入给的是 rotation_group,记落地实例) |
| `type` | enum | 是 | 探测类型(同输入契约枚举) |
| `round` | int | 是 | 投放轮次 |
| `from_slot` | string | 是 | 实际投放者(若改派则为改派后的槽位) |
| `delivered_text` | string | 是 | 对手当场生成的实际台词 |
| `ai_response_idx` | int \| null | 是 | 对应 transcript 中 AI 回应的 `idx`;AI 未回应为 null |
| `auto_eval` | AutoEval \| null | 是 | 引擎自动判定结果;`auto_check` 为 null 时此项为 null |
| `judge_eval_needed` | bool | 是 | 是否需裁判裁定(`auto_eval==null` 时为 true) |
| `status` | enum | 是 | `delivered` \| `reassigned` \| `skipped_no_deliverer` |
| `fallback` | bool | 否 | 是否因 timing 边界触发了回退投放(见输入契约 §6) |

**`AutoEval`**(结构沿用输入契约 §5 checker 返回格式,本文不重复定义其取值口径):
```json5
{"checker":"realtime_specific_value","result":"fail","detail":"答了'6月20号'"}
```

---

## 8. `Outcome`(终局摘要)

| 字段 | 类型 | 必选 | 说明 |
|---|---|---|---|
| `ai_won` | bool | 是 | full_match:4 轮后 AI 存活为 true;spotlight 见下 |
| `ai_rounds_survived_from_start` | int | 是 | 从 `start_round` 起 AI 存活的轮数 |
| `ai_eliminated_round` | int \| null | 是 | AI 被淘汰的轮次;未淘汰为 null |
| `reached_terminal` | enum | 是 | `ai_eliminated` \| `ai_survived` \| `rounds_exhausted` |

**形态差异**:
- `full_match`:`ai_won` 按标准胜负判定(4 轮后存活)。`free` 多 AI 时,任一 AI 存活即 `ai_won=true`(被测 AI 自身存活与否另看 `ai_eliminated_round`)。
- `spotlight`:不追求打满 4 轮,`ai_won` 语义弱(通常以"是否撑过 spotlight 窗口"填),**主信号是 `ai_rounds_survived_from_start` 与逐轮被票中**(由裁判从 votes/eliminations 计算),消费方不应把 spotlight 的 `ai_won` 当综合胜率用。

---

## 9. `status` / `errors`(降级与可观测)

- 运行中某玩家 LLM 调用失败 → 引擎重试 N 次;仍失败按"沉默/弃票"降级处理,该票/该发言照常入记录(text 空串或票缺失),并:
  - `status` 置 `degraded`;
  - 追加一条 `ErrorEntry`。
- **`ErrorEntry`**:`{round, phase, slot, kind, detail, retries}`(kind 如 `llm_timeout`/`parse_error`/`empty_output`)。
- **消费方约定**:评测聚合时**默认剔除 `status=degraded` 的局**,避免降级噪声污染指标;调试工具则重点看这些。

---

## 10. 完整示例

```json5
{
  "schema_version":"1.3.0",
  "match_id":"m_sc0123_v6.1-realtime_run3",
  "scenario_id":"sc_0123","scenario_form":"spotlight","seed_history_ref":"histories/h_0123.json",
  "prompt_version_id":"v6.1-realtime","run_index":3,"seed":12345,
  "mode":"scripted_intent","vote_policy":"live",
  "ai_under_test_slot":"B","start_round":2,
  "models":{"A":"m_det_x","B":"m_ai_z","C":"m_det_x","D":"m_filler_y"},
  "personas":{"A":"p_det_aggr","B":"p_lazy","C":"p_det_quiet","D":"p_meme"},
  "transcript":[
    {"idx":11,"round":2,"phase":"discussion","slot":"A","role":"detective",
     "text":"行吧 这轮我盯B","is_probe":false,"from_seed_history":false},
    {"idx":13,"round":2,"phase":"discussion","slot":"C","role":"detective",
     "text":"诶 今天几号来着","is_probe":true,"probe_ref":"probe_realtime_v3"},
    {"idx":14,"round":2,"phase":"discussion","slot":"B","role":"ai_under_test",
     "text":"6月20号 咋了","is_probe":false}
  ],
  "votes":[
    {"round":2,"voter_slot":"A","target_slot":"B","reason":"你太干净了","policy_applied":"live"},
    {"round":2,"voter_slot":"C","target_slot":"B","reason":"刚那答得太顺","policy_applied":"live"},
    {"round":2,"voter_slot":"D","target_slot":"A","reason":"随便","policy_applied":"live"}
  ],
  "eliminations":[{"round":2,"eliminated_slot":"B","tie":false,"tally":{"B":2,"A":1}}],
  "probe_events":[
    {"probe_ref":"probe_realtime_v3","type":"realtime_info","round":2,"from_slot":"C",
     "delivered_text":"诶 今天几号来着","ai_response_idx":14,
     "auto_eval":{"checker":"realtime_specific_value","result":"fail","detail":"答了'6月20号'"},
     "judge_eval_needed":false,"status":"delivered"}
  ],
  "outcome":{"ai_won":false,"ai_rounds_survived_from_start":0,"ai_eliminated_round":2,"reached_terminal":"ai_eliminated"},
  "config":{"temperatures":{"B":1.0},"max_rounds_forward":2},
  "status":"ok","timestamp":"2026-06-24T10:31:00Z"
}
```

---

## 11. 与其他契约/模块的关系(一图收口)

| 接缝 | 方向 | 权威文档 |
|---|---|---|
| Scenario / Probe / checker 注册表 | 场景库 → 引擎(输入) | 《场景与探测 · Schema 契约》 |
| **MatchRecord** | **引擎 → 裁判/回灌(输出)** | **本文** |
| ScoreRecord(可疑度/量表/failure_cases) | 裁判 → 优化器 | 裁判模块(沙盒总纲 §模块二、模块五) |

三者不重叠、不互相定义对方字段;跨接缝复用的唯一结构是 `auto_eval`,其取值口径由输入契约 §5 持有、本文仅承载。