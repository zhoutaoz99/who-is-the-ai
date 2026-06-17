# AI 提示词自动对局评估自迭代 · 详细逻辑

| 字段 | 内容 |
| --- | --- |
| 文档类型 | Design |
| 文档状态 | Active |
| 适用范围 | 自动对局评估自迭代中的版本库、手动优化与版本感知单局审计 |
| 目标读者 | 后端开发、评审者 |
| 责任人 | AI / Evaluation 维护者 |
| 最近核对日期 | 2026-06-17 |
| 关联代码 | `apps/api/src/ai/`、`apps/api/src/iteration/`、`eval/prompts/` |
| 关联文档 | [AI-Prompt-Eval.md](./AI-Prompt-Eval.md)、[AI-Prompt-Eval-Auto-Optimize.md](./AI-Prompt-Eval-Auto-Optimize.md)、[AI-Prompt-Eval-Flow.md](./AI-Prompt-Eval-Flow.md)、[Replay-Analysis.md](./Replay-Analysis.md) |

本文只讲 AI 提示词版本库、评估尺子版本库和它们的版本管理细节。单局打分、scorecard 聚合和自动优化器实现见 [`AI-Prompt-Eval-Auto-Optimize.md`](AI-Prompt-Eval-Auto-Optimize.md);整体流程与状态流转见 [`AI-Prompt-Eval-Flow.md`](AI-Prompt-Eval-Flow.md)。

## 1. 背景与目标

[`AI-Human-Likeness.md`](AI-Human-Likeness.md) 记录了 AI 拟人化的迭代。瓶颈已从"句子级像不像真人"转移到**生存策略 / 投票协同 / 策略层 tell**,而旧的"人工跑几局 + 凭感觉改提示词"有三个硬伤:单局方差极大(按单局改 = 追噪声)、无法归因、无版本可回滚。

本闭环用「DB 版本管理 + 批量无头对局 + 结构化量化打分」形成"假设 → 批量验证 → 采纳/回滚"的循环。三条核心原则:

- **评估口径与被测对象解耦**:AI 玩家提示词/人格与评估尺子分属两套版本库;切换评估尺子不会直接改 AI 行为,切换 AI 代也不会隐式改打分口径。
- **批量平均,不逐局改**:每轮跑 B 局聚合成 scorecard,只做一处有针对性的改动。
- **版本历史可回滚**:每次改动 = 一个新"代(generation)",父子代关系会被保留;回滚 = 改 active 指针,不动 git、不重启。

> 范围:版本库 + 评估闭环已落地(进程内 `IterationService` + `/iteration` 页面);新版本可由人工按 scorecard 手动创建,也可由「自动优化」(代码 `autoOptimize`)生成候选代后等待确认或自动激活;对手保持 normal 难度;默认 B/K 等常量见 [`AI-Prompt-Eval-Flow.md`](AI-Prompt-Eval-Flow.md) §11。当前**评估尺子版本库**只覆盖 `replay-score/*` 与 `auto-optimize/*`;`ReplayService` 的单局硬问题审计提示词(`system-replay-analysis.txt` / `user-replay-analysis-template.txt`)仍保持文件来源。
> 另:AI 近期连胜、纯胜率区分度低,故主要靠 tell 命中率 / 自然度等先行指标区分版本好坏。

## 2. 版本管理(详细逻辑)

### 2.1 受版本管理的 asset

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

**不纳入 AI 提示词版本库**:`sim-human/*`(对手,冻结以保证评估公平)、`replay-score/*` / `auto-optimize/*`(走独立评估闭环版本库)、`system-replay-analysis.txt` / `user-replay-analysis-template.txt`(单局硬问题审计尺子,保持文件来源)。

### 2.2 数据模型

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
- 派生新代时:只有被改的 asset bump 一个新 version,manifest 继承其余(父子代关系清晰、改动聚焦)。

### 2.3 运行时接入(`PromptRegistry`)

文件:`apps/api/src/ai/prompt-registry.ts`。`AiModule` 已 `@Global`,`PromptRegistry` 直接注入 `PostgresService`,**无循环依赖**。

