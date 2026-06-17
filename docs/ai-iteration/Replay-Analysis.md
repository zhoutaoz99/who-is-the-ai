# 单局硬问题审计

| 字段 | 内容 |
| --- | --- |
| 文档类型 | Design |
| 文档状态 | Active |
| 适用范围 | 单局硬问题审计的后端接口、流式输出、版本感知注入与前端展示 |
| 目标读者 | 后端开发、评审者 |
| 责任人 | AI / Replay 维护者 |
| 最近核对日期 | 2026-06-17 |
| 关联代码 | `apps/api/src/replay/`、`apps/web/app/replay/`、`apps/api/src/ai/prompts/` |
| 关联文档 | [AI-Prompt-Eval-Flow.md](./AI-Prompt-Eval-Flow.md)、[AI-Prompt-Eval-Details.md](./AI-Prompt-Eval-Details.md) |

本文是单局硬问题审计(`POST /replay/analyze`，流式输出 Markdown 文本，只读不改)。它只处理**本局内高置信、可举证、可定位**的问题，例如游戏逻辑 bug、数据一致性 bug、阶段/规则执行异常、明显异常发言或投票理由。自迭代([`AI-Prompt-Eval-Flow.md`](./AI-Prompt-Eval-Flow.md)) 则是批量跑无头对局、用冻结尺子输出可比的结构化分数和 scorecard，用于发现多局后才稳定暴露的隐藏问题、拟人化趋势和提示词版本优劣。两者共用「复盘导出 JSON + `REPLAY_ANALYSIS_*` 评审模型」，但职责、尺子与输出不同：单局审计用 `prompts/system-replay-analysis.txt` 出硬问题审计文本，自迭代用 `eval/prompts/replay-score/system-replay-score.txt` 出结构化分数。

## 1. 背景与目标

复盘页提供“单局审计”能力，用独立配置的大模型审计对局记录，输出面向开发排查的 Markdown 文本。分析重点包括：

- 识别高置信游戏逻辑 bug：投票、淘汰、轮次推进、胜负结算、已出局玩家行为等。
- 识别数据一致性 bug：玩家状态、消息、投票、AI 调用日志、最终执行结果之间的矛盾。
- 识别明显异常发言或模型输出：泄露系统身份、阶段错乱、目标不存在、投给已出局玩家、模板占位符未替换等。
- 给出最小修复方向：只针对本局内有证据的硬问题，不输出泛化的提示词优化建议。

明确不做：

- 不评价某一代 AI prompt 的整体好坏。
- 不输出 human-like 分数、issue code 统计、版本采纳或回滚建议。
- 不把“感觉不够自然”“策略可能不够聪明”“模板感可能偏重”这类需要多局验证的问题写成单局结论。
- 不用单局结果推断隐藏较深的长期问题；这些由自动对局评估自迭代处理。

## 2. 与自动对局评估自迭代的边界

单局审计和自动对局评估自迭代共用 replay JSON 和 `REPLAY_ANALYSIS_*` 模型配置，但它们回答的问题不同，不能互相替代。

| 维度 | 单局审计(`/replay/analyze`) | 自动对局评估自迭代(`/iteration`) |
| --- | --- | --- |
| 核心问题 | “这一局有没有明确硬问题？” | “这一代 AI 在多局里是否稳定更好或更差？” |
| 样本基础 | 单局 replay。 | 多局自动对局结果和 scorecard。 |
| 证据要求 | 必须本局内高置信、可举证、可定位。 | 允许单局噪声，通过多局聚合看趋势和复现率。 |
| 主要输出 | Markdown 审计报告：硬问题、证据、最小修复建议。 | 结构化分数、issue code 命中率、聚合 scorecard、候选提示词版本。 |
| 适合发现 | 游戏逻辑 bug、数据不一致、阶段错乱、明显异常发言/投票、模型输出格式坏掉。 | 隐藏较深的拟人化 tell、长期投票策略问题、人格/提示词版本优劣、低频但稳定复现的问题。 |
| 不适合发现 | 长期趋势、版本排名、提示词整体质量、模糊主观自然度。 | 单局内的具体规则 bug 根因排查、某条异常消息的直接修复定位。 |
| 状态影响 | 只读，不改版本、不写 scorecard。 | 会写入 run/round/game 结果、scorecard，并可能派生候选提示词代。 |
| Prompt 管理 | `apps/api/src/ai/prompts/*replay-analysis*` 文件来源，冻结为硬问题审计尺子。 | `eval/prompts/replay-score/*` 与 `auto-optimize/*` 走评估尺子版本库。 |

