# AI 狼人杀实现方案设计

## 目标

基于当前玩法设计，实现一款真人玩家与 AI 玩家共同参与的实时社交推理游戏。系统需要支持房间、开放发言、轮次倒计时、投票出局、胜负判定、积分结算，以及 AI 玩家自动发言和投票。

## 技术栈选择

### 前端框架

推荐使用 `Next.js App Router + React + TypeScript`。

核心选型理由：

- 适合承载房间页、游戏页、战绩页、排行榜、复盘页等 Web App 页面。
- App Router 是基于文件系统的路由方案，并支持 React Server Components、Suspense 和 Server Functions，适合同时处理页面路由、数据加载和部分服务端逻辑。
- 游戏内实时交互主要发生在客户端，React 组件模型适合拆分玩家列表、聊天区、倒计时、投票面板、结算弹窗等高频 UI 状态。
- TypeScript 可以约束游戏状态、WebSocket 事件和接口数据结构。
- Next.js 生态成熟，后续扩展登录、战绩、排行榜、复盘、SEO 页面和运营页面成本较低。
- 如果前后端分离，Next.js 可以只承担前端页面；如果早期需要快速开发，也可以用 Route Handlers 承担少量后台接口。

适合本项目的原因：

- AI 狼人杀既有实时游戏界面，也有普通业务页面。Next.js 比纯 SPA 更适合承载完整产品形态。
- 游戏页需要大量客户端状态，但房间列表、战绩、复盘等页面又适合服务端渲染或服务端数据加载。
- 团队可以使用统一的 TypeScript 类型定义前端状态、REST DTO 和 WebSocket 事件。

不足与规避：

- Next.js 自身不适合作为权威实时游戏服务器，长连接、倒计时、投票结算仍应放在独立后台。
- WebSocket 不建议直接依赖 Serverless Function 承载，应由 NestJS 或其它常驻进程服务处理。
- 游戏页应明确标记为 Client Component，避免把高频实时状态放进服务端组件模型里。

配套方案：

- UI：`Tailwind CSS + shadcn/ui`
- 实时通信客户端：`socket.io-client`
- 前端状态管理：`Zustand`
- 数据请求：`TanStack Query`
- 表单与数据校验：`Zod`

#### 前端备选方案

| 方案 | 适用场景 | 优点 | 不足 |
| --- | --- | --- | --- |
| `Vite + React + TypeScript` | 只做纯前端 SPA，后台完全独立 | 启动快，结构简单，实时游戏页开发直接 | 需要自行补齐路由、SSR、SEO、BFF 等能力 |
| `Nuxt + Vue + TypeScript` | 团队更熟悉 Vue 生态 | 全栈能力完整，页面开发体验好 | React 生态组件和 AI 应用示例相对更少 |
| `SvelteKit + TypeScript` | 追求轻量交互和更少样板代码 | 组件代码简洁，性能表现好 | 团队招聘、组件生态和大型项目经验相对少 |
| `Remix + React + TypeScript` | 强调 Web 标准、表单和服务端数据流 | 数据加载和表单模型清晰 | 国内团队使用面相对 Next.js 更小 |
| `Expo / React Native` | 直接做移动 App | 可以复用部分 React 和 TypeScript 经验 | Web 房间分享、快速上线和运营页面成本更高 |

推荐结论：

- MVP Web 版本优先选择 `Next.js App Router + React + TypeScript`。
- 如果项目只做一个纯游戏房间页，没有排行榜、复盘、运营页面，可以选择 `Vite + React` 降低复杂度。
- 如果团队主力是 Vue，选择 `Nuxt` 比强行使用 Next.js 更现实。

### 后台框架

推荐使用 `NestJS + Socket.IO + PostgreSQL + Redis`。

核心选型理由：

