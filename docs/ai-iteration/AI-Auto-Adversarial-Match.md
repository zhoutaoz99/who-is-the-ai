# AI 自动对抗调试房

| 字段 | 内容 |
| --- | --- |
| 文档类型 | Design |
| 文档状态 | Active |
| 适用范围 | 调试用 AI 自动对抗房、模拟真人强度、调度分流与复盘展示 |
| 目标读者 | 后端开发、评审者 |
| 责任人 | AI / Gameplay 维护者 |
| 最近核对日期 | 2026-06-15 |
| 关联代码 | `apps/api/src/ai/`、`apps/api/src/game/`、`apps/web/app/page.tsx`、`apps/web/app/room/[roomId]/page.tsx`、`apps/web/app/game/[roomId]/page.tsx` |
| 关联文档 | [AI-Interaction-Flow.md](../gameplay/AI-Interaction-Flow.md)、[AI-Prompt-Eval-Flow.md](./AI-Prompt-Eval-Flow.md) |

调试用「AI 玩家 vs 模拟真人」自动对局环境仅 `DEBUG=true` 可用，用于观察、复盘和批量评估 AI 玩家。普通对局 AI 行为见 [AI-Interaction-Flow.md](../gameplay/AI-Interaction-Flow.md)，批量评估闭环见 [AI-Prompt-Eval-Flow.md](./AI-Prompt-Eval-Flow.md)。

## 1. 背景与目标

AI 自动对抗用于在调试环境中构造“AI 玩家 vs 模拟真人玩家”的自动对局。目标不是让模拟真人替代真实玩家，而是提供一个稳定、可复盘、可批量运行的对抗环境，用来观察 AI 玩家在被公开信息推理、质疑和投票压力下的表现。

当前实现保留原字段 `room.debugAutoAi`，但语义已从“全 AI 自动对局”调整为“AI 自动对抗调试房”。

## 2. 设计目标

- 让 AI 玩家继续扮演隐藏身份方，目标是隐藏 AI 身份并存活。
- 让模拟真人玩家扮演真人阵营，目标是根据公开聊天和投票找出 AI。
- 模拟真人强度可以通过环境变量配置为正常或高强度，但不能获得隐藏身份、未公开投票信息或投票理由。
- 自动对抗房可手动添加 AI 玩家和模拟真人玩家，用于调试阵容。
- 复盘中可以查看 AI 玩家和模拟真人玩家的模型调用记录。

## 3. 非目标

- 不做模型权重训练。
- 不让模拟真人获得上帝视角。
- 不把模拟真人接入普通真人房。
- 不改变普通房间的真实玩家加入、积分结算和隐藏 AI 注入流程。

## 4. 玩家建模

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

## 5. 房间模式

目前未新增 `room.mode`，继续使用 `room.debugAutoAi` 标记自动对抗调试房。

### 5.1 普通房

普通房逻辑保持不变：

- 等待房允许真实真人加入。
- 开局时自动补足隐藏 AI 玩家。
- 真实真人通过 socket 发言和投票。
- AI 玩家通过模型自动发言和投票。
- 积分只结算给有 `accountId` 的真实真人。

### 5.2 自动对抗调试房

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

## 6. 模拟真人强度配置

模拟真人发言和投票 prompt 支持通过环境变量切换强度：

```env
SIMULATED_HUMAN_INTENSITY=normal
```

可选值：

| 值 | 说明 | 发言 system prompt | 投票 system prompt |
| --- | --- | --- | --- |
| `normal` | 默认值。低信息阶段更像正常真人：先自然聊天、轻追问、收集发言样本，不要求判断未发言玩家，不在第一轮前半段过早归票。 | `system-sim-human-speech.txt` | `system-sim-human-vote.txt` |
| `high` | 高强度。保留旧版强对抗模板，更主动质疑、更快施压、更积极推进投票判断。 | `system-sim-human-speech-high.txt` | `system-sim-human-vote-high.txt` |

强度解析逻辑位于 `apps/api/src/ai/sim-human-intensity.ts`：

- 未配置时默认使用 `normal`。
- 配置为无效值时回退到 `normal`。
- `AiService` 在模拟真人发言和投票时按当前强度选择对应 system prompt。
- `GET /replay/debug/prompts` 返回的模拟真人 prompt 也是当前强度实际使用的版本。

