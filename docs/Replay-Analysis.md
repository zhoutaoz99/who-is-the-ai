# 复盘分析实现

## 目标

复盘页提供“一键复盘”能力，用独立配置的大模型分析对局记录，输出开放式文本结果。分析重点包括：

- 根据对局结果分析获胜方胜利原因。
- 指出失败方明显问题。
- 发现 AI 行为、提示词、投票逻辑、发言质量上的优化方向。
- 识别明显对局 bug 或疑似规则异常。

## 数据来源

复盘分析以“复盘导出 JSON”为输入。该 JSON 有两个等价的构造来源：

**前端构造**(复盘页“导出 JSON”与一键复盘共用)：

- `apps/web/app/replay/[roomId]/page.tsx`
- `buildReplayExportData(room, aiCallLogs, includeSkips, includeUserPrompt)`
- `buildTimeline(...)`：按 `round_no` + 玩家 + 时间序做 index 匹配，把 `speech-strategy` / `speech-expression` / `sim-human-speech` 调用挂到对应消息，并交织 skip 记录。

**服务端构造**(供无头评估闭环与外部脚本拉取，逻辑与前端一致)：

- `apps/api/src/replay/replay-export.builder.ts`：`buildReplayExportData(snapshot, aiCallLogs, { includeSkips, includeUserPrompt, promptGenerationId })`
- 数据源：`GET /replay/:roomId` 返回的 `{ room: snapshot, aiCallLogs }`(`replay.service.getAiCallLogs` 取 `ai_call_logs`)。

一键复盘固定使用：

- `includeSkips: true`
- `includeUserPrompt: true`

这样模型可以看到 skip 记录和 AI 用户提示词，便于分析提示词问题和模型行为问题。

服务端导出的 JSON 顶层额外带 `promptGenerationId`(本局开局时生效的 AI 提示词版本代号，见下方“版本感知复盘”)。

注意三方来源的字段差异：

- **前端构造**(`apps/web` 的 `buildReplayExportData`)**不含** `promptGenerationId`。
- 前端“保存到数据库”走 `POST /replay/export/:roomId`，存的是前端本地构造的 data，因此**数据库里这条导出也不含** `promptGenerationId`。
- 只有**服务端导出** `GET /replay/:roomId/export` 构造的 JSON 才带 `promptGenerationId`。

复盘分析(`/replay/analyze`)对此做了兜底：即使提交的 replay JSON 没带 `promptGenerationId`(前端一键复盘正是如此)，也会按 `roomId` 回查 `game_rooms.room_data` 补全，再退到当前 active 代(见“版本感知复盘”的回退链)。

## 后端接口

**复盘分析接口**(流式)：

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

## 流式输出

后端 `ReplayController.streamAnalyzeReplay` 会：

1. 校验 `body.replay`。
2. 设置 `text/plain` 流式响应头。
3. 调用 `ReplayService.streamReplayAnalysisExport`。
4. 将模型返回的 chunk 直接写入 HTTP 响应。
5. 监听响应连接 `close` 事件，客户端中断时通过 `AbortController` 取消模型请求。

前端 `handleAnalyzeReplay` 会：

1. 构造复盘导出 JSON：`buildReplayExportData(room, aiCallLogs, true, true)`(两个开关固定 `true`，不受头部开关影响)。
2. 使用 `fetch` 请求 `POST /replay/analyze`。
3. 通过 `response.body.getReader()` 读取流。
4. 持续追加文本到 `analysisText`。
5. 使用 `AbortController` 支持中断。

交互状态：

- 初始按钮：`一键复盘`
- 分析中按钮：`中断`
- 完成、失败或中断后按钮：`重试复盘`

## 模型配置

复盘分析使用独立模型配置，不复用对局 AI 模型。

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

## 版本感知复盘

复盘分析只依据两类材料：① 本局对局记录(复盘 JSON)；② **该局当时实际运行**的 AI 提示词与人格库。提示词随 AI 提示词 DB 版本库一起迭代([`AI-Prompt-Eval-Loop.md`](./AI-Prompt-Eval-Loop.md))，因此复盘必须按“这一局的版本”注入，而不是当前 active，避免迭代后回看旧局张冠李戴。

`ReplayService` 注入 `PromptRegistry`，`buildReplayAnalysisPrompt` 改为**异步**，流程：

1. `resolvePromptGenerationId(replay)` 解析本局版本代号，优先级：
   - replay JSON 的 `promptGenerationId` 字段；
   - 否则按 `roomId` 查 `game_rooms.room_data->promptGenerationId`；
   - 都没有(旧局)则回退当前 active 代。
2. `prompts.getGenerationAssets(generationId)` 取该代的 7 个 asset 正文 + 解析后的人格库。
3. 把策略层 / 表达层 / 投票提示词与人格库注入 user 模板。

> 复盘分析尺子(`system-replay-analysis.txt` + `user-replay-analysis-template.txt`)始终冻结、来自文件，**不**随版本库变动；只有被分析对象的 AI 提示词是版本感知的。

## Prompt 文件

复盘分析 prompt 分为系统提示词和用户提示词模板。两者都**冻结**(来自文件，不随版本库变动)。

系统提示词：

- `apps/api/src/ai/prompts/system-replay-analysis.txt`

职责：

- 定义“谁是AI”的游戏规则与胜负判定。
- 说明分析边界与可用证据(`players[].aiPersonaName`、`aiCalls` 的两层 `speech-strategy`/`speech-expression`、投票 `rawResponse`、AI vs 模拟真人横向对照)。
- 定义分析优先级(胜负原因 → 失败方问题 → AI 拟人化与生存策略 → 提示词优化 → bug)。
- 给出“拟人化与生存策略评估清单”(语言层自然度、单局生存信号、投票与阵营协同、上下文一致性)。
- 定义开放式 bug / 规则异常分析方式。
- 定义输出格式建议(并要求区分“本局做得好”与“本局暴露的问题”、把建议映射到具体文件)。