判定原则：

- 如果问题**单局内就能直接证明**，例如平票却淘汰、已出局玩家继续投票、AI 输出未替换占位符，归单局审计。
- 如果问题**需要多局才能证明**，例如某人格长期更容易暴露、AI 总是不压制最活跃真人、模板话术命中率偏高，归自动对局评估自迭代。
- 如果单局里只看到“可能不自然”“策略可能一般”，单局审计应不输出结论；最多放入“需补充证据”，并建议通过自动评估积累样本。
- 如果自动评估发现某类问题频繁复现，再回到具体 replay 用单局审计定位某一局的硬证据和最小修复点。

## 3. 数据来源

单局审计以“复盘导出 JSON”为输入。该 JSON 只有一个构造来源：后端 `apps/api/src/replay/replay-export.builder.ts`。前端不再维护导出 JSON 构造逻辑，只负责按当前开关向后端请求 JSON 并展示/导出/提交。

**前端页面展示用 timeline**(不作为导出/模型输入来源)：

- `apps/web/app/replay/[roomId]/page.tsx`
- `buildTimeline(...)`：仅用于页面逐轮回放展示，按 `round_no` + 玩家 + 时间序做 index 匹配，把 `speech-strategy` / `speech-expression` / `sim-human-speech` 调用挂到对应消息，并交织 skip 记录。

**后端构造**(预览、导出、保存、单局审计、无头评估闭环与外部脚本共用)：

- `apps/api/src/replay/replay-export.builder.ts`：`buildReplayExportData(snapshot, aiCallLogs, { includeSkips, includeUserPrompt, promptGenerationId, profile })`
- 数据源：`game_rooms.room_data` 经 `toRoomSnapshot(room)` 生成 snapshot，`ReplayService.getAiCallLogs(roomId)` 读取 `ai_call_logs`。

复盘页的预览、导出、保存到数据库和单局审计请求都使用同一套当前开关构造 replay JSON。默认值为：

- `includeSkips: true`
- `includeUserPrompt: false`
- `profile: "audit"`

自动对局评估自迭代中的单局打分也复用这套默认导出配置,保证复盘页默认预览、单局审计输入和自动迭代打分看到的 replay JSON 口径一致。

这样默认情况下，预览/导出的 JSON 与发给大模型的 replay JSON 保持一致：模型可以看到 skip 记录、消息、投票和模型原始响应，但不会把每次 AI 调用的用户提示词、模型名、debug 模型列表、人格全集等高噪声字段塞进 replay JSON。该局实际运行的 AI 提示词与人格库仍由 `ReplayService.buildReplayAnalysisPrompt` 单独按版本注入，避免在 replay JSON 里重复出现。

审计用 `profile: "audit"` 会保留：

- `roomId` / `promptGenerationId` / `winner` / `currentRound`。
- 必要规则配置：人数、AI 数、最大轮次、发言冷却。
- 玩家姓名、座位、阵营揭示、模拟真人标记、AI 人格名、存活/淘汰信息。
- 每轮消息的玩家名、座位号、内容、来源、时间。
- skip 记录的玩家名、座位号、原因、时间。
- 投票记录的投票玩家名/座位号、目标玩家名/座位号。
- 与消息或投票直接相关的 AI 调用 `callType` 与 `rawResponse`。
- 所有导出时间统一裁剪到秒级，去掉毫秒噪声。

