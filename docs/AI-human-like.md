# AI 拟人化优化方案

## 背景

以 `replay-0B0B57.json` 为例，当前 AI 发言的主要问题不是模型能力不足，而是“说话方式像系统在分析局势”。表现为：

- 信息很少时仍强行分析。
- 发言过完整、过圆滑，缺少即时聊天的碎片感。
- 策略层抽象词被表达层直译成模板话术。
- 多个 AI 的观点和节奏过一致，容易像同阵营联动。

本方案目标是让 AI 更像真人玩家，而不是让 AI 更会总结。

## Replay 问题样例

### 样例 1

原 AI 发言：

```text
3号好，刚打了个招呼。2号怎么不说话呀？先看看大家反应。
```

问题：

- “刚打了个招呼”“先看看大家反应”像主持人或复盘视角。
- 真人在低信息局面更可能只短互动。

更自然的版本：

```text
就一个 hi 也看不出啥，2号人呢？
```

### 样例 2

原 AI 发言：

```text
哈哈，1号别急，我刚在看大家发言呢。3号反应挺快的，1号也挺主动的。先听听看。
```

问题：

- 同时评价 1 号和 3 号，过于均衡。
- “反应挺快”“挺主动”“先听听看”是高频安全话术。

更自然的版本：

```text
我刚才没啥好说的啊，就3号这句“机械”有点太快了吧。
```

### 样例 3

原 AI 发言：

```text
3号，你第一反应说我机械，是不是有点敏感了啊？这才刚开局呢，我让大家说话不是很正常吗？你反应也太快了点吧。
```

问题：

- 方向正确，但过度完整，像标准防守模板。
- 真人被质疑时通常更短、更碎、更情绪化。

更自然的版本：

```text
啊？我就催一下2号，这也算机械吗。你这帽子扣得有点快吧。
```

## 根因分析

### 1. 策略层过抽象

旧策略字段类似 `goal/reason/intensity/length`，容易产生“观察、留后手、轻微试探、不站死”等抽象策略词。表达层即使要求口语化，也会把这些词转成“先看看大家反应”“先听听看”。

当前已改为更可执行的结构：

```json
{
  "replyTo": "3号说我机械",
  "speechAct": "防守反问",
  "publicPoint": "我只是催2号说句话，不足以说明机械",
  "tone": "有点不服，但别长篇解释",
  "maxSentences": 2,
  "constraints": ["不要同时点评多人"],
  "avoidPhrases": ["先看看大家反应", "带节奏", "有点可疑"]
}
```

### 2. 低信息场景强行发言

当最近消息只有 `hi`、单字、寒暄、催人说话时，AI 最自然的行为通常是沉默，或者只做一句短互动。强行产出局势判断会显得机械。

### 3. 表达层过度完整

模型容易输出完整论证链：先承认、再分析、再下结论。真人即时聊天更常见的是短句、反问、省略、轻微情绪。

### 4. 多 AI 风格趋同

如果多个 AI 都使用同一套 prompt 和同一套安全话术，它们会在同一事件上作出相似判断，容易形成“系统角色一起围攻真人”的观感。

### 5. 调度过机械

固定间隔和固定概率会让 AI 像自动填充对话。调度优化见 [`AI-Scheduling.md`](AI-Scheduling.md)。

## 已落地优化

### 策略层结构化

已将策略层改为 `replyTo / speechAct / publicPoint / tone / maxSentences / constraints / avoidPhrases`，让策略更贴近“本次具体要接哪句话、用什么动作说什么”。

相关文件：

- `apps/api/src/ai/ai.types.ts`
- `apps/api/src/ai/ai.service.ts`
- `apps/api/src/ai/prompts/system-speech-strategy.txt`
- `apps/api/src/ai/prompts/system-speech-expression.txt`

### 表达层短句化

表达层已强调：

- 默认 1-2 句。
- 最多 160 字符。
- 允许反问、省略、口头禅。
- 避免报告、总结、主持或复盘口吻。
- 避免模板话术。

### 调度自主化

AI 策略层已开始返回：

- `targetResponseDelayMs`
- `nextCheckAfterMs`

工程层只做硬约束、时间裁剪和上下文过期校验。

## 可实施方案

### 阶段 1：继续打磨 Prompt

目标：用最小工程改动继续降低模板感。

实施项：

1. 扩充 `avoidPhrases` 默认词库。
2. 给表达层增加“禁用句式”：
   - “我觉得 X 有点...，但是先不...”
   - “现在信息还不多，先...”
   - “大家可以再说说”
   - “我先不站死”
3. 增加“低信息短回复”示例：
   - `就一个 hi 看不出啥。`
   - `2号还没说话吧？`
   - `这也能算机械？`
4. 增加“被质疑时短反问”示例：
   - `我就问一句，这也算机械？`
   - `别急着给我扣帽子吧。`
   - `这刚开局，你下结论太快了。`

验收标准：

