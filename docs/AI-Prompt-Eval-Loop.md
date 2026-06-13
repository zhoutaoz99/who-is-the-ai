# AI 提示词自动对局评估闭环

## 背景

[`AI-human-like.md`](./AI-human-like.md) 记录了 AI 拟人化的 4 轮迭代。近两局 AI 连胜、句子级自然度达标,瓶颈已转移到**生存策略 / 投票协同 / 策略层 tell**。但目前的迭代方式是"人工跑几局 + 凭感觉改提示词",有三个硬伤:

1. **单局方差极大**:一局胜负被座位、人格抽签、模型采样随机性主导,接近噪声,按单局改 = 追噪声。
2. **无法归因**:改完下一局变好,分不清是改对了还是抽到了更弱对手。
3. **无版本可回滚**:提示词改了就改了,改坏无法快速回到上一版。

本文档描述一套**可持续的自动迭代闭环**:用数据库管理 AI 提示词版本(DB 版本管理),并跑批量无头对局 + 量化打分来评估每个版本,形成"假设 → 批量验证 → 采纳/回滚"的循环。

核心设计原则:

- **打分尺子冻结**:评估指标的定义和打分提示词固定不变,只进化被测对象(AI 玩家提示词/人格)。否则分数跨版本不可比。
- **批量平均,不是逐局改**:每轮跑 B 局聚合成 scorecard,只做一处有针对性的改动。
- **版本谱系可回滚**:每次改动 = 一个新"代(generation)",回滚 = 改 active 指针,不动 git、不重新部署。

> 第一期范围:**版本库 + 评估闭环**,新版本由人工按 scorecard 手动创建(不做自动编辑器);对手(模拟真人)保持 normal 难度;默认 B=6、K=4(共 24 局)。

## 整体架构

两大块,均已在 `apps/api` 落地:

```
┌─────────────────────────────────────────────────────────────────┐
│  1. DB 版本管理                                                   │
│     ai_prompt_assets ──┐                                         │
│     ai_prompt_generations ── active 指针 ── PromptRegistry(内存)│
│     ai_prompt_state ────┘                                        │
│           │                                                      │
│           ▼ 热路径同步读取                                       │
│     AiService / game.rules / game.snapshot → 实际对局用           │
│     game.start 盖戳 room.promptGenerationId                      │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  2. 评估闭环(eval/)                                              │
│     run-batch.mjs  跑 B 局无头对局 → 拉取 replay 导出             │
│           │                                                      │
│     score.mjs      冻结 rubric 打分 → 严格 JSON                  │
│           │                                                      │
│     aggregate.mjs  聚合 → scorecard.json/.md                     │
│           │                                                      │
│     versions.mjs   创建新代 / 激活 / 回滚 / 回写分数              │
└─────────────────────────────────────────────────────────────────┘
```

## 1. DB 版本管理

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

**不纳入版本管理**(冻结):

- `sim-human/*` —— 对手,保持不变以保证评估对比公平。
- `system-replay-analysis.txt` —— 复盘分析尺子,冻结。

### 1.2 数据模型

三张表(在 `postgres.service.ts` 的 `migrate()` 中 `CREATE TABLE IF NOT EXISTS` 创建,首启自动生效):

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

- **代(generation)** 是版本管理的单位:对局真正运行的是"一个代",而非单个 asset。
- **active 指针**单行表,决定线上对局用哪代。回滚 = `UPDATE ai_prompt_state` + 热重载。
- `is_best` 标记历史最佳代(回滚目标)。
- 派生新代时:只有被改的 asset bump 一个新 version,manifest 继承其余(谱系清晰、改动聚焦)。

### 1.3 运行时接入(`PromptRegistry`)

文件:`apps/api/src/ai/prompt-registry.ts`。`AiModule` 已 `@Global`,`PromptRegistry` 直接注入 `PostgresService`,**无循环依赖**(`DataModule` 不依赖 `ai/`)。

- `onModuleInit`:`await postgres.ready` → 若库空则事务播种 `gen-0001`(从当前文件 + `DEFAULT_AI_PERSONAS`)→ `loadActive()`。
- **热路径同步**:`getPrompt(key)` / `render(key, vars)` / `getActiveGenerationId()` 读内存 Map,零额外延迟(与旧 `prompt-loader` 一致)。
- **历史代异步**:`getGenerationAssets(genId)` 走 DB,仅供版本感知复盘。
- **热切换**:`setActive(genId)` 改指针 + `loadActive()`,引擎立即生效,无需重启。
- **写操作**:`createGeneration({fromGenId, changedAssets, note})` / `setActive` / `markBest` / `writeScore` / `listGenerations`。

