# AI Prompt Cache Optimization

本文记录当前 AI 提示词缓存优化方案。目标是在仍然使用一条 `system` 提示词和一条 `user` 提示词的前提下，让模型服务端的相同前缀缓存更容易命中，尤其优化同一局、同一轮、多个玩家之间的跨玩家复用。

## 目标

- 保持现有 OpenAI-compatible `chat/completions` 调用形态：每次请求仍然只有一条 `system` message 和一条 `user` message。
- 尽量把稳定、公共、跨玩家一致的内容放在 `user` prompt 前面。
- 把玩家私有字段、高频变化字段和本次调用独有字段放在后面。
- 长对局中尽量让聊天记录以追加形式增长，避免因为滑动窗口或重新编号导致大块前缀失效。

## 核心原则

### 1. 固定说明放在最前

所有游戏相关用户模板都先放固定文本：

- 任务说明
- 输出要求
- 上下文字段说明

这些内容不包含模板变量，能够作为所有同类调用的稳定前缀。

涉及模板：

- `apps/api/src/ai/prompts/user-speech-strategy-template.txt`
- `apps/api/src/ai/prompts/user-speech-expression-template.txt`
- `apps/api/src/ai/prompts/user-vote-template.txt`
- `apps/api/src/ai/prompts/user-sim-human-speech-template.txt`
- `apps/api/src/ai/prompts/user-sim-human-vote-template.txt`

`user-replay-analysis-template.txt` 没有调整，因为它本身已经是固定说明在前、`{{replayJson}}` 在后的结构。

### 2. 动态上下文按缓存稳定度排序

动态区按以下顺序组织：

```text
历史对话
历史公开投票结果
公共房间信息
当前轮全部公开聊天

玩家私有信息
高频变化信息 / 本次调用独有信息
```

这样同一房间、同一轮、多个玩家的 prompt 可以复用到当前轮公开聊天结束，再从玩家私有字段处开始分叉。

### 3. 公共聊天不使用“你”视角

`recentMessages` 和 `historicalMessages` 都统一使用公共视角：

```text
[2.3] 4号位：这句解释有点绕
```

不再把当前玩家自己的发言改写成：

```text
你：这句解释有点绕
```

这样同一段聊天对不同 AI 玩家是相同文本，利于跨玩家缓存复用。

### 4. 当前轮聊天不截断

`recentMessages` 现在使用当前轮全部公开聊天，不再使用最后 20 条的滑动窗口。

原因：

- 滑动窗口超过 20 条后，每新增一条消息都会移除最旧一条，导致最近聊天块开头变化。
- 全量当前轮聊天更接近追加式增长，新消息主要追加在尾部，更利于前缀缓存。

### 5. 消息编号使用轮内稳定序号

聊天消息编号不再使用局部数组下标 `[1] [2]`，而是在构建 `GameContext` 时按 `room.messages` 原始顺序生成稳定标签：

```text
[1.1] 2号位：先都说两句吧
[1.2] 5号位：我刚进来，先听一下
[2.1] 3号位：上一轮5号投票有点怪
```

格式含义：

- `1.1` 表示第 1 轮第 1 条公开消息。
- `2.1` 表示第 2 轮第 1 条公开消息。

这样即使未来做过滤、摘要或召回，同一条消息的编号也不会因为局部数组位置变化而漂移。

相关实现：

- `apps/api/src/ai/ai.types.ts`: `ChatMessageInput.orderLabel`
- `apps/api/src/game/game.service.ts`: 为每条消息生成 `${roundNo}.${roundMessageIndex}`
- `apps/api/src/ai/ai.service.ts`: `formatChatMessages()` 优先使用 `orderLabel`

## 发言模板

发言相关模板包括：

- `user-speech-strategy-template.txt`
- `user-speech-expression-template.txt`
- `user-sim-human-speech-template.txt`

动态区公共部分顺序：

```text
历史对话
历史公开投票结果
存活玩家
当前轮次
当前阶段：讨论阶段
最近聊天
```

玩家私有和高频变化部分顺序：

```text
你的身份
局内说话人格（仅 AI 发言模板有）
你的短期记忆（策略层和模拟真人发言有）
你上次发言
策略层输出（仅表达层有）
剩余时间
```

讨论阶段不展示 `当前投票情况`。原因是发言调用只发生在讨论阶段，投票信息在这里没有有效含义，还会增加动态内容。

## 投票模板

投票相关模板包括：

- `user-vote-template.txt`
- `user-sim-human-vote-template.txt`

动态区公共部分顺序：

```text
历史对话
历史公开投票结果
当前轮次：第 N 轮（投票阶段）
当前投票情况
本轮讨论记录
```

玩家私有部分顺序：

```text
你的身份
局内说话人格（仅 AI 投票模板有）
你的短期记忆
可投票目标
```

投票模板保留 `当前投票情况`，用于明确同时盲投阶段看不到其他玩家当前票数。

## 跨玩家复用

当前方案优先优化同一轮多个玩家之间的缓存复用。

可复用前缀通常覆盖：

```text
固定任务说明
字段说明
历史对话
历史公开投票结果
公共房间信息
当前轮全部公开聊天
```

第一个主要跨玩家分叉点通常是：

```text
你的身份：{{mySeatNo}}号位，名字叫{{myName}}
```

如果同一轮内多个 AI 玩家看到的是同一份房间状态和聊天快照，它们可以共享到公共聊天结束。

## 本玩家复用

同一玩家在一轮内多次观察时：

- 如果没有新增聊天，通常只有 `剩余时间` 变化，能复用到 prompt 尾部。
- 如果新增聊天，缓存会在 `recentMessages` 新增处之后分叉，但新增消息以前的聊天前缀仍能复用。
- `myLastSpeech` 放在公共聊天之后，避免它提前打断多个玩家对公开聊天的复用。

这是一个有意取舍：当前更重视跨玩家复用，而不是把玩家私有信息提前以优化单玩家复用。

## 多轮长局注意事项

多轮后，token 大头会逐渐变成 `historicalMessages` 和 `recentMessages`。为了保持缓存效果：

- 历史对话应保持追加式表达，不要重排旧轮次。
- 不要用滑动窗口截断历史对话，否则历史块开头会变化。
- 不要重新编号旧消息；同一条消息的 `orderLabel` 必须稳定。
- 如果未来要压缩历史，应优先使用“不可变轮次摘要 + 当前轮原文”的方式。
- 摘要一旦生成，不应在后续轮次反复改写，否则会破坏缓存前缀。

## 后续可优化项

- 对 `alivePlayersList` 显式按座位号排序，避免依赖数组原始顺序。
- 对 `voteHistory` 内的票据按 `voterSeatNo` 排序，保证同一投票事实生成相同文本。
- 对超长历史引入不可变轮次摘要，并保留必要原文证据 ID。
- 记录每次 prompt 的稳定前缀 hash、prompt token 和 cached token，量化优化效果。

## 验证

当前变更已通过：

```bash
npm --workspace apps/api run build
```
