# 权威状态和基础安全实现方案

本文覆盖 P0 实现视角下的权威状态和基础安全：

- 服务端作为唯一可信状态源
- 服务端驱动倒计时和阶段切换
- 完整校验 WebSocket 行为
- 校验 AI 输出合法性
- 增加 AI 超时兜底

## 一、服务端作为唯一可信状态源

### 目标

确保所有关键游戏状态只由服务端计算和修改，前端只能提交行为意图，不能提交或覆盖房间、阶段、投票、出局和胜负结果。

### 核心原则

- 前端发送 intent，不发送 authoritative state。
- 服务端持有房间完整状态。
- 所有状态变更都通过 `GameService` 方法执行。
- 广播给客户端的是 `RoomSnapshot`，不是内部 `Room`。
- 客户端本地状态只能作为展示缓存。

### 后端实现

客户端命令只允许以下字段：

- `room.create`：昵称、讨论时长。
- `room.join`：房间号、昵称。
- `room.leave`：房间号、玩家 ID。
- `room.reconnect`：房间号、玩家 ID。
- `game.start`：房间号、玩家 ID。
- `chat.send`：房间号、内容。
- `vote.cast`：房间号、目标玩家 ID。

禁止客户端提交或覆盖：

- 当前轮次。
- 当前阶段。
- 阶段结束时间。
- 玩家身份。
- 玩家存活状态。
- 投票统计。
- 胜负结果。

所有房间状态变更只允许在 `GameService` 内部方法完成：

- `startDiscussion()`
- `startVoting()`
- `resolveVotes()`
- `finishGame()`
- `castVoteForPlayer()`
- `addMessage()`
- `disconnect()`
- `reconnect()`

`RoomSnapshot` 必须继续隐藏：

- 未结束时的玩家真实身份。
- 内部 AI source。
- 非公开投票结果。
- 服务端内部定时器信息。

游戏结束后才允许 `revealedType`。

建议为 `Room` 增加：

```ts
version: number;
```

每次 `touch(room)` 时递增。前端可以用版本避免旧快照覆盖新快照。

### 前端实现

- 前端不根据本地倒计时自行切阶段。
- 所有按钮点击都调用 Socket 事件并等待服务端结果。
- 收到 `room.updated` 后覆盖本地房间快照。
- 如果本地判断可操作但服务端拒绝，展示服务端错误并刷新房间。

### 验收标准

- 任意客户端 payload 不能直接改变服务端权威状态。
- 所有状态变更都可在 `GameService` 中追踪。
- 前端刷新或多端打开时，最终状态以服务端快照为准。

## 二、服务端驱动倒计时和阶段切换

### 目标

确保讨论、投票、结算和游戏结束全部由服务端定时器驱动，客户端只负责展示倒计时和阶段状态。

### 状态设计

每个房间同一时间最多存在：

- 一个阶段结束 timer。
- 一个 tick interval。
- 一个 AI 发言 interval。
- 若干 AI 投票 timeout。

建议扩展 `RoomTimers`：

```ts
type RoomTimers = {
  phase?: NodeJS.Timeout;
  tick?: NodeJS.Timeout;
  aiSpeech?: NodeJS.Timeout;
  aiVotes?: NodeJS.Timeout[];
};
```

`clearTimers(room.id)` 必须清理所有 timer。

### 阶段切换流程

`startDiscussion(room)`：

1. 清理旧 timers。
2. `currentRound += 1`。
3. `phase = "discussion"`。
4. `phaseEndsAt = futureIso(discussionDurationMs)`。
5. 广播 `round.started` 和 `room.updated`。
6. 启动 tick。
7. 启动 AI 发言。
8. 设置阶段 timer 到点进入 `startVoting(room)`。

`startVoting(room)`：

1. 清理旧 timers。
2. `phase = "voting"`。
3. `phaseEndsAt = futureIso(VOTE_DURATION_MS)`。
4. 广播 `vote.started` 和 `room.updated`。
5. 启动 tick。
6. 调度 AI 投票。
7. 设置阶段 timer 到点进入 `resolveVotes(room)`。

