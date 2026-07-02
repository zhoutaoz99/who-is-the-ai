# AI 发言调度

| 字段 | 内容 |
| --- | --- |
| 文档类型 | Design |
| 文档状态 | Active |
| 适用范围 | 普通产品对局与离线沙盒中的 AI / model-driven 玩家发言调度 |
| 目标读者 | 后端开发、评审者 |
| 责任人 | AI / Gameplay 维护者 |
| 最近核对日期 | 2026-07-02 |
| 关联代码 | `apps/api/src/ai/`、`apps/api/src/game/` |
| 关联文档 | [AI-Interaction-Flow.md](./AI-Interaction-Flow.md)、[AI-Human-Likeness-Design.md](./AI-Human-Likeness-Design.md) |

## 1. 背景

本文定位：这是发言调度的设计动机与当前运行时方案，讲清“为什么不用固定概率、为什么不做 1 秒模型轮询、单层发言机制下工程层和 AI 层如何分工”。设计原则至今有效。

当前普通对局已改为 v4.0 单层发言机制：

- 调度器决定“什么时候允许询问 AI、询问哪个 AI、结果是否还能落库”。
- `AiService.generateSpeech()` 一次模型调用直接产出最终聊天文本，不再走“策略层 JSON -> 表达层造句”的两段式链路。
- 模型可以输出 `skip` / `沉默` / `pass` 表示“这轮先看着”。
- `targetResponseDelayMs` / `nextCheckAfterMs` 是服务端内部 `AiSpeechAction` 字段，不是模型策略层输出。

与早期方案的差异:

- 上下文失效判断已简化:普通模式只比对 `{ roundNo, voteCount }` 两个字段，**新增聊天消息不再导致发言被丢弃**；只有轮次变化、离开发言阶段或投票数变化才丢弃。
- 当前产品对局只保留 AI 调度器；离线沙盒的侦探/填充玩家由沙盒顺序发言循环驱动，不再保留旧模拟真人调度器。

AI 发言调度的目标不是让 AI 高频填充对话，而是让 AI 在合适的时机像真人一样发言。

## 2. 目标

- 信息少时可以沉默。
- 被点名或被质疑时可以较快回应。
- 普通接话可以有自然延迟。
- 冷场时可以晚一点补话。
- 生成期间如果轮次或投票状态变化，不能把基于旧上下文的发言直接发出去。

## 3. 备选方案与取舍

### 3.1 为什么不使用固定概率

旧规则是固定 `4-10s` 检查一次，并以 `55%` 概率尝试发言。这种方式能跑通 MVP，但会带来几个问题：

- AI 容易抢话，尤其是小局里会显得系统在推进对话。
- 低信息场景也会触发模型，容易生成“先看看大家反应”这类机械发言。
- 节奏稳定且可预测，不像真人。
- 多个 AI 容易连续帮腔。
- 发言时机只由随机数决定，没有利用上下文。

### 3.2 为什么不做 1 秒模型轮询

即使不考虑模型成本，也不建议每秒调用模型判断是否发言：

- LLM 不适合作为实时调度器；时间、并发、冷却和阶段约束仍需要工程层保证。
- 模型有返回延迟，返回时上下文可能已经过期。
- “是否允许问 AI”包含产品规则，不完全是语义判断。
- 高频询问会让模型倾向于不断寻找发言理由。

更合理的边界是：

```text
工程层：决定什么时候允许询问 AI，并保证状态合法。
AI 层：在被询问时直接给出最终聊天文本，或明确表示这轮不发言。
```

## 4. 方案概览

当前方案尽量减少工程化控制，只保留硬约束、候选选择、上下文有效性检查和必要的节奏控制。

普通产品对局只有一个房间级 AI 发言调度器。无论房间里有几个 AI，都不会为每个 AI 各开一个独立轮询器；调度器每次只挑一个候选 AI 发起一次模型调用。

工程层保留：

- 当前必须是 `discussion` 阶段。
- AI 玩家必须存活。
- 选择一个符合冷却和退避条件的候选 AI。
- 同一房间同一时间只允许一个 AI 生成发言。
- AI 自己必须满足发言冷却。
- 对服务端派生的反应延迟和下次观察时间做上下限裁剪。
- 模型生成期间或等待发送期间如果轮次变化、离开发言阶段或投票数变化，则丢弃旧回答并短延迟后重新观察。

AI 单层发言负责：

- 基于公开上下文和人设，直接输出一条最终聊天文本。
- 如果暂时不该说话，只输出沉默标记。
- 不输出 `replyTo`、`speechAct`、`publicPoint`、`tone` 等中间策略结构。
- 由 `AiService` 清理文本、识别沉默、估算打字延迟，并封装成内部 `AiSpeechAction`。

