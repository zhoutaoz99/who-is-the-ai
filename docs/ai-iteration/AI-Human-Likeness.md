# AI 拟人化优化

| 字段 | 内容 |
| --- | --- |
| 文档类型 | Iteration Report |
| 文档状态 | Active |
| 适用范围 | AI 拟人化优化的迭代记录、实验结论与后续演进 |
| 目标读者 | 后端开发、评审者 |
| 责任人 | AI / Gameplay 维护者 |
| 最近核对日期 | 2026-06-15 |
| 关联代码 | `apps/api/src/ai/`、`apps/api/src/game/`、`apps/web/app/replay/` |
| 关联文档 | [AI-Prompt-Eval-Details.md](AI-Prompt-Eval-Details.md)、[AI-Interaction-Flow.md](../gameplay/AI-Interaction-Flow.md) |

相关:提示词的 DB 版本管理与批量自动对局评估闭环见 [`AI-Prompt-Eval-Details.md`](AI-Prompt-Eval-Details.md)。本文是迭代记录，那篇是可持续迭代的工程化方案。

## 1. 背景

以 `replay-0B0B57.json` 为例，当前 AI 发言的主要问题不是模型能力不足，而是“说话方式像系统在分析局势”。表现为：

- 信息很少时仍强行分析。
- 发言过完整、过圆滑，缺少即时聊天的碎片感。
- 策略层抽象词被表达层直译成模板话术。
- 多个 AI 的观点和节奏过一致，容易像同阵营联动。

本方案目标是让 AI 更像真人玩家，而不是让 AI 更会总结。

## 2. 问题陈述

### 2.1 样例 1

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

### 2.2 样例 2

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

### 2.3 样例 3

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

## 3. 假设

### 3.1 策略层过抽象

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

### 3.2 低信息场景强行发言

当最近消息只有 `hi`、单字、寒暄、催人说话时，AI 最自然的行为通常是沉默，或者只做一句短互动。强行产出局势判断会显得机械。

### 3.3 表达层过度完整

模型容易输出完整论证链：先承认、再分析、再下结论。真人即时聊天更常见的是短句、反问、省略、轻微情绪。

### 3.4 多 AI 风格趋同

如果多个 AI 都使用同一套 prompt 和同一套安全话术，它们会在同一事件上作出相似判断，容易形成“系统角色一起围攻真人”的观感。

### 3.5 调度过机械

固定间隔和固定概率会让 AI 像自动填充对话。调度优化见 [`AI-Scheduling.md`](../gameplay/AI-Scheduling.md)。

## 4. 改动项

### 4.1 策略层结构化

已将策略层改为 `replyTo / speechAct / publicPoint / tone / maxSentences / constraints / avoidPhrases`，让策略更贴近“本次具体要接哪句话、用什么动作说什么”。

相关文件：

- `apps/api/src/ai/ai.types.ts`
- `apps/api/src/ai/ai.service.ts`
- `apps/api/src/ai/prompts/system-speech-strategy.txt`
- `apps/api/src/ai/prompts/system-speech-expression.txt`

### 4.2 表达层短句化

表达层已强调：

- 默认 1-2 句。
- 最多 160 字符。
- 允许反问、省略、口头禅。
- 避免报告、总结、主持或复盘口吻。
- 避免模板话术。

### 4.3 调度自主化

AI 策略层已开始返回：

- `targetResponseDelayMs`
- `nextCheckAfterMs`

工程层只做硬约束、时间裁剪和上下文过期校验。

### 4.4 投票短期记忆

第一版已落地轻量短期记忆：每个模型驱动玩家只记录自己的历史投票目标和模型输出的可公开投票理由，用于后续发言和投票时保持自洽。

当前记忆结构挂在 `Room.aiMemories`，以玩家 ID 分桶，不进入公开 `RoomSnapshot`：

```ts
type AiShortMemory = {
  votes: Array<{
    roundNo: number;
    targetSeatNo: number;
    publicReason?: string;
    source: "model" | "fallback";
  }>;
};
```

写入规则：

