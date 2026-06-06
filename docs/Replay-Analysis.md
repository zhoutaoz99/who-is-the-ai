# 复盘分析实现

## 目标

复盘页提供“一键复盘”能力，用独立配置的大模型分析对局记录，输出开放式文本结果。分析重点包括：

- 根据对局结果分析获胜方胜利原因。
- 指出失败方明显问题。
- 发现 AI 行为、提示词、投票逻辑、发言质量上的优化方向。
- 识别明显对局 bug 或疑似规则异常。

## 数据来源

复盘分析复用复盘页“导出 JSON”的数据构造逻辑。

前端入口位于：

- `apps/web/app/replay/[roomId]/page.tsx`

核心函数：

- `buildReplayExportData(room, aiCallLogs, includeSkips, includeUserPrompt)`

一键复盘固定使用：

- `includeSkips: true`
- `includeUserPrompt: true`

这样模型可以看到 skip 记录和 AI 用户提示词，便于分析提示词问题和模型行为问题。

## 后端接口

唯一复盘分析接口：

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

## 流式输出

后端 `ReplayController.streamAnalyzeReplay` 会：

1. 校验 `body.replay`。
2. 设置 `text/plain` 流式响应头。
3. 调用 `ReplayService.streamReplayAnalysisExport`。
4. 将模型返回的 chunk 直接写入 HTTP 响应。
5. 监听响应连接 `close` 事件，客户端中断时通过 `AbortController` 取消模型请求。

前端 `handleAnalyzeReplay` 会：

1. 构造复盘导出 JSON。
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

## Prompt 文件

复盘分析 prompt 分为系统提示词和用户提示词模板。

系统提示词：

- `apps/api/src/ai/prompts/system-replay-analysis.txt`

职责：

- 定义“谁是AI”的游戏规则。
- 说明分析边界。
- 定义分析优先级。
- 定义开放式 bug / 规则异常分析方式。
- 定义输出格式建议。

用户提示词模板：

- `apps/api/src/ai/prompts/user-replay-analysis-template.txt`

职责：

- 说明输入是一份复盘页导出的 JSON。
- 注入 `{{replayJson}}`。

用户提示词不重复系统提示词中的规则和分析优先级。

渲染位置：

- `ReplayService.buildReplayAnalysisPrompt`

## 前端展示

复盘页在头部操作区提供“一键复盘”按钮，并在玩家概览前展示分析结果面板。

相关状态：

- `analysisText`
- `analysisLoading`
- `analysisError`
- `analysisInterrupted`
- `analysisAbortRef`

相关样式：

- `apps/web/app/globals.css`
- `.replay-analyze-btn`
- `.replay-analysis-section`
- `.replay-analysis-status`
- `.replay-analysis-content`

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