## 7. 胜负规则

自动对抗调试房复用正常胜负规则：

- 所有 AI 玩家出局，真人阵营获胜。
- 所有 human 阵营玩家出局，AI 阵营获胜。
- 达到最大轮数后仍有 AI 存活，AI 阵营获胜。

模拟真人因为 `type === "human"`，天然计入真人阵营，但没有 `accountId`，因此不会获得积分。

## 8. 模型调用分流

入口位于 `apps/api/src/ai/ai.service.ts`。

### 8.1 AI 玩家发言

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

### 8.2 模拟真人发言

模拟真人使用单次模型调用：

- call type: `sim-human-speech`
- system prompt: 由 `SIMULATED_HUMAN_INTENSITY` 决定，默认 `system-sim-human-speech.txt`，高强度为 `system-sim-human-speech-high.txt`
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

### 8.3 AI 玩家投票

AI 玩家继续使用：

- call type: `vote`
- system prompt: `system-vote.txt`
- user prompt: `user-vote-template.txt`

AI 玩家的投票目标是保护自身阵营，优先投真人阵营玩家。

投票阶段为同时盲投，AI 玩家投票 prompt 中当前票数固定显示为“同时盲投，当前票数不可见”，不会看到其他玩家本轮已经投出的票。

### 8.4 模拟真人投票

模拟真人使用：

- call type: `sim-human-vote`
- system prompt: 由 `SIMULATED_HUMAN_INTENSITY` 决定，默认 `system-sim-human-vote.txt`，高强度为 `system-sim-human-vote-high.txt`
- user prompt: `user-sim-human-vote-template.txt`

输出格式：

```json
{"type":"vote","targetPlayerId":"玩家ID","reason":"投票理由"}
```

模拟真人投票只基于公开聊天和历史公开投票结果。投票阶段为同时盲投，当前票数在 prompt 中固定显示为“同时盲投，当前票数不可见”，避免模型看到服务端未公开票数。

## 9. Prompt 上下文格式

所有 AI 玩家和模拟真人玩家的用户提示词都会使用统一的公开上下文格式。

### 9.1 聊天消息序号

`最近聊天` 和 `历史对话` 中的每条消息都会带局部顺序号：

```text
最近聊天：
  [1] 3号位：1号位，目前没人说话，不如你先带个头？
  [2] 1号位：3号，你这突然让我带头，我也没啥头绪啊。
  [3] 2号位：1号位，你可以说说谁最可疑。
```

序号用于帮助模型判断发言先后关系，降低把早于问题的发言误当成后续回应的概率。

### 9.2 历史公开投票结果

历史投票在 prompt 中展示为：

```text
历史公开投票结果（只包含投票方向，不包含投票理由）：
  第1轮：3号→1号、2号→1号、4号→1号、5号→3号、1号→2号 → 1号被淘汰
```

这里的信息只表示投票方向和淘汰结果，不表示投票理由，也不表示玩家在投票阶段发表过观点。

### 9.3 同时盲投

投票阶段采用同时盲投：

- 投票时看不到其他玩家当前投票。
- 投票结果只在本轮投票结束后公开。
- prompt 中的 `当前投票情况` 会明确标注“同时盲投，投票阶段看不到其他玩家当前投票”。
- 模型不能依据本轮投票阶段的实时票型做跟票、冲票或避票判断。

## 10. 模拟真人强度策略

模拟真人不是复用 AI 玩家的隐藏身份策略，而是采用真人阵营策略。当前实现支持 `normal` 和 `high` 两档。

`normal` 是默认强度，目标是更接近正常低信息对局：

- 第一轮信息不足时先自然聊天、轻追问、收集发言样本。
- 不要求别人判断尚未发言、没有行为记录的玩家。
- 不把短暂沉默、刚被问后没有马上回应、说得少，单独当成 AI 证据。
- 第一轮前半段避免“票你”“票定”“直接投你”“最后机会”等强压话术。
- 怀疑需要基于公开内容逐步升级：先观察或轻问，再给临时判断，接近投票或证据更充分时才施压。