- 只在投票真正成功写入 `room.votes` 后更新记忆。
- 模型投票记录 `source: "model"` 和 `reason`。
- 兜底投票记录 `source: "fallback"`，不伪造理由。
- 每个玩家只保留最近 4 条投票记忆。
- 记忆只给同一个模型驱动玩家自己看，不给其他玩家或其他 AI 看。

Prompt 使用方式：

- `GameContext.shortMemory` 只读取 `room.aiMemories[myPlayerId]`。
- 发言策略 prompt 和投票 prompt 都会看到“你的短期记忆”。
- 模板明确说明：短期记忆只代表自己的公开投票记录和可公开解释；如果与聊天记录冲突，以聊天记录为准。

已实现文件：

- `apps/api/src/game/game.types.ts`
- `apps/api/src/game/game.service.ts`
- `apps/api/src/ai/ai.types.ts`
- `apps/api/src/ai/ai.service.ts`
- `apps/api/src/ai/prompts/user-speech-strategy-template.txt`
- `apps/api/src/ai/prompts/user-vote-template.txt`
- `apps/api/src/ai/prompts/user-sim-human-speech-template.txt`
- `apps/api/src/ai/prompts/user-sim-human-vote-template.txt`

## 5. 实验设置或观察来源

- 主要观察样本包括 `replay-0B0B57.json`、`replay-3895D0.json`、`replay-FE64B3.json`、`replay-F63DDB.json`、`replay-8C0BE0.json`。
- 观察维度包括发言长度、开场句是否复用示例、被质疑后的回复形态、第一轮投票倾向、队友误伤情况。
- 相关提示词与人格来源于 `ai-player/`、`sim-human/` 提示词模板以及 `ai.personas.ts` 的人格库。

## 6. 结果

当前回放证明，句子级拟人化已经明显改善，但真正的瓶颈已经转移到策略层的生存判断和投票协同上。

- AI 发言不再集中复用固定开场，口语感明显提升。
- 第一轮盲投和队友误伤问题已经通过投票策略修复。
- 当前更需要优化的是“该不该说”“该投谁”“是否和自己阵营一致”。

## 7. 下一步

### 7.1 阶段 1：继续打磨 Prompt

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

### 7.2 阶段 2：AI 人格系统

目标：让不同 AI 的发言节奏、句式和攻击性有差异。

创建 AI 玩家时随机分配一个 `aiPersonaId`，构建 `GameContext` 时解析成完整 persona，并注入发言策略、表达转换和投票 prompt。游戏结束后的 replay 快照会揭示 AI 的人格名称，方便复盘。

> 人格库已在「迭代 1」重写为 8 个多元生活化人格（见下文「迭代记录」），并随 AI 提示词 DB 版本库一起迭代（可变 active 集，见 [`AI-Prompt-Eval-Details.md`](AI-Prompt-Eval-Details.md)）。当前 8 个人格见 [`AI-Interaction-Flow.md`](../gameplay/AI-Interaction-Flow.md) 的「AI 人格」一节。

当前 persona 结构（迭代 1 后新增可选 `typingHabit`、`sampleLines`）：

```ts
type AiPersona = {
  id: string;
  name: string;
  speechStyle: string;
  sentenceStyle: string;
  responseBias: string;
  toneRules: string[];
  avoidPhrases: string[];
  typingHabit?: string;   // 打字习惯（可选）
  sampleLines?: string[]; // 语感参考片段；表达层禁止照抄（见迭代 2 Fix1）
};
```

示例（`active_icebreaker`，破冰调度依赖此 id）：