- NestJS 提供模块、Provider、依赖注入、Guard、Pipe、Interceptor 等结构化能力，适合拆分房间、游戏、聊天、投票、奖励、AI 等业务模块。
- NestJS 官方支持 WebSocket Gateway，并可使用 Socket.IO 或 `ws` 作为底层实现。
- Socket.IO 支持房间机制，适合按游戏房间广播聊天、倒计时、投票和出局事件。
- PostgreSQL 适合持久化用户、房间、对局、投票、积分流水等结构化数据。
- Redis 适合存储实时房间状态、倒计时、限流信息，并支持多实例 WebSocket 扩展。
- Node.js + TypeScript 可以与前端共享类型，降低事件协议、DTO 和业务状态不一致的风险。

适合本项目的原因：

- 该游戏不是简单 CRUD，而是以状态机和实时事件为核心。NestJS 的模块边界比 Express 这类轻量框架更适合长期维护。
- AI Core、游戏状态机、投票结算、积分结算都需要明确服务边界，NestJS 的依赖注入便于做单元测试和替换实现。
- Socket.IO 的房间广播能力与游戏房间模型天然匹配。
- 后续如果需要多实例部署，可以通过 Redis 扩展 Socket.IO 广播能力。

不足与规避：

- NestJS 学习成本高于 Express 或 Hono，MVP 初期需要先约定模块边界和目录结构。
- 实时状态不能只放在进程内存中，正式环境需要 Redis 或数据库兜底，避免实例重启导致游戏丢失。
- Socket.IO 不是原生 WebSocket 协议，若未来要接入非浏览器客户端，需要额外评估协议兼容。

配套方案：

- Web 框架：`NestJS`
- 实时网关：`@nestjs/websockets + socket.io`
- 数据库：`PostgreSQL`
- ORM：`Prisma`
- 缓存、队列、限流：`Redis + BullMQ`
- 鉴权：`JWT`
- 部署：前端可部署在 Vercel，后端可部署在 Fly.io、Railway、Render、ECS 等平台

#### 后台备选方案

| 方案 | 适用场景 | 优点 | 不足 |
| --- | --- | --- | --- |
| `FastAPI + WebSocket + PostgreSQL + Redis` | 团队主力是 Python，AI 服务也希望用 Python | 类型提示、Pydantic 校验、OpenAPI 支持好，和 AI 生态衔接自然 | 前端 TypeScript 类型复用较弱，复杂实时房间工程化需要额外约束 |
| `Express + Socket.IO` | 极快验证 MVP，团队熟悉 Node.js | 上手快，资料多，Socket.IO 集成直接 | 大型项目容易缺少清晰模块边界，需要自己建立工程规范 |
| `Hono + WebSocket` | 追求轻量、边缘运行或小型 API 服务 | 性能好，API 简洁，基于 Web 标准 | 复杂游戏状态机、队列、后台任务和大型团队协作需要更多自建约定 |
| `Spring Boot + WebSocket/STOMP` | 团队 Java 能力强，偏企业级稳定性 | 工程化、事务、监控、权限体系成熟 | 开发速度和前端类型共享不如 TypeScript 全栈，AI 接入样板更多 |
| `Go + Gin/Fiber + WebSocket` | 高并发、低资源占用优先 | 性能好，部署简单，资源占用低 | 业务迭代速度和生态便利性不如 Node.js/Python |
| `Laravel + Broadcasting` | 团队熟悉 PHP，已有 Laravel 体系 | 业务后台、用户系统、队列和广播体系成熟 | 实时游戏状态机和 AI 服务通常需要额外拆分服务 |
| `Colyseus + Node.js` | 更偏游戏服务器，强调房间状态同步 | 房间、状态同步、多人游戏模型更强 | 常规业务后台能力弱，仍需搭配独立 API 服务 |

推荐结论：

- 综合实时房间、业务后台、AI 调用和前端类型共享，优先选择 `NestJS + Socket.IO`。
- 如果团队 AI 工程主要使用 Python，并希望 AI Core 与后台放在同一语言栈，可以选择 `FastAPI`。
- 如果只想最快验证玩法，可先用 `Express + Socket.IO`，但正式化前建议迁移到 NestJS 或补齐工程规范。
- 如果未来游戏状态同步复杂度显著提高，可以评估 `Colyseus` 作为专门的游戏房间服务，NestJS 继续负责账号、积分、战绩和管理后台。

