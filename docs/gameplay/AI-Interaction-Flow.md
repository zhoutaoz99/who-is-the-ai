# AI 交互流程

> 本文记录**普通对局**中 AI 玩家的发言、投票交互流程，以及 Prompt 结构与模型调用约定。
> 相关文档:
> - 拟人化迭代记录见 [`AI-Human-Likeness.md`](../ai-iteration/AI-Human-Likeness.md)。
> - 发言调度的设计动机与策略层输出见 [`AI-Scheduling.md`](AI-Scheduling.md)。
> - 提示词缓存优化见 [`AI-Prompt-Cache-Optimization.md`](AI-Prompt-Cache-Optimization.md)。
> - 调试用的「AI 自动对抗」全流程(含模拟真人、快速/普通调度)见 [`AI-Auto-Adversarial-Match.md`](../ai-iteration/AI-Auto-Adversarial-Match.md),本文不展开。

## 架构概览

```
GameService (apps/api/src/game/game.service.ts)
  ├─ startAiSpeech()      → AiService.generateSpeech() → LLM API
  └─ scheduleAiVotes()    → AiService.generateVote()    → LLM API
```

AI 组件:

- `AiModule` (`ai.module.ts`) — NestJS 模块(已 `@Global`)。
- `AiService` (`ai.service.ts`) — LLM 调用、Prompt 构建、输出解析、缓存拆分。
- `ai.types.ts` — 类型定义(`GameContext`、`SpeechStrategy` 等)。
- `ai.personas.ts` — AI 人格库(`active_icebreaker` 等 8 个人格)。

对局 AI 模型由根目录 `ai-models.json` 配置,复盘/打分使用独立的 `REPLAY_ANALYSIS_*` 配置。

---

## 一、发言流程

### 触发机制

讨论阶段开始后,`afterDiscussionStarted` 会启动 AI 发言调度器 `startAiSpeech(room)`。普通对局中它只调度 `type === "ai"` 的玩家;模拟真人(`simulated === true`)走另一个独立调度器(详见 [`AI-Auto-Adversarial-Match.md`](../ai-iteration/AI-Auto-Adversarial-Match.md))。

调度器保持**房间级串行**:同一调度器同一时间只允许一个 AI 进入发言决策,避免多个 AI 基于同一上下文同时生成。调度器使用 AI 决策返回的 `nextCheckAfterMs` 递归调度,首次检查默认 `AI_SPEECH_INITIAL_CHECK_MS = 10s`:

```
startModelSpeech(room, schedulerKind, initialDelayMs):
  ├─ 按当前 delay 创建一个 setTimeout
  ├─ 触发后重新读取房间
  ├─ 房间不存在或阶段不是 discussion → 本调度器停止
  ├─ 本调度器已有模型调用进行中 → 等待 AI_SPEECH_NEXT_CHECK_MIN_MS 后重新观察
  ├─ selectSpeechPlayer(room, schedulerKind) 选一个候选 AI
  ├─ 无候选 → 等待 AI_SPEECH_NEXT_CHECK_MIN_MS 后重新观察
  ├─ 记录上下文标记 { roundNo, voteCount }
  ├─ 设置 speaking 锁 = true
  ├─ await aiService.generateSpeech(context)
  ├─ 模型返回后重新读取房间;轮次/阶段/投票数变化 → 丢弃,随机短延迟后重新观察
  ├─ speak → 按 targetResponseDelayMs - 模型耗时 等待剩余时间,保存前再次校验
  ├─ skip → 进入 skip backoff
  └─ finally: 释放 speaking 锁 → 按 nextCheckAfterMs 安排下一次观察
```

> 上下文失效判断(普通模式)只看 `{ roundNo, voteCount }` 两个字段。其他玩家在模型调用期间新增聊天消息**不会**让本次发言失效——只有轮次变化或投票数变化才丢弃。这是为避免 AI 与模拟真人两个调度器互相独立后大量调用被聊天变化误杀。

### 候选 AI 选择(fairness)

候选 AI 不再纯随机,而是用「公平优先级 + 同级随机」:

```
selectSpeechPlayer(room, schedulerKind):
  ├─ 候选 = 存活 AI 且属于本调度器
  │   ├─ 已过 SPEAK_COOLDOWN_MS(15s) 发言冷却
  │   └─ 当前不在 aiSkipBackoffUntil 退避期
  ├─ 优先 1: 本轮未发言 且 本轮未被考虑过
  ├─ 优先 2: 本轮未发言
  ├─ 优先 3: 本轮未被考虑过
  └─ 兜底: 所有候选(同级内随机)
```

