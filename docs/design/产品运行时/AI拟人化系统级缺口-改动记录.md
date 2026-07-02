# AI 拟人化系统级缺口 · 改动记录

| 字段 | 内容 |
| --- | --- |
| 文档类型 | Iteration Report |
| 文档状态 | Active |
| 适用范围 | [AI 拟人化系统级缺口](./AI拟人化系统级缺口.md) 登记的 `GAP-*` 机制类改动的**累积时间线**（一次机制改动追加一条，供后续回溯） |
| 目标读者 | 后端 / AI 开发、评审者 |
| 责任人 | AI / Gameplay 维护者 |
| 最近核对日期 | 2026-07-02 |
| 关联代码 | `apps/api/src/ai/`、`apps/api/src/game/game.service.ts`（各条目内注明具体位置） |
| 关联文档 | [AI 拟人化系统级缺口](./AI拟人化系统级缺口.md)、[ai玩家 prompt模板与人设卡](./ai玩家%20prompt模板与人设卡.md) |

---

## 1. 目的与用法

- 本文是[系统级缺口册](./AI拟人化系统级缺口.md)中 `GAP-*` 机制改动的**累积 changelog**：每做一次机制类改动就在 §3 追加一条，用于回溯"哪个缺口、什么时候、怎么改的、验证到什么程度"。
- **只记机制类改动**（缺口册 §4 判定的 A/B/C 三类：输入状态 / 输出投递 / 轮次仲裁）。提示词措辞优化属优化器，不进本文。
- 追加规范：
  - 一次改动一条，**倒序**（最新在最前）。
  - 每条套 §2 模板，字段齐全；缺口册对应章节回填一行"实现进度"并链接到本条。
  - 改动落地但未验证时如实写"待观察"，别把"已改代码"写成"已见效"。

## 2. 条目模板

```md
### YYYY-MM-DD · `GAP-XXX` · <一句话摘要>

- **缺口**：[`GAP-XXX`](./AI拟人化系统级缺口.md#<锚点或章节>)（类别 A/B/C）
- **问题**：<为什么改>
- **改动项**：
  | 位置 | 改动 | 说明 |
  | --- | --- | --- |
- **关键决策**：<取舍要点>
- **状态**：<已落地 / 部分 / 回滚>；<静态验证做了什么；线上/A-B 数据有没有>
- **未完 / 下一步**：<同缺口还剩什么>
- **关联**：代码 `<path>`；文档 `<link>`
```

## 3. 改动记录（倒序）

### 2026-07-02 · `GAP-TIMING` · 时间感知（输入侧第一步）

- **缺口**：[`GAP-TIMING` 时间感知与节奏](./AI拟人化系统级缺口.md)（类别 A 输入状态 + B 输出投递；本条只动 A）
- **问题**：讨论阶段有倒计时（`DEFAULT_DISCUSSION_DURATION_MS = 300_000`，最短 60s），真人前端能看到（`apps/web/app/game/[roomId]/page.tsx` 按 `max(0, phaseEndsAt - now)` 展示），但 AI 讨论提示词里没有剩余时间——AI 不会像真人那样临近结束压哨、或时间充裕时不急表态。
- **改动项**：
  | 位置 | 改动 | 说明 |
  | --- | --- | --- |
  | `ai.service.ts` `formatRoundTimeLeft(remainingMs)` | 新增 | 把 `remainingTimeMs` 渲染成"瞥一眼倒计时"式约数（分桶见下） |
  | `ai.service.ts` `buildDiscussionUserPrompt` | 新增变量 | 传 `roundTimeLeft: formatRoundTimeLeft(context.remainingTimeMs)` |
  | `user-discussion-template.txt` | 新增 `{{roundTimeLeft}}` 行 | 置于尾部"接一句…"动作指令之前、输出格式行仍保持最后 |

  数据来源：`context.remainingTimeMs` 取自 `buildGameContext` 的 `remainingMs = max(0, phaseEndsAt - Date.now())`，与前端倒计时同源；每次 `generateSpeech` 重算，同轮多次发言约数自然递减。

  分桶（粗粒度）：`≤5s 马上结束 / ≤20s 快结束了就剩二十来秒 / ≤45s 时间不多了还剩约 N0 秒 / ≤120s 还有一两分钟 / 其它 时间还早`。

- **关键决策**：
  - **只给约数、不给毫秒**：与真人所见扯平，避免精确时间推理的机器味。
  - **放尾部但在输出格式行之前**：落在"会话之后、永不缓存的尾巴"，不伤缓存前缀（对齐[提示词缓存优化](../../gameplay/AI-Prompt-Cache-Optimization.md)）；作为决策依据排在"接一句/[skip]"之前，把"只输出这一句…"留在最后一行保发言格式。
  - **AI / 侦探 / 填充通吃**：三者共用讨论 user 模板。
- **状态**：已落地。静态验证：`npx tsc --noEmit` 通过；0~300s 采样渲染分桶自然；整模板渲染确认 `{{roundTimeLeft}}` 独占一行、位置正确。**无对局 / 线上 / A-B 数据**，节奏改善仍是假设。
- **未完 / 下一步**：`GAP-TIMING` 输出侧节奏未做（改 `typingDelayForContent` / 出站延迟通道，按消息类型+房间语速从人类分布采样延迟）；上线后扫一眼真实发言，确认没把"本轮讨论快结束了"当台词复读，若有并入 `GAP-SEGMENTATION` humanizer。
- **关联**：代码 `apps/api/src/ai/ai.service.ts`、`apps/api/src/ai/prompts/ai-player/user-discussion-template.txt`、`apps/api/src/game/game.service.ts`（`buildGameContext`）；文档 [系统级缺口册 §6.1](./AI拟人化系统级缺口.md)。
