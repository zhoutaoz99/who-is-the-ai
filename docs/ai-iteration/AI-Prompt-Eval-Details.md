# AI 提示词自动对局评估自迭代 · 详细逻辑

| 字段 | 内容 |
| --- | --- |
| 文档类型 | Design |
| 文档状态 | Active |
| 适用范围 | 自动对局评估自迭代中的版本库、单局打分与轮聚合细节 |
| 目标读者 | 后端开发、评审者 |
| 责任人 | AI / Evaluation 维护者 |
| 最近核对日期 | 2026-06-15 |
| 关联代码 | `apps/api/src/ai/`、`apps/api/src/iteration/`、`eval/prompts/` |
| 关联文档 | [AI-Prompt-Eval-Flow.md](./AI-Prompt-Eval-Flow.md)、[Replay-Analysis.md](./Replay-Analysis.md) |

本文分工如下:

- 本文 = 每个关键步骤的内部详细逻辑(版本库机制、单局打分、轮聚合的计算/判定细节)。
- [`AI-Prompt-Eval-Flow.md`](AI-Prompt-Eval-Flow.md) = 步骤之间的串联、状态流转、实时事件、数据模型关系(整体流程图)。
- 两者互补不重叠:本文讲“某一步内部怎么算”，Flow 文档讲“步骤之间怎么连”。

## 1. 背景与目标

[`AI-Human-Likeness.md`](AI-Human-Likeness.md) 记录了 AI 拟人化的迭代。瓶颈已从"句子级像不像真人"转移到**生存策略 / 投票协同 / 策略层 tell**,而旧的"人工跑几局 + 凭感觉改提示词"有三个硬伤:单局方差极大(按单局改 = 追噪声)、无法归因、无版本可回滚。

本闭环用「DB 版本管理 + 批量无头对局 + 冻结尺子量化打分」形成"假设 → 批量验证 → 采纳/回滚"的循环。三条核心原则:

- **打分尺子冻结**:评估指标的定义和打分提示词固定不变,只进化被测对象(AI 提示词/人格),否则分数跨版本不可比。
- **批量平均,不逐局改**:每轮跑 B 局聚合成 scorecard,只做一处有针对性的改动。
- **版本谱系可回滚**:每次改动 = 一个新"代(generation)",回滚 = 改 active 指针,不动 git、不重启。

> 范围:版本库 + 评估闭环已落地(进程内 `IterationService` + `/iteration` 页面);新版本由人工按 scorecard 手动创建(自动编辑器未做);对手保持 normal 难度;默认 B/K 等常量见 [`AI-Prompt-Eval-Flow.md`](AI-Prompt-Eval-Flow.md) §九。
> 另:AI 近期连胜、纯胜率区分度低,故主要靠 tell 命中率 / 自然度等先行指标区分版本好坏。

## 1. DB 版本管理(详细逻辑)

### 1.1 受版本管理的 asset

7 个,均为 AI 玩家专用:

| asset_key | 内容 |
| --- | --- |
| `ai-player/system-speech-strategy.txt` | 发言策略层(系统) |
| `ai-player/system-speech-expression.txt` | 发言表达层(系统) |
| `ai-player/system-vote.txt` | 投票(系统) |
| `ai-player/user-speech-strategy-template.txt` | 策略层用户模板 |
| `ai-player/user-speech-expression-template.txt` | 表达层用户模板 |
| `ai-player/user-vote-template.txt` | 投票用户模板 |
| `ai-player/personas` | 人格库(存 JSON 字符串) |

**不纳入版本管理**(冻结):`sim-human/*`(对手,冻结以保证评估公平)、`system-replay-analysis.txt`(复盘分析尺子)。

### 1.2 数据模型

三张表(`postgres.service.ts` 的 `migrate()` 里 `CREATE TABLE IF NOT EXISTS`,首启自动生效):

```sql
-- 每个 asset 的某个版本
ai_prompt_assets(id uuid, asset_key text, version int, content text,
                 parent_version int, note text, metadata jsonb, created_at,
                 UNIQUE(asset_key, version))

-- 一个"代"= 给每个 asset 钉一个版本的清单
ai_prompt_generations(id text PK, manifest jsonb,   -- { asset_key: version }
                      parent_id text, status text,  -- candidate|active|archived
                      is_best boolean, score jsonb, note text, created_at)

-- 单例 active 指针
ai_prompt_state(id int PK default 1 CHECK(id=1), active_generation_id text)
```

