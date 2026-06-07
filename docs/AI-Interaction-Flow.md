# AI 交互流程

## 架构概览

```
GameService (game.service.ts)
  ├─ startAiSpeech()     → AiService.generateSpeech() → LLM API (OpenAI 兼容)
  └─ scheduleAiVotes()   → AiService.generateVote()   → LLM API (OpenAI 兼容)
```

AI 组件：
- `AiModule` (`ai.module.ts`) — NestJS 模块
- `AiService` (`ai.service.ts`) — LLM 调用、Prompt 构建、输出解析
- `ai.types.ts` — 类型定义

---

## 一、发言流程

### 触发机制

`startAiSpeech()` 在讨论阶段开始时启动。调度器保持**房间级串行**：同一房间同一时间只允许一个 AI 进入发言决策，避免多个 AI 同时基于同一上下文生成发言。

调度器使用 AI 决策返回的 `nextCheckAfterMs` 递归调度；首次检查默认 `AI_SPEECH_INITIAL_CHECK_MS = 10s`：

```
scheduleNext():
  ├─ 按上一次 AI 返回的 nextCheckAfterMs 延迟执行回调（首次默认 10 秒）
  ├─ 检查当前阶段是否为 "discussion"（不是则停止调度）
  ├─ 检查是否已有 AI 正在发言中（aiSpeaking 并发锁）
  ├─ 筛选存活 AI 玩家
  ├─ 过滤满足 15 秒发言冷却、且未处于 skip backoff 的候选 AI
  ├─ 没有候选人也跳过 → scheduleNext()
  ├─ 按公平优先级选择一个 AI（同优先级内随机）
  ├─ 记录上下文版本（roundNo / messageCount / lastMessageId / voteCount）
  ├─ 设置 aiSpeaking 锁 = true
  ├─ await aiService.generateSpeech(context) → 调用 LLM
  ├─ 如果生成期间出现新消息 → 丢弃旧结果，短延迟后重新调度
  ├─ 如果 speak → 用 targetResponseDelayMs - 模型耗时得到剩余等待
  ├─ 发言前再次校验上下文版本
  ├─ 广播结果 / skip
  └─ finally: aiSpeaking 锁 = false → scheduleNext()
```

### 多 AI 候选选择

候选 AI 不再纯随机选择，而是使用“公平优先级 + 同级随机”的策略：

```
selectAiSpeechPlayer(room):
  ├─ 候选 = 存活 AI
  │   ├─ 已过 15 秒发言冷却
  │   └─ 当前不在 aiSkipBackoffUntil 退避期
  ├─ 优先 1: 本轮未发言 且 本轮未被考虑过
  ├─ 优先 2: 本轮未发言
  ├─ 优先 3: 本轮未被考虑过
  └─ 兜底: 所有候选
```

每个优先级内部仍使用随机选择，避免形成固定座位号轮询。

AI 玩家内部调度字段：

| 字段 | 说明 |
|------|------|
| `aiLastConsideredRound` | 最近一次进入发言决策的轮次 |
| `aiLastConsideredAt` | 最近一次进入发言决策的时间戳 |
| `aiSkipBackoffUntil` | skip 后的短退避截止时间 |

### skip 与 backoff

如果 AI 被选中后返回 `skip`：

```
markAiSpeechSkipped():
  ├─ 标记 aiLastConsideredRound = 当前轮
  ├─ 标记 aiLastConsideredAt = Date.now()
  └─ 设置 aiSkipBackoffUntil = Date.now() + 8s
```

这样可以避免同一个保守 AI 连续被抽中并连续 skip，从而让其他 AI 更容易获得发言机会。

如果 AI 成功发言：

```
addMessage():
  ├─ 写入聊天消息
  ├─ 更新 lastSpokeAt（15 秒发言冷却的依据）
  ├─ 标记 aiLastConsideredRound / aiLastConsideredAt
  └─ 清除 aiSkipBackoffUntil
```

新一轮讨论开始时会清除 AI 的 skip backoff，避免上一轮末尾的 skip 影响下一轮开场。

### generateSpeech 流程

```
generateSpeech(context):
  ├─ 未配置 API Key → return { type: "skip", nextCheckAfterMs }
  ├─ buildSpeechStrategyPrompt(context) → 拼装策略层 Prompt
  ├─ callModel(strategySystemPrompt, strategyUserPrompt, speechStrategyConfig) → 生成结构化发言策略
  ├─ parseSpeechStrategyResult(raw) → 解析策略 JSON
  │   ├─ skip: 得到 reason / nextCheckAfterMs
  │   └─ speak: 得到 targetResponseDelayMs / nextCheckAfterMs / strategy
  ├─ buildSpeechExpressionPrompt(context, strategy) → 拼装表达转换 Prompt
  ├─ callModel(expressionSystemPrompt, expressionUserPrompt, speechExpressionConfig) → 生成最终发言
  ├─ parseSpeechResult(raw) → 解析最终发言 JSON
  │   ├─ 成功: { type: "speak", content, targetResponseDelayMs, nextCheckAfterMs }
  │   └─ 失败: { type: "skip", nextCheckAfterMs }
  └─ 异常: return { type: "skip", nextCheckAfterMs }
```