该系统提示词**自包含**：不引用任何外部文档(如 `AI-human-like.md`)或历史对局，只依据本局记录与随附 AI 提示词做判断，保证单局复盘结论稳定、可复现。

用户提示词模板：

- `apps/api/src/ai/prompts/user-replay-analysis-template.txt`

注入变量：

- `{{replayJson}}`：本局复盘 JSON。
- `{{aiSpeechStrategyPrompt}}` / `{{aiSpeechExpressionPrompt}}` / `{{aiVotePrompt}}`：该局版本对应的 AI 玩家三层提示词(版本感知)。
- `{{aiPersonas}}`：该局版本对应的人格库 JSON。

模板把材料分两段呈现：① AI 玩家提示词(行为成因，用于定位问题根源)；② 本局对局记录。用户提示词不重复系统提示词中的规则和分析优先级。

渲染位置：

- `ReplayService.buildReplayAnalysisPrompt`(异步，见“版本感知复盘”)

## 前端展示

复盘页(`apps/web/app/replay/[roomId]/page.tsx`)头部操作区有三组控件：导出开关、一键复盘、预览/导航。

### 头部开关(控制预览/导出，不影响一键复盘)

两个 toggle 开关：

- **显示 Skip 记录** → `showSkips`(默认 `false`)
- **导出用户提示词** → `includeUserPrompt`(默认 `true`)

这两个开关**只影响预览面板和导出 JSON**；一键复盘固定用 `includeSkips=true / includeUserPrompt=true`(见下)，与开关状态无关。开关变化时若预览已展开，会调 `refreshPreviewFromToggles` 本地重建预览。

### 一键复盘

`handleAnalyzeReplay` 流程：

1. 若正在分析，点按钮即 `abort` 中断。
2. 本地构造 `replay = buildReplayExportData(room, aiCallLogs, true, true)`(硬编码两个 `true`，不受头部开关影响)。
3. `fetch` 请求 `POST /replay/analyze`，带 `AbortController`。
4. `response.body.getReader()` 读取流，逐 chunk 追加到 `analysisText`。
5. 中断时 `analysisInterrupted=true`；失败写 `analysisError`。

分析结果面板(`replay-analysis-section`)在 loading/有文本/有错误/已中断时展示，正文经 `MarkdownContent`(渲染为 `.replay-analysis-content`)输出 Markdown。

按钮文案状态：

- 初始：`一键复盘`
- 分析中：`中断`
- 完成、失败或中断后：`重试复盘`

相关状态：`analysisText`、`analysisLoading`、`analysisError`、`analysisInterrupted`、`analysisAbortRef`。

### 预览 + 保存到数据库

预览面板(`replay-preview-section`)由“预览”按钮切换，用于在导出/保存前检查 JSON。展开时(`showPreview=true`)的 `useEffect`：

1. `GET /replay/export/:roomId` 查数据库是否已存导出。
2. `exists` → 用数据库 data，`previewSource = "db"`(徽标“来自数据库”)。
3. 否则 → 本地 `buildReplayExportData(room, aiCallLogs, showSkips, includeUserPrompt)`，`previewSource = "local"`(徽标“本地生成”)。
4. 查询失败 → `previewMessage`(error)。

头部开关变化时 `refreshPreviewFromToggles` 用本地重建覆盖预览，`previewSource` 重置为 `"local"`。

工具栏(`replay-preview-toolbar`)两个动作：

- **导出 JSON** → `handleExportPreview` → `downloadJson(previewData, replay-<roomId>.json)`。
- **保存到数据库** → `handleSavePreviewToDatabase` → `POST /replay/export/:roomId`，body `{ data: previewData, includeSkips, includeUserPrompt }`；成功后 `previewSource` 置 `"db"` 并提示“已保存到数据库”。

> 前端保存进数据库的 data 是本地构造的，**不含 `promptGenerationId`**(见“数据来源”的字段差异)。需要带版本代号的导出请用服务端 `GET /replay/:roomId/export`。

预览头部还显示当前开关摘要(`replay-preview-toggles-summary`)与“自动换行”开关(`previewWrap`)。

相关状态：`showPreview`、`previewData`、`previewSource`(`"db" | "local" | null`)、`previewLoading`、`previewSaving`、`previewMessage`、`previewWrap`。

### 相关样式

`apps/web/app/globals.css`：

- 一键复盘：`.replay-analyze-btn`、`.replay-analysis-section`、`.replay-analysis-status`、`.replay-analysis-content`
- 预览：`.replay-preview-section`、`.replay-preview-head`、`.replay-preview-source-badge`(含 `.db`/`.local`)、`.replay-preview-toggles-summary`、`.replay-preview-toolbar`、`.replay-preview-message`(含 `.success`/`.error`)、`.replay-preview-active`、`.replay-preview-close-btn`
- 通用开关：`.replay-toggle-switch`、`.replay-toggle-slider`、`.replay-toggle-label`
- 错误：`.replay-debug-error`

## 请求体大小

因为复盘 JSON 默认包含 AI 用户提示词，体积可能较大。

API 在 `apps/api/src/main.ts` 中将 JSON body limit 调整为 `5mb`：

```ts
app.useBodyParser("json", { limit: "5mb" });
app.useBodyParser("urlencoded", { extended: true, limit: "5mb" });
```

## 验证

当前实现已通过：

```bash
npm --workspace apps/api run build
npm --workspace apps/web run build
```