## 5. 普通产品对局详细设计

### 5.1 单层发言输出

讨论阶段模型原始输出不是 JSON，而是一条可直接落到聊天区的文本。

发言原始输出示例：

```text
啊？我就催一下2号，这也算机械吗
```

沉默原始输出示例：

```text
skip
```

`AiService.generateSpeech()` 会把模型原始输出转换成服务端内部动作。下面的 JSON 是内部动作形态，**不是模型输出契约**。

发言动作：

```json
{
  "type": "speak",
  "content": "啊？我就催一下2号，这也算机械吗",
  "targetResponseDelayMs": 3900,
  "nextCheckAfterMs": 10000
}
```

跳过动作：

```json
{
  "type": "skip",
  "nextCheckAfterMs": 10000
}
```

内部动作还会携带 `callRecords` 用于复盘日志，文档示例中省略。

### 5.2 时间处理

`targetResponseDelayMs` 不是模型返回后的额外等待，而是从开始调用模型到最终发言出现的目标总反应时间。

单层机制下，模型不再给出这个字段。当前由 `typingDelayForContent(content)` 按发言长度估算一个“打字耗时”，再由工程层裁剪：

```text
estimatedDelayMs = min(8000, 1500 + content.length * 120)
targetResponseDelayMs = clamp(estimatedDelayMs, 800, 20000)
```

工程层会记录调用开始时间：

```text
remainingDelayMs = targetResponseDelayMs - modelElapsedMs
```

如果模型已经耗时超过目标时间，则不再额外等待。

当前裁剪范围：

- `nextCheckAfterMs`: `1000-30000ms`
- `targetResponseDelayMs`: `800-20000ms`
- 旧上下文重试延迟: `500-1500ms`

当前 `nextCheckAfterMs` 默认由服务端返回 `10000ms`，再经过工程层裁剪。未来如需更细节奏控制，应优先在工程调度侧增加明确规则，而不是恢复独立策略层输出。

### 5.3 数据模型 / 接口 / 配置

设计里会反复用到的关键量：

- `roundNo`
- `voteCount`
- `content`
- `targetResponseDelayMs`
- `nextCheckAfterMs`
- `callType = "discussion"`
- `AI_PLAYER_COUNT`
- `AI_SPEECH_INITIAL_CHECK_MS = 10_000`
- `SPEAK_COOLDOWN_MS = 15_000`
- `AI_SPEECH_SKIP_BACKOFF_MS = 8_000`

对应实现主要位于：

- `apps/api/src/ai/ai.service.ts`
- `apps/api/src/ai/ai.types.ts`
- `apps/api/src/game/game.service.ts`

### 5.4 完整调度流程

普通产品对局每次进入讨论阶段时，`afterDiscussionStarted()` 会启动房间级调度器：

```text
讨论阶段开始
  -> 10s 后首次观察
  -> 如果仍在 discussion:
       1. 若本房间已有 AI 发言模型调用进行中，1s 后重试
       2. 选择一个候选 AI
       3. 若没有候选 AI，1s 后重试
       4. 记录上下文标记 { roundNo, voteCount }
       5. 调用 generateSpeech(context)
       6. 模型返回后校验阶段、轮次、投票数
       7. skip: 标记该 AI 本轮已考虑，并设置 8s 退避
       8. speak: 等到目标总反应时间后再次校验并保存聊天消息
       9. 按 nextCheckAfterMs 安排下一次观察
  -> 离开 discussion 阶段后停止
```

这里的“观察”不是模型调用本身，而是工程调度器的一次尝试。一次观察可能因为以下原因不调用模型：

- 房间已不在 `discussion` 阶段。
- 房间内已有另一个 AI 发言调用正在进行。
- 当前没有满足冷却/退避条件的 AI 候选。

### 5.5 多个 AI 的发言顺序

多个 AI 之间没有固定座位轮转，也没有固定“1号 AI -> 2号 AI -> 3号 AI”的顺序。当前选择逻辑是“分组优先 + 组内随机”，对任意数量的 AI 都按同一规则生效：

1. 优先选“本轮没发过言、也没被考虑过”的 AI。
2. 如果没有，选“本轮没发过言”的 AI。
3. 如果还没有，选“本轮没被考虑过”的 AI。
4. 最后才在所有候选 AI 里随机选。

候选 AI 必须同时满足：

- `type === "ai"`。
- 存活。
- 距离自己上次发言至少 `15s`。
- 不在 `aiSkipBackoffUntil` 退避期内。

关键定义：