`high` 是旧版强对抗模板，目标是更快暴露 AI 的防守、回避和模板化问题：

- 更主动识别和追问。
- 更快要求对方解释具体发言、给出个人判断或指出真实可疑点。
- 更积极根据公开发言质感推进投票判断。

### 10.1 能力边界

允许：

- 更积极发言。
- 更短发言冷却。
- 更短 skip 退避。
- 更强公开信息推理。
- 与 AI 玩家发言调度隔离，避免互相挤占发言机会。

不允许：

- 知道谁是 AI。
- 使用隐藏身份或系统信息作为发言理由。
- 看到投票阶段未公开票数。
- 看到投票理由。
- 声称自己确定知道某玩家身份。

### 10.2 公开信息推理重点

模拟真人 prompt 会引导模型关注：

- 发言质感是否像 AI。
- 措辞机械、模板化、像总结报告。
- 过度圆滑、过度安全。
- 没有个人视角，只做泛泛归纳。
- 强行平衡各方，回应像在完成任务。
- 被追问后仍用空泛话术搪塞。
- 前后观点变化、投票异常等公开行为线索。

少说、沉默、说没头绪都不能单独当成强 AI 证据或主要投票理由，因为真实玩家也可能少说。只有当少说同时伴随机械化回应、投票异常、前后矛盾或被追问后仍空泛搪塞时，才作为辅助线索。

追问时优先要求对方解释具体发言为什么这么说、给出个人判断或指出一条真实可疑点，而不是单纯逼对方多说话。

## 11. 发言调度

工程层在讨论阶段开始后根据 `room.debugAutoAiSequentialSpeech` 选择两套调度策略：

- 普通模式：AI 玩家和模拟真人玩家走独立的普通发言调度器。
- 顺序发言：所有模型驱动玩家走自动对抗串行发言循环。

顺序发言只影响 AI 自动对抗调试房。普通房不读取该开关，自动对抗房未打开顺序发言时也保持普通发言策略。

### 11.1 普通模式

普通模式用于让自动对抗房尽量接近普通对局的时间节奏。它不会把所有模型玩家串成一个队列，而是保留“按时间观察、按候选条件挑人、按模型返回的延迟继续观察”的普通发言策略。

#### 11.1.1 启动入口和调度隔离

普通模式由 `GameService.afterDiscussionStarted` 启动。当房间不是“自动对抗顺序发言”时，会同时启动两个普通发言调度器：

- `startAiSpeech(room)`：只调度 `type === "ai"` 的 AI 玩家。
- `startSimulatedHumanSpeech(room)`：只调度 `type === "human" && simulated === true` 的模拟真人玩家。

两个调度器使用不同的 timer key 和 speaking map：

- AI 玩家：`RoomTimers.aiSpeech` + `GameService.aiSpeaking`
- 模拟真人：`RoomTimers.simulatedHumanSpeech` + `GameService.simulatedHumanSpeaking`

这样 AI 玩家和模拟真人的普通发言调度互相隔离，某一类玩家正在模型调用、等待下次观察或进入 skip backoff 时，不会阻塞另一类玩家的调度。

在普通房里也会调用这两个入口。由于普通房没有模拟真人，模拟真人调度器通常找不到候选人并持续低频观察；AI 玩家仍走和自动对抗普通模式一致的 AI 发言调度。真实真人发言不经过模型调度，仍由 socket 用户输入触发。

#### 11.1.2 普通模式调度循环

普通模式的核心实现是 `startModelSpeech(room, schedulerKind, initialDelayMs)`。`schedulerKind` 决定当前调度器只处理 AI 玩家还是模拟真人玩家。

每个调度器按以下流程循环：

1. 使用当前 delay 创建一个 `setTimeout`。
2. timeout 触发后重新读取房间。
3. 如果房间不存在或当前阶段不是 `discussion`，本调度器停止。
4. 如果当前调度器在这个房间已有模型调用进行中，等待 `AI_SPEECH_NEXT_CHECK_MIN_MS` 后重新观察。
5. 调用 `selectSpeechPlayer(room, schedulerKind)` 选择一个候选玩家。
6. 如果没有候选玩家，等待 `AI_SPEECH_NEXT_CHECK_MIN_MS` 后重新观察。
7. 记录发言上下文标记：
   - `roundNo`
   - `voteCount`