每个优先级内部仍随机选择,避免形成固定座位号轮询。

AI 玩家内部调度字段:

| 字段 | 说明 |
|------|------|
| `aiLastConsideredRound` | 最近一次进入发言决策的轮次 |
| `aiLastConsideredAt` | 最近一次进入发言决策的时间戳 |
| `aiSkipBackoffUntil` | skip 后的短退避截止时间 |

### skip 与 backoff

被选中后返回 `skip`:

```
markAiSpeechSkipped():
  ├─ 标记 aiLastConsideredRound = 当前轮
  ├─ 标记 aiLastConsideredAt = Date.now()
  └─ 设置 aiSkipBackoffUntil = Date.now() + AI_SPEECH_SKIP_BACKOFF_MS(8s)
```

这样可以避免同一个保守 AI 连续被抽中并连续 skip,让其他 AI 更容易获得发言机会。

成功发言后(`addChatMessage`):

```
├─ 写入聊天消息
├─ 更新 lastSpokeAt(15s 发言冷却依据)
├─ 标记 aiLastConsideredRound / aiLastConsideredAt
├─ 清除 aiSkipBackoffUntil
└─ 广播房间快照
```

新一轮讨论开始时会清除 AI 的 skip backoff,避免上一轮末尾的 skip 影响下一轮开场。

### generateSpeech 流程(双层)

AI 发言采用**策略层 + 表达层**两次模型调用:

```
generateSpeech(context):
  ├─ 未配置 API Key → return { type: "skip", nextCheckAfterMs }
  ├─ buildSpeechStrategyPrompt(context) → 拼装策略层 Prompt
  ├─ callModel(strategySystem, strategyUser, speechStrategyConfig) → 生成结构化发言策略
  ├─ parseSpeechStrategyResult(raw)
  │   ├─ skip: { reason, nextCheckAfterMs }
  │   └─ speak: { targetResponseDelayMs, nextCheckAfterMs, strategy }
  ├─ buildSpeechExpressionPrompt(context, strategy) → 拼装表达转换 Prompt
  ├─ callModel(expressionSystem, expressionUser, speechExpressionConfig) → 生成最终发言
  ├─ parseSpeechResult(raw)
  │   ├─ 成功: { type: "speak", content, targetResponseDelayMs, nextCheckAfterMs }
  │   └─ 失败: { type: "skip", nextCheckAfterMs }
  └─ 异常: return { type: "skip", nextCheckAfterMs }
```

- **策略层**决定「现在是否发言、目标反应时间、下次观察时间、结构化策略」。
- **表达层**把结构化策略改写成最终玩家发言,并隐藏策略层内部信息。

---

## 二、投票流程

### 触发机制

`scheduleAiVotes()` 在投票阶段开始时调用,每个存活 AI 在**错开延迟**后触发:

```
aiPlayers.forEach(aiPlayer, index):
  setTimeout(AI_VOTE_DELAY_MS + index * AI_VOTE_STAGGER_MS)ms 后:
    ├─ 阶段不是 voting → 跳过
    ├─ buildGameContext(room, aiPlayer)
    ├─ await aiService.generateVote(context, aiPlayerId)
    ├─ 成功: castVoteForPlayer(room, aiPlayer, target.id, { voteSource: "model" })
    └─ 失败/null: chooseFallbackVoteTarget() → 兜底
```

投票为**同时盲投**:投票阶段看不到其他玩家当前投票,结果只在本轮投票结束后公开。`GameContext` 中虽然计算了 `currentVoteCounts`,但投票 user 模板把「当前投票情况」固定渲染为「同时盲投,投票阶段看不到其他玩家当前投票」,模型看不到实时票型。

### generateVote 流程

```
generateVote(context, aiPlayerId):
  ├─ 未配置 API Key → return null
  ├─ buildVotePrompt(context, aiPlayerId)
  ├─ callModel(systemPrompt, userPrompt) → POST /chat/completions
  ├─ parseVoteResult(raw, context)
  │   ├─ 成功且 targetPlayerId 合法: { type: "vote", targetPlayerId, reason }
  │   └─ 失败: null
  └─ 异常: return null
```

### 兜底投票

模型投票失败时进入 `chooseFallbackVoteTarget`:

- **AI 玩家**:优先投存活 human 阵营玩家;没有则投其他存活玩家;都没有则 `null`。
- **模拟真人**:不偷看隐藏身份,优先参考本轮已记录票数中最高票的非自己存活玩家;无趋势则随机投非自己存活玩家(详见 [`AI-Auto-Adversarial-Match.md`](../ai-iteration/AI-Auto-Adversarial-Match.md))。

### 投票与淘汰判定

- 每轮投票结束后,`resolveElimination` 统计本轮票数,得票最多的存活玩家出局。
- **平票**(`isTie`):本轮**无人出局**。
- **无人投票**(`votes.length === 0`,含全体超时未投):同样**无人出局**。

---

## 三、GameContext 上下文构建

`buildGameContext(room, aiPlayer)` 为每次 LLM 调用组装输入:

| 字段 | 说明 |
|------|------|
| `roomId` | 房间 ID |
| `roundNo` | 当前轮次 |
| `phase` | 当前阶段(discussion / voting) |
| `remainingTimeMs` | 剩余时间(毫秒) |
| `myPlayerId` / `myName` / `mySeatNo` | AI 自己的玩家 ID、昵称、座位号 |
| `myPlayerType` | `"ai"` 或 `"human"`(模拟真人为 `human`) |
| `mySimulated` | 是否模拟真人 |
| `myModelId` | 该玩家使用的模型条目 ID |
| `myPersona` | AI 的局内说话人格(仅 `type === "ai"`,模拟真人为 `null`) |
| `alivePlayers` | 存活玩家列表(仅 `{ id, seatNo }`,**不含昵称**) |
| `recentMessages` | **当前轮全部**公开聊天,统一用「X号位:内容」公共视角(不用「你」),全量不截断 |
| `historicalMessages` | 历史轮次聊天(按轮分组,同样用公共视角) |
| `myLastSpeech` | 自己最近一次发言内容 |
| `currentVoteCounts` | 当前轮次投票统计(投票模板中渲染为「同时盲投」) |
| `voteHistory` | 历史每轮投票方向与淘汰结果(`{ roundNo, votes[{voterSeatNo,targetSeatNo}], eliminatedSeatNo }`) |
| `shortMemory` | 自己的投票短期记忆(`room.aiMemories[myPlayerId]`,不进公开快照) |

**隐私规则**:AI 只能看到自己的昵称,其他玩家一律以座位号「X号位」显示。`recentMessages` 用全量当前轮 + 公共视角是为了让同一段聊天对不同 AI 玩家是相同文本,利于跨玩家缓存复用(见 [`AI-Prompt-Cache-Optimization.md`](AI-Prompt-Cache-Optimization.md))。

**短期记忆**:仅记录自己的历史投票目标和可公开理由,最多保留最近 4 条,只给自己看。详见 [`AI-Human-Likeness.md`](../ai-iteration/AI-Human-Likeness.md) 的「投票短期记忆」。

---

## 四、AI 人格

AI 人格库在 `apps/api/src/ai/ai.personas.ts`,当前 8 个:

| ID | 名称 | 行为摘要 |
|----|------|----------|
| `active_icebreaker` | 热心话痨型 | 话多、自来熟,冷场时先开口 |
| `lazy_floater` | 划水摸鱼型 | 话少、敷衍,不主动 |
| `snarky_joker` | 贫嘴玩笑型 | 爱玩梗、吐槽 |
| `blunt_grumpy` | 暴躁直球型 | 冲、直接、不耐烦 |
| `emoji_fan` | 表情语气型 | 常用语气词、表情化表达 |
| `shy_quiet` | 社恐慢热型 | 慢热、惜字,被点名才多说半句 |
| `serious_analyst` | 认真分析型 | 偏逻辑、爱推理 |
| `contrarian` | 杠精抬杠型 | 爱唱反调、抬杠 |

人格结构(迭代后含 `typingHabit`、`sampleLines`):

```ts
type AiPersona = {
  id: string;
  name: string;
  speechStyle: string;
  sentenceStyle: string;
  responseBias: string;
  toneRules: string[];
  avoidPhrases: string[];
  typingHabit?: string;   // 打字习惯(可选)
  sampleLines?: string[]; // 语感参考片段(表达层禁止照抄,见 AI-Human-Likeness.md)
};
```