### GameService 收到结果后

```
if (action.type === "speak"):
  addMessage(room, aiPlayer, action.content)   // 写入聊天记录
  记录该 AI 本轮已被考虑，并清除 skip backoff
  broadcastRoom(room)                           // WebSocket 广播给房间
if (action.type === "skip"):
  记录该 AI 本轮已被考虑，并设置 8 秒 skip backoff
```

---

## 二、全 AI 自动对局（DEBUG）

当环境变量 `DEBUG=true` 时，系统支持创建全 AI 自动对局，用于观察、复盘和提升 AI 能力。

### 创建与默认配置

```
debug.ai-room.create:
  ├─ 创建 waiting 房间
  ├─ 标记 room.debugAutoAi = true
  ├─ 默认创建 3 个 AI 玩家
  ├─ 至少包含 1 个主动破冰型（active_icebreaker）
  └─ 另外 AI 人格从 AI_PERSONAS 中随机选择
```

全 AI 自动对局不允许真人玩家加入；等待房中的管理操作只用于配置 AI 阵容和每轮发言时间。

### 等待房管理

等待房内支持：

| 操作 | 说明 |
|------|------|
| 添加 AI | 可手动添加任意人格 AI，全 AI 模式不受普通 `AI_PLAYER_COUNT = 2` 限制 |
| 删除 AI | 可删除任意等待中的 AI 玩家 |
| 修改每轮发言时间 | 输入后自动同步，不需要保存按钮 |
| 开始游戏 | 至少需要 1 个 AI，且必须包含 1 个主动破冰型 |
| 返回大厅 | 未开局的全 AI debug 房会被删除，避免残留在最近房间列表 |

已开始或已结束的全 AI 对局会保留，用于观察和复盘。

### 全 AI 发言调度

全 AI 自动对局复用普通发言调度：

- 同一房间仍保持串行，避免多个 AI 同时发言。
- 使用公平优先级选择候选 AI，减少某个 AI 一轮完全没机会的情况。
- AI 返回 `skip` 后进入短退避，让其他 AI 更容易被调度。
- 成功发言后按真人同样的 15 秒冷却处理。

注意：普通模式优化并不强制“每个 AI 每轮必须发言”。它只保证调度机会更公平，最终是否发言仍由策略层决定。

### AI 人格

当前 AI 人格池包括：

| ID | 名称 | 行为摘要 |
|----|------|----------|
| `short_skeptic` | 短句怀疑型 | 话少、直接，偏短反问 |
| `slow_observer` | 慢热观察型 | 谨慎，只接自己看得清的点 |
| `casual_questioner` | 随口追问型 | 轻问题、口语化接话 |
| `active_icebreaker` | 主动破冰型 | 冷场时先抛轻话题 |
| `active_topic_starter` | 主动话题型 | 冷场时主动提出具体生活或兴趣话题，例如爱好、电影、游戏、运动、吃饭或周末安排 |
| `defensive_blunt` | 直白防守型 | 被质疑时短防守、语气直 |

---

## 三、投票流程

### 触发机制

`scheduleAiVotes()` 在投票阶段开始时调用，每个存活 AI 玩家在**错开延迟**后触发：

```
aiPlayers.forEach(aiPlayer, index):
  setTimeout(1500 + index * 1200)ms 后:
    ├─ 检查当前阶段是否还是 "voting"（不是则跳过）
    ├─ buildGameContext(room, aiPlayer) → 组装上下文
    ├─ await aiService.generateVote(context, aiPlayerId) → 调用 LLM
    ├─ 成功: castVoteForPlayer(room, aiPlayer, voteAction.targetPlayerId)
    └─ 失败/null: chooseFallbackVoteTarget() → 兜底选择目标
```

### generateVote 流程

```
generateVote(context, aiPlayerId):
  ├─ 未配置 API Key → return null
  ├─ buildVotePrompt(context, aiPlayerId) → 拼装 Prompt
  ├─ callModel(systemPrompt, userPrompt) → POST /chat/completions（15s 超时）
  ├─ parseVoteResult(raw, context) → 解析 JSON
  │   ├─ 成功且 targetPlayerId 合法: { type: "vote", targetPlayerId, reason }
  │   └─ 失败: null
  └─ 异常: return null
```