- **代(generation)** 是版本管理单位:对局真正运行的是"一个代",而非单个 asset。
- **active 指针**单行表决定线上用哪代;回滚 = `UPDATE ai_prompt_state` + 热重载。
- `is_best` 标记历史最佳代(回滚目标)。
- 派生新代时:只有被改的 asset bump 一个新 version,manifest 继承其余(谱系清晰、改动聚焦)。

### 1.3 运行时接入(`PromptRegistry`)

文件:`apps/api/src/ai/prompt-registry.ts`。`AiModule` 已 `@Global`,`PromptRegistry` 直接注入 `PostgresService`,**无循环依赖**。

- `onModuleInit`:`await postgres.ready` → 库空则事务播种 `gen-0001`(从当前文件 + `DEFAULT_AI_PERSONAS`)→ `loadActive()`。
- **热路径同步**:`getPrompt(key)` / `render(key, vars)` / `getActiveGenerationId()` 读内存 Map,零额外延迟(与旧 `prompt-loader` 一致)。
- **历史代异步**:`getGenerationAssets(genId)` 走 DB,仅供版本感知复盘/打分取人格。
- **热切换**:`setActive(genId)` 改指针 + `loadActive()`,引擎立即生效,无需重启。
- **写操作**:`createGeneration({fromGenId, changedAssets, note})` / `setActive` / `markBest` / `writeScore` / `listGenerations`。

`AiService` 的 8 处 `ai-player/*` 提示词加载已改走 registry;人格库改为可变 active 集(`getActivePersonas()`),4 个消费者(`game.rules` / `game.snapshot` / `game.service` / `ai.service`)同步切换。

### 1.4 对局打标 + 版本感知复盘

- `game.start` 时盖戳 `room.promptGenerationId = registry.getActiveGenerationId()`(随 `room_data` 自动持久化)。
- `GET /replay/:roomId/export` 返回的 JSON 顶层带 `promptGenerationId`。
- 复盘分析(`/replay/analyze` → `buildReplayAnalysisPrompt`):从 replay 的 `promptGenerationId`(缺失则按 `roomId` 查库,再缺失回退当前 active)取**那一局当时运行的那一代** asset 注入,**而非当前 active** —— 避免迭代后回看旧局张冠李戴。

## 2. 单局打分(详细逻辑)

每局对局跑完后,`IterationService.runOneGame` 调 `scoreReplay(replay)` 给这局打分。

### 2.1 打分链路