`AiService` 的 8 处 `ai-player/*` 提示词加载已改为走 registry;人格库改为可变 active 集(`getActivePersonas()`),4 个消费者(`game.rules` / `game.snapshot` / `game.service` / `ai.service`)同步切换。

### 1.4 对局打标 + 版本感知复盘

- `game.start` 时盖戳 `room.promptGenerationId = registry.getActiveGenerationId()`(随 `room_data` 自动持久化)。
- `GET /replay/:roomId/export` 返回的 JSON 顶层带 `promptGenerationId`。
- 复盘分析(`/replay/analyze` → `buildReplayAnalysisPrompt`):从 replay 的 `promptGenerationId`(缺失则按 `roomId` 查库,再缺失回退当前 active)取**那一局当时运行的那一代** asset 注入,**而非当前 active** —— 避免迭代后回看旧局张冠李戴。

## 2. 评估闭环

### 2.1 循环算法(每轮)

```
1. 记录 baseline = 历史 best 的 scorecard
2. run-batch:并发跑 B 局(并发上限 3-5),每局盖戳当前 active 代
3. score:    每份 replay 调冻结 rubric → 严格 JSON 指标
4. aggregate:聚合成 scorecard(均值 ± 标准误、tell 命中率、高频问题)
5. 编辑器(本期手动):针对【最高频/最严重的那一个 tell】改一处 asset
   → createGeneration(新代) → setActive → 进入下一轮
6. 若新一轮 scorecard 优于 baseline → markBest;否则 setActive 回滚到 best
```

K 轮 × B 局跑完,`ai_prompt_generations` 的谱系 + 分数就是完整迭代历史,可渲染成报表。

### 2.2 组件(`eval/`)

| 文件 | 作用 |
| --- | --- |
| `lib.mjs` | 共享:加载 `.env`、跑无头对局(`runOneGame`)、拉 replay 导出、调打分模型、并发控制 |
| `run-batch.mjs` | 跑 B 局 → 存 `replays/replay-<id>.json` |
| `prompts/system-replay-score.txt` | **冻结**打分尺子,输出严格 JSON |
| `score.mjs` | 逐局打分 → `scores/score-<id>.json` |
| `aggregate.mjs` | 聚合 → `scorecard.json` + `scorecard.md` |
| `run-round.mjs` | 串联 run-batch → score → aggregate |
| `versions.mjs` | 版本库 CLI:list / show / create / active / best / score |
| `README.md` | 快速操作手册 |

### 2.3 无头对局(`runOneGame`)

通过 socket.io 连 API:

1. `debug.ai-room.create`({fastMode:true, discussionDurationMinutes}) → 拿 roomId,socket 自动 join 房间。
2. `room.observe` + `game.start`。
3. **以 HTTP 轮询为主**检测结束(`GET /rooms/:id` → `status==="finished"`),WS `game.ended` 作加速路径。`discussionDurationMinutes` 最小 1 分钟/轮。
4. 结束后 `GET /replay/:roomId/export` 拉取带 `promptGenerationId` 的 JSON。

> 之所以以 HTTP 轮询为主:`game.ended` 是 room-scoped 广播(`.to(roomId).emit`),观察者 socket 偶发收不到;HTTP 无状态更可靠。

### 2.4 冻结打分尺子(`system-replay-score.txt`)

