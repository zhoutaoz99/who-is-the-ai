# AI 单层方案迁移状态

| 字段 | 内容 |
| --- | --- |
| 文档类型 | Status |
| 文档状态 | Active |
| 适用范围 | 普通对局主链路从两段式（策略层+表达层）迁移到 v4.0 单层方案的进度与遗留问题 |
| 目标读者 | 后端开发、评审者 |
| 责任人 | AI / Gameplay 维护者 |
| 最近核对日期 | 2026-06-23 |
| 关联代码 | `apps/api/src/ai/ai.service.ts`、`apps/api/src/ai/ai.personas.ts`、`apps/api/src/ai/ai.types.ts`、`apps/api/src/ai/prompts/ai-player/`、`apps/api/src/game/game.service.ts`、`apps/api/src/game/game.snapshot.ts`、`apps/api/src/game/game.gateway.ts` |
| 关联文档 | [谁是AI v4.0 设计稿](./AI-Human-Likeness-Design-v4.0.md)、[游戏玩法](./Gameplay.md)、[AI 玩家交互流程](./AI-Interaction-Flow.md) |

## 1. 背景

普通对局原本走 v3.0 的**两段式**发言：策略层（输出结构化 JSON 策略）→ 表达层（把策略改写成口语发言）。v4.0 设计稿改为**单层方案**：一整张「人设卡」直接拼进 system，让模型“忘掉自己是 AI”、以人设身份玩；讨论是**一次调用直接产出聊天发言**，投票是和讨论**独立的一次调用**、只输出一行 JSON。

本次迁移把普通对局主链路（`game/` + `ai/`）切换到单层方案，并清理掉两段式旧代码与 `match/` 目录下已迁移好的参考实现。**迁移只聚焦“正常对局”**：不含 AI 自动对抗（模拟真人/调试自动房），也不含复盘/迭代/单局审计/提示词版本控制等工具链。

## 2. 范围

- ✅ 覆盖：普通对局的发言提示词、投票提示词、人格库，以及 `ai.service` 单层发言/投票、对局流程接线。
- ❌ 不覆盖：复盘（replay）、迭代自对抗（iteration）、Eval、提示词版本控制（PromptRegistry）、模拟真人/自动对抗房。这些按既定决策**保留代码、暂不编译、暂不接线**，留待后续按单层方案重做。

## 3. 已完成迁移

### 3.1 提示词模板（单层，逐字对齐设计稿）

`apps/api/src/ai/prompts/ai-player/`：

| 文件 | 状态 | 作用 |
| --- | --- | --- |
| `system-discussion.txt` | 新增 | 讨论 system（人设身份 + 打法心法），以 `{{persona}}` 收口 |
| `user-discussion-template.txt` | 新增 | 讨论运行时上下文 + 开场签到自判 |
| `system-vote.txt` | 替换 | 投票 system（独立调用、只产出投票），以 `{{persona}}` 收口 |
| `user-vote-template.txt` | 替换 | 投票运行时上下文 |
| `system-speech-strategy.txt` | 删除 | 旧策略层 |
| `user-speech-strategy-template.txt` | 删除 | 旧策略层 |
| `system-speech-expression.txt` | 删除 | 旧表达层 |
| `user-speech-expression-template.txt` | 删除 | 旧表达层 |

讨论/投票 user 模板的占位符：`{{selfCode}}`、`{{roundNo}}`、`{{alivePlayers}}`、`{{voteHistory}}`、`{{conversation}}`、`{{currentRoundCount}}`、`{{aliveCount}}`。

### 3.2 人格库（4 张人设卡）

`apps/api/src/ai/ai.personas.ts`：把旧的 8 人格 `AiPersonaContext` 库替换为 v4.0 第三节的 **4 张人设卡**（`P-01 阿条`/`P-02 酸梅`/`P-03 布丁`/`P-04 探长`），含 `basicSetting / personality / speakingStyle / catchphrases / blindSpots / howToPlay / examples` 七字段。

- `formatPersonaCard(card, seatNo)`：把整张卡渲染成 system 末尾 `{{persona}}` 那段文本，并写入“你的代号是 N号”。
- `getPersonaOptions` / `findPersonaById` / `pickPersonaCards`：抽卡与查卡。
- 兼容访问器 `getActivePersonas()` / `getAiPersonaById()`：返回新人设卡，供 `game.rules` / `game.snapshot` / `game.service` 的既有调用点继续使用。
- 类型 `PersonaCard` / `PersonaOption` 定义在 `ai.types.ts`，`GameContext.myPersona` 改为 `PersonaCard | null`。