### AI Core 框架

推荐使用 `OpenAI Agents SDK + Responses API + Structured Outputs`。

选择理由：

- AI 玩家只需要完成发言和投票决策，链路相对明确。
- Structured Outputs 可以强制 AI 返回结构化结果，降低解析失败和非法输出风险。
- Agents SDK 适合封装 AI 玩家人设、工具调用和行为策略。
- 游戏规则应由后端 Game Engine 强制执行，AI Core 只输出行为意图。

暂不建议 MVP 阶段直接使用 LangGraph。当前玩法的 AI 决策主要是读取状态、生成发言、生成投票，直接使用 OpenAI Agents SDK 更轻量。后续如果出现复杂多阶段推理、长期策略状态、AI 协作或多模型编排，再考虑引入 LangGraph。

## 整体架构

```text
Next.js Client
  |
  | REST: 登录、房间列表、战绩、排行榜、复盘
  | WebSocket: 聊天、倒计时、投票、游戏状态
  v
NestJS Backend
  |
  |-- Auth Module
  |-- Room Module
  |-- Game Module
  |-- Chat Module
  |-- Vote Module
  |-- Reward Module
  |-- AI Core Module
  |
  |-- PostgreSQL: 持久化数据
  |-- Redis: 房间状态、队列、限流、Socket.IO 扩展
  v
OpenAI / 兼容 OpenAI API 的模型服务
```

## 核心设计原则

- 后端是游戏状态的唯一可信来源。
- AI 输出只能作为行为意图，不能直接修改游戏状态。
- 真人玩家和 AI 玩家尽量走同一套发言、投票和出局流程。
- 所有关键游戏事件需要持久化，方便赛后复盘和问题排查。
- 先实现纯文本 MVP，再考虑语音、视频或更复杂的角色技能。

## 后端模块设计

### Auth Module

负责用户登录、身份校验和会话管理。

主要能力：

- 用户注册和登录
- JWT 签发与校验
- WebSocket 连接鉴权
- 用户基础信息读取

### Room Module

负责房间创建、加入、退出和房间状态广播。

主要能力：

- 创建房间
- 加入房间
- 退出房间
- 房间人数检查
- 房主开始游戏
- 房间状态广播

### Game Module

负责游戏主流程和状态机。

建议状态机：

```text
WAITING
  -> READY
  -> ASSIGNING
  -> DISCUSSION
  -> VOTING
  -> RESOLVING
  -> DISCUSSION | GAME_OVER
```

主要能力：

- 分配 2 名 AI 玩家和 5 名真人玩家
- 控制 4 轮游戏流程
- 管理讨论阶段和投票阶段
- 执行玩家出局
- 判断真人胜利或人类玩家失败
- 触发积分结算

### Chat Module

负责开放发言和聊天记录。

主要能力：

- 接收玩家发言
- 校验玩家是否存活
- 校验 15 秒发言冷却
- 限制发言长度
- 过滤空消息和异常消息
- 广播聊天内容
- 持久化聊天记录

### Vote Module

负责每轮投票。

主要能力：

- 开启投票阶段
- 校验投票资格
- 限制每名玩家每轮只能投 1 票
- 统计票数
- 生成出局结果
- 广播投票进度和结果

建议补充规则：

- 平票时进入 30 秒重新投票。
- 重新投票仍平票时，本轮无人出局。
- 超时未投票视为弃票。

### Reward Module

负责积分奖励和积分流水。

主要能力：

- 判断真人玩家是否获胜
- 真人玩家获胜时，将 2000 积分平分给获胜真人玩家
- 写入积分流水
- 后续支持个人贡献奖励

建议使用积分流水表，不直接只更新用户余额，方便审计和回滚。

### AI Core Module

负责 AI 玩家的发言和投票决策。

主要能力：

- 创建 AI 玩家上下文
- 生成 AI 发言
- 生成 AI 投票
- 控制 AI 发言频率
- 处理模型超时和失败兜底
- 记录 AI 行为日志