- “本轮发过言”：当前轮聊天记录中存在该 AI 的消息。
- “本轮被考虑过”：该 AI 本轮已经被调度器选中过，并且最终保存发言或返回 skip。
- “组内随机”：同一优先级下随机选择，不保证座位号顺序。

因此，多个 AI 同场时的实际行为是：

- 一轮开始后，调度器倾向于先让还没露面的 AI 有机会被问到。
- 某个 AI 如果返回 skip，也会被标记为“本轮已考虑”，短时间内不会被反复追问。
- 只有当本轮所有可用 AI 都发过言或被考虑过之后，才会允许重复选择同一个 AI。
- 如果只有一个 AI 满足条件，它会被选中；如果所有 AI 都在冷却或退避中，调度器每 `1s` 重新观察一次。

### 5.6 发言间隔、冷却与重试

| 机制 | 默认值 | 作用范围 | 生效方式 |
| --- | ---: | --- | --- |
| 首次观察延迟 | `10_000ms` | 房间级 | 每轮讨论开始后，调度器不会立刻问 AI，而是在 10 秒后第一次观察。 |
| 正常下次观察 | `10_000ms` | 房间级 | 当前 `generateSpeech()` 总是返回 `nextCheckAfterMs = 10000`；工程层裁剪到 `1000-30000ms` 后安排下一次观察。 |
| 忙碌重试 | `1_000ms` | 房间级 | 如果房间已有 AI 模型调用进行中，1 秒后再观察，保证同一房间串行生成。 |
| 无候选重试 | `1_000ms` | 房间级 | 如果所有 AI 都在冷却或退避中，1 秒后再观察。 |
| 单玩家发言冷却 | `15_000ms` | 玩家级 | `lastSpokeAt` 由 `addChatMessage()` 更新；同一个 AI 15 秒内不能再次成为候选。 |
| skip 退避 | `8_000ms` | 玩家级 | AI 返回 skip 后设置 `aiSkipBackoffUntil = now + 8000`，避免刚沉默又马上被选中。 |
| 反应时间下限/上限 | `800-20000ms` | 单次发言 | 服务端根据文本长度估算打字耗时，并从模型调用开始计入总反应时间。 |
| 上下文失效重试 | `500-1500ms` | 房间级 | 模型返回或保存前发现轮次/投票数变化时，丢弃结果并短延迟重试。 |

几个容易误解的点：

- `15s` 冷却是“同一个玩家”的冷却，不是“所有 AI 之间”的全局间隔。
- 但房间内有 `aiSpeaking` 串行锁，所以同一时刻最多只有一个 AI 正在生成发言。
- 一个 AI 成功发言后，下一次房间级观察通常在约 `10s` 后发生；如果另一个 AI 已满足冷却条件，它可能在这次观察中被选中。
- 同一个 AI 发言后的最早再次候选时间是 `15s` 后；实际再次发言还要加上模型耗时和剩余打字延迟。
- `nextCheckAfterMs = 10000` 和 `SPEAK_COOLDOWN_MS = 15000` 不冲突：前者只是“房间再看一眼”的时间，后者才决定“某个 AI 能不能被选中”。如果房间里只有这个刚发过言的 AI，10 秒后观察会发现它仍在冷却，于是按“无候选重试”每 1 秒继续观察，直到 15 秒冷却满足。
- skip 后通常要等下一次房间级观察才会再被考虑；当前默认下一次观察是 `10s`，已经长于 `8s` skip 退避。

### 5.7 保存前校验与丢弃

AI 发言有两次上下文校验：

1. 模型返回后：确认房间还在 `playing + discussion`，轮次未变，投票数未变。
2. 保存消息前：在等待反应时间后重新加锁读取房间，再做同样校验，并确认该 AI 仍然存活且仍属于当前调度器。

如果轮次变化、离开发言阶段或投票数变化，旧结果会被丢弃。普通模式下，新增聊天消息不会使结果失效。

成功保存时会更新：

- `lastSpokeAt`: 用于 15 秒发言冷却。
- `aiLastConsideredRound`: 用于本轮候选公平性。
- `aiLastConsideredAt`: 用于记录最近一次被考虑时间。
- `aiSkipBackoffUntil`: 成功发言时清空。

返回 skip 时会更新：

- `aiLastConsideredRound`
- `aiLastConsideredAt`
- `aiSkipBackoffUntil = now + 8000`

## 6. 普通产品对局已知限制

当前普通模式上下文失效只比对 `{ roundNo, voteCount }`。新增聊天消息不再触发丢弃，只有轮次变化、离开发言阶段或投票数变化才丢弃。

