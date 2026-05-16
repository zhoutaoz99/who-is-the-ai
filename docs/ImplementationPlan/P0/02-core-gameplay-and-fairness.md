# 核心玩法和公平规则实现方案

本文覆盖 P0 业务视角下的核心玩法和公平规则：

- 明确平票处理规则
- 明确超时未投票规则
- 明确掉线和异常行为处理
- 增加无意义消息和作弊判定
- 提升 AI 对抗可信度

## 一、平票处理规则

### 目标

定义并实现投票平票时的确定性处理，避免相同最高票无法结算导致争议或卡局。

### 推荐规则

1. 投票阶段结束后统计当前轮次票数。
2. 如果最高票唯一，最高票玩家出局。
3. 如果最高票平票，进入 30 秒重新投票阶段。
4. 重新投票仅允许投给本次平票候选人。
5. 重新投票仍然平票，则本轮无人出局，进入下一轮。
6. 如果已经是最大轮次，重新投票仍平票后按胜负规则结算。

### 状态设计

建议扩展 `GamePhase`：

```ts
type GamePhase =
  | "waiting"
  | "discussion"
  | "voting"
  | "revote"
  | "resolving"
  | "game_over";
```

扩展 `Room`：

```ts
interface Room {
  voteRound: number;
  revoteTargetIds: string[];
}
```

其中 `voteRound = 1` 表示正常投票，`voteRound = 2` 表示平票后的重新投票。

### 后端实现

建议扩展 `Vote`：

```ts
interface Vote {
  id: string;
  roundNo: number;
  voteStage: "normal" | "revote";
  voterPlayerId: string;
  targetPlayerId: string;
  createdAt: string;
}
```

拆分当前 `resolveElimination(room)`：

1. `getRoundVotes(room, stage)`：获取当前轮次、当前投票阶段的票。
2. `countVotes(votes)`：统计票数。
3. `getTopVoteResult(counts)`：返回最高票候选和票数。
4. `resolveVotes(room)` 根据结果决定出局、重投或无人出局。

新增 `startRevote(room, targetIds)`：

- 清理当前定时器。
- 设置 `phase = "revote"`。
- 设置 `phaseEndsAt = futureIso(30_000)`。
- 设置 `revoteTargetIds = targetIds`。
- 广播 `vote.started` 或新增 `revote.started`。
- 启动 tick。
- 调度 AI 重投。
- 30 秒后再次 `resolveVotes(room)`。

`castVoteForPlayer()` 需要根据阶段判断目标：

- `voting`：目标必须是任意存活玩家，且不能是自己。
- `revote`：目标必须是 `revoteTargetIds` 中的存活玩家，且不能是自己。

重复投票校验也要区分 `voteStage`，避免玩家正常投票后无法参与重投。

### 前端实现

- `GamePhase` 增加 `revote`。
- 投票面板在 `revote` 阶段只展示平票候选人。
- 倒计时文案区分“投票阶段”和“重新投票阶段”。
- 如果本轮无人出局，时间线展示“平票，无人出局”。

### 验收标准

- 平票不会让房间卡在 `resolving`。
- 所有客户端看到一致的重投候选人和倒计时。
- 投票记录能区分正常投票和重新投票。

## 二、超时未投票规则

### 目标

定义投票阶段超时未投票的处理方式，避免玩家不操作导致房间卡死，并确保投票统计可解释。

### 推荐规则

1. 投票阶段固定时长结束时自动结算。
2. 未投票玩家视为弃票。
3. 弃票不计入任何候选人的票数。
4. 弃票记录需要保留，方便复盘。
5. 所有存活玩家都提前投票后，可以提前进入结算。

### 数据结构

建议新增弃票记录，而不是只在结算时忽略未投票玩家：

```ts
type VoteChoice = "player" | "abstain";

interface Vote {
  id: string;
  roundNo: number;
  voteStage: "normal" | "revote";
  voterPlayerId: string;
  targetPlayerId: string | null;
  choice: VoteChoice;
  autoSubmitted: boolean;
  createdAt: string;
}
```

字段含义：