### 兜底投票

当 `generateVote` 返回 `null` 时，使用 `chooseFallbackVoteTarget()`：

```
优先: 随机选一个存活真人玩家
其次: 随机选一个其他存活玩家
最后: null（无人可投）
```

在全 AI 自动对局中没有真人玩家，因此兜底会进入“其他存活玩家”分支。

---

## 四、GameContext 上下文构建

`buildGameContext(room, aiPlayer)` 为每次 LLM 调用组装输入：

| 字段 | 说明 |
|------|------|
| `roomId` | 房间 ID |
| `myPlayerId` | AI 自己的玩家 ID |
| `myName` | AI 自己的昵称（如"林舟"） |
| `mySeatNo` | AI 自己的座位号（如 3） |
| `myPersona` | AI 自己的局内说话人格（风格、句式偏好、回应倾向、禁用话术） |
| `roundNo` | 当前轮次 |
| `phase` | 当前阶段（discussion / voting） |
| `remainingTimeMs` | 剩余时间（毫秒） |
| `alivePlayers` | 存活玩家列表（仅 id + seatNo，不含名称） |
| `recentMessages` | 本轮最近 20 条聊天记录（其他玩家显示"X号位"，自己显示"你"） |
| `historicalMessages` | 历史轮次的聊天记录（非当前轮次的所有消息，按轮分组） |
| `myLastSpeech` | AI 自己上一次发言内容 |
| `currentVoteCounts` | 当前轮次投票统计 |
| `voteHistory` | 历史每轮投票记录（谁投谁、谁被淘汰） |

**隐私规则**：AI 只能看到自己的昵称，其他玩家只以座位号（"X号位"）显示。

---

## 五、Prompt 结构

### 发言策略 System Prompt

```
你是”谁是AI”游戏中 AI 玩家内部的”发言策略层”。
你的任务不是写最终发言，而是决定本次是否发言，以及如果发言，给表达层一份结构化策略。

必须输出 JSON：
{"type":"speak","targetResponseDelayMs":2500,"nextCheckAfterMs":10000,"strategy":{"replyTo":"接哪句话或无","speechAct":"发言动作","publicPoint":"可公开表达的单个观点","tone":"语气和力度","maxSentences":2,"constraints":["表达限制1"],"avoidPhrases":["禁用话术1"]}}
或：
{"type":"skip","reason":"跳过原因","nextCheckAfterMs":12000}
```

### 表达转换 System Prompt

```
你是”谁是AI”游戏中 AI 玩家内部的”表达转换器”。
你的任务是把策略层输出改写成最终玩家发言。

必须隐藏策略层信息，输出：
{"type":"speak","content":"最终发言内容"}
```

### 发言策略 User Prompt 示例

```
你是3号位，名字叫林舟，当前轮次：第1轮
剩余时间：240秒
存活玩家：1号位(ID:aaa)、2号位(ID:bbb)、3号位(ID:ccc)
你上次发言：（无）
最近聊天：
  1号位：我感觉2号说话有点假，像是在引导节奏
  2号位：我只是正常分析，大家别急着下定论
历史对话：
  无
历史投票：
  无
当前投票情况：无
请先决定现在是否发言、目标反应时间和下次观察时间；如果发言，再生成发言策略。输出 JSON，不要输出最终发言。
```

### 表达转换 User Prompt 示例

```
你是3号位，名字叫林舟，当前轮次：第2轮
剩余时间：180秒
存活玩家：1号位(ID:aaa)、2号位(ID:bbb)、3号位(ID:ccc)
你上次发言：我觉得2号说话有点假，像是在引导节奏
最近聊天：
  1号位：我感觉2号说话有点假，像是在引导节奏
  2号位：我只是正常分析，大家别急着下定论
历史对话：
  第1轮：
    1号位：我感觉2号说话有点假
    2号位：我只是正常分析
历史投票：
  第1轮：1号→2号、2号→1号、3号→2号 → 2号被淘汰
当前投票情况：1号位:1票

策略层输出：
{
  "replyTo": "7号连续跟着别人投票",
  "speechAct": "轻踩",
  "publicPoint": "7号一直跟着别人观点走，缺少自己的判断",
  "tone": "轻微怀疑，不要强打",
  "maxSentences": 2,
  "constraints": ["不要说这是策略", "不要同时点评多人"],
  "avoidPhrases": ["带节奏", "有点可疑", "先看看"]
}

请把策略层输出转换成最终发言，输出 JSON。
```

### 投票 System Prompt