`resolveVotes(room)`：

1. 防止重复执行。
2. 清理旧 timers。
3. `phase = "resolving"`。
4. 补齐弃票。
5. 计算出局或重投。
6. 判断胜负。
7. 未结束时延迟 3 秒进入下一轮。

### 防重复触发

需要处理两类重复：

- 所有人提前投票后触发 `resolveVotes()`。
- 投票阶段 timer 到点又触发 `resolveVotes()`。

建议增加房间级锁：

```ts
private readonly resolvingRooms = new Set<string>();
```

`resolveVotes()` 开头检查当前房间是否正在结算，同时校验当前阶段必须是 `voting` 或 `revote`。

### 前端实现

- 以 `phaseEndsAt` 计算本地剩余时间，用 `round.tick` 修正。
- 前端倒计时归零后不自行切换 UI 到下一阶段，等待服务端快照。
- 如果 tick 丢失，仍以最新 `room.updated` 为准。

### 验收标准

- 客户端无法通过修改本地时间影响阶段。
- 阶段切换事件顺序稳定。
- 任意房间结束或删除后没有残留定时器继续广播。

## 三、WebSocket 行为完整校验

### 目标

为所有 Socket.IO 入口建立一致的校验规则，保证非法事件不会改变房间状态，并返回明确错误。

### 校验分层

Gateway 层只负责：

- 接收事件。
- 补齐空 payload。
- 传入 socket id。
- 根据成功结果加入或离开 Socket.IO room。

`GameService` 负责所有业务校验：

- 房间是否存在。
- 玩家是否属于房间。
- 玩家是否真人或 AI。
- 玩家是否存活。
- 当前房间状态。
- 当前游戏阶段。
- 行为目标是否合法。
- 行为是否重复。

### 事件校验清单

`room.create`：

- 昵称长度最多 16。
- 讨论时长最小 1 分钟。
- 服务端生成房间 ID、玩家 ID、座位号。

`room.join`：

- `roomId` 非空且存在。
- 房间必须是 `waiting`。
- 真人人数未满。
- 昵称规范化。

`room.leave`：

- 房间存在。
- `playerId` 属于该房间真人玩家。
- 仅等待房间允许离开。
- 房主离开时转移房主。
- 无真人后删除房间。

`room.reconnect`：

- 房间存在。
- `playerId` 属于该房间真人玩家。
- 重新绑定 socket。
- 取消等待房间的移除 timer。

`game.start`：

- 房间存在。
- 房间必须是 `waiting`。
- 调用者必须是房主。
- 至少 1 名真人玩家。

`chat.send`：

- 房间存在。
- socket 对应真人玩家存在。
- 房间必须是 `playing`。
- 阶段必须是 `discussion`。
- 玩家必须存活且在线。
- 发言冷却结束。
- 内容合法且通过质量校验。

`vote.cast`：

- 房间存在。
- socket 对应真人玩家存在。
- 房间必须是 `playing`。
- 阶段必须是 `voting` 或 `revote`。
- 投票人必须存活且在线。
- 目标必须存活。
- 目标不能是自己。
- 重投阶段目标必须在候选人中。
- 当前轮次当前投票阶段未投过票。

### Payload 规范化

新增统一工具：

```ts
private normalizeString(value: unknown): string
```

所有 payload 字段先经过类型判断和 trim，避免传入对象、数组、数字导致异常。

### 验收标准

- 所有 WebSocket 行为都有服务端校验。
- 非法行为不会改变 `Room`。
- 错误响应稳定、可展示、不会让客户端卡 pending。

## 四、AI 输出合法性校验

### 目标

确保 AI 输出只能作为行为意图，必须经过服务端结构、内容、目标和阶段校验后，才允许转化为游戏行为。

### 输出 Schema

发言：

```ts
type AiSpeechAction =
  | { type: "speak"; content: string }
  | { type: "skip" };
```

校验规则：

- `type` 必须是 `speak` 或 `skip`。
- `content` 必须是字符串。
- trim 后非空。
- 长度不超过 `MESSAGE_LIMIT`。
- 通过消息质量校验。