- `targetPlayerId = null` 表示弃票。
- `autoSubmitted = true` 表示服务端因超时自动补齐。

### 后端实现

新增 `ensureAbstainVotes(room, stage)`：

1. 获取当前轮次当前阶段所有存活玩家。
2. 获取已投票玩家集合。
3. 对未投票玩家追加弃票记录。
4. `touch(room)` 并广播最终投票状态。

`resolveVotes(room)` 开头调用：

```ts
this.ensureAbstainVotes(room, this.getCurrentVoteStage(room));
```

统计票数时只统计 `choice === "player"` 且 `targetPlayerId` 非空的投票。如果所有人弃票，本轮无人出局。

### 前端实现

- 投票阶段展示“未投票人数”或“已投票/总人数”。
- P0 阶段可以只支持超时自动弃票，不开放主动弃票按钮。
- 复盘和投票结果中展示“弃票”，避免玩家误以为系统漏计。

### 验收标准

- 投票阶段一定能在 `VOTE_DURATION_MS` 后结束。
- 投票统计中不把弃票计入任何玩家。
- 复盘数据能解释每名存活玩家本轮投票或弃票状态。

## 三、掉线和异常行为处理

### 目标

定义玩家掉线、重连、断线托管和异常操作的处理方式，降低实时对局中断风险，并避免掉线玩家影响公平性。

### 推荐规则

1. 等待房间中掉线，保留 30 秒，未重连则移出房间。
2. 游戏中掉线，不立即移出，玩家状态标记为 disconnected。
3. 游戏中掉线玩家不能发言，投票阶段超时视为弃票。
4. 掉线玩家重连后恢复同一 `playerId` 和座位。
5. 出局玩家掉线不影响对局推进。
6. 异常重复操作、非法阶段操作、非法目标操作都返回错误，不改变房间状态。

### 后端实现

当前已有 `Player.connected`、`room.reconnect`、`disconnect(socketId)` 和等待房间 30 秒移除逻辑。需要补齐：

- `room.reconnect` 校验 `roomId` 存在，`playerId` 属于该房间真人玩家。
- 如果玩家已被其他 socket 连接，允许新 socket 覆盖旧 socket。
- 游戏中掉线只设置 `connected = false` 和 `socketId = undefined`，不修改 `Player.status`。
- 等待房间中房主掉线并被移除后，转移房主给下一名真人。
- 房间无人时清理定时器并删除房间。

所有异常操作统一返回 `ActionResult`：

- 不存在的房间：`房间不存在`
- 不在房间：`你不在该房间中`
- 非房主开始游戏：`只有房主可以开始游戏`
- 游戏中离开：`游戏进行中，无法离开`
- 非发言阶段发言：`当前不在发言阶段`
- 出局后发言或投票：`已出局玩家不能发言/投票`
- 重复投票：`本轮已经投过票`
- 无效投票目标：`投票目标无效`

### 前端实现

- 玩家列表展示在线/离线状态。
- 如果当前玩家掉线后重连，自动调用 `room.reconnect`。
- 如果重连失败，提示“房间不存在或身份已失效”。
- 发言和投票按钮依赖服务端响应，不只依赖本地状态。

### 验收标准

- 掉线不会导致房间状态异常或服务端抛错。
- 游戏中掉线不会阻塞阶段推进。
- 重连后玩家身份、座位、出局状态保持一致。

## 四、无意义消息和作弊判定

### 目标

建立最小可用的消息质量和作弊判定机制，限制刷屏、空洞内容、重复内容和明显作弊文本，保护讨论体验。

### P0 范围

P0 不做复杂语义风控，只做确定性规则：

- 空消息过滤。
- 长度限制。
- 频率限制。
- 重复消息限制。
- 连续低质量消息限制。
- 明显作弊关键词拦截。

### 判定规则

发言内容必须满足：

- trim 后非空。
- 长度在 1 到 240 字符。
- 不全是标点、数字、空白或重复字符。
- 不包含超长连续重复字符，例如 `aaaaaa`、`哈哈哈哈哈哈哈哈`。