- 创建 AI 玩家时随机分配一个 `aiPersonaId`;`active_icebreaker` 是破冰调度依赖的特殊人格。
- 构建 `GameContext` 时把 `myPersona` 解析成完整 persona,注入发言策略、表达转换和投票 prompt。
- 人格库随 AI 提示词 DB 版本库一起迭代(可变 active 集),详见 [`AI-Prompt-Eval-Details.md`](../ai-iteration/AI-Prompt-Eval-Details.md)。
- 人格迭代记录与拟人化优化见 [`AI-Human-Likeness.md`](../ai-iteration/AI-Human-Likeness.md)。

---

## 五、Prompt 结构

提示词文件已按玩家阵营拆分为 `ai-player/` 与 `sim-human/` 两个子目录(`apps/api/src/ai/prompts/`)。下面以 **AI 玩家**(`ai-player/*`)为例。

### 发言策略层 System(`system-speech-strategy.txt`)

决定本次是否发言,以及若发言给表达层一份结构化策略。输出 JSON:

```json
{"type":"speak","targetResponseDelayMs":2500,"nextCheckAfterMs":10000,"strategy":{"replyTo":"接哪句话或无","speechAct":"发言动作","publicPoint":"可公开表达的单个观点","tone":"语气和力度","maxSentences":2,"constraints":["表达限制"],"avoidPhrases":["禁用话术"]}}
```

或:

```json
{"type":"skip","reason":"跳过原因","nextCheckAfterMs":12000}
```

`speechAct` 含非分析型动作(闲聊/玩笑/吐槽/附和/敷衍/跑题),`publicPoint` 允许是口语化临场反应。

### 表达转换层 System(`system-speech-expression.txt`)

把策略层输出改写成最终玩家发言,隐藏策略层信息。要求像真人那样打字(中度):默认 1-2 句、长度随情境波动(上限 `MESSAGE_LIMIT = 240`),允许反问、省略、口头禅;避免报告/总结/主持口吻和模板话术;不刻意造错别字。

输出:

```json
{"type":"speak","content":"最终发言内容"}
```

### 投票 System(`system-vote.txt`)

投票为同时盲投。AI 不知道队友是谁,策略上优先投「最积极抓 AI、最主导讨论」的真人,避免因话少投到队友(详见 [`AI-Human-Likeness.md`](../ai-iteration/AI-Human-Likeness.md) 迭代 3 的 B3)。输出:

```json
{"type":"vote","targetPlayerId":"玩家ID","reason":"投票理由"}
```

### User 模板与缓存分层

User 模板用 `<<CACHE_SPLIT>>` 标记划分缓存层级(固定说明 → 身份+人格 → 历史/记忆/最近聊天 → 可投票目标等高频字段)。标记在发送前被移除,不进模型。完整分层见 [`AI-Prompt-Cache-Optimization.md`](AI-Prompt-Cache-Optimization.md)。注入变量含 `{{myPersonaInfo}}`、`{{historicalMessages}}`、`{{recentMessages}}`、`{{voteHistory}}`、`{{shortMemory}}`、`{{voteTargets}}` 等。

---

## 六、API 调用

### 请求格式

对局 AI 模型由根目录 `ai-models.json` 配置,每个条目的 `format` 决定请求协议:

- 不填 `format` 或 `"openai"`:OpenAI-compatible `chat/completions`。
- `"claude"`:原生 Claude Messages API,并启用显式多层 `cache_control`(见缓存文档)。

#### OpenAI-compatible

```
POST {baseURL}/chat/completions
Headers:
  Content-Type: application/json
  Authorization: Bearer {apiKey}
Body:
{
  "model": "gpt-4o-mini",
  "temperature": 0.7,
  "messages": [
    { "role": "system", "content": "system prompt" },
    { "role": "user", "content": "user prompt" }
  ],
  "thinking": { "type": "enabled" },
  "reasoning_effort": "high"
}
```

#### Claude Messages API

Claude 条目的 `baseURL` 配置为不带 `/v1` 的根地址,服务端调用时拼接 `/v1/messages`;若配置误带 `/v1`,加载时自动去掉。

```
POST {baseURL}/v1/messages
Headers:
  Content-Type: application/json
  x-api-key: {apiKey}
  anthropic-version: 2023-06-01
Body:
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 1024,
  "temperature": 0.7,
  "system": [ { "type": "text", "text": "system prompt" } ],
  "messages": [ { "role": "user", "content": [ ...带 cache_control 的分层 block ] } ]
}
```

