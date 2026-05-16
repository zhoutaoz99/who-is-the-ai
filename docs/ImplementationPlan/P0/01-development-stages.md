# 开发阶段实现方案

本文覆盖 P0 开发阶段的两个事项：

- 第一阶段：无 AI MVP
- 第二阶段：假 AI 接入

## 一、第一阶段：无 AI MVP

### 目标

跑通没有真实 AI 参与时的完整实时游戏流程，保证房间、发言、倒计时、投票、出局、胜负判定这些核心链路都由服务端权威控制。

### 范围

- 用户以临时昵称进入游戏，不要求正式账号体系。
- 支持创建房间、加入房间、房主开始游戏。
- 支持讨论阶段发言、发言冷却、投票阶段投票。
- 支持出局、轮次推进、胜负判定和游戏结束身份揭示。
- AI 可以作为占位玩家存在，但不依赖真实模型。

### 当前基础

- 后端主模块：`apps/api/src/game/game.service.ts`、`apps/api/src/game/game.gateway.ts`、`apps/api/src/game/game.types.ts`。
- 前端主模块：`apps/web/app/lib/game-client.tsx`、`apps/web/app/lib/game-types.ts`、房间页和游戏页。
- 当前已有内存房间、Socket.IO 事件、讨论阶段、投票阶段、出局、胜负判定和快照广播基础。

### 后端实现

#### 状态模型

保留当前 `Room`、`Player`、`Vote`、`ChatMessage` 基础结构，所有可变状态只在 `GameService` 中修改：

- `Room.status`：`waiting`、`playing`、`finished`
- `Room.phase`：`waiting`、`discussion`、`voting`、`resolving`、`game_over`
- `Room.currentRound`：服务端递增
- `Room.phaseEndsAt`：服务端计算
- `Player.status`：`alive`、`eliminated`
- `Vote.roundNo`：绑定服务端当前轮次

#### 房间流程

1. `room.create` 创建房间，服务端生成房间号和房主 `playerId`。
2. `room.join` 只允许 `waiting` 状态加入。
3. `game.start` 只允许房主调用，并要求至少 1 名真人玩家。
4. 开局时重置 `currentRound`、`messages`、`votes`、玩家存活状态和发言冷却。
5. 调用 `startDiscussion(room)` 进入第一轮讨论。

#### 发言流程

`chat.send` 必须满足：

- 房间存在。
- socket 对应真人玩家存在。
- 房间处于 `playing`。
- 阶段为 `discussion`。
- 玩家状态为 `alive`。
- 发言冷却已结束。
- 内容 trim 后非空，并截断到 `MESSAGE_LIMIT`。

服务端通过 `addMessage()` 记录消息，再广播 `chat.message` 和 `room.updated`。

#### 投票流程

`vote.cast` 必须满足：

- 房间存在。
- socket 对应真人玩家存在。
- 房间处于 `playing`。
- 阶段为 `voting`。
- 投票人存活。
- 投票目标存在且存活。
- 投票目标不是自己。
- 当前轮次未投过票。

投票成功后广播 `vote.updated` 和 `room.updated`。当存活玩家全部完成投票时，服务端可以提前调用 `resolveVotes(room)`。

#### 胜负判定

- 所有 AI 玩家出局，真人胜利。
- 所有真人玩家出局，AI 胜利。
- 达到最大轮数后仍有 AI 存活，AI 胜利。

如果无 AI MVP 需要完全不创建 AI，建议增加测试模式配置，不建议直接删除 AI 相关字段，避免第二阶段再改数据结构。

### 前端实现

#### 房间列表和创建

- 展示可加入房间。
- 创建房间时允许输入昵称和讨论时长。
- 创建成功后保存 `playerId` 到 `localStorage`，用于刷新或重连。

#### 房间等待页

- 展示玩家列表、房主、当前房间配置。
- 只有房主显示开始按钮。
- 未达到最小人数时禁用开始按钮。

#### 游戏页

