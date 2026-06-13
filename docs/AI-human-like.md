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

### 投票短期记忆

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

### 阶段 3：扩展发言记忆与立场连续性

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
3. 已接入投票短期记忆，先通过 replay 验证跨轮投票解释是否更一致。
4. 如仍出现立场跳跃，再扩展发言立场、待回应问题和重复话术记忆。
5. 建设 replay 评估闭环，避免凭感觉改 prompt。

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

## 迭代记录

### 迭代 1（拟人化第一轮：提示词 + 人格库）

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

### 迭代 2（基于 `replay-3895D0.json` 第一轮的二次微调）

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

### 迭代 3（基于 `replay-FE64B3.json` 第一轮）

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