Claude 响应从 `content[]` 的 text block 拼接文本,并把 `usage`(含 `cache_creation_input_tokens` / `cache_read_input_tokens`)映射到统一日志。

### 配置(`ai-models.json`)

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `format` | 请求格式:`openai` 或 `claude` | `openai` |
| `baseURL` | API 根地址;Claude 格式不写 `/v1` | 必填 |
| `apiKey` | API Key | 必填 |
| `model` | 主模型名称 | 必填 |
| `temperature` | 温度 | `0.7` |
| `reasoningEffort` | OpenAI-compatible 推理强度 | `high` |
| `thinking` | OpenAI-compatible thinking 开关 | 默认发送 |
| `maxTokens` | Claude `max_tokens` | `1024` |
| `timeoutMs` | 超时(毫秒) | `15000` |

`expression` 可覆盖表达层的 `model`、`temperature`、`reasoningEffort`、`thinking`、`maxTokens`;未配置时继承主模型条目。

### 游戏内 AI 调度常量(`game.config.ts`)

| 常量 | 说明 | 默认值 |
|------|------|--------|
| `AI_PLAYER_COUNT` | 普通对局自动补齐的 AI 数量 | `2` |
| `MAX_HUMAN_PLAYERS` | 真人玩家上限 | `5` |
| `MAX_ROUNDS` | 最大轮数 | `4` |
| `DEFAULT_DISCUSSION_DURATION_MS` | 单轮讨论时长(可被 `ROUND_DURATION_MS` 覆盖) | `300_000`(5 分钟) |
| `MIN_DISCUSSION_DURATION_MS` | 单轮讨论最短时长 | `60_000` |
| `VOTE_DURATION_MS` | 投票阶段时长 | `60_000` |
| `SPEAK_COOLDOWN_MS` | 单个玩家发言冷却 | `15_000` |
| `MESSAGE_LIMIT` | 单条发言字符上限(对 AI 与真人一致) | `240` |
| `DISCONNECT_GRACE_MS` | 掉线宽限期 | `30_000` |
| `AI_SPEECH_INITIAL_CHECK_MS` | 讨论开始后首次 AI 检查延迟 | `10_000` |
| `AI_SPEECH_NEXT_CHECK_MIN_MS` / `_MAX_MS` | 下一次 AI 检查延迟区间 | `1_000` / `30_000` |
| `AI_SPEECH_RESPONSE_DELAY_MIN_MS` / `_MAX_MS` | 表现反应时间区间 | `800` / `20_000` |
| `AI_SPEECH_STALE_RETRY_MIN_MS` / `_MAX_MS` | 上下文失效后重试延迟区间 | `500` / `1_500` |
| `AI_SPEECH_SKIP_BACKOFF_MS` | AI 返回 skip 后的退避 | `8_000` |
| `AI_VOTE_DELAY_MS` | 投票阶段首个 AI 投票延迟 | `1_500` |
| `AI_VOTE_STAGGER_MS` | 多个 AI 投票错开间隔 | `1_200` |

模拟真人(`sim-human`)有一套独立的调度常量(`SIM_HUMAN_SPEECH_COOLDOWN_MS = 8_000` 等),详见 [`AI-Auto-Adversarial-Match.md`](../ai-iteration/AI-Auto-Adversarial-Match.md)。

### 超时处理

- 按模型条目的 `timeoutMs` 配置超时(默认 15s,`AbortController`)。
- 超时 → 发言 skip,投票走兜底逻辑。

---

## 七、JSON 解析策略

`extractJson(text)` 按以下顺序尝试:

1. 直接 `JSON.parse(text.trim())`
2. 提取 markdown 代码块中的 JSON(``` ```json ... ``` ```)
3. 匹配文本中的第一个 `{...}` 对象

三种都失败 → 发言 skip / 投票返回 `null`。发言内容保存前自动截断到 `MESSAGE_LIMIT = 240` 字符。

---

## 八、调试与自动对抗

调试环境(`DEBUG=true`)下的「AI 自动对抗调试房」(AI 玩家 vs 模拟真人玩家)是实现上述评估闭环与批量复盘的基础。其房间建模、模拟真人强度(`normal`/`high`)、快速/普通两套发言调度、投票兜底与前端展示**全部在** [`AI-Auto-Adversarial-Match.md`](../ai-iteration/AI-Auto-Adversarial-Match.md) 中详述,本文不再重复。
