# 文档总览

| 字段 | 内容 |
| --- | --- |
| 文档类型 | Overview |
| 文档状态 | Active |
| 适用范围 | `docs/` 下的正式文档，不包括 `docs/ImplementationPlan/` 与 `docs/design/` 草稿 |
| 目标读者 | 项目维护者、开发、测试、评审者 |
| 责任人 | 项目维护者 |
| 最近核对日期 | 2026-06-30 |
| 关联代码 | `docs/`、`apps/api`、`apps/web` |
| 关联文档 | [Doc-Style-Guide.md](./Doc-Style-Guide.md)、[Roadmap.md](./Roadmap.md) |

## 目的与范围

本目录整理「谁是AI」项目的正式文档。当前主线文档聚焦真实对局与项目级索引/规范；`docs/design/` 保留专题设计草稿，`docs/ImplementationPlan/` 保留早期实施计划归档。各文档通过统一元数据表说明自身类型、范围和关联文档，避免内容重叠。

## 目录结构

```text
docs/
  gameplay/        真实对局相关:运行的对局本体与其中 AI 的行为
  design/          专题设计草稿与补充材料(不在本清单)
  README.md        本索引
  Roadmap.md       项目路线图(前瞻规划)
  Doc-Style-Guide.md  文档写作规范
  ImplementationPlan/  早期分阶段实现计划归档(历史参考)
```

## 阅读路径

第一次了解项目,建议按这个顺序读:

1. [gameplay/Player-Guide.md](./gameplay/Player-Guide.md) — 给玩家看的简明玩法说明，可直接用于 UI 展示。
2. [gameplay/Gameplay.md](./gameplay/Gameplay.md) — 普通对局的完整规则说明。
3. [gameplay/AI-Interaction-Flow.md](./gameplay/AI-Interaction-Flow.md) — AI 玩家在普通对局里如何发言、投票、调模型。
4. [gameplay/AI-Human-Likeness-Design.md](./gameplay/AI-Human-Likeness-Design.md) — 当前 AI 拟人化设计主文档：策略层、表达层、短期记忆与人格库。
5. [gameplay/AI-Scheduling.md](./gameplay/AI-Scheduling.md) — 发言调度的设计动机(为什么不像机器人)。
6. [gameplay/AI-Prompt-Cache-Optimization.md](./gameplay/AI-Prompt-Cache-Optimization.md) — 提示词缓存的设计与模板组织。
7. 再按需进入 [Roadmap.md](./Roadmap.md) 和 [Doc-Style-Guide.md](./Doc-Style-Guide.md) 查看规划与写作约定。

---

## 文档清单

### gameplay/ — 真实对局相关

运行中的对局本体,以及其中 AI 玩家的发言/投票/调度/缓存等生产行为。

| 文档 | 内容 |
| --- | --- |
| [Player-Guide.md](./gameplay/Player-Guide.md) | 面向玩家的简明玩法说明，可直接用于 UI 展示。 |
| [Gameplay.md](./gameplay/Gameplay.md) | 游戏简介、基础配置、流程、胜负与投票/奖励规则。 |
| [AI-Interaction-Flow.md](./gameplay/AI-Interaction-Flow.md) | AI 发言/投票交互流程、GameContext 字段、人格、Prompt 结构、模型调用与常量。**普通对局的 AI 交互主文档。** |
| [AI-Human-Likeness-Design.md](./gameplay/AI-Human-Likeness-Design.md) | 当前 AI 拟人化设计主文档：策略层、表达层、短期记忆与人格库。 |
| [AI-Scheduling.md](./gameplay/AI-Scheduling.md) | 发言调度的设计动机与第一版方案(为何不用固定概率、策略层输出什么)。 |
| [AI-Prompt-Cache-Optimization.md](./gameplay/AI-Prompt-Cache-Optimization.md) | OpenAI 自动前缀缓存 + Claude 显式多层 `cache_control` 的优化方案与模板字段顺序。 |

### 项目级文档

| 文档 | 内容 |
| --- | --- |
| [Roadmap.md](./Roadmap.md) | 项目路线图,只列未完成/部分完成的事项,已完成项指向对应功能文档。 |
| [Doc-Style-Guide.md](./Doc-Style-Guide.md) | 文档写作规范:标题、头部信息块、章节结构、交叉与代码引用的统一约定。 |
| [ImplementationPlan/](./ImplementationPlan/) | 早期分阶段实现计划归档(`P0/`、`init/`),保留作历史参考。 |

## 交叉引用地图

```text
gameplay/
  Player-Guide.md
    └─ Gameplay.md
  Gameplay.md
    └─ AI-Interaction-Flow.md ─┬─ AI-Scheduling.md
                               ├─ AI-Human-Likeness-Design.md
                               └─ AI-Prompt-Cache-Optimization.md

项目级:
  README.md ── gameplay/*、Roadmap.md、Doc-Style-Guide.md
  Roadmap.md (指向以上主线功能文档)
```

## 维护约定

- 新增正式文档请放进 `gameplay/` 或 `docs/` 根目录的项目级文档；专题设计草稿放进 `design/`。
- 写作遵循 [Doc-Style-Guide.md](./Doc-Style-Guide.md) 的标题与结构规范。
- 每篇正式文档开头使用统一元数据表说明文档类型、范围与关联文档。
- 跨目录引用用相对路径(例如 `../gameplay/X.md` / `../design/Y.md`)。
- 涉及代码路径、常量、人格清单、接口的内容改动后,记得回核对齐;在文档顶部记录最近核对日期。