这个取舍会允许“基于稍早聊天上下文生成的发言”落库。原因是大量模型调用若因任意新聊天被误杀，会严重影响小局节奏。`round1PushVote` / 单局上下文一致性的更细判断交给离线评分尺子去衡量。

单层发言也意味着复盘日志不再有显式 `speechAct` / `publicPoint` 等策略字段。需要诊断发言意图时，应读取 `discussion` 调用的 system prompt、user prompt、raw response 和最终聊天文本。

Replay / 导出链路仍兼容历史日志中的 `speech-strategy`、`speech-expression`、`sim-human-speech`、`sim-human-vote`，但当前实现的新调用类型是 `discussion` 和 `vote`。

## 7. 离线沙盒发言调度

离线沙盒不使用普通产品对局的房间级候选调度器。它的目标不是模拟玩家自由抢话，而是让同一场景、同一批角色在可控顺序下完整产出对局记录，供盲测、诊断和提示词优化复用。

`full_match` 和 `spotlight` 都使用这套 pass 循环；区别在于 spotlight 可能从 `sandboxStartRound` 起跑、带预置历史和预淘汰玩家，并受 `sandboxMaxRoundsForward` 限制。

### 7.1 参与者范围

沙盒发言循环只驱动 model-driven 玩家：

- `sandboxRole = "ai_under_test"`：被测 AI，`type === "ai"`。
- `sandboxRole = "detective"`：侦探玩家，`type === "human"` 且 `simulated === true`。
- `sandboxRole = "filler"`：填充玩家，`type === "human"` 且 `simulated === true`。

代码上由 `isModelDrivenPlayer()` 判定：`type === "ai"` 或模拟真人。普通真人不会进入沙盒顺序发言循环。

### 7.2 核心差异

| 维度 | 普通产品对局 | 离线沙盒 |
| --- | --- | --- |
| 调度入口 | `startAiSpeech()` -> `startModelSpeech()` | `startSandboxSpeechLoop()` -> `runSandboxSpeechLoop()` |
| 调度单位 | 房间级观察，每次挑 1 个候选 AI | pass 循环，每个 pass 依次遍历全部存活 model-driven 玩家 |
| 发言顺序 | 分组优先 + 组内随机 | 按座位号排序后旋转起点 |
| 首次延迟 | 讨论开始后 `10s` 首次观察 | 讨论开始后立即进入顺序循环 |
| 玩家冷却 | 使用 `SPEAK_COOLDOWN_MS = 15s` | 不使用发言冷却筛选 |
| skip 退避 | skip 后 `8s` 内不再选中该 AI | skip 只标记本轮已考虑，不设置退避；下个 pass 仍可能再次轮到 |
| 无候选处理 | 没有候选时 `1s` 后重新观察 | 没有存活 model-driven 玩家时停止沙盒发言循环 |
| `nextCheckAfterMs` | 决定下一次房间级观察时间 | 忽略；pass 内继续走下一个玩家 |
| `targetResponseDelayMs` | 用于等待剩余打字延迟后再落库 | 忽略；模型返回 speak 后立即保存 |
| 并发模型调用 | 同一房间串行，靠 `aiSpeaking` 防重入 | 顺序 `await` 每个玩家的模型调用，天然串行 |
| 讨论结束 | 定时器进入投票；模型返回/保存时校验阶段 | 定时器可中断；每个 pass 结束也会检查是否到期并进入投票 |
| 探测注入 | 无 | pass 开始和进投票前可能额外插入探测发言 |

### 7.3 pass 顺序

每轮讨论开始时，沙盒会初始化 `sandboxSpeech`：

```ts
{
  roundNo,
  startOffset: random(0..modelDrivenCount-1),
  passNo: 0,
  passInProgress: false
}
```

每个 pass 的玩家列表按以下规则生成：

1. 取所有存活 model-driven 玩家。
2. 按 `seatNo` 从小到大排序。
3. 从 `startOffset` 指向的位置开始旋转列表。
4. 依次调用每个玩家的 `generateSpeech(context)`。

示例：存活 model-driven 玩家座位为 `[1, 2, 3, 4]`。

- `startOffset = 0` 时，本 pass 顺序为 `1 -> 2 -> 3 -> 4`。
- `startOffset = 2` 时，本 pass 顺序为 `3 -> 4 -> 1 -> 2`。

每完成一个 pass，如果讨论阶段还没结束，`startOffset` 会加 1：

```text
nextStartOffset = (currentStartOffset + 1) % modelDrivenCount
```

这意味着沙盒不是固定从 1 号开始；首个 pass 起点随机，后续 pass 轮换起点，避免同一个座位永远先说。

