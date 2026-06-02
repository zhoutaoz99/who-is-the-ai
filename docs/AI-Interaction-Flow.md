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

`startAiSpeech()` 在讨论阶段开始时启动，使用**随机间隔 4-10 秒**的递归 `setTimeout`：

```
scheduleNext():
  ├─ 随机延迟 4~10 秒后执行回调
  ├─ 检查当前阶段是否为 "discussion"（不是则停止调度）
  ├─ 检查是否已有 AI 正在发言中（aiSpeaking 并发锁）
  ├─ 筛选存活 AI 玩家
  ├─ 过滤满足 15 秒冷却的候选 AI
  ├─ 45% 概率跳过（Math.random() > 0.55，即 55% 概率继续）
  ├─ 没有候选人也跳过 → scheduleNext()
  ├─ 从候选人中随机选一个 AI
  ├─ 设置 aiSpeaking 锁 = true
  ├─ await aiService.generateSpeech(context) → 调用 LLM
  ├─ 广播结果 / skip
  └─ finally: aiSpeaking 锁 = false → scheduleNext()
```

### generateSpeech 流程

```
generateSpeech(context):
  ├─ 未配置 API Key → return { type: "skip" }
  ├─ buildSpeechStrategyPrompt(context) → 拼装策略层 Prompt
  ├─ callModel(strategySystemPrompt, strategyUserPrompt, speechStrategyConfig) → 生成结构化发言策略
  ├─ parseSpeechStrategyResult(raw) → 解析策略 JSON
  │   ├─ skip: return { type: "skip" }
  │   └─ speak: 得到 goal / reason / intensity / length / constraints
  ├─ buildSpeechExpressionPrompt(context, strategy) → 拼装表达转换 Prompt
  ├─ callModel(expressionSystemPrompt, expressionUserPrompt, speechExpressionConfig) → 生成最终发言
  ├─ parseSpeechResult(raw) → 解析最终发言 JSON
  │   ├─ 成功: { type: "speak", content: "..." }
  │   └─ 失败: { type: "skip" }
  └─ 异常: return { type: "skip" }
```

### GameService 收到结果后

```
if (action.type === "speak"):
  addMessage(room, aiPlayer, action.content)   // 写入聊天记录
  broadcastRoom(room)                           // WebSocket 广播给房间
if (action.type === "skip"):
  什么都不做
```

---

## 二、投票流程

### 触发机制

`scheduleAiVotes()` 在投票阶段开始时调用，每个存活 AI 玩家在**错开延迟**后触发：

```
aiPlayers.forEach(aiPlayer, index):
  setTimeout(1500 + index * 1200)ms 后:
    ├─ 检查当前阶段是否还是 "voting"（不是则跳过）
    ├─ buildGameContext(room, aiPlayer) → 组装上下文
    ├─ await aiService.generateVote(context, aiPlayerId) → 调用 LLM
    ├─ 成功: castVoteForPlayer(room, aiPlayer, voteAction.targetPlayerId)
    └─ 失败/null: chooseFallbackVoteTarget() → 随机投给存活真人玩家
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

---

## 三、GameContext 上下文构建

`buildGameContext(room, aiPlayer)` 为每次 LLM 调用组装输入：

| 字段 | 说明 |
|------|------|
| `roomId` | 房间 ID |
| `myPlayerId` | AI 自己的玩家 ID |
| `myName` | AI 自己的昵称（如"林舟"） |
| `mySeatNo` | AI 自己的座位号（如 3） |
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

## 四、Prompt 结构

### 发言策略 System Prompt

```
你是”谁是AI”游戏中 AI 玩家内部的”发言策略层”。
你的任务不是写最终发言，而是决定本次是否发言，以及如果发言，给表达层一份结构化策略。

必须输出 JSON：
{"type":"speak","strategy":{"goal":"本次发言目标","reason":"可公开使用的理由","intensity":"策略强度","length":"长度要求","constraints":["表达限制1"]}}
或：
{"type":"skip","reason":"跳过原因"}
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
请先生成发言策略，或决定跳过发言，输出 JSON。不要输出最终发言。
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
  "goal": "轻踩 7 号，保护 3 号，不暴露自己对 5 号的真实判断",
  "reason": "7 号多次跟随他人观点，缺少独立判断",
  "intensity": "轻微怀疑，不要强打",
  "length": "3-4 句",
  "constraints": ["不要说这是策略", "不要直接暴露保护意图"]
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

## 五、API 调用

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

### 超时处理

- 按 `AI_TIMEOUT_MS` 配置超时，默认 15 秒（`AbortController`）
- 超时 → 发言 skip，投票走兜底逻辑

---

## 六、JSON 解析策略

`extractJson(text)` 按以下顺序尝试提取 JSON：

1. 直接 `JSON.parse(text.trim())`
2. 提取 markdown 代码块中的 JSON：`` ```json ... ``` ``
3. 匹配文本中的第一个 `{...}` 对象

三种方式都失败 → 发言 skip / 投票返回 null

发言内容自动截断到 **240 字符**（与真人发言限制一致）。