AI Core 内部建议拆分：

- `AiPlayerAgent`：单个 AI 玩家的 Agent 配置
- `AiOrchestrator`：决定何时触发 AI 行动
- `PromptBuilder`：组装当前局面、聊天记录、AI 人设和目标
- `ModelClient`：封装模型 API 调用
- `ActionSchema`：定义结构化输出格式
- `AiMemoryStore`：记录本局短期记忆和策略摘要

## AI 行为设计

### 发言策略

- AI 玩家在讨论阶段自动发言。
- 每个 AI 应遵守和真人相同的 15 秒发言冷却。
- AI 不应过于频繁发言，建议每 20 到 45 秒按概率触发一次。
- 当 AI 被点名、质疑或票数上升时，提高回应概率。
- 单次发言建议限制在 60 到 120 字。

### 投票策略

- 投票阶段每个存活 AI 必须提交一票。
- AI 只能投给当前存活玩家。
- AI 不应投给已出局玩家或不存在的玩家。
- 如果模型超时，使用兜底策略投票。

兜底策略示例：

- 优先选择当前票数较高的真人玩家。
- 如果没有明显目标，则随机选择一名存活真人玩家。
- 如果只剩 AI 玩家，则按游戏状态直接进入结算。

### AI 输出格式

AI 输出不要直接使用自然语言自由解析，应强制使用结构化 JSON。

```ts
type AiAction =
  | {
      type: "speak";
      content: string;
      publicReason?: string;
    }
  | {
      type: "vote";
      targetPlayerId: string;
      publicReason?: string;
    }
  | {
      type: "skip";
    };
```

### Prompt 输入内容

建议传入以下信息：

- 游戏规则
- 当前轮数
- AI 玩家身份和目标
- 当前存活玩家列表
- 最近聊天记录
- AI 上次发言
- 当前投票趋势
- 当前被怀疑程度
- 输出格式要求

注意：不要要求模型输出详细内心推理链。只需要保存短理由、决策结果和调试标签。

## WebSocket 事件设计

### 客户端发送

```text
room.join
room.leave
game.start
chat.send
vote.cast
```

### 服务端广播

```text
room.updated
game.started
round.started
round.tick
chat.message
vote.started
vote.updated
player.eliminated
game.ended
```

### 服务端校验

服务端必须校验：

- 用户是否已登录
- 用户是否在房间内
- 用户是否仍存活
- 当前是否处于允许发言阶段
- 当前是否处于允许投票阶段
- 发言冷却是否结束
- 投票目标是否合法
- 用户是否已经投过票

## 数据库表设计

### users

用户表。

关键字段：

- `id`
- `nickname`
- `avatar_url`
- `point_balance`
- `created_at`
- `updated_at`

### rooms

房间表。

关键字段：

- `id`
- `owner_user_id`
- `status`
- `max_human_players`
- `ai_player_count`
- `created_at`
- `updated_at`

### games

对局表。

关键字段：

- `id`
- `room_id`
- `status`
- `current_round`
- `winner`
- `started_at`
- `ended_at`

### game_players

对局玩家表。

关键字段：

- `id`
- `game_id`
- `user_id`
- `ai_profile_id`
- `type`
- `status`
- `seat_no`
- `eliminated_round`

### rounds

轮次表。

关键字段：

- `id`
- `game_id`
- `round_no`
- `phase`
- `started_at`
- `ended_at`

### chat_messages

聊天消息表。

关键字段：

- `id`
- `game_id`
- `round_id`
- `sender_player_id`
- `content`
- `source`
- `created_at`

### votes

投票表。

关键字段：

- `id`
- `game_id`
- `round_id`
- `voter_player_id`
- `target_player_id`
- `created_at`

### ai_profiles

AI 玩家配置表。

关键字段：

- `id`
- `name`
- `persona`
- `difficulty`
- `model`
- `temperature`

### ai_action_logs

AI 行为日志表。

关键字段：