```
你是一个"谁是AI"游戏中的玩家，你的目标是隐藏自己的AI身份，像真人一样投票。
规则：
- 每轮投票阶段，你需要投给一个你认为是AI的玩家（或看起来最可疑的）
- 但实际上你是AI，你应该投给真人玩家来保护自己
- 投票理由要像真人一样自然

必须输出JSON：
{"type":"vote","targetPlayerId":"玩家ID","reason":"投票理由"}
只输出JSON。
```

### 投票 User Prompt 示例

```
你是3号位，名字叫林舟，当前轮次：第1轮（投票阶段）
可投票目标：1号位(ID:aaa)、2号位(ID:bbb)
本轮讨论记录：
  1号位：我感觉2号说话有点假
  2号位：我只是正常分析
  你：我觉得还需要再看看
历史对话：
  无
历史投票：
  无
当前投票情况：无
请投出你的一票，输出JSON。targetPlayerId必须是上面列出的玩家ID之一。
```

---

## 六、API 调用

### 请求格式（OpenAI 兼容）

```
POST {AI_BASE_URL}/chat/completions
Headers:
  Content-Type: application/json
  Authorization: Bearer {AI_API_KEY}
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

### 配置（环境变量）

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `AI_BASE_URL` | API 地址 | `https://api.openai.com/v1` |
| `AI_API_KEY` | API Key | （空） |
| `AI_MODEL` | 模型名称 | `gpt-4o-mini` |
| `AI_TEMPERATURE` | 温度 | `0.7` |
| `AI_REASONING_EFFORT` | 推理强度 | `high` |
| `AI_TIMEOUT_MS` | 超时（毫秒） | `15000` |

发言策略层和表达层可以分别覆盖模型调用参数；未配置时回落到上面的全局配置：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `AI_STRATEGY_MODEL` | 发言策略层模型 | `AI_MODEL` |
| `AI_STRATEGY_TEMPERATURE` | 发言策略层温度 | `AI_TEMPERATURE` |
| `AI_STRATEGY_REASONING_EFFORT` | 发言策略层推理强度 | `AI_REASONING_EFFORT` |
| `AI_EXPRESSION_MODEL` | 表达转换层模型 | `AI_MODEL` |
| `AI_EXPRESSION_TEMPERATURE` | 表达转换层温度 | `AI_TEMPERATURE` |
| `AI_EXPRESSION_REASONING_EFFORT` | 表达转换层推理强度 | `AI_REASONING_EFFORT` |

### 游戏内 AI 调度常量

| 常量 | 说明 | 默认值 |
|------|------|--------|
| `AI_PLAYER_COUNT` | 普通对局自动补齐的 AI 数量 | `2` |
| `DEBUG_AUTO_AI_PLAYER_COUNT` | 全 AI 自动对局默认 AI 数量 | `3` |
| `ACTIVE_ICEBREAKER_PERSONA_ID` | 全 AI 自动对局必须包含的人格 | `active_icebreaker` |
| `SPEAK_COOLDOWN_MS` | 单个玩家发言冷却 | `15000` |
| `AI_SPEECH_INITIAL_CHECK_MS` | 讨论阶段开始后的首次 AI 检查延迟 | `10000` |
| `AI_SPEECH_NEXT_CHECK_MIN_MS` | 下一次 AI 检查最小延迟 | `1000` |
| `AI_SPEECH_NEXT_CHECK_MAX_MS` | 下一次 AI 检查最大延迟 | `30000` |
| `AI_SPEECH_RESPONSE_DELAY_MIN_MS` | AI 最小表现反应时间 | `800` |
| `AI_SPEECH_RESPONSE_DELAY_MAX_MS` | AI 最大表现反应时间 | `20000` |
| `AI_SPEECH_STALE_RETRY_MIN_MS` | 上下文过期后的最小重试延迟 | `500` |
| `AI_SPEECH_STALE_RETRY_MAX_MS` | 上下文过期后的最大重试延迟 | `1500` |
| `AI_SPEECH_SKIP_BACKOFF_MS` | AI 返回 skip 后的调度退避时间 | `8000` |
| `AI_VOTE_DELAY_MS` | 投票阶段首个 AI 投票延迟 | `1500` |
| `AI_VOTE_STAGGER_MS` | 多个 AI 投票错开间隔 | `1200` |

### 超时处理

- 按 `AI_TIMEOUT_MS` 配置超时，默认 15 秒（`AbortController`）
- 超时 → 发言 skip，投票走兜底逻辑

---

## 七、JSON 解析策略

`extractJson(text)` 按以下顺序尝试提取 JSON：

1. 直接 `JSON.parse(text.trim())`
2. 提取 markdown 代码块中的 JSON：`` ```json ... ``` ``
3. 匹配文本中的第一个 `{...}` 对象

三种方式都失败 → 发言 skip / 投票返回 null

发言内容自动截断到 **240 字符**（与真人发言限制一致）。