只输出一个 JSON 对象,字段固定(指标即 [`AI-human-like.md`](./AI-human-like.md) 迭代中沉淀的 tell 清单的结构化版):

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
    "sampleLineCopy": 0,        // 命中人格 sampleLines 原句
    "lockstepBlockVote": 0,     // 两 AI 本轮投票目标完全一致的轮次
    "formulaicVoteReason": 0,   // 投票理由同质化
    "teammateMisfire": 0,       // 投给己方 AI
    "postProvocationSkip": 0,   // 抛挑衅后连续 skip
    "templatePhrase": 0         // 模板话术条数
  },
  "naturalnessAiVsHuman": 4,    // 1-5
  "voteThreatTargeting": 4,     // 1-5
  "humanLikeScore": 78,         // 0-100
  "topIssues": ["..."]
}
```

### 2.5 scorecard 输出(`aggregate.mjs`)

- AI 胜率、平均存活 AI 数、平均轮数
- humanLikeScore / 自然度(AI vs 真人)/ 投票威胁定位:**均值 ± 标准误**
- tells:总命中次数 / 命中对局占比
- 高频问题:`topIssues` 跨局聚合

## 3. 迭代工作流(手动编辑器,本期)

```bash
# 一轮评估(默认 6 局,1 分钟/轮)
node eval/run-round.mjs --batch 6 --minutes 1 --concurrency 3

# 改某个 asset(文本直接编辑;personas 存 JSON 数组)后,从当前 active 派生新代
node eval/versions.mjs create --from gen-0001 \
  --asset ai-player/system-speech-strategy.txt=./tmp/strategy.txt \
  --note "收敛第一轮带节奏 tell"
node eval/versions.mjs active gen-0002          # 引擎热切换,无需重启

# 再跑一轮对比 scorecard
node eval/run-round.mjs --batch 6 --minutes 1

# 更好 → 标记历史最佳;更差 → 回滚(同样热切换)
node eval/versions.mjs best gen-0002            # 或 active gen-0001 回滚
```

## 4. 已知限制(引擎侧,非本工具)

- **内存定时器 + 重启 = 卡死**:对局阶段靠进程内存 `setTimeout` 推进。API 进程中途重启(如 `nest --watch` 重编译、手动重启)会让定时器丢失,该局永久卡在当前 phase。`runOneGame` 已内置卡死检测(`phaseEndsAt` 过期 >90s 即判该局失败跳过),不会无限挂起。
  - **建议**:评估时关闭 `--watch`,或用独立构建实例(`npm run build --workspace apps/api && node apps/api/dist/main.js`)跑,避免重编译打断对局。
- **胜负信号接近饱和**:AI 近期连胜,纯胜率区分度低。当前主要靠 tell 命中率 / 自然度等先行指标区分版本好坏。

## 5. 后续演进(未做)

- **自动编辑器**:run-batch + 打分全脚本化后,第 5 步"改提示词"也可做成对强模型的脚本调用(返回 diff 自动 apply),实现纯无人值守过夜连推 K 轮;靠回滚兜底质量。两种执行方式:
  - 方案 A(半自动,推荐):plumbing 脚本化,每轮由人/Claude 读 scorecard 改提示词提交;可用 `/loop` 无人值守。质量最高。
  - 方案 B(全自动):连改提示词也脚本化,纯无人跑。靠回滚兜底。
- **调强对手**:若胜率持续饱和无信号,可冻结 `SIMULATED_HUMAN_INTENSITY=high` 让胜率重新有区分度。
- **更大批量**:方差允许时把 B 提到 10-15 以收紧标准误。

## 6. 文件清单

新增 / 改动:

```
apps/api/src/data/postgres.service.ts          # 3 张版本表(migrate)
apps/api/src/ai/prompt-registry.ts             # 新增:版本库服务
apps/api/src/ai/prompt-version.controller.ts   # 新增:DEBUG 版本库接口
apps/api/src/ai/ai.module.ts                   # 注册 registry + controller
apps/api/src/ai/ai.personas.ts                 # 可变 active 集 + 访问器
apps/api/src/ai/ai.service.ts                  # 8 处提示词改走 registry
apps/api/src/ai/prompt-loader.ts               # 抽出 renderTemplateString 复用
apps/api/src/game/game.types.ts                # Room.promptGenerationId
apps/api/src/game/game.rules.ts                # getActivePersonas()
apps/api/src/game/game.snapshot.ts             # getActivePersonas()
apps/api/src/game/game.service.ts             # 盖戳 + getActivePersonas()
apps/api/src/replay/replay-export.builder.ts   # 新增:服务端导出(移植前端)
apps/api/src/replay/replay.controller.ts       # GET /replay/:roomId/export
apps/api/src/replay/replay.service.ts          # 版本感知复盘分析
eval/{lib,run-batch,score,aggregate,run-round,versions}.mjs
eval/prompts/system-replay-score.txt           # 冻结尺子
eval/README.md                                  # 快速操作手册
```