- `id`
- `game_id`
- `round_id`
- `ai_player_id`
- `action_type`
- `input_snapshot`
- `output_action`
- `model`
- `latency_ms`
- `created_at`

### point_ledger

积分流水表。

关键字段：

- `id`
- `user_id`
- `game_id`
- `change_amount`
- `reason`
- `created_at`

## 前端页面设计

### 房间列表页

主要功能：

- 查看可加入房间
- 创建房间
- 加入房间
- 查看房间人数和状态

### 房间等待页

主要功能：

- 展示当前玩家
- 展示 AI 数量、真人数量和游戏配置
- 房主开始游戏
- 玩家退出房间

### 游戏页

主要功能：

- 展示当前轮数和剩余时间
- 展示存活玩家和出局玩家
- 展示聊天区
- 支持玩家发言
- 展示发言冷却
- 投票阶段展示投票面板
- 游戏结束后展示胜负结果

### 复盘页

主要功能：

- 展示所有玩家身份
- 展示每轮发言记录
- 展示每轮投票结果
- 展示出局顺序
- 展示积分变化

## 开发阶段拆分

### 第一阶段：无 AI MVP

目标是跑通完整游戏流程。

实现内容：

- 用户登录
- 创建房间
- 加入房间
- 开始游戏
- 轮次倒计时
- 真人发言
- 投票出局
- 胜负判定

### 第二阶段：假 AI 接入

目标是验证 AI 玩家接入点。

实现内容：

- 后端创建 AI 玩家
- AI 使用固定模板发言
- AI 使用简单规则投票
- 真人与 AI 走同一套发言和投票流程

### 第三阶段：真实 AI Core

目标是让 AI 具备可玩性。

实现内容：

- 接入 OpenAI Responses API
- 增加结构化输出
- 增加 AI 发言策略
- 增加 AI 投票策略
- 增加超时兜底
- 增加 AI 行为日志

### 第四阶段：积分与复盘

目标是增强完整游戏闭环。

实现内容：

- 真人获胜积分结算
- 积分流水
- 游戏复盘页
- 出局后上帝视角
- 每轮投票和发言记录回放

### 第五阶段：稳定性与扩展

目标是支持正式上线。

实现内容：

- Redis 存储实时房间状态
- Socket.IO Redis Adapter 支持多实例
- 聊天限流
- 模型调用限流
- 异常重连
- 断线托管
- 日志和监控

## 风险与注意事项

- 不能信任前端传来的游戏状态，所有关键判断必须由后端完成。
- 不能信任 AI 输出，必须校验输出结构和合法性。
- AI 调用可能超时，所有 AI 行为都必须有兜底策略。
- 实时游戏中倒计时和阶段切换必须由服务端驱动。
- 积分结算要使用事务，避免重复发奖。
- 聊天记录和投票记录要持久化，方便复盘和争议处理。

## 后续可扩展方向

- 增加 AI 难度分级。
- 增加不同 AI 人设。
- 增加特殊技能，例如查验、保护、禁言。
- 增加排行榜。
- 增加赛后推理评分。
- 增加语音发言模式。
- 支持自定义房间规则。
- 增加账号和积分系统.
- 增加日志回放功能，用于复盘分析提升AI胜率
- 增加积分排行榜系统，周榜前几奖励积分
- 增加判定系统，防止作弊发送一些无意义的消息
- 需要增加限制系统，限制每天游戏次数，不能一直玩下去
- 增加人格系统，AI有不同的人格设定

## 参考资料

- [Next.js App Router](https://nextjs.org/docs/app)
- [NestJS WebSocket Gateways](https://docs.nestjs.com/websockets/gateways)
- [Socket.IO Rooms](https://socket.io/docs/v4/rooms/)
- [Socket.IO Redis Adapter](https://socket.io/docs/v4/redis-adapter/)
- [FastAPI WebSockets](https://fastapi.tiangolo.com/advanced/websockets/)
- [Nuxt Documentation](https://nuxt.com/docs)
- [SvelteKit Documentation](https://svelte.dev/docs/kit)
- [Hono Documentation](https://hono.dev/docs/)