投票：

```ts
type AiVoteAction = {
  type: "vote";
  targetPlayerId: string;
  reason?: string;
};
```

校验规则：

- `type` 必须是 `vote`。
- `targetPlayerId` 必须是字符串。
- 目标必须存在、存活、不是自己。
- 重投阶段目标必须属于重投候选人。
- `reason` 可选，最多截断到 120 字符。

### 后端实现

`AiService` 只判断模型输出能否转成候选 action，不直接修改房间，也不判断完整游戏规则。

AI 发言最终必须调用 `addMessage(room, aiPlayer, action.content)`。调用前需要复用校验：

```ts
const validationError = this.validateCanSpeak(room, aiPlayer)
  ?? this.validateMessageContent(room, aiPlayer, action.content);
```

AI 投票必须继续调用 `castVoteForPlayer(room, aiPlayer, targetId)`，让它经过统一投票校验。

当前 `parseVoteResult()` 只校验目标在 `alivePlayers` 中，而 `alivePlayers` 包含自己。应改为：

```ts
const isValidTarget = context.alivePlayers.some(
  (p) => p.id === parsed.targetPlayerId && p.id !== aiPlayerId,
);
```

### 错误处理

- 发言解析失败：返回 `skip`。
- 发言内容非法：返回 `skip`，记录 warn。
- 投票解析失败：返回 `null`，进入兜底投票。
- 投票目标非法：返回 `null`，进入兜底投票。

### 验收标准

- 任意 AI 输出不能直接绕过服务端规则。
- 非法 AI 输出不会导致游戏异常或卡局。
- 所有 AI 行为最终都经过和真人同源的状态校验。

## 五、AI 超时兜底

### 目标

保证 AI 模型调用慢、失败或返回非法结果时，对局仍能按时推进，AI 行为不会阻塞讨论、投票和阶段结算。

### 发言兜底

规则：

- AI 发言模型超时：跳过本次发言。
- AI 发言解析失败：跳过本次发言。
- AI 发言内容非法：跳过本次发言。
- 跳过不会广播消息，也不会更新 `lastSpokeAt`。

`GameService.startAiSpeech()` 中必须确保：

- `finally` 一定释放 `aiSpeaking`。
- 调用返回后再次检查房间阶段仍是 `discussion`。
- 如果阶段已切换，不再写入消息。

### 投票兜底

AI 投票失败后按以下顺序选择目标：

1. 当前允许投票目标中的真人玩家。
2. 当前票数最高的真人玩家。
3. 任意其他存活玩家。
4. 找不到目标则不投，最终由超时弃票记录处理。

如果处于重投阶段，目标集合必须限制在重投候选人内。

改造 `chooseFallbackVoteTarget(room, aiPlayer)`：

- 接收可选 `allowedTargetIds`。
- 先过滤存活、非自己、在允许目标集合内。
- 优先真人。
- 如果已有投票趋势，优先当前票数高的真人。
- 最后随机。

AI 兜底投票仍调用：

```ts
this.castVoteForPlayer(room, aiPlayer, target.id)
```

### 超时配置

建议配置：

```text
AI_TIMEOUT_MS=5000
AI_VOTE_DELAY_BASE_MS=1500
AI_VOTE_DELAY_STEP_MS=1200
```

投票阶段只有 30 秒，AI 单次调用 15 秒风险较高。P0 建议投票超时不超过 5 秒，发言可以稍长但不应超过 10 秒。

### 定时器清理

`scheduleAiVotes()` 当前使用裸 `setTimeout()`，建议保存到 `RoomTimers.aiVotes`。`clearTimers()` 清理所有 AI 投票 timeout，防止阶段结束后迟到投票。

AI vote 回调开始和模型返回后都要检查：

- 房间仍存在。
- `room.phase` 仍是 `voting` 或 `revote`。
- `room.status` 仍是 `playing`。
- AI 玩家仍存活且未投票。

### 验收标准

- AI 模型不可用时，游戏仍能完整结束。
- AI 调用不会阻塞阶段 timer。
- 所有 AI 失败路径都有明确兜底或安全跳过。
