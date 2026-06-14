# AI Prompt Cache Optimization

本文记录当前 AI 提示词缓存优化方案。OpenAI 格式依赖相同前缀的自动缓存；Claude 格式使用显式多层缓存断点。

## 目标

- OpenAI 格式：保持 `chat/completions` 调用形态，通过前缀稳定性优化自动缓存命中。
- Claude 格式：利用 `cache_control` 断点和 `<<CACHE_SPLIT>>` 标记实现多层显式缓存。
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

涉及模板（已拆分为 `ai-player/` 和 `sim-human/` 子目录）：

- `apps/api/src/ai/prompts/ai-player/user-speech-strategy-template.txt`
- `apps/api/src/ai/prompts/ai-player/user-speech-expression-template.txt`
- `apps/api/src/ai/prompts/ai-player/user-vote-template.txt`
- `apps/api/src/ai/prompts/sim-human/user-sim-human-speech-template.txt`
- `apps/api/src/ai/prompts/sim-human/user-sim-human-vote-template.txt`

### 2. 动态上下文按缓存稳定度排序

动态区按以下顺序组织：

```text
[全局静态] 任务说明、输出要求、字段说明
[玩家固定] 身份、局内说话人格
[轮内稳定] 历史对话、历史公开投票结果、存活玩家、短期记忆、轮次、阶段
[轮内递增] 最近聊天（当前轮全部公开聊天，逐条追加）
[高频变化] 上次发言、策略层输出、剩余时间、可投票目标
```

### 3. 公共聊天不使用"你"视角

`recentMessages` 和 `historicalMessages` 都统一使用公共视角：

```text
4号位：这句解释有点绕
```

不再把当前玩家自己的发言改写成"你：..."，这样同一段聊天对不同 AI 玩家是相同文本，利于跨玩家缓存复用。

### 4. 当前轮聊天不截断

`recentMessages` 使用当前轮全部公开聊天，不使用滑动窗口。

原因：滑动窗口超过上限后每新增一条会移除最旧一条，导致最近聊天块开头变化；全量当前轮聊天以追加为主，更利于前缀缓存。

### 5. 消息编号使用轮内稳定序号

聊天消息编号不再使用局部数组下标 `[1] [2]`，而是在构建 `GameContext` 时按 `room.messages` 原始顺序生成稳定标签 `[roundNo.roundMsgIndex]`。

这样即使未来做过滤、摘要或召回，同一条消息的编号也不会因为局部数组位置变化而漂移。

## Claude 显式多层缓存

Claude 格式的大模型调用使用显式 `cache_control` 断点实现多层缓存。模板中通过 `<<CACHE_SPLIT>>` 标记划分缓存层级，代码在 `buildClaudeRequest` 中 `split` 切分后自动移除标记，不会发送给大模型。

### 缓存结构

4 个 `cache_control` 断点（Claude API 上限），加上无断点的 system prompt（作为 Layer 0 前缀的一部分被一起缓存）：

```text
System: [system_prompt]                    ← 无 cache_control，作为 Layer 0 前缀被一起缓存

User message:
  [Layer 0] 静态指令+字段说明               ← bp0 跨玩家跨轮次
  <<CACHE_SPLIT>>
  [Layer 1] 身份+局内说话人格               ← bp1 同玩家
  <<CACHE_SPLIT>>
  [Layer 2] 历史对话→短期记忆→最近聊天：    ← bp2 同玩家同轮次
  <<CACHE_SPLIT>>
  [Layer 3] 最近聊天逐条 block              ← bp3 滑动（最后一条带 cache_control）
  <<CACHE_SPLIT>>
  [Uncached] 上次发言+剩余时间/策略输出/投票目标
```

### 缓存命中场景

| 场景 | 命中断点 | 缓存内容 |
|------|---------|---------|
| 不同玩家同模板 | bp0 | system + 静态指令 |
| 同玩家不同轮 | bp0+bp1 | + 身份+人格 |
| 同玩家同轮新消息追加 | bp0+bp1+bp2 | + 轮内稳定内容 + 已有消息 |
| 同玩家同轮无新消息 | bp0+bp1+bp2+bp3 | 全部命中 |

### 代码实现

- `AiService.CACHE_SPLIT`：标记常量 `"<<CACHE_SPLIT>>"`
- `buildClaudeRequest`：`userPrompt.split(marker)` 切分为 5 段，Layer 0/1/2/3 各自带 `cache_control`，Layer 3 内 recentMessages 逐条构建独立 block
- `buildOpenAiRequest` / `streamModel`：`userPrompt.split(CACHE_SPLIT).join("")` 清除标记后发送
- `formatAiLog`：日志打印前清除标记

### 相关代码

- `apps/api/src/ai/ai.service.ts`：`buildClaudeRequest`、`buildOpenAiRequest`、`streamModel`
- `apps/api/src/ai/ai.types.ts`：`GameContext`（`recentMessages`、`historicalMessages` 类型定义）

## 模板字段顺序

### 发言模板（ai-player / sim-human）

```text
[Layer 0] 任务说明 → 输出要求 → 字段说明
[Layer 1] 你的身份 → 局内说话人格
[Layer 2] 历史对话 → 历史公开投票结果 → 存活玩家 → 短期记忆 → 轮次 → 阶段 → 最近聊天：
[Layer 3] {{recentMessages}}（逐条 block）
[Uncached] 上次发言 → 策略层输出 → 剩余时间
```

### 投票模板（ai-player / sim-human）

```text
[Layer 0] 任务说明 → 输出要求 → 字段说明
[Layer 1] 你的身份 → 局内说话人格
[Layer 2] 历史对话 → 历史公开投票结果 → 存活玩家 → 短期记忆 → 轮次 → 投票情况 → 本轮讨论记录：
[Layer 3] {{recentMessages}}（逐条 block）
[Uncached] 可投票目标
```

## OpenAI 格式缓存

OpenAI 格式不做显式 block 拆分，依赖相同前缀自动缓存。模板中 `<<CACHE_SPLIT>>` 标记在发送前通过 `split().join("")` 移除，不影响模型输入。前缀稳定性同样由字段排序保证。

## 多轮长局注意事项

多轮后，token 大头会逐渐变成 `historicalMessages` 和 `recentMessages`。为了保持缓存效果：

- 历史对话应保持追加式表达，不要重排旧轮次。
- 不要用滑动窗口截断历史对话，否则历史块开头会变化。
- 不要重新编号旧消息；同一条消息的 `orderLabel` 必须稳定。
- 如果未来要压缩历史，应优先使用"不可变轮次摘要 + 当前轮原文"的方式。
- 摘要一旦生成，不应在后续轮次反复改写，否则会破坏缓存前缀。

## 后续可优化项

- 对 `alivePlayersList` 显式按座位号排序，避免依赖数组原始顺序。
- 对 `voteHistory` 内的票据按 `voterSeatNo` 排序，保证同一投票事实生成相同文本。
- 对超长历史引入不可变轮次摘要，并保留必要原文证据 ID。
- 记录每次 prompt 的稳定前缀 hash、prompt token 和 cached token，量化优化效果。
