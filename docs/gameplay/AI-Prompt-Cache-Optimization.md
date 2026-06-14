# AI 提示词缓存优化

| 字段 | 内容 |
| --- | --- |
| 文档类型 | Design |
| 文档状态 | Active |
| 适用范围 | AI 玩家与模拟真人的提示词缓存组织方式 |
| 目标读者 | 后端开发、评审者 |
| 责任人 | AI / Gameplay 维护者 |
| 最近核对日期 | 2026-06-15 |
| 关联代码 | `apps/api/src/ai/`、`apps/api/src/ai/prompts/` |
| 关联文档 | [AI-Scheduling.md](./AI-Scheduling.md)、[AI-Interaction-Flow.md](./AI-Interaction-Flow.md) |

## 1. 背景

本文记录 AI 提示词缓存优化方案：OpenAI 格式依赖相同前缀的自动缓存；Claude 格式使用显式多层 `cache_control` 断点。

长对局中，提示词体积会不断增长。如果公共前缀不稳定，模型调用会频繁失去缓存命中，成本和延迟都会上升。

## 2. 目标

- 保持公共、稳定、跨玩家一致的内容尽量可复用。
- 让同类调用共享相同前缀，提升 OpenAI 自动缓存命中率。
- 让 Claude 通过显式断点形成可预测的多层缓存。
- 保持聊天记录尽量追加式增长，避免前缀漂移。

## 3. 约束与假设

- `user` prompt 的固定说明应排在最前。
- 玩家私有字段、高频变化字段和本次调用独有字段应排在后面。
- 公共聊天与历史投票应使用公共视角，而不是改写成当前玩家视角。
- 当前轮全部聊天优先保留，不使用滑动窗口截断。
- 消息编号应保持轮内稳定，不能随着局部数组位置漂移。

## 4. 方案概览

- OpenAI 格式：保持 `chat/completions` 调用形态，通过前缀稳定性优化自动缓存命中。
- Claude 格式：利用 `cache_control` 断点和 `<<CACHE_SPLIT>>` 标记实现多层显式缓存。
- 模板字段顺序固定，稳定内容在前，高频变化内容在后。

## 5. 详细设计

### 5.1 核心原则

#### 5.1.1 固定说明放在最前

所有游戏相关用户模板都先放固定文本：

- 任务说明
- 输出要求
- 上下文字段说明

这些内容不包含模板变量，能够作为所有同类调用的稳定前缀。

涉及模板(已拆分为 `ai-player/` 和 `sim-human/` 子目录)：

- `apps/api/src/ai/prompts/ai-player/user-speech-strategy-template.txt`
- `apps/api/src/ai/prompts/ai-player/user-speech-expression-template.txt`
- `apps/api/src/ai/prompts/ai-player/user-vote-template.txt`
- `apps/api/src/ai/prompts/sim-human/user-sim-human-speech-template.txt`
- `apps/api/src/ai/prompts/sim-human/user-sim-human-vote-template.txt`

#### 5.1.2 动态上下文按缓存稳定度排序

动态区按以下顺序组织：

```text
[全局静态] 任务说明、输出要求、字段说明
[玩家固定] 身份、局内说话人格
[轮内稳定] 历史对话、历史公开投票结果、存活玩家、短期记忆、轮次、阶段
[轮内递增] 最近聊天(当前轮全部公开聊天，逐条追加)
[高频变化] 上次发言、策略层输出、剩余时间、可投票目标
```

#### 5.1.3 公共聊天不使用"你"视角

`recentMessages` 和 `historicalMessages` 都统一使用公共视角：

```text
4号位：这句解释有点绕
```

不再把当前玩家自己的发言改写成`你：...`，这样同一段聊天对不同 AI 玩家是相同文本，利于跨玩家缓存复用。

#### 5.1.4 当前轮聊天不截断

`recentMessages` 使用当前轮全部公开聊天，不使用滑动窗口。

原因：滑动窗口超过上限后每新增一条会移除最旧一条，导致最近聊天块开头变化;全量当前轮聊天以追加为主，更利于前缀缓存。

#### 5.1.5 消息编号使用轮内稳定序号

聊天消息编号不再使用局部数组下标 `[1] [2]`，而是在构建 `GameContext` 时按 `room.messages` 原始顺序生成稳定标签 `[roundNo.roundMsgIndex]`。

这样即使未来做过滤、摘要或召回，同一条消息的编号也不会因为局部数组位置变化而漂移。

### 5.2 Claude 显式多层缓存

Claude 格式的大模型调用使用显式 `cache_control` 断点实现多层缓存。模板中通过 `<<CACHE_SPLIT>>` 标记划分缓存层级，代码在 `buildClaudeRequest` 中 `split` 切分后自动移除标记，不会发送给大模型。

#### 缓存结构

4 个 `cache_control` 断点(Claude API 上限)，加上无断点的 system prompt(作为 Layer 0 前缀的一部分被一起缓存)：

