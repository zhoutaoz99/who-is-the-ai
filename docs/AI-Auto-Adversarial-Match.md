# AI 自动对抗实现设计

## 背景

AI 自动对抗用于在调试环境中构造“AI 玩家 vs 模拟真人玩家”的自动对局。目标不是让模拟真人替代真实玩家，而是提供一个稳定、可复盘、可批量运行的对抗环境，用来观察 AI 玩家在被公开信息推理、质疑和投票压力下的表现。

当前实现保留原字段 `room.debugAutoAi`，但语义已从“全 AI 自动对局”调整为“AI 自动对抗调试房”。

## 设计目标

- 让 AI 玩家继续扮演隐藏身份方，目标是隐藏 AI 身份并存活。
- 让模拟真人玩家扮演真人阵营，目标是根据公开聊天和投票找出 AI。
- 模拟真人可以更积极、更强推理、更快追问，但不能获得隐藏身份或未公开投票信息。
- 自动对抗房可手动添加 AI 玩家和模拟真人玩家，用于调试阵容。
- 复盘中可以查看 AI 玩家和模拟真人玩家的模型调用记录。

## 非目标

- 不做模型权重训练。
- 不让模拟真人获得上帝视角。
- 不把模拟真人接入普通真人房。
- 不改变普通房间的真实玩家加入、积分结算和隐藏 AI 注入流程。

## 玩家建模

当前玩家身份仍由 `PlayerType` 表示：

```ts
type PlayerType = "human" | "ai";
```

`type` 表示游戏阵营：

- `type === "ai"`：AI 阵营，隐藏身份。
- `type === "human"`：真人阵营。

模拟真人通过 `Player.simulated` 标记：

```ts
interface Player {
  type: PlayerType;
  simulated?: boolean;
}
```

语义如下：

| 玩家 | type | simulated | 控制方式 | 阵营 |
| --- | --- | --- | --- | --- |
| 真实真人 | human | false 或 undefined | Socket 用户输入 | 真人阵营 |
| 模拟真人 | human | true | 模型自动发言和投票 | 真人阵营 |
| AI 玩家 | ai | undefined | 模型自动发言和投票 | AI 阵营 |

辅助判断函数位于 `apps/api/src/game/game.rules.ts`：

- `isSimulatedHuman(player)`
- `countSimulatedHumans(room)`
- `isModelDrivenPlayer(player)`

其中 `isModelDrivenPlayer` 表示需要由模型自动驱动的场上玩家：

```ts
player.type === "ai" || isSimulatedHuman(player)
```

## 房间模式

目前未新增 `room.mode`，继续使用 `room.debugAutoAi` 标记自动对抗调试房。

### 普通房

普通房逻辑保持不变：

- 等待房允许真实真人加入。
- 开局时自动补足隐藏 AI 玩家。
- 真实真人通过 socket 发言和投票。
- AI 玩家通过模型自动发言和投票。
- 积分只结算给有 `accountId` 的真实真人。

### 自动对抗调试房

自动对抗调试房由 `debug.ai-room.create` 创建，仅在 `DEBUG=true` 时可用。

默认阵容：

- `DEBUG_AUTO_AI_PLAYER_COUNT` 个 AI 玩家，默认等于 `AI_PLAYER_COUNT`，当前为 2。
- `DEBUG_AUTO_SIMULATED_HUMAN_COUNT` 个模拟真人，当前默认 3。

开局条件：

- 至少 1 名 AI 玩家。
- 至少 1 名模拟真人玩家。

等待房中可以手动添加：

- AI 玩家，可选择 AI 人格。
- 模拟真人玩家，不使用 AI 人格。

等待房中可以删除：

- AI 玩家。
- 模拟真人玩家。

自动对抗调试房不允许真实真人加入。

## 胜负规则

自动对抗调试房复用正常胜负规则：

- 所有 AI 玩家出局，真人阵营获胜。
- 所有 human 阵营玩家出局，AI 阵营获胜。
- 达到最大轮数后仍有 AI 存活，AI 阵营获胜。