- `onModuleInit`:`await postgres.ready` → 库空则事务播种 `gen-0001`(从当前文件 + `DEFAULT_AI_PERSONAS`)→ `loadActive()`。
- **热路径同步**:`getPrompt(key)` / `render(key, vars)` / `getActiveGenerationId()` 读内存 Map,零额外延迟(与旧 `prompt-loader` 一致)。
- **历史代异步**:`getGenerationAssets(genId)` 走 DB,仅供版本感知单局审计/打分取人格。
- **热切换**:`setActive(genId)` 改指针 + `loadActive()`,引擎立即生效,无需重启。
- **写操作**:`createGeneration({fromGenId, changedAssets, note})` / `setActive` / `markBest` / `writeScore` / `listGenerations`。
- **运行时接入**:单局打分、scorecard 聚合、`scoreRequest`/`autoOptimizeRequest` 重建等运行时逻辑见 [`AI-Prompt-Eval-Auto-Optimize.md`](AI-Prompt-Eval-Auto-Optimize.md)。

`AiService` 的 8 处 `ai-player/*` 提示词加载已改走 registry;人格库改为可变 active 集(`getActivePersonas()`),4 个消费者(`game.rules` / `game.snapshot` / `game.service` / `ai.service`)同步切换。

### 2.4 手动优化面板(多 asset 草稿保存)

前端 `/iteration` 页面中的 **「AI 提示词版本」** 面板不再要求“一次只能改一个 asset 再立即保存”。当前交互是:

- 左侧选择某个 generation,右侧一次性加载该代的 **7 个 asset 全量正文** 进入前端草稿 Map。
- 右上 asset 下拉只决定“当前正在调整哪一个 asset”;切换 asset **不会丢失** 已修改的其他 asset 草稿。
- 被改过的 asset 会在下拉选项中以 `*` 标识,状态条显示“已修改 N 项”。
- 点击「保存 N 项修改为新版本」时,前端会把所有脏 asset 一次性组装成一个 `changedAssets` 对象发给 `POST /debug/prompts/generation`,从而**把多个提示词改动合并进同一个新代**。
- 「还原全部修改」会把当前代下所有草稿恢复到刚加载时的状态;切换 generation 时若存在未保存草稿会二次确认。

这层交互与后端 `PromptRegistry.createGeneration({ changedAssets })` 的不可变版本模型配套:保存动作不会覆盖原代,而是派生一个新的 child generation。

### 2.5 对局打标 + 版本感知单局审计

- `game.start` 时盖戳 `room.promptGenerationId = registry.getActiveGenerationId()`(随 `room_data` 自动持久化)。
- `GET /replay/:roomId/export` 返回的 JSON 顶层带 `promptGenerationId`。
- 单局审计(`/replay/analyze` → `buildReplayAnalysisPrompt`):从 replay 的 `promptGenerationId`(缺失则按 `roomId` 查库,再缺失回退当前 active)取**那一局当时运行的那一代** asset 注入,**而非当前 active** —— 避免迭代后回看旧局张冠李戴。

### 2.6 评估尺子版本库

当前实现把“评估尺子”拆成一套**独立于 AI 提示词版本库**的 DB 版本库,用于手动管理打分尺子与自动优化器提示词。

**受版本管理的评估 asset(当前仅 4 个):**

| asset_key | 内容 |
| --- | --- |
| `replay-score/system-replay-score.txt` | 单局量化打分 system prompt |
| `replay-score/user-replay-score-template.txt` | 单局量化打分 user 模板 |
| `auto-optimize/system-prompt-optimizer.txt` | 自动优化器 system prompt |
| `auto-optimize/user-prompt-optimizer-template.txt` | 自动优化器 user 模板 |

**暂不纳入该版本库:**`system-replay-analysis.txt` / `user-replay-analysis-template.txt`(单局硬问题审计,仍走文件)。

**数据模型(与 AI 提示词版本库平行):**