```text
System: [system_prompt]                    ← 无 cache_control，作为 Layer 0 前缀被一起缓存

User message:
  [Layer 0] 静态指令+字段说明               ← bp0 跨玩家跨轮次
  <<CACHE_SPLIT>>
  [Layer 1] 身份+局内说话人格               ← bp1 同玩家
  <<CACHE_SPLIT>>
  [Layer 2] 历史对话→短期记忆→最近聊天：    ← bp2 同玩家同轮次
  <<CACHE_SPLIT>>
  [Layer 3] 最近聊天逐条 block              ← bp3 滑动(最后一条带 cache_control)
  <<CACHE_SPLIT>>
  [Uncached] 上次发言+剩余时间/策略输出/投票目标
```

#### 缓存命中场景

| 场景 | 命中断点 | 缓存内容 |
| --- | --- | --- |
| 不同玩家同模板 | bp0 | system + 静态指令 |
| 同玩家不同轮 | bp0+bp1 | + 身份+人格 |
| 同玩家同轮新消息追加 | bp0+bp1+bp2 | + 轮内稳定内容 + 已有消息 |
| 同玩家同轮无新消息 | bp0+bp1+bp2+bp3 | 全部命中 |

#### 代码实现

- `AiService.CACHE_SPLIT`:标记常量 `"<<CACHE_SPLIT>>"`
- `buildClaudeRequest`: `userPrompt.split(marker)` 切分为 5 段，Layer 0/1/2/3 各自带 `cache_control`，Layer 3 内 recentMessages 逐条构建独立 block
- `buildOpenAiRequest` / `streamModel`: `userPrompt.split(CACHE_SPLIT).join("")` 清除标记后发送
- `formatAiLog`:日志打印前清除标记

#### 相关代码

- `apps/api/src/ai/ai.service.ts`: `buildClaudeRequest`、`buildOpenAiRequest`、`streamModel`
- `apps/api/src/ai/ai.types.ts`: `GameContext`(`recentMessages`、`historicalMessages` 类型定义)

### 5.3 模板字段顺序

#### 发言模板（ai-player / sim-human）

```text
[Layer 0] 任务说明 → 输出要求 → 字段说明
[Layer 1] 你的身份 → 局内说话人格
[Layer 2] 历史对话 → 历史公开投票结果 → 存活玩家 → 短期记忆 → 轮次 → 阶段 → 最近聊天：
[Layer 3] {{recentMessages}}（逐条 block）
[Uncached] 上次发言 → 策略层输出 → 剩余时间
```

#### 投票模板（ai-player / sim-human）

```text
[Layer 0] 任务说明 → 输出要求 → 字段说明
[Layer 1] 你的身份 → 局内说话人格
[Layer 2] 历史对话 → 历史公开投票结果 → 存活玩家 → 短期记忆 → 轮次 → 投票情况 → 本轮讨论记录：
[Layer 3] {{recentMessages}}（逐条 block）
[Uncached] 可投票目标
```

### 5.4 OpenAI 格式缓存

OpenAI 格式不做显式 block 拆分，依赖相同前缀自动缓存。模板中 `<<CACHE_SPLIT>>` 标记在发送前通过 `split().join("")` 移除，不影响模型输入。前缀稳定性同样由字段排序保证。

## 6. 数据模型 / 接口 / 配置

- `AiService.CACHE_SPLIT`：模板分层标记。
- `buildClaudeRequest`：显式拆分 Claude 用户消息。
- `buildOpenAiRequest`：清除分层标记后发给 OpenAI 风格接口。
- `GameContext.recentMessages`：当前轮公开聊天。
- `GameContext.historicalMessages`：历史公开聊天。

## 7. 备选方案与取舍

- 滑动窗口更省 token，但会让公共前缀抖动，不利于缓存。
- 重新改写为当前玩家视角更符合“你”的语气，但会让同一段聊天对不同玩家文本不同，缓存复用差。
- 只靠 OpenAI 自动缓存可以满足一部分场景，但 Claude 的显式分层更稳定，值得单独保留。

## 8. 风险与失败模式

- `alivePlayersList` 或投票列表如果顺序不稳定，会导致相同事实渲染成不同 prompt。
- 历史消息如果被重新编号，缓存前缀会漂移。
- 长局中若引入滑动窗口，Layer 2 / Layer 3 的前缀命中会下降。
- 摘要如果反复改写，会破坏缓存的稳定前缀。

## 9. 验证方式

- 比较 Claude 调用中不同层级的缓存命中情况。
- 观察 OpenAI 调用在同前缀场景下的 cached token 表现。
- 对比同局同轮追加聊天前后的 prompt 片段稳定性。
- 检查日志中是否仍有稳定前缀 hash 与消息编号漂移。

## 10. 已知限制

- 当前没有对 `alivePlayersList` 显式按座位号排序，仍依赖上游构造顺序。
- `voteHistory` 的票据顺序仍依赖生成时的输入顺序。
- 当前历史对话还没有不可变摘要层。

## 11. 后续工作

- 对 `alivePlayersList` 显式按座位号排序，避免依赖数组原始顺序。
- 对 `voteHistory` 内的票据按 `voterSeatNo` 排序，保证同一投票事实生成相同文本。
- 对超长历史引入不可变轮次摘要，并保留必要原文证据 ID。
- 记录每次 prompt 的稳定前缀 hash、prompt token 和 cached token，量化优化效果。