### 3.3 单层发言 / 投票（`ai.service.ts`）

- `generateSpeech`：**一次调用**。system = `system-discussion.txt` + `formatPersonaCard`；user = 渲染 `user-discussion-template.txt`；模型返回沉默标记（`[skip]`/`沉默`/`pass`）→ 不发言，否则 `cleanSpeech` 落成单行气泡（去包裹引号、去自报编号前缀、折叠空白、限长 120）。
- `generateVote`：独立一次调用，解析一行 JSON `{"vote":"代号","reason":"..."}`，把 `N号`/`P3`/`3` 归一成座位号 → 找存活且非自己的玩家 → `targetPlayerId`；解析失败返回 `null`，由 `game.service` 既有兜底逻辑随机/弃票。
- 上下文格式化 `formatConversation`（历史轮次 + 当前轮次，按 `N号: 内容`）、`formatVoteHistory`（投票去向/票型/结果）从 `match/` 参考实现移植到 `ai.service`。
- 移除 `PromptRegistry` 依赖：提示词改为 `prompt-loader` 直接读文件。
- `AiCallType` 收敛为 `"discussion" | "vote"`；`AiConfig` 去掉两段式的 `speechStrategy` / `speechExpression` 拆分。

### 3.4 对局流程接线

- `game.service.ts`：去掉 `PromptRegistry` 注入与 `promptGenerationId` 写入；`buildGameContext` 把聊天记录的发言人标识统一成 `N号`（原为 `N号位`）；`myPersona` 走新人设卡。
- `game.snapshot.ts`：对外暴露的 `aiPersonaName` 取 `persona.nickname`。
- 发言调度（`startModelSpeech`）、投票调度（`scheduleAiVotes` / `castAiVote`）、计票与胜负判定均沿用既有逻辑，单层 `generateSpeech` 仍返回 `targetResponseDelayMs`（按发言长度估算的“打字耗时”）/ `nextCheckAfterMs` 以适配既有调度器。

### 3.5 清理

- **`match/` 目录**：删除已迁移/冗余的参考代码（`prompts.ts`、`persona-pool.ts`、`match-ai.service.ts`、`match.service.ts`、`player-labels.ts`、`match.types.ts`、`prompts/`、实现说明 `*-Implementation.md`），仅保留设计稿 `AI-Human-Likeness-Design-v4.0.md`。
- **工具链摘除**：`replay/`、`iteration/`、`prompt-registry`、`eval-*`、`prompt-version` 控制器从运行时模块图中摘除（`app.module` / `game.module` / `game.gateway` / `ai.module`），并在 `tsconfig.json` 的 `exclude` 中排除编译。**文件保留**。

### 3.6 当前运行时模块图

```
AppModule
 ├─ DataModule
 ├─ AuthModule
 └─ GameModule
      ├─ AiModule（只提供 AiService）
      ├─ AuthModule
      └─ DataModule
      providers: GameGateway, GameService, GameRoomRepository
```

构建验证：`tsc --noEmit` 0 错误；`nest build` 正常产出 JS，并把 `ai/prompts/ai-player/*.txt` 拷贝到 `dist`。

## 4. 遗留问题与后续工作

### 4.1 复盘 / 迭代 / Eval / 提示词版本控制（最大遗留项）

`replay/`、`iteration/`、`ai/prompt-registry.ts`、`ai/eval-*`、`ai/prompt-version.controller.ts` **目前无法编译且未接线**，原因是它们仍依赖被移除的旧符号：

- 旧人格 API / 类型：`AiPersonaContext`、`DEFAULT_AI_PERSONAS`、`setActivePersonas`。
- 旧两段式提示词文件名：`system-speech-strategy.txt` 等（已删除）。
- `ai.service` 上已移除的方法：`streamModel`、`stripCacheMarker`。
- `replay.types` 自己的 `AiCallType` 不含 `"discussion"`。

**后续**：若要恢复这些工具链，需要把它们改造到单层调用类型（`discussion`/`vote`）与 4 卡人设模型，重做提示词版本/种子逻辑，然后从 `tsconfig.json` 的 `exclude` 移除并重新接入模块图与网关。

### 4.2 AI 自动对抗 / 模拟真人房不再工作