审计用 `profile: "audit"` 会去掉：

- `userPrompt` / `templatePrompt`。
- `modelName` / `temperature` / `reasoningEffort`。
- `config.aiPersonas` / `config.availableModels` / `config.rewardPool` / `discussionDurationMs` / `voteDurationMs`。
- AI 调用里的玩家名与座位冗余字段。
- `players[].aiPersonaId`。
- 空的 `messages[].aiCalls`。

如果关闭“精简数据”，预览/导出/保存/单局审计都会使用 full profile；如果再打开“导出用户提示词”，模型输入也会包含单次 AI 调用的 `userPrompt`。这保证页面看到的 replay JSON 与模型收到的 replay JSON 一致，不再做后端隐式字段删减。

服务端导出的 JSON 顶层额外带 `promptGenerationId`(本局开局时生效的 AI 提示词版本代号，见下方“版本感知审计”)。

因为复盘页也统一使用后端导出，所以预览、导出和单局审计请求里的 replay JSON 都会带 `promptGenerationId`。`/replay/analyze` 仍保留兜底：如果外部调用方提交的 replay JSON 缺少 `promptGenerationId`，会按 `roomId` 回查 `game_rooms.room_data` 补全，再退到当前 active 代(见“版本感知审计”的回退链)。

## 4. 后端接口

**单局审计接口**(流式)：

```http
POST /replay/analyze
Content-Type: application/json
```

请求体：

```json
{
  "replay": {}
}
```

响应：

- `text/plain; charset=utf-8`
- 流式输出分析文本

实现位置：

- `apps/api/src/replay/replay.controller.ts`
- `apps/api/src/replay/replay.service.ts`

后端不保留非流式分析接口。

**服务端导出接口**(供评估闭环/外部拉取，非复盘必需)：

```http
GET /replay/:roomId/export?includeSkips=true&includeUserPrompt=true
```

返回 `{ ok, data }`，`data` 即上述服务端构造的导出 JSON(含 `promptGenerationId`)。

如需直接拉取单局审计用瘦身 JSON，可加 `profile=audit`：

```http
GET /replay/:roomId/export?includeSkips=true&includeUserPrompt=false&profile=audit
```

## 5. 流式输出

后端 `ReplayController.streamAnalyzeReplay` 会：

1. 校验 `body.replay`。
2. 设置 `text/plain` 流式响应头。
3. 调用 `ReplayService.streamReplayAnalysisExport`。
4. 将模型返回的 chunk 直接写入 HTTP 响应。
5. 监听响应连接 `close` 事件，客户端中断时通过 `AbortController` 取消模型请求。

前端 `handleAnalyzeReplay` 会：

1. 按当前页面开关调用 `GET /replay/:roomId/export?includeSkips=...&includeUserPrompt=...&profile=...` 取得后端构造的 replay JSON。
2. 使用该 JSON 请求 `POST /replay/analyze`。
3. 通过 `response.body.getReader()` 读取流。
4. 持续追加文本到 `analysisText`。
5. 使用 `AbortController` 支持中断。

交互状态：

- 初始按钮：`单局审计`
- 分析中按钮：`中断`
- 完成、失败或中断后按钮：`重试审计`

## 6. 模型配置

单局审计使用独立模型配置，不复用对局 AI 模型。

`.env` 必填：

```bash
REPLAY_ANALYSIS_BASE_URL=https://api.example.com/v1
REPLAY_ANALYSIS_API_KEY=sk-your-replay-analysis-key
REPLAY_ANALYSIS_MODEL=your-review-model
```

`.env` 可选：

```bash
REPLAY_ANALYSIS_TEMPERATURE=0.2
REPLAY_ANALYSIS_REASONING_EFFORT=high
REPLAY_ANALYSIS_THINKING=true
REPLAY_ANALYSIS_TIMEOUT_MS=300000
```

