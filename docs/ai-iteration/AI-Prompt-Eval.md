# AI 提示词自动对局评估自迭代 · 总览

| 字段 | 内容 |
| --- | --- |
| 文档类型 | Design |
| 文档状态 | Active |
| 适用范围 | 自动对局评估自迭代文档入口、阅读路径与分工说明 |
| 目标读者 | 后端开发、评审者 |
| 责任人 | AI / Evaluation 维护者 |
| 最近核对日期 | 2026-06-16 |
| 关联代码 | `apps/api/src/ai/`、`apps/api/src/iteration/`、`apps/web/app/iteration/` |
| 关联文档 | [AI-Prompt-Eval-Flow.md](./AI-Prompt-Eval-Flow.md)、[AI-Prompt-Eval-Auto-Optimize.md](./AI-Prompt-Eval-Auto-Optimize.md)、[AI-Prompt-Eval-Details.md](./AI-Prompt-Eval-Details.md)、[AI-Human-Likeness.md](./AI-Human-Likeness.md)、[Replay-Analysis.md](./Replay-Analysis.md) |

这是自动对局评估自迭代的入口页，不替代正文，只负责把主题拆清楚：

- `AI-Prompt-Eval-Flow.md`：看“怎么跑”。重点是主循环、状态流转、实时事件和数据模型。
- `AI-Prompt-Eval-Auto-Optimize.md`：看“单局打分、scorecard 和自动优化器怎么跑”。以后改这条链路，优先只改这一篇。
- `AI-Prompt-Eval-Details.md`：看“版本怎么管”。重点是版本库、手动优化面板和版本感知复盘。

建议阅读顺序：

1. 先看 Flow，建立整体路径。
2. 如果要改单局打分、scorecard 或自动优化器，直接看 Auto-Optimize。
3. 再看 Details，补齐版本库与手动优化面板。

## 1. 主题地图

| 文档 | 关注点 |
| --- | --- |
| [AI-Prompt-Eval-Flow.md](./AI-Prompt-Eval-Flow.md) | 运行顺序、状态机、事件流、数据模型、run / round / game 的串联。 |
| [AI-Prompt-Eval-Auto-Optimize.md](./AI-Prompt-Eval-Auto-Optimize.md) | 单局打分、scorecard 聚合和自动优化器的独立维护点。 |
| [AI-Prompt-Eval-Details.md](./AI-Prompt-Eval-Details.md) | AI 提示词版本库、评估尺子版本库、手动优化面板与版本感知复盘。 |
| [Replay-Analysis.md](./Replay-Analysis.md) | 单局复盘，开放文本，只读不改状态。 |
| [AI-Human-Likeness.md](./AI-Human-Likeness.md) | 拟人化优化的背景、问题拆解与迭代记录。 |

## 2. 关键不变量

- AI 提示词版本库与评估尺子版本库是两套独立的版本系统，互不影响。
- 每局对局会记录 `promptGenerationId`，每局打分会记录 `scoreGenerationId`。
- 每轮自动优化会记录 `autoOptimize.evalGenerationId`，用于回放时重建请求。
- `eval/prompts/*` 只是 seed / fallback，不是运行时唯一来源。
- `scorecard` 是一轮 B 局的聚合结果，不是单局结果。

## 3. 什么时候看哪篇

- 改主循环、状态流转、事件推送、数据表关系时，先看 Flow。
- 改单局打分、scorecard 或自动优化器实现逻辑时，先看 Auto-Optimize。
- 改 prompt 版本管理、手动优化面板或版本感知复盘时，先看 Details。
- 只想看单局复盘怎么生成文本时，看 Replay-Analysis。