8. 构建该玩家的 `GameContext`，调用 `aiService.generateSpeech(context)`。
9. 根据玩家类型裁剪模型返回的 `nextCheckAfterMs`，作为后续默认观察间隔。
10. 模型返回后重新读取房间，确认仍是同一轮 `discussion`。
11. 如果轮次、阶段或投票数量变化，丢弃本次结果并打印日志。
12. 根据模型动作分别处理 `skip` 或 `speak`。
13. finally 中释放当前调度器的 `speaking` 标记。
14. 如果仍需要继续调度，并且房间仍处于 `playing + discussion`，按 `nextDelayMs` 安排下一次观察。

这里的串行只在同一个 scheduler 内生效：

- AI 调度器同一时间只会有一个 AI 玩家模型发言调用。
- 模拟真人调度器同一时间只会有一个模拟真人模型发言调用。
- 两个调度器互相独立，因此自动对抗普通模式下可能同时存在一个 AI 玩家调用和一个模拟真人调用。

#### 11.1.3 首次观察

每轮讨论开始后首次观察时间仍为：

```ts
AI_SPEECH_INITIAL_CHECK_MS = 10_000
```

AI 调度器和模拟真人调度器的首次观察时间相同。模拟真人不会因为 `normal` 或 `high` 强度配置而提前到 3-6 秒观察。这样避免模拟真人过早抢第一句话；强度差异只由 prompt 和后续公开上下文判断体现，而不是工程层强行插队。

#### 11.1.4 候选条件

候选玩家必须满足：

- 属于当前调度器：
  - AI 调度器只接受 `player.type === "ai"`。
  - 模拟真人调度器只接受 `isSimulatedHuman(player)`。
- 存活。
- 不在发言冷却中。
- 不在 skip backoff 中。

如果当前调度器没有候选玩家，它不会调用模型，只会在 `AI_SPEECH_NEXT_CHECK_MIN_MS = 1_000` 后再次观察。

#### 11.1.5 冷却时间

| 玩家 | 发言冷却 |
| --- | --- |
| AI 玩家 | `SPEAK_COOLDOWN_MS = 15_000` |
| 模拟真人 | `SIM_HUMAN_SPEECH_COOLDOWN_MS = 8_000` |

冷却依赖 `player.lastSpokeAt`。发言成功保存时，`addChatMessage` 会更新 `lastSpokeAt` 并把消息写入 `room.messages`。

#### 11.1.6 skip backoff

| 玩家 | skip backoff |
| --- | --- |
| AI 玩家 | `AI_SPEECH_SKIP_BACKOFF_MS = 8_000` |
| 模拟真人 | `SIM_HUMAN_SPEECH_SKIP_BACKOFF_MS = 4_000` |

当模型返回 `skip` 时：

- 更新 `aiLastConsideredRound`。
- 更新 `aiLastConsideredAt`。
- 设置 `aiSkipBackoffUntil = Date.now() + modelSpeechSkipBackoffMs(player)`。
- 记录模型调用。
- 不新增聊天消息。

#### 11.1.7 nextCheck 裁剪

| 玩家 | nextCheckAfterMs 最大值 |
| --- | --- |
| AI 玩家 | `AI_SPEECH_NEXT_CHECK_MAX_MS = 30_000` |
| 模拟真人 | `SIM_HUMAN_SPEECH_NEXT_CHECK_MAX_MS = 15_000` |

`nextCheckAfterMs` 的最小值统一为 `AI_SPEECH_NEXT_CHECK_MIN_MS = 1_000`。如果模型返回值过小或过大，会按玩家类型裁剪后再用于下一次观察。

#### 11.1.8 发言反应时间裁剪

| 玩家 | targetResponseDelayMs 最大值 |
| --- | --- |
| AI 玩家 | `AI_SPEECH_RESPONSE_DELAY_MAX_MS = 20_000` |
| 模拟真人 | `SIM_HUMAN_SPEECH_RESPONSE_DELAY_MAX_MS = 12_000` |