模拟真人因为 `type === "human"`，天然计入真人阵营，但没有 `accountId`，因此不会获得积分。

## 模型调用分流

入口位于 `apps/api/src/ai/ai.service.ts`。

### AI 玩家发言

AI 玩家继续使用原双层发言流程：

1. `speech-strategy`
   - system prompt: `system-speech-strategy.txt`
   - user prompt: `user-speech-strategy-template.txt`
   - 输出是否发言、反应时间、下次观察时间和结构化策略。
2. `speech-expression`
   - system prompt: `system-speech-expression.txt`
   - user prompt: `user-speech-expression-template.txt`
   - 将结构化策略转换成最终发言。

AI 玩家的目标是隐藏身份。

### 模拟真人发言

模拟真人使用单次模型调用：

- call type: `sim-human-speech`
- system prompt: `system-sim-human-speech.txt`
- user prompt: `user-sim-human-speech-template.txt`

输出格式：

```json
{"type":"speak","content":"最终发言内容","targetResponseDelayMs":2500,"nextCheckAfterMs":10000}
```

或：

```json
{"type":"skip","reason":"跳过原因","nextCheckAfterMs":12000}
```

模拟真人 prompt 只提供游戏规则和公开上下文，目标是找出 AI。它不会收到任何玩家隐藏身份。

### AI 玩家投票

AI 玩家继续使用：

- call type: `vote`
- system prompt: `system-vote.txt`
- user prompt: `user-vote-template.txt`

AI 玩家的投票目标是保护自身阵营，优先投真人阵营玩家。

### 模拟真人投票

模拟真人使用：

- call type: `sim-human-vote`
- system prompt: `system-sim-human-vote.txt`
- user prompt: `user-sim-human-vote-template.txt`

输出格式：

```json
{"type":"vote","targetPlayerId":"玩家ID","reason":"投票理由"}
```

模拟真人投票只基于公开聊天和历史投票。投票阶段的当前票数在 prompt 中固定显示为“投票阶段未公开”，避免模型看到服务端未公开票数。

## 强对抗模拟真人策略

模拟真人不是复用 AI 玩家的隐藏身份策略，而是采用“强对抗真人阵营”策略。

### 能力边界

允许：

- 更积极发言。
- 更短发言冷却。
- 更短 skip 退避。
- 更强公开信息推理。
- AI 玩家发言后更快进入观察，并优先选择模拟真人回应。

不允许：

- 知道谁是 AI。
- 使用隐藏身份或系统信息作为发言理由。
- 看到投票阶段未公开票数。
- 声称自己确定知道某玩家身份。

### 公开信息推理重点

模拟真人 prompt 会引导模型关注：

- 发言过于圆滑。
- 回避站边。
- 只做安全总结。
- 前后观点变化。
- 跟票、补票。
- 被问后绕开问题。
- 连续低信息发言。
- 被质疑后防守过满或过空。

## 发言调度

工程层仍由 `GameService.startAiSpeech` 统一调度所有模型驱动玩家。

### 首次观察

每轮讨论开始后首次观察时间仍为：

```ts
AI_SPEECH_INITIAL_CHECK_MS = 10_000
```

模拟真人不会在开局阶段因为强对抗而提前到 3-6 秒观察。这样避免模拟真人过早抢第一句话，强对抗重点放在 AI 发言后的追问和压迫。

### 候选条件

候选玩家必须满足：

- `isModelDrivenPlayer(player) === true`
- 存活。
- 不在发言冷却中。
- 不在 skip backoff 中。

### 冷却时间

| 玩家 | 发言冷却 |
| --- | --- |
| AI 玩家 | `SPEAK_COOLDOWN_MS = 15_000` |
| 模拟真人 | `SIM_HUMAN_SPEECH_COOLDOWN_MS = 8_000` |

### skip backoff

| 玩家 | skip backoff |
| --- | --- |
| AI 玩家 | `AI_SPEECH_SKIP_BACKOFF_MS = 8_000` |
| 模拟真人 | `SIM_HUMAN_SPEECH_SKIP_BACKOFF_MS = 4_000` |

### nextCheck 裁剪

