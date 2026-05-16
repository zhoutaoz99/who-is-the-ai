# P0 实现方案索引

本目录存放 `FollowUpPlan.md` 中 P0 级计划的实现方案。P0 的定义是影响核心可玩性、公平性或上线安全的必要事项。

## 文档结构

| 文档 | 覆盖范围 |
| --- | --- |
| [01-development-stages.md](./01-development-stages.md) | 开发阶段：无 AI MVP、假 AI 接入 |
| [02-core-gameplay-and-fairness.md](./02-core-gameplay-and-fairness.md) | 业务视角：核心玩法和公平规则 |
| [03-authoritative-state-and-security.md](./03-authoritative-state-and-security.md) | 实现视角：权威状态和基础安全 |

## 建议实施顺序

1. 先完成 [03-authoritative-state-and-security.md](./03-authoritative-state-and-security.md) 中的服务端权威状态、阶段定时器和 WebSocket 校验，确保后续规则有可靠状态基础。
2. 再完成 [02-core-gameplay-and-fairness.md](./02-core-gameplay-and-fairness.md) 中的平票、弃票、掉线和异常行为规则，补齐公平性。
3. 然后完成 [01-development-stages.md](./01-development-stages.md) 中的无 AI MVP 和假 AI 接入闭环。
4. 最后补齐 AI 上下文可信度、AI 输出校验、AI 超时兜底和消息质量治理。