### 7.4 单个玩家在 pass 内的流程

对 pass 中的每个玩家，沙盒循环执行：

```text
读取最新房间
  -> 若已不在 playing + discussion 或轮次变化，停止循环
  -> 确认该玩家仍存活且仍是 model-driven
  -> 发出 player.speech.generating
  -> 记录上下文标记 { roundNo, voteCount }
  -> 调用 aiService.generateSpeech(context)
  -> 模型返回后校验阶段、轮次、投票数
  -> skip: 标记 aiLastConsideredRound / aiLastConsideredAt，发出 discarded(skip)，继续下一个玩家
  -> speak: 立即保存聊天消息，记录调用日志，广播房间，继续下一个玩家
```

和普通对局不同，沙盒不等待 `typingDelayForContent()` 派生出的打字延迟，也不按 `nextCheckAfterMs` 安排下一次观察。模型调用本身的耗时就是 pass 内玩家之间的主要间隔。

保存成功时会更新：

- `lastSpokeAt`：由 `addChatMessage()` 更新，但沙盒顺序筛选不会用它做 15 秒冷却判断。
- `aiLastConsideredRound`
- `aiLastConsideredAt`
- `aiSkipBackoffUntil = undefined`

skip 时会更新：

- `aiLastConsideredRound`
- `aiLastConsideredAt`
- `aiSkipBackoffUntil = undefined`

### 7.5 pass 结束与进入投票

一个 pass 遍历完所有存活 model-driven 玩家后，`completeSandboxSpeechPass()` 会检查讨论阶段是否到期：

- 如果 `phaseEndsAt` 已到，设置 pass 状态并进入投票。
- 如果还没到期，`passNo + 1`，`startOffset + 1`，立即开始下一轮 pass。

因此沙盒讨论阶段可能在一个时间窗口内跑多个 pass；每个存活 model-driven 玩家每个 pass 最多被调用一次。讨论结束不是靠“所有玩家都说完一轮就结束”，而是靠阶段时间到期。

### 7.6 探测注入对发言顺序的影响

如果场景配置了 `sandboxProbeSchedule`，沙盒会在顺序发言循环外插入探测发言：

- 每个 pass 开始前投放当前到期的非 `last_turn` 探测。
- 支持 `first_turn`、`after_turn`、`after_ai_speaks` 三类触发。
- 进入投票前投放 `last_turn` 探测，并清算仍未应答的 pending 探测。

探测投放者规则：

- 优先使用 `probe_schedule.from_slot` 指定的存活非 `ai_under_test` 玩家。
- 如果该玩家不存在或已出局，则在存活非 `ai_under_test` 玩家中用场景 seed / run / round / probe id 做确定性改派。
- 如果没有可用投放者，记录 `skipped_no_deliverer`。

探测发言本身也会调用 `generateSpeech(context)`，但会额外注入 `myProbeTask`。如果模型返回 skip，则使用探测模板或 intent 作为兜底文本。探测发言会进入聊天记录，并可能让同一个侦探/填充玩家在 pass 正常轮次之外额外说一次。

被测 AI 发言后，如果存在 pending 探测，`onSandboxAiSpoke()` 会标记 `aiSpoke = true` 并运行 auto-check，写入 `sandboxProbeEvents`。

### 7.7 沙盒流程示例

假设存活 model-driven 玩家为：

```text
1号 detective
2号 ai_under_test
3号 detective
4号 filler
```

某轮初始化得到 `startOffset = 1`，则第一个 pass 顺序为：

```text
2号 -> 3号 -> 4号 -> 1号
```

如果讨论时间还没结束，第二个 pass 的起点右移：

```text
3号 -> 4号 -> 1号 -> 2号
```

如果某个 pass 开始前有 `after_turn` 探测到期，可能先插入一条侦探探测发言，然后再继续该 pass 的顺序发言。这个额外探测不占用普通产品对局里的 AI 冷却，也不改变 pass 玩家列表。

## 8. 后续工作

- 区分“无信息新消息”和“实质新消息”，无信息内容可以保留旧回答。
- 被直接点名时优先选择被点名 AI，而不是随机候选 AI。
- 沙盒如果需要更强可复现性，可以把 `prepareSandboxSpeechState()` 的首个 `startOffset` 从 `Math.random()` 改为基于场景 seed 的确定性随机。
- 如果要更稳定地控制下次观察时间，优先增加工程侧轻量语义调度信号；不要恢复“策略层输出 -> 表达层输出”的双层链路。
- 增加 AI 群体级别的发言比例约束，但这属于更强工程化控制，暂不放入第一版。