| 玩家 | nextCheckAfterMs 最大值 |
| --- | --- |
| AI 玩家 | `AI_SPEECH_NEXT_CHECK_MAX_MS = 30_000` |
| 模拟真人 | `SIM_HUMAN_SPEECH_NEXT_CHECK_MAX_MS = 15_000` |

### 发言反应时间裁剪

| 玩家 | targetResponseDelayMs 最大值 |
| --- | --- |
| AI 玩家 | `AI_SPEECH_RESPONSE_DELAY_MAX_MS = 20_000` |
| 模拟真人 | `SIM_HUMAN_SPEECH_RESPONSE_DELAY_MAX_MS = 12_000` |

最小值均沿用 `AI_SPEECH_RESPONSE_DELAY_MIN_MS = 800`。

### AI 发言后的模拟真人优先观察

当 AI 玩家成功发言后，如果房间里存在存活模拟真人：

- 下一次观察延迟被压到 `1_000-2_000ms`。
- 如果候选中存在模拟真人，优先从模拟真人中选择。

这使模拟真人更像对抗方，会更快针对 AI 玩家的公开发言做判断和追问。

### 候选选择顺序

如果触发 AI 发言后的模拟真人优先观察：

1. 从可发言的模拟真人候选中选。
2. 优先本轮未发言且未考虑过的玩家。
3. 其次本轮未发言的玩家。
4. 其次本轮未考虑过的玩家。
5. 否则随机。

普通情况下，在所有模型驱动玩家中使用同样的 freshness 选择顺序。

## 投票兜底

模型投票失败时会进入 `chooseFallbackVoteTarget`。

AI 玩家兜底：

- 优先投存活 human 阵营玩家。
- 没有 human 阵营玩家时，投其他存活玩家。

模拟真人兜底：

- 不偷看隐藏身份。
- 优先参考本轮已记录票数中最高票的非自己存活玩家。
- 如果没有票数趋势，则随机投非自己存活玩家。

注意：这里的“票数趋势”是工程兜底策略，不是模拟真人 prompt 中可见信息。模拟真人正常模型投票不接收投票阶段未公开票数。

## 复盘与调试

复盘新增模拟真人模型调用类型：

- `sim-human-speech`
- `sim-human-vote`

调试 prompt 接口 `GET /replay/debug/prompts` 会返回：

- AI 发言策略 system prompt。
- AI 表达转换 system prompt。
- AI 投票 system prompt。
- 模拟真人发言 system prompt。
- 模拟真人投票 system prompt。

复盘页面会展示：

- AI 玩家发言的策略层和表达层调用。
- 模拟真人发言调用。
- AI 玩家和模拟真人投票调用。
- 模拟真人身份标签。

## 前端展示

大厅中 debug 入口展示为“AI 自动对抗”。

等待房中：

- 显示 AI 数量和模拟真人数量。
- 可选择添加“AI 玩家”或“模拟真人”。
- AI 玩家可选择人格。
- 模拟真人不选择人格。
- 玩家列表中模拟真人显示为“模拟真人”标签。

游戏页中：

- 自动对抗房为观察模式，不显示真实玩家输入框。
- 结束标题显示“AI 自动对抗结束”。
- 消息来源和身份标签会区分 AI、真人和模拟真人。

## 当前限制

- 自动对抗房仍使用字段名 `debugAutoAi`，这是兼容历史代码的命名，语义已经变化。
- 模拟真人没有长期独立记忆，只依赖当前 `GameContext` 中的历史消息和历史投票。
- 强对抗程度目前通过 prompt 和工程调度参数控制，没有独立难度档位。
- 当前未引入上帝视角评审器；赛后分析仍依赖 replay 人工查看或后续扩展。

## 后续扩展

可以继续增加：

- 模拟真人难度档位，例如 fair / strong / expert。
- 赛后上帝视角评审器，只分析不参与场上行动。
- 自动对抗批量跑局脚本。
- AI 暴露点评分，例如被质疑次数、被投票次数、首个 AI 出局轮次。
- 模拟真人误判率、命中率和追问有效性指标。
