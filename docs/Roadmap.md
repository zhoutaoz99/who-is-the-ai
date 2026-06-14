# 项目路线图

| 字段 | 内容 |
| --- | --- |
| 文档类型 | Roadmap |
| 文档状态 | Active |
| 适用范围 | 项目未来交付路径、优先级、依赖与里程碑 |
| 目标读者 | 维护者、协作者、评审者 |
| 责任人 | 项目维护者 |
| 最近核对日期 | 2026-06-15 |
| 关联代码 | `docs/README.md`、`apps/api`、`apps/web` |
| 关联文档 | [README.md](./README.md)、[Doc-Style-Guide.md](./Doc-Style-Guide.md) |

## 目标与范围

本文档记录当前仍需推进的事项和规划中的交付路径。已完成能力只保留简要状态与对应文档链接，不在此展开实现细节。

## 当前状态

状态约定:✅ 已完成 · ⏳ 部分完成 · ⬜ 未开始。

### 开发阶段

| 阶段 | 状态 | 说明 |
| --- | --- | --- |
| 第一阶段:无 AI MVP | ✅ | 完整游戏流程跑通(登录、房间、轮次倒计时、真人发言、投票出局、胜负判定)。 |
| 第二阶段:假 AI 接入 | ✅ | AI 玩家接入点验证,随后被真实 AI 取代。 |
| 第三阶段:真实 AI Core | ✅ | 真实模型、结构化输出、双层发言、投票策略、超时兜底、行为日志。见 [`AI-Interaction-Flow.md`](gameplay/AI-Interaction-Flow.md)。 |
| 第四阶段:积分与复盘 | ✅(上帝视角除外) | 积分结算、复盘页、每轮投票/发言回放。出局后上帝视角见 P1。 |
| 第五阶段:稳定性与扩展 | ⏳ | 见下方 P0/P1 的限流、多实例、监控项。 |

## 优先级定义

- `P0`:影响核心可玩性、公平性或上线安全的必要事项。
- `P1`:补齐产品闭环、正式化运营和稳定性的关键事项。
- `P2`:提升留存、运营效率、AI 表现和复盘质量的增强事项。
- `P3`:中长期玩法形态、复杂能力或探索性方向。

## 分阶段计划

### P0 · 核心玩法与公平规则

| 事项 | 状态 | 说明 |
| --- | --- | --- |
| 平票处理规则 | ✅ | 平票本轮无人出局(`resolveElimination` 的 `isTie` 分支)。 |
| 超时未投票规则 | ✅ | 无人投票(含全体超时)本轮无人出局。 |
| AI 对抗可信度 | ✅ | 已补跨轮次记忆与上下文(历史对话、历史投票、短期记忆)。见 [`AI-Human-Likeness.md`](ai-iteration/AI-Human-Likeness.md)。 |
| 掉线与异常重连 | ⏳ | 已有重连(`room.reconnect`)、`DISCONNECT_GRACE_MS=30s` 宽限、断线清理。**未做**:掉线真人由 AI 托管。 |
| 无意义消息与作弊/刷屏判定 | ⬜ | 暂无发言内容校验、刷屏/作弊检测与限流。 |

### P0 · 实现视角(权威状态与安全)

| 事项 | 状态 |
| --- | --- |
| 服务端唯一可信状态源 / 驱动倒计时与阶段切换 | ✅ |
| 完整校验 WebSocket 行为(登录、房间归属、存活、阶段、冷却、投票目标) | ✅ |
| 校验 AI 输出合法性 / AI 超时兜底 | ✅ |

### P1 · 完整游戏闭环

| 事项 | 状态 | 说明 |
| --- | --- | --- |
| 接入真实 AI Core | ✅ | 见 [`AI-Interaction-Flow.md`](gameplay/AI-Interaction-Flow.md)。 |
| 账号与积分系统 | ✅ | `accounts` 表 + JWT 鉴权(`auth` 模块)。 |
| 积分结算 | ⏳ | 真人获胜平分 `REWARD_POOL=2000`;**未做**:积分流水账本(目前只维护余额)、结算事务化。 |
| 赛后复盘 | ✅ | 见 [`Replay-Analysis.md`](ai-iteration/Replay-Analysis.md)。 |
| 出局后上帝视角(观战) | ⬜ | 出局玩家目前不能以上帝视角继续观战。 |
| 房间规则配置 | ⏳ | 普通房可配讨论时长(`ROUND_DURATION_MS`)与轮数;**未做**:AI 数量、真人数量、奖励池配置(普通房 AI 数固定为 `AI_PLAYER_COUNT=2`)。调试自动对抗房阵容可配。 |