- 根据 `phase` 切换讨论区、投票区、结算状态。
- 使用服务端 `phaseEndsAt` 或 `round.tick` 展示倒计时。
- 发言框只在讨论阶段且玩家存活时可用。
- 投票按钮只在投票阶段且玩家存活时可用。
- 游戏结束后展示胜负和身份。

### 事件协议

客户端发送：

- `room.create`
- `room.join`
- `room.leave`
- `room.reconnect`
- `game.start`
- `chat.send`
- `vote.cast`

服务端广播：

- `server.ready`
- `room.updated`
- `game.started`
- `round.started`
- `round.tick`
- `chat.message`
- `vote.started`
- `vote.updated`
- `player.eliminated`
- `game.ended`

### 验收标准

- 单机内存模式下，1 到 5 名真人玩家可以完成一整局。
- 前端无法通过伪造事件绕过阶段、存活状态、重复投票和目标合法性校验。
- 游戏结束后身份字段对前端可见，未结束时不可见。

## 二、第二阶段：假 AI 接入

### 目标

在不接入真实模型的情况下，让 AI 玩家完整走通与真人一致的发言和投票流程，验证 AI 接入点、状态流转和事件广播。

### 范围

- 房间创建时自动加入 2 名隐藏 AI 玩家。
- AI 玩家使用固定模板或规则生成发言。
- AI 玩家使用简单规则投票。
- AI 发言和投票必须复用服务端统一流程，不允许直接改投票结果或阶段状态。

### AI 玩家创建

AI 玩家应满足：

- `type = "ai"`
- `connected = true`
- `status = "alive"`
- 与真人共用 `seatNo`
- 不暴露 `type`，直到游戏结束

`room.create` 时自动创建固定数量 AI：

```text
players = [hostHuman, ai1, ai2]
seatNo = 1..N
```

P0 建议保持当前实现：创建房间时创建 AI，占位更直观。如果后续支持更复杂座位规则，再在开局时统一重排。

### 假 AI 发言

讨论阶段启动后，服务端定时尝试 AI 发言：

- 每 6 秒检查一次。
- 同一房间只允许一个 AI 同时生成发言。
- AI 必须存活。
- AI 必须满足 15 秒发言冷却。
- 按概率跳过，避免 AI 过于频繁。

模板池示例：

```text
观察型：我先听一下大家的逻辑，目前还没有特别明确的怀疑对象。
质疑型：我觉得 X 号刚才的说法有点跳，理由不是很完整。
防守型：我这轮没有太多信息，只能先看投票阶段大家怎么选。
跟进型：上一轮投票里 X 号的选择比较关键，我想听他解释一下。
```

模板生成要求：

- 只引用存活玩家座位号。
- 不暴露玩家类型。
- 不使用固定机械前缀。
- 限制在 60 到 120 字左右。

AI 发言必须调用 `addMessage(room, aiPlayer, content)`，复用消息结构、发言冷却、房间更新时间和广播。

### 假 AI 投票

进入投票阶段后，为每个存活 AI 设置错开延迟：

```text
delay = 1500ms + index * 1200ms
```

触发时必须再次校验：

- 房间仍在投票阶段。
- AI 仍存活。
- AI 本轮未投票。

投票策略：

1. 优先投给存活真人玩家。
2. 如果已有投票趋势，优先投给当前票数最高的真人。
3. 如果没有真人可投，投给其他存活玩家。
4. 如果没有合法目标，跳过，等待超时弃票规则处理。

AI 投票必须调用：

```ts
this.castVoteForPlayer(room, aiPlayer, target.id);
```

不能直接向 `room.votes` push 数据。

### 前端展示

- 游戏结束前不展示 AI 身份。
- AI 发言与真人发言在 UI 上保持一致。
- 游戏结束后通过 `revealedType` 展示身份。
- 投票结果公开时，AI 投票记录和真人投票记录格式一致。

### 验收标准

- 不配置任何模型 API 时，AI 仍能参与完整对局。
- 真人和 AI 的发言、投票、出局流程一致。
- 假 AI 行为不会造成阶段阻塞或投票重复。