配置解析位于：

- `ReplayService.resolveReplayAnalysisModel`

模型调用复用：

- `AiService.streamModel`

该方法按 OpenAI-compatible chat completions streaming 响应格式解析 `data:` 行，并提取：

- `choices[0].delta.content`
- `choices[0].message.content`
- `choices[0].text`

## 7. 版本感知审计

单局审计只依据两类材料：① 本局对局记录(复盘 JSON)；② **该局当时实际运行**的 AI 提示词与人格库。提示词随 AI 提示词 DB 版本库一起迭代([`AI-Prompt-Eval-Details.md`](AI-Prompt-Eval-Details.md))，因此审计必须按“这一局的版本”注入，而不是当前 active，避免迭代后回看旧局张冠李戴。

`ReplayService` 注入 `PromptRegistry`，`buildReplayAnalysisPrompt` 改为**异步**，流程：

1. `resolvePromptGenerationId(replay)` 解析本局版本代号，优先级：
   - replay JSON 的 `promptGenerationId` 字段；
   - 否则按 `roomId` 查 `game_rooms.room_data->promptGenerationId`；
   - 都没有(旧局)则回退当前 active 代。
2. `prompts.getGenerationAssets(generationId)` 取该代的 7 个 asset 正文 + 解析后的人格库。
3. 把策略层 / 表达层 / 投票提示词与人格库注入 user 模板。

> 单局审计尺子(`system-replay-analysis.txt` + `user-replay-analysis-template.txt`)始终冻结、来自文件，**不**随版本库变动；只有被审计对象的 AI 提示词是版本感知的。

## 8. Prompt 文件

单局审计 prompt 分为系统提示词和用户提示词模板。两者都**冻结**(来自文件，不随版本库变动)。

系统提示词：

- `apps/api/src/ai/prompts/system-replay-analysis.txt`

职责：

- 定义“谁是AI”的游戏规则与胜负判定。
- 说明单局审计边界：只报高置信、可举证、可定位的硬问题。
- 定义硬问题清单：规则与流程异常、数据一致性异常、明显异常发言或模型输出、可直接修复的问题定位。
- 明确禁止输出单局主观拟人化评估、human-like 分数、issue code 统计、版本采纳/回滚建议。
- 定义输出结构：总体结论、高置信硬问题、明显异常发言/模型输出、规则与数据一致性检查、需补充证据、最小修复建议。

该系统提示词**自包含**：不引用任何外部文档(如 `AI-Human-Likeness.md`)或历史对局，只依据本局记录与随附 AI 提示词做判断，保证单局审计结论稳定、可复现。

用户提示词模板：

- `apps/api/src/ai/prompts/user-replay-analysis-template.txt`

注入变量：

- `{{replayJson}}`：本局复盘 JSON。
- `{{aiSpeechStrategyPrompt}}` / `{{aiSpeechExpressionPrompt}}` / `{{aiVotePrompt}}`：该局版本对应的 AI 玩家三层提示词(版本感知)。
- `{{aiPersonas}}`：该局版本对应的人格库 JSON。

模板把材料分两段呈现：① AI 玩家提示词(仅用于定位明显异常输出的直接成因)；② 本局对局记录。用户提示词不重复系统提示词中的规则和分析优先级。

渲染位置：

- `ReplayService.buildReplayAnalysisPrompt`(异步，见“版本感知审计”)

## 9. 前端展示

复盘页(`apps/web/app/replay/[roomId]/page.tsx`)头部操作区有三组控件：导出开关、单局审计、预览/导航。

### 9.1 头部开关(控制预览/导出/单局审计)

三个 toggle 开关：

- **显示 Skip 记录** → `showSkips`(默认 `true`)
- **导出用户提示词** → `includeUserPrompt`(默认 `false`)
- **精简数据** → `compactReplayData`(默认 `true`，即 `profile="audit"`)