```json
{
  "id": "active_icebreaker",
  "name": "热心话痨型",
  "speechStyle": "自来熟，话密，爱找话题，冷场先开口。",
  "sentenceStyle": "多句连发，口语化，常带语气词。",
  "responseBias": "主动起话头，被冷落时更想接话。",
  "toneRules": ["热情但不油腻", "可以带点小情绪", "别长篇分析"],
  "avoidPhrases": ["先看看", "观察一下", "不站死"]
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

### 7.3 阶段 3：扩展发言记忆与立场连续性

目标：减少 AI 前后观点跳跃，让 AI 有“自己的视角”。

当前已完成投票短期记忆。后续如果 replay 显示 AI 仍然存在“刚质疑过又突然改口”“被追问但忘记回应”“重复使用同一类表达动作”等问题，再扩展到发言立场记忆。

建议扩展结构：

```ts
type ExtendedAiShortMemory = {
  votes: Array<{
    roundNo: number;
    targetSeatNo: number;
    publicReason?: string;
    source: "model" | "fallback";
  }>;
  publicStances: Array<{
    seatNo: number;
    stance: "suspect" | "defend" | "neutral";
    reason: string;
    roundNo: number;
  }>;
  pendingReplies: Array<{
    fromSeatNo: number;
    topic: string;
    roundNo: number;
  }>;
  openQuestions: Array<{
    toSeatNo: number;
    question: string;
    roundNo: number;
  }>;
  recentSelfNotes: string[];
};
```

后续实现步骤：

1. 成功发言后根据策略层的 `replyTo / speechAct / publicPoint` 更新自己的公开立场。
2. 记录自己提出的问题，后续观察目标玩家是否回应。
3. 记录别人对自己的直接质疑，避免下一次发言漏回应。
4. 记录最近表达动作或高频话术，降低重复感。

优先级：`P1/P2`。先观察投票记忆版 replay，再决定是否扩展。

### 7.4 阶段 4：上下文信息质量判断

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

### 7.5 阶段 5：Replay 评估闭环

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

### 7.6 推荐落地顺序

1. 继续补 prompt 示例和禁用话术，成本最低，收益直接。
2. 接入 persona，让两个 AI 说话风格分化。
3. 已接入投票短期记忆，先通过 replay 验证跨轮投票解释是否更一致。
4. 如仍出现立场跳跃，再扩展发言立场、待回应问题和重复话术记忆。
5. 建设 replay 评估闭环，避免凭感觉改 prompt。

## 8. 结论

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

## 9. 迭代记录

### 9.1 迭代 1（拟人化第一轮：提示词 + 人格库）

范围（用户拍板）：口语糙度=中度；只改 `ai-player/` 提示词 + 人格库；不动两层架构、调度和投票策略。

根因（结合 replay 与旧提示词）：

1. 任务感：表达层在“把策略字段翻译成句子”，读起来像在完成任务。
2. 过完整/过规范：句子语法完整、标点规范、三段式论证。
3. 长度签名：表达层写“最多 160 字符”，代码实际截断 240，AI 系统性偏短且统一。
4. 人格趋同：7 个人格全是“严肃社交推理风”。

落地：

- 人格库 `ai.personas.ts` 重写为 8 个多元生活化人格（保留 `active_icebreaker` id，破冰调度依赖它）：热心话痨 / 划水摸鱼 / 贫嘴玩笑 / 暴躁直球 / 表情语气 / 社恐慢热 / 认真分析 / 杠精抬杠。`AiPersonaContext` 新增可选 `typingHabit`、`sampleLines`；`AiService.formatPersonaInfo` 字段存在时才渲染。
- 表达层 `system-speech-expression.txt` 增加「像真人那样打字（中度）」「不要太完整/太规范」「长度随情境波动（上限对齐 240，默认远短）」段，补 4 组 few-shot；明令不刻意造错别字。
- 策略层 `system-speech-strategy.txt`：`speechAct` 扩出非分析型动作（闲聊/玩笑/吐槽/附和/敷衍/跑题），`publicPoint` 允许是口语化临场反应。
- 投票 `system-vote.txt`：`reason` 改中度口语短句、贴合人格。

### 9.2 迭代 2（基于 `replay-3895D0.json` 第一轮的二次微调）

对局构成：1 号赵晨（AI/暴躁直球）、2 号沈星（AI/热心话痨）+ 3/4/5 模拟真人。结果：**1 号赵晨第一轮被 5/5 全票淘汰（连队友 2 号都投了它）**。

正面验证：句子级拟人化已见效。

- 2 号：`诶今天人挺齐啊 你们平时都玩这种吗 我头一回玩 有点懵`、`哈哈投就完了这心态行啊 不过第一轮就动手吗 我手还有点抖哈`。
- 1 号：`没玩过投就完了 懵啥`。
- AI 投票理由已口语化（`2号手抖啥 心虚吧`），比模拟真人的长段论证更像真人。

replay 暴露的三个问题与对应修复（均在“提示词+人格”范围内）：

1. **sampleLines 被几乎逐字照抄** → 会变成“人格签名开场白”，跨局成 tell。2 号开场把示例 `诶今天人挺齐啊` + `你们平时都玩这种吗 我第一次` 原样拼了出来。
   修复：各人格 `sampleLines` 改为更碎、更杂、情境化的语感片段（非整句开场白）；表达层把“口吻示例”从“可参考”升级为**禁止素材**（不能含原句、不能拼接或换字复用，必须临场另说）。
2. **第一轮怂恿盲投=自杀**：`没玩过投就完了 懵啥` 被全场判为“带节奏、想推进投票”，4/5 投票理由点这个。第一轮推动投票是真人识别 AI 的头号信号。
   修复：策略层“第一轮”加红线——绝不怂恿投票/不催现在投/不带节奏，人格再冲也只表现为“嫌寒暄啰嗦、呛一句”；`blunt_grumpy`/`contrarian` 加 toneRule 并把“投就完了/直接投/那就投他”写入 `avoidPhrases`。
3. **抛挑衅后连续 skip 5 次=打完就跑**：旧“被怀疑时”触发器只认“说你是 AI/机械”，认不出“全场在对你的话表态”。
   修复：策略层放宽触发——最近有人回应你上一句/点你的号/复述评价你的话（即使没说 AI），倾向接一句而非 skip；并加“刚抛出挑衅发言后别立刻连续 skip 消失”。

下一局 replay 重点验证：① 同人格开场不再复现固定句；② 暴躁/杠精第一轮不喊“投就完了”；③ 被回应后会跟一句而非连续 skip。

待后续轮次处理（超出本轮范围）：

- **队友误伤**：2 号不仅没护队友，还带头怀疑并投了 1 号——“AI 不知道队友是谁”的投票策略问题。
- **两次调用延迟**：1 号从观察到发言实测约 15s（策略层单独 ~13s），`targetResponseDelayMs` 形同虚设；反应速度是 Gameplay 明列的识别线索，属架构层。

### 9.3 迭代 3（基于 `replay-FE64B3.json` 第一轮）

对局构成：3 号陆白（AI/热心话痨）、5 号江野（AI/划水摸鱼）+ 1/2/4 模拟真人。结果：**5 号江野被淘汰（得 3 票，其中一票来自队友 3 号陆白）**。

迭代 2 修复验证：

- Fix1（禁照抄示例）✅ 生效：两个 AI 无一句命中 `sampleLines`，全是临场说的（江野的“在”也是自发，不在示例里）。
- Fix2（第一轮不怂恿投票）✅ 无回归（但本局是话痨+划水，暴躁/杠精护栏未被压测）。
- Fix3（被回应要接话）⚠️ 部分生效：江野被点名时确实接了话，但只回“在”这种单字，接了反而坐实“惜字如金”被投。

新结论：

1. **句子级拟人化基本解决，瓶颈已转移**。陆白零票被疑，比模拟真人（还在用“大家好，我是X”带句号自我介绍）更自然。AI 现在输不是因为像机器人，而是生存策略。
2. **人格方差决定生死**：热心话痨两局稳活；暴躁直球（上局 5/5）、划水摸鱼（本局 3 票）稳死。过冲与过沉默都是票王磁铁，真人投票理由直接写“发言最少的先投他”。
3. **队友误伤是头号败因（决定性）**：陆白投江野是压垮的第 3 票；若改投真人何夏，则何夏 3 票出局、两个 AI 全活直接赢这轮。两局均出现。

本轮落地（A1 + B3）：

- A1 生存下限（拟人化范围）：
  - 策略层加“生存下限（不分人格）”——第一轮别成全场最沉默/最扎眼的人，至少接一两句有内容的话；被点“太安静/太冲”时顺势调整（沉默人格带点个性多说半句而非蹦单字，冲的人格收一收）。
  - 人格 `lazy_floater`/`shy_quiet`/`blunt_grumpy` 各加对应 toneRule。
- B3 投票队友感知（超出原范围，因已是头号败因）：
  - `system-vote.txt` 重写策略——明确“2 个 AI、你不知道队友是谁”；**不要因为话少/存在感低就投他（极可能是队友或腼腆真人）**；优先投最积极抓 AI、最笃定、最主导讨论的人（真人概率最高、威胁最大）；看不出时也宁可投活跃认真推理的人，不投被嫌“太安静”的人。

下一局重点验证：① 划水/社恐被怼后会多说半句而非单字；② AI 不再把票投给“最安静的玩家”、尤其不再误投队友；③ 是否开始把票集中到积极抓 AI 的真人身上。

仍待后续：队友延迟/反应速度（架构层）；以及 B3 之后若仍分票，可考虑让 AI 感知“当前存活 AI 数”。

### 9.4 迭代 4（基于 `replay-F63DDB.json` 与 `replay-8C0BE0.json` 两局连胜）

两局均 **AI 阵营获胜，且 2 个 AI 全程存活**：

- `replay-F63DDB.json`：2 号赵晨（AI/热心话痨）+ 4 号林舟（AI/社恐慢热），第 3 轮结束 AI 胜，3 名模拟真人全部出局。
- `replay-8C0BE0.json`：1 号许知（AI/贫嘴玩笑）+ 3 号陆白（AI/热心话痨），撑满 4 轮 AI 胜。

正向验证（历史修复确实生效）：

1. **句子级拟人化已彻底反超**：两局 AI 口语都比模拟真人更自然——模拟真人反而还在用“大家好，我是X”式自我介绍、句号规整、长段论证投票理由。瓶颈已不在“像不像真人说话”。
2. **B3 投票队友感知 = 决胜机制**：两局取胜都靠 2 个 AI 每轮把票集中到“最活跃、最主导、最积极抓 AI”的真人身上（F63DDB 抱团投 1/5 号活跃真人；8C0BE0 锁定追问最凶的 2 号），而真人票分散、互投、纠结细小 tell，反复平票/误伤。不再出现误投队友。
3. **Fix3 被回应要接话**已稳定，沉默/社恐人格被点名时会跟话而非单字消失。

本局新暴露 / 需警惕的“策略层 tell”（瓶颈已从句子转移到策略）：

1. **抱团锁票反噬**：8C0BE0 中 1 号与 3 号连续 4 轮投票目标完全一致，F63DDB 中 2/4 号 R2/R3 同步——“这俩总一起投同一人”本身是同阵营信号，需在不牺牲威胁判断前提下偶尔错开或给差异化理由。
2. **投票理由模板化**：AI 投票理由几乎清一色“太积极/追着问/投他看看”，短而口语是优点，但全员全轮同一句式会成为可归纳模式。
3. **纯插科打诨人格靠运气活**：8C0BE0 的 1 号（贫嘴玩笑）全程只玩梗（“嗑瓜子/绝了/随手甩”），被真人逐轮记“持续回避实质分析”，R2 一度平票，仅靠抱团+真人票散侥幸存活——需让此类人格在保持人格的同时偶尔交出一个具体、像样的怀疑点，甩掉“从不分析”的标签。

本轮落地：把上述全部经验沉淀进 **复盘分析提示词 `system-replay-analysis.txt`**——加入项目迭代定位、可用证据说明（两层 strategy/expression + 投票 rawResponse + AI/模拟真人对照）、“拟人化与生存策略评估清单”（含已解决项、逐局排查项、投票协同与新策略层 tell），并要求输出区分“正向验证 / 新暴露问题”、把建议映射到具体提示词/人格文件，形成可持续的迭代闭环。

下一局重点验证：① 贫嘴/划水人格是否开始交出具体怀疑点而非纯玩梗；② 两个 AI 投票是否仍 100% 锁步同投；③ 投票理由是否仍是单一句式。