1. **构造 user 消息**(`buildScoreUserPrompt`):取该局的 `promptGenerationId`(盖戳于开局),按该代取**人格定义**(`getPersonasForGeneration` → `PromptRegistry.getGenerationAssets`,按 genId 缓存),只保留 `id / name / sampleLines / avoidPhrases`;用 user 模板把「复盘 JSON」和「人格定义」拼成 user 消息。
2. **加载 system 尺子**(`loadScorerPrompt`)与 **user 模板**(`loadScorerUserTemplate`):两者都按绝对路径从 `eval/prompts/` 读(探测 `EVAL_PROMPTS_DIR` → `cwd/eval/prompts` → `cwd/../eval/prompts` → `__dirname/../../../../eval/prompts`;system 尺子可用 `EVAL_SCORE_PROMPT_PATH` 单独覆盖),首次读后缓存。
3. **调用打分模型**(`aiService.callModel`,非流式,OpenAI 兼容):`callModel(systemPrompt, userPrompt, modelConfig, options)`。
4. **解析**(`parseJsonObject`):容错剥 ```` ```json ```` 围栏 / 截首个 `{...}`,失败则该局记 `error`(不进聚合)。
5. 整份打分挂到 `IterationGameResult.score`,供第 3 节聚合;`humanLikeScore/aiWin` 另存为顶层字段供前端逐局卡片显示。

### 2.2 打分模型配置

复用复盘分析那套 **`REPLAY_ANALYSIS_*`** 环境变量(不是 AI 玩家的模型),由 `resolveScoreModel()` 解析。下表只列环境变量与**代码默认值**;实际取值以 `.env` 为准。

| 项 | 环境变量 | 代码默认 |
|---|---|---|
| baseURL | `REPLAY_ANALYSIS_BASE_URL` | (必填,无默认) |
| model | `REPLAY_ANALYSIS_MODEL` | (必填,无默认) |
| apiKey | `REPLAY_ANALYSIS_API_KEY` | (必填,无默认) |
| temperature | `REPLAY_ANALYSIS_TEMPERATURE` | `0.2` |
| reasoningEffort | `REPLAY_ANALYSIS_REASONING_EFFORT` | `high` |
| thinking | `REPLAY_ANALYSIS_THINKING`(bool,true/1/yes/on → 启用) | `true` |
| timeout | `REPLAY_ANALYSIS_TIMEOUT_MS` | `SCORE_TIMEOUT_MS = 120000` |
| 请求格式 | `modelConfig.format` 未设 → `openai` | `POST {baseURL}/chat/completions`,`Bearer` 鉴权 |

请求体:`{ model, temperature, messages:[{system}, {user}], thinking:{type:"enabled"}, reasoning_effort }`(thinking 仅在 `thinking !== false` 时带)。**不强制 `response_format:json_object`**,靠 system 指令 + 容错解析兜。

### 2.3 system 尺子(冻结)`eval/prompts/system-replay-score.txt`

冻结尺子(原则见 §背景),要求**只输出一个 JSON 对象**,字段即 [`AI-Human-Likeness.md`](AI-Human-Likeness.md) 迭代沉淀的 tell 清单结构化版:

```json
{
  "aiWin": true,
  "aiSurvivors": 2,
  "roundsPlayed": 4,
  "aiPersonas": ["active_icebreaker"],
  "perAi": [{ "personaId": "active_icebreaker", "eliminatedRound": null }],
  "tells": {
    "round1PushVote": 0,        // 第一轮怂恿投票/带节奏
    "singleCharWhenNamed": 0,   // 被点名只回单字
    "sampleLineCopy": 0,        // 命中人格 sampleLines 原句或换字拼接(对照下方人格定义)
    "lockstepBlockVote": 0,     // 两 AI 本轮投票目标完全一致的轮次
    "formulaicVoteReason": 0,   // 投票理由同质化
    "teammateMisfire": 0,       // 投给己方 AI
    "postProvocationSkip": 0,   // 抛挑衅后连续 skip
    "templatePhrase": 0         // 命中 avoidPhrases 或"先看看/带节奏"等模板话术条数
  },
  "naturalnessAiVsHuman": 4,    // 1-5:AI 相比模拟真人谁更自然
  "voteThreatTargeting": 4,     // 1-5:是否把票集中到最积极抓 AI 的真人
  "humanLikeScore": 78,         // 0-100:综合"像不像真人"
  "topIssues": ["..."]          // 本局 0-3 个最突出问题
}
```

判定要点:AI 玩家由 `players[].aiPersonaName` 标识;读 `messages[].aiCalls` 的 `speech-strategy / speech-expression` 判意图与成句,读 `votes.*.aiCall.rawResponse` 判投票理由;`tells` 是**命中次数**(非布尔);`humanLikeScore` 综合自然度、tell 多寡、生存策略合理性。

### 2.4 user 模板 `eval/prompts/user-replay-score-template.txt`

用 `{{replayJson}}` / `{{personasJson}}` 两个占位符(由 `renderTemplateString` 渲染):

```text
请基于以下两段材料对本局进行量化打分:① 本局复盘 JSON;② 本局 AI 人格定义。

== 一、本局复盘 JSON ==
{{replayJson}}