同一玩家最近 3 条发言中，如果标准化后内容相同，拒绝发送。标准化方式：

- trim。
- 多空格合并为一个空格。
- 转小写。
- 去除首尾标点。

除 15 秒发言冷却外，再增加房间级限流：

- 同一房间 10 秒内最多接受 10 条真人发言。
- 超出后返回“当前发言过于频繁，请稍后再试”。

### 后端实现

新增消息校验函数：

```ts
private validateMessageContent(room: Room, player: Player, content: string): string | null
```

校验顺序：

1. 空内容。
2. 低信息密度。
3. 重复内容。
4. 房间级频率。
5. 作弊关键词。

低信息密度判定：

- 去掉空格和标点后长度为 0。
- 同一字符占比超过 80%，且长度大于 8。
- 仅包含数字或单一符号。

作弊关键词 P0 可先用常量维护：

```ts
const CHEAT_PATTERNS = [
  /系统提示词/,
  /prompt/i,
  /api[_ -]?key/i,
  /控制台/,
  /抓包/,
  /localStorage/i,
];
```

### 前端实现

- 发送失败时展示服务端返回错误。
- 发言框保留 240 字符限制。
- 冷却和限流都以服务端结果为准。
- 不在前端暴露完整风控规则，避免被规避。

### 验收标准

- 低质量消息不会进入 `room.messages`。
- 被拒绝消息不会触发 `chat.message` 和 `room.updated`。
- 风控失败返回可读错误，不影响房间其他玩家。

## 五、提升 AI 对抗可信度

### 目标

补齐 AI 只看当前轮次讨论记录的问题，让 AI 发言和投票能引用跨轮次信息、历史投票和自身发言，降低被真人通过上下文缺失识别的概率。

### 当前问题

当前 `buildGameContext()` 已经传入当前轮次最近 20 条聊天、AI 自己上一次发言、当前投票统计和历史投票摘要。仍需补齐：

- 最近聊天只取当前轮次。
- 缺少跨轮次关键发言摘要。
- 缺少每名玩家的行为画像。
- 缺少 AI 自己前后立场一致性约束。

### 上下文设计

扩展 `GameContext`：

```ts
interface GameContext {
  roundNo: number;
  phase: string;
  remainingTimeMs: number;
  myName: string;
  mySeatNo: number;
  alivePlayers: Array<{ id: string; seatNo: number }>;
  recentMessages: ChatMessageInput[];
  previousRoundMessages: ChatMessageInput[];
  playerBehaviorSummaries: PlayerBehaviorSummary[];
  mySpeechHistory: string[];
  myVoteHistory: Array<{ roundNo: number; targetSeatNo: number | null }>;
  currentVoteCounts: Record<string, number>;
  voteHistory: RoundVoteSummary[];
}
```

P0 阶段 `PlayerBehaviorSummary.suspicionTags` 可以由规则生成，不调用模型。

### 后端实现

`buildGameContext()` 中增加：

- 当前轮次最近 20 条。
- 前两轮每轮最近 8 条。
- 所有轮次中点名当前 AI 的最近 10 条。

从 `room.messages` 和 `room.votes` 生成玩家行为摘要：

- 每名玩家发言次数。
- 每名玩家最近一次发言轮次。
- 每名玩家历史投票目标。
- 每名玩家被投票次数。
- 是否多次跟票。
- 是否长期沉默。

为当前 AI 传入：

- 最近 5 条自己的发言。
- 历史投票目标。
- 上轮是否被投票。

Prompt 中要求 AI 不要否认自己前面说过的话，可以修正判断但需要自然理由，不要表现出只记得本轮内容。

### Token 控制

上下文截断顺序：

1. 当前轮次最近消息优先。
2. 点名自己的消息优先。
3. 投票历史优先于完整聊天。
4. 旧轮次聊天只保留摘要或少量代表消息。

### 验收标准

- `GameContext` 包含跨轮次信息和玩家行为摘要。
- AI 发言在多轮对局中能保持基本立场连续。
- 上下文构建不会泄露其他玩家真实身份。