最小值均沿用 `AI_SPEECH_RESPONSE_DELAY_MIN_MS = 800`。

当模型返回 `speak` 时，普通模式不会立刻保存，而是用 `targetResponseDelayMs` 模拟真实响应时间：

1. 记录模型决策耗时 `elapsedMs`。
2. 裁剪 `targetResponseDelayMs`。
3. 计算 `remainingDelayMs = max(0, targetResponseDelayMs - elapsedMs)`。
4. 如果 `remainingDelayMs > 0`，等待这段时间。
5. 保存前再次加锁读取房间并校验状态。

保存成功后：

- 更新 `aiLastConsideredRound`。
- 更新 `aiLastConsideredAt`。
- 清空 `aiSkipBackoffUntil`。
- 调用 `addMessage` 写入聊天消息。
- 记录模型调用。
- 广播房间快照。

#### 11.1.9 上下文失效判断

普通模式的发言上下文标记只包含：

```ts
{
  roundNo: room.currentRound,
  voteCount: room.votes.length,
}
```

也就是说，其他玩家在模型调用期间新增聊天消息不会导致本次发言被判定为失效。只有轮次变化或投票数量变化才会让结果丢弃。

这样做是为了避免 AI 玩家和模拟真人调度互相独立后，大量模型调用因为对话消息变化而被丢弃。模型发言可能基于稍早的聊天上下文生成，但只要仍在同一轮发言阶段且投票状态未变，就允许保存。

如果保存前发现上下文失效，会使用 `AI_SPEECH_STALE_RETRY_MIN_MS = 500` 到 `AI_SPEECH_STALE_RETRY_MAX_MS = 1_500` 的随机延迟进行下一次观察。

#### 11.1.10 候选选择顺序

每个普通调度器只在自己的候选集合中使用 freshness 选择顺序：

1. 优先本轮未发言且未考虑过的玩家。
2. 其次本轮未发言的玩家。
3. 其次本轮未考虑过的玩家。
4. 否则随机。

普通模式不再使用“AI 发言后强制模拟真人跟进”的跨调度器逻辑，避免模拟真人调度挤占 AI 玩家的发言机会。

### 11.2 丢弃日志

模型发言返回后，如果对局已经离开发言阶段、轮次变化、上下文失效或保存失败，服务端会打印丢弃日志：

```text
Discarded model speech room=<roomId> round=<roundNo> scheduler=<ai|simulated-human> seat=<seatNo> player=<name> reason=<reason>
```

日志只记录被丢弃发言的短预览，方便定位模型调用耗时过长或保存时状态变化导致的发言丢弃。

### 11.3 顺序发言

顺序发言由 `room.debugAutoAiSequentialSpeech` 控制。该字段只在 AI 自动对抗调试房中有效，等待房通过“顺序发言”开关修改，服务端事件为 `debug.ai-room.sequentialSpeech.update`。

服务端限制：

- 仅 `DEBUG=true` 时可修改。
- 只能修改 `room.debugAutoAi === true` 的自动对抗调试房。
- 只能在 `room.status === "waiting"` 时修改。

顺序发言打开后，每轮讨论阶段开始时不启动普通调度器，而是启动 `startDebugAutoAiSpeechLoop(room)`。这个循环覆盖 AI 玩家和模拟真人玩家。

#### 11.3.1 顺序发言状态

顺序发言使用房间内的临时状态记录当前轮的 pass 进度：

```ts
room.debugAutoAiSpeech = {
  roundNo: room.currentRound,
  startOffset: number,
  passNo: number,
}
```

- `roundNo`：状态所属轮次。
- `startOffset`：当前 pass 的轮转起点。
- `passNo`：已经完成的 pass 数。

每轮进入讨论阶段时会重新初始化该状态。第一轮 pass 的 `startOffset` 随机生成；每完成一个 pass，`startOffset = (startOffset + 1) % aliveModelDrivenPlayers.length`，因此每个 pass 的起始玩家都会轮转。

#### 11.3.2 顺序发言 pass 顺序

每个 pass 会重新读取当前房间状态，并按以下规则生成发言顺序：

1. 取所有存活的模型驱动玩家：
   - AI 玩家。
   - 模拟真人玩家。