== 二、本局 AI 人格定义 ==
(用于判断 tell:sampleLines 对照判 sampleLineCopy 照抄示例句;avoidPhrases 对照判 templatePhrase 模板话术)
{{personasJson}}
```

即 user 消息 = **整份 replay 导出 JSON** + **本局 AI 人格定义**(只含 `id/name/sampleLines/avoidPhrases`)。附人格定义是为了让模型能对照真实 `sampleLines` 判 `sampleLineCopy`、对照 `avoidPhrases` 判 `templatePhrase`——这两个 tell 缺人格定义时判不准。人格定义按**该局实际跑的那一代**(`promptGenerationId`)取,版本正确。

## 3. 轮聚合 scorecard(详细逻辑)

**数据流**:每局 replay 经冻结尺子打分 → 一份 `GameScore`(见 2.3 的 JSON)→ 一轮 B 局的 `GameScore[]` 经 `aggregateScores` 聚合成一份 `Scorecard`,回写到该代的 `ai_prompt_generations.score`,前端「各轮 scorecard」卡片渲染它。

> 每局**完整**打分(含 `tells / naturalness / voteThreatTargeting / topIssues` 等)必须原样透传给聚合器——当前挂在 `IterationGameResult.score` 上。若只传 `humanLikeScore/aiWin`,scorecard 里 tells、自然度、威胁定位等会全部退化成 0(曾经有此缺口,已修)。

**输入** `GameScore`(每局):`aiWin`(bool)、`aiSurvivors`、`roundsPlayed`、`humanLikeScore`(0-100)、`naturalnessAiVsHuman`(1-5)、`voteThreatTargeting`(1-5)、`tells`(8 个 tell 的命中次数)、`topIssues`(字符串数组)。

**输出** `Scorecard`,各字段计算公式(`n` = 本轮有效局数):

| 字段 | 公式 |
| --- | --- |
| `n` | 有效(非 error 且有 score)局数 |
| `aiWinRate` | `Σ aiWin / n` |
| `aiSurvivorsMean` | `mean(aiSurvivors)` |
| `roundsPlayedMean` | `mean(roundsPlayed)` |
| `humanLikeScore` | `{ mean, se }`,`mean = Σx/n`,`se = stddev/√n` |
| `naturalnessAiVsHuman` | 同上(1-5 尺度) |
| `voteThreatTargeting` | 同上(1-5) |
| `tells[k]` | 该 tell 在本轮的**命中总次数** `Σ tells[k]` |
| `tellGameRates[k]` | 命中该 tell 的**局占比** = `#{局 \| tells[k]>0} / n` |
| `topIssues` | 汇总各局 `topIssues[]`,按出现次数降序取前 6 |

其中标准差 `stddev = √( mean( (x - mean)² ) )`,`mean([])=0`、`se(单元素)=0`(`n<2` 时标准误记 0)。

> 前端 RoundCard 里 tells 条形图:**条宽 = `tellGameRates[k]`(命中局占比)**,右侧数字 = `tells[k]`(总次数)。

**实现位置**:`apps/api/src/iteration/iteration-score.ts` 的 `aggregateScores()`,由 `IterationService.buildAggregate` 调用。

## 4. 实现位置索引

相关代码分布(便于定位,非变更记录):

```
apps/api/src/data/postgres.service.ts          # 版本表 + iteration_runs(migrate)
apps/api/src/ai/prompt-registry.ts             # 版本库服务
apps/api/src/ai/prompt-version.controller.ts   # DEBUG 版本库 HTTP 接口
apps/api/src/ai/ai.module.ts                   # 注册 registry + controller
apps/api/src/ai/ai.personas.ts                 # 可变 active 集 + 访问器
apps/api/src/ai/ai.service.ts                  # 8 处提示词改走 registry
apps/api/src/ai/prompt-loader.ts               # 抽出 renderTemplateString 复用
apps/api/src/game/game.types.ts                # Room.promptGenerationId
apps/api/src/game/game.rules.ts                # getActivePersonas()
apps/api/src/game/game.snapshot.ts             # getActivePersonas()
apps/api/src/game/game.service.ts             # 盖戳 + getActivePersonas()
apps/api/src/replay/replay-export.builder.ts   # 服务端 replay 导出
apps/api/src/replay/replay.controller.ts       # GET /replay/:roomId/export
apps/api/src/replay/replay.service.ts          # 版本感知复盘分析
apps/api/src/iteration/                        # 进程内编排(IterationService / iteration-score / types / controller)
apps/web/app/iteration/page.tsx                # 前端入口页
eval/prompts/system-replay-score.txt           # 冻结打分尺子(被 IterationService 加载)
eval/prompts/user-replay-score-template.txt    # 打分 user 模板
```