```sql
eval_prompt_assets(id uuid, asset_key text, version int, content text,
                   parent_version int, note text, metadata jsonb, created_at,
                   UNIQUE(asset_key, version))

eval_prompt_generations(id text PK, manifest jsonb,  -- { asset_key: version }
                        parent_id text, status text, -- candidate|active|archived
                        is_best boolean, score jsonb, note text, created_at)

eval_prompt_state(id int PK default 1 CHECK(id=1), active_generation_id text)
```

运行时接入点:

- `EvalPromptRegistry` 负责播种 `eval-gen-0001`、维护 active 指针、按 generation 读取 asset、人工派生/激活/删除版本。
- `IterationService.scoreReplay` / `GET /debug/iterations/score-request/:roomId` / `IterationService.createAutoOptimizeGeneration` / `GET /debug/iterations/auto-optimize-request/:runId/:roundNo` 的实现细节见 [`AI-Prompt-Eval-Auto-Optimize.md`](AI-Prompt-Eval-Auto-Optimize.md)。
- `GET /debug/iterations/score-request/:roomId` 与 `GET /debug/iterations/auto-optimize-request/:runId/:roundNo` 重建历史请求时,优先使用这些**已记录的评估尺子代号**,而不是简单读取“当前 active 尺子”,避免事后切换尺子后详情失真。

当前评估尺子版本库的写操作只有:

- `createGeneration({ fromGenId, changedAssets, note })`
- `setActive(generationId)`
- `deleteGeneration(generationId)`

与 AI 提示词版本库不同,它**当前没有** `markBest` / `writeScore` 这类“效果排名”操作;用途仅限人工试验不同评估口径。

### 2.7 评估尺子手动优化面板(多 asset 草稿保存)

前端 `/iteration` 页面中的 **「评估尺子版本」** 面板与 AI 提示词版本面板采用相同的多 asset 草稿模型:

- 左侧选版本,右侧把该代全部评估 asset 载入草稿 Map。
- 可在 `replay-score/*` 与 `auto-optimize/*` 间来回切换调整,已改 asset 用 `*` 标记。
- 保存时把**所有脏 asset** 一次性提交给 `POST /debug/eval-prompts/generation`,生成一个新的 `eval-gen-*` 子代。
- 切换 generation 时若存在未保存草稿会提醒;切换 asset 不会丢草稿;「还原全部修改」会整体回退到当前代已加载正文。

这使得“同时调整打分 system prompt + user 模板”成为一个原子版本,便于后续回放与归因。

## 3. 单局打分与轮聚合已迁移

单局打分、scorecard 聚合、打分请求重建和 Issue Code 口径已迁移到 [`AI-Prompt-Eval-Auto-Optimize.md`](AI-Prompt-Eval-Auto-Optimize.md)。

## 4. 自动优化器已迁移

自动优化器的状态流转、优化链路、结果重建与重试日志已迁移到 [`AI-Prompt-Eval-Auto-Optimize.md`](AI-Prompt-Eval-Auto-Optimize.md)。

---

## 5. 实现位置索引

相关代码分布(便于定位,非变更记录):

```
apps/api/src/data/postgres.service.ts          # 版本表 + iteration_runs(migrate)
apps/api/src/ai/prompt-registry.ts             # 版本库服务
apps/api/src/ai/prompt-version.controller.ts   # DEBUG 版本库 HTTP 接口
apps/api/src/ai/eval-prompt-registry.ts        # 评估尺子版本库服务
apps/api/src/ai/eval-prompt-version.controller.ts # DEBUG 评估尺子版本库 HTTP 接口
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
apps/api/src/replay/replay.service.ts          # 版本感知单局审计
apps/api/src/iteration/                        # 进程内编排(IterationService / iteration-score / types / controller)
apps/web/app/iteration/page.tsx                # 前端入口页
eval/prompts/replay-score/system-replay-score.txt            # 评估尺子版本库的 seed / 回退来源
eval/prompts/replay-score/user-replay-score-template.txt     # 打分 user 模板 seed / 回退来源
eval/prompts/auto-optimize/system-prompt-optimizer.txt       # 自动优化器 system 提示词 seed / 回退来源
eval/prompts/auto-optimize/user-prompt-optimizer-template.txt # 自动优化器 user 模板 seed / 回退来源
```