### P1 · 持久化与正式运行能力

| 事项 | 状态 | 说明 |
| --- | --- | --- |
| 接入 PostgreSQL | ✅ | `accounts / game_rooms / ai_call_logs / replay_exports / ai_prompt_* / iteration_runs`。 |
| 接入 Redis | ⏳ | 已用于缓存/会话/房间缓存(`RedisCacheService`);**未做**:Redis 作为实时房间权威状态。 |
| Socket.IO Redis Adapter(多实例) | ⬜ | 当前单实例,无 Adapter。 |
| JWT 与 WebSocket 鉴权 | ✅ | |
| 积分结算使用事务 | ⏳ | 结算逻辑存在但未显式事务化。 |
| 持久化聊天与投票记录 | ✅ | |
| 异常重连与断线托管 | ⏳ | 重连已有;真人掉线的 AI 托管未做。 |

### P1 · 真实 AI Core(内部模块化)

| 事项 | 状态 | 说明 |
| --- | --- | --- |
| 接入真实模型调用(可替换配置) | ✅ | `ai-models.json`,支持 `openai` / `claude` 格式。 |
| 强制结构化输出 | ✅ | 发言/投票/跳过均走 JSON + 容错解析。 |
| 拆分 AI Core 内部模块 | ⬜ | 目前集中在 `ai.service.ts`,未拆 `AiPlayerAgent / AiOrchestrator / PromptBuilder / ModelClient / ActionSchema / AiMemoryStore`。 |
| AI 行为日志 | ✅ | `ai_call_logs`。 |
| 改进 AI 上下文(跨轮次) | ✅ | |
| 前缀缓存 / 提示缓存 | ✅ | 见 [`AI-Prompt-Cache-Optimization.md`](gameplay/AI-Prompt-Cache-Optimization.md)。 |

### P2 · 运营、留存与复盘质量

| 事项 | 状态 | 说明 |
| --- | --- | --- |
| AI 人格系统 | ✅ | 8 个人格,见 [`AI-Interaction-Flow.md`](gameplay/AI-Interaction-Flow.md)。 |
| AI 表现评分 | ✅ | 批量对局 + 冻结尺子 scorecard,见 [`AI-Prompt-Eval-Details.md`](ai-iteration/AI-Prompt-Eval-Details.md) / [`AI-Prompt-Eval-Flow.md`](ai-iteration/AI-Prompt-Eval-Flow.md)。 |
| AI 难度分级 | ⏳ | 已有 `normal`/`high` 模拟真人强度 + 8 人格;更细档位(fair/strong/expert)未做。 |
| 日志回放(提升 AI 胜率) | ✅ | 版本感知复盘 + 自动评估闭环已承担此角色。 |
| 复盘页 | ✅ | |
| 赛后推理评分(真人) | ⬜ | 当前评估对象是 AI,未对真人玩家的识别表现评分。 |
| 排行榜 | ⬜ | |
| 每日游戏次数限制 | ⬜ | |
| 按识别效率调整奖励 | ⬜ | |
| 聊天限流 / 模型调用限流 | ⬜ | |
| 日志与监控 | ⬜ | |

### P3 · 玩法扩展与高级编排

| 事项 | 状态 |
| --- | --- |
| 特殊行动/技能(查验、保护、沉默、禁言) | ⬜ |
| 语音发言模式 | ⬜ |
| 复杂角色与技能引擎 | ⬜ |
| 评估 LangGraph(复杂多阶段 AI 编排) | ⬜ |
| 运营页面 / SEO 页面 | ⬜ |

## 依赖与风险

- `P0` 的刷屏/作弊判定和掉线托管，直接影响房间稳定性和公平性。
- `P1` 的多实例、结算事务和上帝视角，决定能否从调试走向正式运行。
- `P2` 的评分与复盘依赖前面版本感知和日志链路完整，否则反馈闭环会失真。
- `P3` 的扩展玩法应建立在当前规则、调度和评估稳定之后。

## 里程碑 / 决策点

1. **P0 收尾**:发言刷屏/作弊判定与限流、真人掉线 AI 托管。
2. **P1 正式化**:Socket.IO Redis Adapter 与多实例、积分流水账本与结算事务、上帝视角观战。
3. **P1 AI 工程**:把 `ai.service.ts` 拆分为职责清晰的子模块,为后续复杂策略打基础。
4. **P2 运营**:排行榜、每日次数限制、真人推理评分。
5. **P3 探索**:特殊技能、语音、LangGraph 编排。
