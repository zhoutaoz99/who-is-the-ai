# docs/ 文档总览

本目录是「谁是AI」项目的玩法与实现方案文档,按「真实对局」与「迭代 AI 玩家」两类分开存放。每篇文档开头都标注了它与其他文档的分工,避免内容重叠。

> 最近核对日期:2026-06-15。各篇已与 `apps/api`、`apps/web` 当前代码对齐。

## 目录结构

```text
docs/
  gameplay/        真实对局相关:运行的对局本体与其中 AI 的行为
  ai-iteration/    用于迭代 AI 玩家:离线评估/版本管理工具与迭代记录
  README.md        本索引
  Roadmap.md       项目路线图(前瞻规划)
  ImplementationPlan/  早期分阶段实现计划归档(历史参考)
```

## 阅读顺序建议

第一次了解项目,建议按这个顺序读:

1. [gameplay/Gameplay.md](./gameplay/Gameplay.md) — 游戏玩法与规则(最浅层入口)。
2. [gameplay/AI-Interaction-Flow.md](./gameplay/AI-Interaction-Flow.md) — AI 玩家在普通对局里如何发言、投票、调模型。
3. [gameplay/AI-Scheduling.md](./gameplay/AI-Scheduling.md) — 发言调度的设计动机(为什么不像机器人)。
4. [ai-iteration/AI-Human-Likeness.md](./ai-iteration/AI-Human-Likeness.md) — 拟人化迭代的完整记录。
5. 再按需进入「自动评估闭环」「复盘」「缓存优化」等专题。

---

## gameplay/ — 真实对局相关

运行中的对局本体,以及其中 AI 玩家的发言/投票/调度/缓存等生产行为。

| 文档 | 内容 |
| --- | --- |
| [Gameplay.md](./gameplay/Gameplay.md) | 游戏简介、基础配置、流程、胜负与投票/奖励规则。 |
| [AI-Interaction-Flow.md](./gameplay/AI-Interaction-Flow.md) | AI 发言/投票交互流程、GameContext 字段、人格、Prompt 结构、模型调用与常量。**普通对局的 AI 交互主文档。** |
| [AI-Scheduling.md](./gameplay/AI-Scheduling.md) | 发言调度的设计动机与第一版方案(为何不用固定概率、策略层输出什么)。 |
| [AI-Prompt-Cache-Optimization.md](./gameplay/AI-Prompt-Cache-Optimization.md) | OpenAI 自动前缀缓存 + Claude 显式多层 `cache_control` 的优化方案与模板字段顺序。 |

## ai-iteration/ — 用于迭代 AI 玩家

离线工具与迭代记录:批量跑无头对局、冻结尺子量化打分、提示词版本管理、自动对抗调试房,以及复盘分析(既是玩家功能、也是评估闭环的数据源)。

| 文档 | 内容 |
| --- | --- |
| [AI-Human-Likeness.md](./ai-iteration/AI-Human-Likeness.md) | AI 拟人化优化的根因分析、已落地项、可实施方案与 4 轮迭代记录。 |
| [AI-Auto-Adversarial-Match.md](./ai-iteration/AI-Auto-Adversarial-Match.md) | 调试用的「AI 自动对抗」调试房:玩家建模、模拟真人强度(normal/high)、快速/普通两套发言调度、投票兜底、前端展示。 |
| [AI-Prompt-Eval-Details.md](./ai-iteration/AI-Prompt-Eval-Details.md) | 提示词 DB 版本管理 + 单局打分 + 轮聚合 scorecard 的**内部详细逻辑**(「某一步内部怎么算」)。 |
| [AI-Prompt-Eval-Flow.md](./ai-iteration/AI-Prompt-Eval-Flow.md) | 自动对局评估自迭代的**整体流程**(「步骤之间怎么连」),含组件图、主循环、实时事件、数据模型。 |
| [Replay-Analysis.md](./ai-iteration/Replay-Analysis.md) | 一键复盘的前后端实现、流式输出、版本感知复盘、Prompt 文件与前端展示。 |

> [AI-Prompt-Eval-Details.md](./ai-iteration/AI-Prompt-Eval-Details.md) 与 [AI-Prompt-Eval-Flow.md](./ai-iteration/AI-Prompt-Eval-Flow.md) 是互补的一对:前者讲单步内部计算,后者讲步骤间串联。

---

## 项目级文档

| 文档 | 内容 |
| --- | --- |
| [Roadmap.md](./Roadmap.md) | 项目路线图,只列未完成/部分完成的事项,已完成项指向对应功能文档。 |
| [ImplementationPlan/](./ImplementationPlan/) | 早期分阶段实现计划归档(`P0/`、`init/`),保留作历史参考。 |

## 交叉引用地图

```text
gameplay/
  Gameplay.md
    └─ AI-Interaction-Flow.md ─┬─ AI-Scheduling.md
                               ├─ AI-Prompt-Cache-Optimization.md
                               └─ (跨目录)→ ai-iteration/*

ai-iteration/
  AI-Human-Likeness.md ── AI-Prompt-Eval-Details.md ── AI-Prompt-Eval-Flow.md
  AI-Auto-Adversarial-Match.md ── AI-Prompt-Eval-Details.md
  Replay-Analysis.md ── AI-Prompt-Eval-Details.md
  (跨目录)→ gameplay/AI-Interaction-Flow.md、AI-Scheduling.md

项目级:
  Roadmap.md (指向以上各功能文档)
```

## 维护约定

- 新增文档请放进 `gameplay/` 或 `ai-iteration/`(真实对局 vs 迭代 AI),并在本索引登记。
- 每篇文档开头用引用块说明与其他文档的分工,避免重叠。
- 跨目录引用用相对路径(`../gameplay/X.md` / `../ai-iteration/X.md`)。
- 涉及代码路径、常量、人格清单、接口的内容改动后,记得回核对齐;在文档顶部记录最近核对日期。