这三个开关同时影响预览面板、导出 JSON、保存到数据库和单局审计请求。开关变化时若预览已展开，前端会重新请求后端导出接口刷新预览。

### 9.2 单局审计

`handleAnalyzeReplay` 流程：

1. 若正在分析，点按钮即 `abort` 中断。
2. `fetchReplayExport(room.id)` 调后端导出接口，取得与当前预览/导出开关一致的 replay JSON。
3. `fetch` 请求 `POST /replay/analyze`，带 `AbortController`。
4. `response.body.getReader()` 读取流，逐 chunk 追加到 `analysisText`。
5. 中断时 `analysisInterrupted=true`；失败写 `analysisError`。

审计结果面板(`replay-analysis-section`)在 loading/有文本/有错误/已中断时展示，正文经 `MarkdownContent`(渲染为 `.replay-analysis-content`)输出 Markdown。

按钮文案状态：

- 初始：`单局审计`
- 分析中：`中断`
- 完成、失败或中断后：`重试审计`

相关状态：`analysisText`、`analysisLoading`、`analysisError`、`analysisInterrupted`、`analysisAbortRef`。

### 9.3 预览 + 保存到数据库

预览面板(`replay-preview-section`)由“预览”按钮切换，用于在导出/保存/单局审计前检查 JSON。展开时(`showPreview=true`)的 `useEffect`：

1. 调 `GET /replay/:roomId/export?includeSkips=...&includeUserPrompt=...&profile=...`。
2. `previewSource = "server"`(徽标“后端生成”)。
3. 任何开关变化都会重新请求后端导出，保证预览、导出、保存和单局审计输入一致。

头部开关变化时预览会重新请求后端导出接口。

工具栏(`replay-preview-toolbar`)两个动作：

- **导出 JSON** → `handleExportPreview` → `downloadJson(previewData, replay-<roomId>.json)`。
- **保存到数据库** → `handleSavePreviewToDatabase` → `POST /replay/export/:roomId`，body `{ data: previewData, includeSkips, includeUserPrompt }`；保存的是当前后端导出的数据。成功后 `previewSource` 置 `"db"` 并提示“已保存到数据库”。

> 由于预览数据来自后端导出，保存进数据库的 data 也会带 `promptGenerationId`。

预览头部还显示当前开关摘要(`replay-preview-toggles-summary`)与“自动换行”开关(`previewWrap`)。

相关状态：`showPreview`、`previewData`、`previewSource`(`"db" | "server" | null`)、`previewLoading`、`previewSaving`、`previewMessage`、`previewWrap`。

### 9.4 相关样式

`apps/web/app/styles/replay.css`（由 `globals.css` 统一 `@import`，前台样式已按页面拆分）：

- 单局审计：`.replay-analyze-btn`、`.replay-analysis-section`、`.replay-analysis-status`、`.replay-analysis-content`
- 预览：`.replay-preview-section`、`.replay-preview-head`、`.replay-preview-source-badge`(含 `.db`/`.server`)、`.replay-preview-toggles-summary`、`.replay-preview-toolbar`、`.replay-preview-message`(含 `.success`/`.error`)、`.replay-preview-active`、`.replay-preview-close-btn`
- 通用开关：`.replay-toggle-switch`、`.replay-toggle-slider`、`.replay-toggle-label`
- 错误：`.replay-debug-error`

## 10. 请求体大小

预览/导出的完整 replay JSON 可选择包含 AI 用户提示词，体积可能较大。单局审计请求使用 audit profile，不包含单次 AI 调用的 `userPrompt`，请求体通常明显更小。

API 在 `apps/api/src/main.ts` 中将 JSON body limit 调整为 `5mb`：

```ts
app.useBodyParser("json", { limit: "5mb" });
app.useBodyParser("urlencoded", { extended: true, limit: "5mb" });
```

## 11. 验证

相关变更建议运行：

```bash
npm --workspace apps/api run build
npm --workspace apps/web run build
```