2. 按 `seatNo` 升序排序。
3. 从 `startOffset` 开始旋转数组。

例如当前存活玩家座位为 `[1, 2, 3, 4, 5]`，第一轮随机 `startOffset = 2`，则第一个 pass 的顺序是 `[3, 4, 5, 1, 2]`；下一个 pass 起点变为 3，顺序是 `[4, 5, 1, 2, 3]`。

#### 11.3.3 顺序发言模型调用

顺序发言中所有模型调用严格串行：

1. 取当前 pass 中的下一个玩家。
2. 重新读取房间，确认仍处于当前轮发言阶段，且玩家仍存活。
3. 构建 `GameContext`。
4. `await aiService.generateSpeech(context)`。
5. 模型返回后再次读取房间，确认仍处于当前轮发言阶段且上下文未失效。
6. 如果返回 `skip`，标记该玩家本轮已考虑过，记录模型调用，继续下一个玩家。
7. 如果返回 `speak`，立即保存发言、记录模型调用并广播房间快照。

顺序发言不使用普通调度中的等待和限制：

- 不等待 `AI_SPEECH_INITIAL_CHECK_MS`。
- 不检查发言冷却。
- 不使用 skip backoff。
- 不使用 `nextCheckAfterMs` 调度下一次观察。
- 不等待 `targetResponseDelayMs` 模拟真实响应时间。

顺序发言仍然保留真实讨论阶段时间限制。讨论时间到后，房间会正常进入投票阶段；串行循环下一次检查房间状态时会退出。模型调用如果在阶段切换后才返回，发言不会保存，并会打印丢弃日志。

#### 11.3.4 顺序发言退出条件

串行循环在以下情况退出：

- 房间不存在。
- 房间不再是 `playing`。
- 房间不再处于 `discussion`。
- 当前轮次变化。
- 房间不再是自动对抗调试房。
- 当前没有存活的模型驱动玩家。
- 保存发言失败。

当前 UI 只允许开局前修改顺序发言，所以运行中的顺序发言不会被用户中途关闭。

## 12. 投票兜底

模型投票失败时会进入 `chooseFallbackVoteTarget`。

AI 玩家兜底：

- 优先投存活 human 阵营玩家。
- 没有 human 阵营玩家时，投其他存活玩家。

模拟真人兜底：

- 不偷看隐藏身份。
- 优先参考本轮已记录票数中最高票的非自己存活玩家。
- 如果没有票数趋势，则随机投非自己存活玩家。

注意：这里的“票数趋势”是工程兜底策略，不是模拟真人 prompt 中可见信息。模拟真人正常模型投票只会看到“同时盲投，当前票数不可见”。

## 13. 复盘与调试

复盘新增模拟真人模型调用类型：

- `sim-human-speech`
- `sim-human-vote`

调试 prompt 接口 `GET /replay/debug/prompts` 会返回：

- AI 发言策略 system prompt。
- AI 表达转换 system prompt。
- AI 投票 system prompt。
- 当前强度下的模拟真人发言 system prompt。
- 当前强度下的模拟真人投票 system prompt。

复盘页面会展示：

- AI 玩家发言的策略层和表达层调用。
- 模拟真人发言调用。
- AI 玩家和模拟真人投票调用。
- 模拟真人身份标签。

## 14. 前端展示

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

## 15. 已知限制

- 自动对抗房仍使用字段名 `debugAutoAi`，这是兼容历史代码的命名，语义已经变化。
- 模拟真人没有长期独立记忆，只依赖当前 `GameContext` 中的历史消息和历史投票。
- 模拟真人强度目前只有 `normal` 和 `high` 两档，且只影响 prompt，不改变调度参数。
- 当前未引入上帝视角评审器；赛后分析仍依赖 replay 人工查看或后续扩展。

## 16. 后续工作

可以继续增加：

- 更细粒度的模拟真人难度档位，例如 fair / strong / expert。
- 赛后上帝视角评审器，只分析不参与场上行动。
- 自动对抗批量跑局脚本。
- AI 暴露点评分，例如被质疑次数、被投票次数、首个 AI 出局轮次。
- 模拟真人误判率、命中率和追问有效性指标。