- `generateSpeech` 在无人设（`myPersona == null`）时直接返回不发言；模拟真人玩家（`type:"human", simulated:true`）没有人设，因此**自动对抗房里模拟真人不再发言**。
- `game.rules.createDebugAutoAiPlayers` 仍引用常量 `ACTIVE_ICEBREAKER_PERSONA_ID`（`"active_icebreaker"`），新 4 卡里已无此 id，`hasActiveIcebreaker` 恒为 false。
- `game.gateway` 的 `iteration.*` 事件与桥接已移除；前端自对抗面板无后端。

**后续**：自动对抗属于迭代工具链，按需在 4.1 一并重做。

### 4.3 复盘 / 单局审计入口下线

`game.gateway` 的 `iteration.*` 与 `app.module` 的 `ReplayModule` 已摘除，相关 socket 事件与 REST 路由（含单局审计）在运行时不可用。前端历史回放/单局审计页将无后端响应。

### 4.4 单层方案下的“悬空”数据

- `Room.aiMemories` / `AiShortMemory`：`game.service` 仍在维护 AI 投票短期记忆，但单层提示词**不再注入 `shortMemory`**，该数据当前无消费方。
- `Room.promptGenerationId`：字段保留但不再写入（版本感知复盘已下线）。
- `AiService.setRecorder` / `recordCalls`：唯一的录制器 `DebugAiRecorder` 属于已摘除的 replay；普通对局下 `recordCalls` 为空操作，**AI 调用不再落库**（仅打印日志）。

**后续**：决定是否清理这些悬空字段，或在重做复盘时重新接上。

### 4.5 与设计稿的实现差异（沿用，需评估）

- **开场签到自判块**：`user-discussion-template.txt` 保留了让模型自判是否处于开场、开场就 `[skip]` 或只发招呼水话的硬约束，设计稿无此设计。
- **注入 `voteHistory`**：讨论/投票上下文都注入历史投票去向/票型/出局结果；设计稿第二节只要求注入“完整聊天记录”，多注入投票记录与“凭感觉反应”的调性存在潜在张力。
- **沉默由模型自判**：没有代码层强制概率沉默，靠模型输出 `[skip]`，沉默率不可控。

### 4.6 验证缺口

目前只完成了**编译 + 资产拷贝**验证，**未真机跑通一局**（需要 PostgreSQL、Redis 与 `ai-models.json`）。建议后续：

1. 配真实模型，建普通房，观察讨论是否单行口语、是否会 `[skip]`、投票是否输出一行 JSON 且只投他人。
2. 核对 `N号` 代号在发言/投票/聊天记录中的一致性与解析正确性。
3. 核对 4 卡人设在开局的去重分配（2 个 AI / 4 张卡）。

## 5. 文件清单

| 文件 | 改动 |
| --- | --- |
| `apps/api/src/ai/prompts/ai-player/system-discussion.txt` | 新增 |
| `apps/api/src/ai/prompts/ai-player/user-discussion-template.txt` | 新增 |
| `apps/api/src/ai/prompts/ai-player/system-vote.txt` | 替换 |
| `apps/api/src/ai/prompts/ai-player/user-vote-template.txt` | 替换 |
| `apps/api/src/ai/prompts/ai-player/system-speech-*.txt`、`user-speech-*.txt` | 删除（4 个旧两段式文件） |
| `apps/api/src/ai/ai.personas.ts` | 重写为 4 卡人设库 |
| `apps/api/src/ai/ai.types.ts` | 单层化类型（`PersonaCard`/`PersonaOption`、`AiCallType`、`AiConfig`） |
| `apps/api/src/ai/ai.service.ts` | 重写为单层发言/投票 |
| `apps/api/src/ai/ai.module.ts` | 只提供 `AiService` |
| `apps/api/src/game/game.service.ts` | 去 `PromptRegistry`、`N号` 标识、人设接线 |
| `apps/api/src/game/game.snapshot.ts` | `persona.nickname` |
| `apps/api/src/game/game.gateway.ts` | 摘除 `iteration.*` 注入/桥接/处理器 |
| `apps/api/src/game/game.module.ts` | 摘除 iteration/replay |
| `apps/api/src/app.module.ts` | 摘除 `ReplayModule` |
| `apps/api/tsconfig.json` | `exclude` 排除未迁移工具链 |
| `apps/api/src/match/` | 仅保留设计稿，删除参考代码 |
| `apps/api/src/{replay,iteration}/`、`ai/prompt-registry.ts`、`ai/eval-*`、`ai/prompt-version.controller.ts` | 保留、未编译、未接线 |
