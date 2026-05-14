# AI 交互流程

## 架构概览

```
GameService (game.service.ts)
  ├─ startAiSpeech()     → AiService.generateSpeech() → DeepSeek API
  └─ scheduleAiVotes()   → AiService.generateVote()   → DeepSeek API
```

AI 组件：
- `AiModule` (`ai.module.ts`) — NestJS 模块
- `AiService` (`ai.service.ts`) — LLM 调用、Prompt 构建、输出解析
- `ai.types.ts` — 类型定义

---

## 一、发言流程

### 触发机制

`startAiSpeech()` 在讨论阶段开始时启动，每 **6 秒** 执行一次：

```
setInterval(每6秒):
  ├─ 检查当前阶段是否为 "discussion"（不是则跳过）
  ├─ 检查是否已有 AI 正在发言中（aiSpeaking 并发锁，防止重复触发）
  ├─ 筛选存活 AI 玩家
  ├─ 过滤满足 15 秒冷却的候选 AI
  ├─ 55% 概率跳过（Math.random() > 0.55，有候选人才进行）
  ├─ 没有候选人也跳过
  ├─ 从候选人中随机选一个 AI
  ├─ 设置 aiSpeaking 锁 = true
  ├─ await aiService.generateSpeech(context) → 调用 LLM
  ├─ 广播结果 / skip
  └─ finally: aiSpeaking 锁 = false
```

### generateSpeech 流程

```
generateSpeech(context):
  ├─ 未配置 API Key → return { type: "skip" }
  ├─ buildSpeechPrompt(context) → 拼装 Prompt
  ├─ callModel(systemPrompt, userPrompt) → POST /chat/completions（15s 超时）
  ├─ parseSpeechResult(raw) → 解析 JSON
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
| `myName` | AI 自己的昵称（如"林舟"） |
| `mySeatNo` | AI 自己的座位号（如 3） |
| `roundNo` | 当前轮次 |
| `phase` | 当前阶段（discussion / voting） |
| `remainingTimeMs` | 剩余时间（毫秒） |
| `alivePlayers` | 存活玩家列表（仅 id + seatNo，不含名称） |
| `recentMessages` | 本轮最近 20 条聊天记录（其他玩家显示"X号位"，自己显示"你"） |
| `myLastSpeech` | AI 自己上一次发言内容 |
| `currentVoteCounts` | 当前轮次投票统计 |
| `voteHistory` | 历史每轮投票记录（谁投谁、谁被淘汰） |

**隐私规则**：AI 只能看到自己的昵称，其他玩家只以座位号（"X号位"）显示。

---

## 四、Prompt 结构

### 发言 System Prompt

```
你是一个狼人杀游戏中的玩家，你的目标是隐藏自己的AI身份，像真人一样参与讨论。
规则：
- 游戏中有真人和AI玩家混在一起，真人需要找出所有AI，AI需要隐藏身份
- 每轮有讨论和投票阶段，得票最多的玩家被淘汰
- 4轮后如果AI仍存活，AI获胜；所有AI被淘汰则真人获胜
- 你的身份是AI，但绝不能暴露这一点
- 发言要自然、有逻辑、像真人一样
- 可以质疑他人、为自己辩解、分析局势，但不要说得太刻意
- 不要使用模板化或机械化的语言

必须输出JSON：
- {"type":"speak","content":"发言内容"}
- {"type":"skip"}
只输出JSON。
```

### 发言 User Prompt 示例

```
你是3号位，名字叫林舟，当前轮次：第1轮
剩余时间：240秒
存活玩家：1号位(ID:aaa)、2号位(ID:bbb)、3号位(ID:ccc)
最近聊天：
  1号位：我感觉2号说话有点假，像是在引导节奏
  2号位：我只是正常分析，大家别急着下定论
你上次发言：（无）

请决定是否发言，输出JSON。
```

### 投票 System Prompt

```
你是一个狼人杀游戏中的玩家，你的目标是隐藏自己的AI身份，像真人一样投票。
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
    "model": "deepseek-v4-flash",
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

### 超时处理

- 5 秒超时（`AbortController`）
- 超时 → 发言 skip，投票走兜底逻辑

---

## 六、JSON 解析策略

`extractJson(text)` 按以下顺序尝试提取 JSON：

1. 直接 `JSON.parse(text.trim())`
2. 提取 markdown 代码块中的 JSON：`` ```json ... ``` ``
3. 匹配文本中的第一个 `{...}` 对象

三种方式都失败 → 发言 skip / 投票返回 null

发言内容自动截断到 **240 字符**（与真人发言限制一致）。

## 七、 后续计划
1. AI只获取当前轮次的讨论记录, 可能会被真实用户抓到这点
2. 当前调用大模型没有利用前缀缓存, 会导致响应慢和消耗token比较多