- replay 中 AI 不再高频出现“先看看”“先听听”“观察一下”。
- 低信息局面中 AI 更常 skip 或只发 1 句。
- 被点名时回复更短。

### 阶段 2：AI 人格系统

目标：让不同 AI 的发言节奏、句式和攻击性有差异。

第一版已落地：创建 AI 玩家时随机分配一个 `aiPersonaId`，构建 `GameContext` 时解析成完整 persona，并注入发言策略、表达转换和投票 prompt。游戏结束后的 replay 快照会揭示 AI 的人格名称，方便复盘。

当前 persona 结构：

```ts
type AiPersona = {
  id: string;
  name: string;
  speechStyle: string;
  sentenceStyle: string;
  responseBias: string;
  toneRules: string[];
  avoidPhrases: string[];
};
```

示例：

```json
{
  "id": "short_skeptic",
  "name": "短句怀疑型",
  "speechStyle": "话少，直接，常用短反问，不喜欢铺垫。",
  "sentenceStyle": "多数时候 1 句，最多 2 句；少用连接词。",
  "responseBias": "被点名或看到过快下结论时更愿意接话，平时不主动长篇分析。",
  "toneRules": ["可以有一点不服", "不要太礼貌圆滑", "不要完整论证自己"],
  "avoidPhrases": ["先看看", "观察一下", "不站死", "有点可疑"]
}
```

已实现文件：

- `apps/api/src/ai/ai.personas.ts`
- `apps/api/src/game/game.rules.ts`
- `apps/api/src/game/game.types.ts`
- `apps/api/src/game/game.service.ts`
- `apps/api/src/ai/prompts/user-speech-strategy-template.txt`
- `apps/api/src/ai/prompts/user-speech-expression-template.txt`
- `apps/api/src/ai/prompts/user-vote-template.txt`

后续可继续做：

1. 根据 replay 结果调整 persona 文案。
2. 给不同 persona 设置不同 `targetResponseDelayMs` 偏好。
3. persona 与 AI 名字做稳定搭配，减少割裂感。

### 阶段 3：发言记忆与立场连续性

目标：减少 AI 前后观点跳跃，让 AI 有“自己的视角”。

建议维护轻量记忆：

```ts
type AiMemory = {
  suspiciousSeats: Array<{ seatNo: number; reason: string; confidence: number }>;
  defendedSeats: Array<{ seatNo: number; reason: string }>;
  lastStanceSummary: string;
  repeatedPhrases: string[];
};
```

实现步骤：

1. 每轮结束后根据聊天和投票生成每个 AI 的短摘要。
2. 下轮 `GameContext` 增加 `myMemorySummary`。
3. 策略层要求不要无理由推翻自己的上轮立场。
4. 表达层要求避免重复自己的 `repeatedPhrases`。

优先级：`P1/P2`。需要有更多 replay 样本后再做。

### 阶段 4：上下文信息质量判断

目标：让 AI 判断“有没有值得说的东西”，而不是为了完成任务找话说。

实现方式：

1. 在策略层 prompt 中强化 `informationLevel` 思维，但不要求输出。
2. 或显式输出：

```json
{
  "informationLevel": "low",
  "type": "skip",
  "reason": "只有问候，没有实质信息",
  "nextCheckAfterMs": 12000
}
```

3. 工程层可以只记录该字段，不参与强控制。

优先级：`P2`。当前可以先靠 prompt 隐式判断。

### 阶段 5：Replay 评估闭环

目标：用导出对局持续验证 AI 是否更像真人。

建议增加一组人工/半自动评分项：

| 指标 | 判断方式 |
| --- | --- |
| 低信息强行分析 | 最近只有寒暄时是否给出局势判断 |
| 模板话术 | 是否出现禁用词或近似表达 |
| 句子过完整 | 是否每次都是 2-4 句完整论证 |
| 多 AI 同步 | 多个 AI 是否连续对同一真人同向施压 |
| 忽略新消息 | 是否基于旧上下文发言 |
| 口语自然度 | 是否像即时聊天而非报告 |

实现步骤：

1. 在 replay 页面为每条 AI 发言显示 `strategy`、原始输出和最终发言。
2. 增加人工标记按钮：`机械`、`自然`、`忽略上下文`、`过度分析`。
3. 导出评估 JSON，用于下一轮 prompt 调整。

优先级：`P2`。

## 推荐落地顺序

1. 继续补 prompt 示例和禁用话术，成本最低，收益直接。
2. 接入 persona，让两个 AI 说话风格分化。
3. 增加 AI 记忆摘要，保证跨轮立场一致。
4. 建设 replay 评估闭环，避免凭感觉改 prompt。

## 当前最佳实践

AI 发言要遵循：

- 信息少时少说。
- 被点名时短反问。
- 一次只接一个点。
- 不同时评价多人。
- 不做主持人式总结。
- 不使用“先看看”“先听听”“观察一下”等模板话术。
- 多个 AI 不要立刻互相帮腔。

核心目标：

```text
少分析，短回应，有临场感。
```
