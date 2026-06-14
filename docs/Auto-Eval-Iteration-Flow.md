# 自动对局评估自迭代 · 流程说明

> 本文聚焦**整体流程与运行逻辑**,配合流程图说明「自动对局评估自迭代」如何运转。
> 设计动机与取舍见 [`AI-Prompt-Eval-Loop.md`](./AI-Prompt-Eval-Loop.md);拟人化迭代记录见 [`AI-human-like.md`](./AI-human-like.md)。

## 一句话概览

点击「开始迭代」→ 服务端**进程内**用当前提示词版本跑一批无头对局 → 用**冻结的打分尺子**逐局量化打分 → 聚合成 scorecard → 轮间由人工在页面上创建/激活新版本 → 继续下一轮,循环 K 轮。全程实时可见进度,版本可一键回滚。

---

## 一、组件总览

```mermaid
flowchart LR
  subgraph 前端["前端 (Next.js)"]
    PAGE["/iteration 页面"]
    PROVIDER["GameClientProvider<br/>(socket 订阅 + 动作)"]
  end

  subgraph 网关["API 网关"]
    GW["GameGateway<br/>iteration.start/continue/stop<br/>桥接事件 → iteration.* 广播"]
  end

  subgraph 编排["迭代编排 (进程内)"]
    ITER["IterationService<br/>EventEmitter"]
    SCORE["iteration-score.ts<br/>(聚合纯函数)"]
  end

  subgraph 引擎与数据["游戏引擎 / 版本库 / 模型"]
    GAME["GameService<br/>createDebugAutoAiRoom<br/>startGame / observeRoom"]
    REG["PromptRegistry<br/>(版本库 + active 热切换)"]
    REPLAY["ReplayService<br/>getAiCallLogs"]
    EXPORT["buildReplayExportData<br/>(纯函数)"]
    AI["AiService.callModel<br/>(打分模型)"]
    DB[("Postgres<br/>iteration_runs<br/>ai_prompt_*")]
  end

  SCORER[("eval/prompts/<br/>system-replay-score.txt<br/>冻结尺子")]

  PAGE <-->|socket iteration.*| PROVIDER
  PROVIDER -->|WS emit| GW
  GW --> ITER
  ITER -->|驱动对局| GAME
  ITER -->|读/写版本| REG
  ITER -->|取调用日志| REPLAY
  ITER --> EXPORT
  ITER -->|打分| AI
  AI -.使用.-> SCORER
  ITER --> SCORE
  ITER --> DB
  REG --> DB
  GAME --> DB
```

关键点:
- **对局在进程内跑完**:`IterationService` 直接调 `GameService.createDebugAutoAiRoom + startGame`,纯服务端定时器推进(讨论→投票→淘汰→下一轮→结束),**不需要 socket 客户端**。
- **IterationService 不碰 socket**:它用 `EventEmitter` 发本地事件,由 `GameGateway` 桥接成 `iteration.*` 广播,保持可测试、解耦。
- **打分尺子冻结**:scorer 提示词按绝对路径加载,**不进版本库**,确保跨版本打分可比。

---

## 二、核心概念

| 概念 | 说明 |
| --- | --- |
| **代(generation)** | 一组提示词版本的快照(6 个文本模板 + 人格库 JSON 的各一个版本号)。`ai_prompt_generations` 一行。 |
| **active 代** | 当前线上对局实际使用的代,由 `ai_prompt_state` 单例指针指定。**热切换**:改指针即生效,无需重启。 |
| **run** | 一次「开始迭代」到「完成/停止」的过程,含 K 轮。`iteration_runs` 一行。 |
| **轮(round)** | 用当前 active 代跑 B 局 → 打分 → 聚合。轮与轮之间进入 `awaiting_activation` 等待人工换版本。 |
| **scorecard** | 一轮 B 局分数的聚合(胜率、humanLikeScore 均值±标准误、各 tell 命中率、高频问题)。 |

---

## 三、整体迭代流程(主循环)

```mermaid
flowchart TD
  START([用户在 /iteration 设置 B/K/分钟<br/>点「开始迭代」]) --> ACK
  ACK["socket iteration.start"] --> INIT["IterationService.start()<br/>校验 DEBUG + 单 run 互斥<br/>建 iteration_runs 行 status=running round=1<br/>emit status"]
  INIT --> ROUND

  subgraph ROUND["runRound(round R)"]
    direction TB
    R1["读 active 代 id"] --> R2["并发跑 B 局(上限 3)<br/>逐局 emit iteration.game"]
    R2 --> R3["聚合 scorecard"]
    R3 --> R4["writeScore(active代, scorecard)<br/>持久化该轮到 iteration_runs.rounds"]
    R4 --> R5{"R >= K ?"}
  end

  R5 -- 否 --> WAIT["status = awaiting_activation<br/>emit round / status"]
  WAIT --> MANUAL[/"人工:版本面板<br/>编辑 asset → 创建新代 → 激活<br/>(PromptRegistry 热切换 active)"/]
  MANUAL --> CONT["用户点「继续下一轮」<br/>iteration.continue"]
  CONT --> NEXT["continueToNextRound()<br/>round++ → runRound"]

  R5 -- 是 --> DONE["status = completed<br/>emit done"]
  DONE --> END([结束,谱系留存])

  STOP([用户点「停止」]) -.stopRequested.-> HALT["status = stopped<br/>中断未完成局"]
```

要点:
- **评估循环自动跑,版本激活人工操作**(本期不做自动编辑器,`IterationService` 预留 `editor` 钩子)。
- 不强制换版本:保持同一代继续跑,只是为该代累积更多样本、分数会更稳。
- **单进程互斥**:同时只允许一个 run(active 代是进程级单例)。

---

## 四、单轮内部流程(B 局并发)

```mermaid
flowchart TD
  A["runRound 开始<br/>generationId = active 代"] --> POOL["并发池(上限 3)"]
  POOL --> G1[工人 1: runOneGame]
  POOL --> G2[工人 2: runOneGame]
  POOL --> GN[... 工人 N: runOneGame]

  G1 --> COLLECT["results[i] = 结果<br/>currentRoundGames.push(结果)<br/>emit iteration.game"]
  G2 --> COLLECT
  GN --> COLLECT
  COLLECT --> ALLDONE{"B 局都完成?"}
  ALLDONE -- 否 --> POOL
  ALLDONE -- 是 --> AGG["aggregateScores(有效分数)<br/>→ scorecard"]
  AGG --> WRITE["prompts.writeScore(generationId, scorecard)"]
  WRITE --> PERSIST["rounds.push({round, generationId, games, aggregate})<br/>写 iteration_runs"]
  PERSIST --> STATUS{"R >= K ?"}
  STATUS -- 否 --> AW[status=awaiting_activation]
  STATUS -- 是 --> CMP[status=completed, emit done]
```

---

## 五、单局流程(对局驱动 + 打分)

```mermaid
flowchart TD
  C["gameService.createDebugAutoAiRoom<br/>{fastMode, discussionMinutes}"] -->|room.id, playerId| S["gameService.startGame<br/>{roomId, playerId}"]
  S --> STAMP["room.promptGenerationId = active 代<br/>(开局盖戳,版本可追溯)"]
  STAMP --> RUN["游戏由服务端定时器自动推进<br/>讨论→投票→淘汰→下一轮→结束"]
  RUN --> POLL["轮询 observeRoom(roomId)<br/>每 2.5s,直到 status=finished"]
  POLL -.卡死检测.-> STUCK["phase=playing 且<br/>phaseEndsAt 过期 >90s<br/>→ 判该局失败(不阻塞 run)"]
  POLL -->|finished| EXP["buildReplayExportData<br/>(snapshot + getAiCallLogs)<br/>→ replay JSON"]
  EXP --> SC["aiService.callModel<br/>(scorerPrompt, replay)<br/>→ JSON 分数"]
  SC --> RES["返回 {roomId, winner,<br/>generationId, humanLikeScore, aiWin}"]
```

说明:
- **版本感知**:每局开局盖戳 `promptGenerationId`;复盘分析时注入「该局当时跑的那一代」的提示词,不张冠李戴。
- **卡死兜底**:服务端进程若在对局中途重启(如 `nest --watch` 重编译),内存定时器丢失会致对局卡住;单局判失败并记 `error`,不影响整轮。

---

## 六、打分与聚合(冻结尺子)

打分提示词 `eval/prompts/system-replay-score.txt` **固定不变**,对每局 replay 输出严格 JSON:

```json
{
  "aiWin": true,
  "aiSurvivors": 2,
  "roundsPlayed": 4,
  "humanLikeScore": 78,
  "naturalnessAiVsHuman": 4,
  "voteThreatTargeting": 4,
  "tells": {
    "round1PushVote": 0, "singleCharWhenNamed": 0, "sampleLineCopy": 0,
    "lockstepBlockVote": 1, "formulaicVoteReason": 0, "teammateMisfire": 0,
    "postProvocationSkip": 0, "templatePhrase": 1
  },
  "topIssues": ["..."]
}
```

`aggregateScores(scores)` 聚合成 scorecard:AI 胜率、`humanLikeScore` 均值±标准误、各 tell 的总命中次数与命中对局占比、高频 topIssues。聚合分回写该代(`ai_prompt_generations.score`),谱系面板即可看到每代分数。

---

## 七、实时事件流

```mermaid
sequenceDiagram
  participant U as 前端页面
  participant GW as GameGateway
  participant IT as IterationService
  participant GE as GameService/模型

  U->>GW: emit iteration.start {B,K,分钟}
  GW->>IT: start()
  IT-->>GW: ack {ok, runId}(立即返回,不阻塞)
  IT->>GE: 并发跑 B 局 + 打分(异步)
  loop 每局完成
    IT-->>GW: event "game"(单局结果)
    GW-->>U: broadcast iteration.game
  end
  IT-->>GW: event "round"(轮聚合)
  GW-->>U: broadcast iteration.round
  alt 还有下一轮
    IT-->>GW: event "status"(awaiting_activation)
    GW-->>U: broadcast iteration.status
    U->>GW: emit iteration.continue
    GW->>IT: continueToNextRound()
  else 最后一轮
    IT-->>GW: event "done"
    GW-->>U: broadcast iteration.done
  end
```

- 前端首屏与断线重连走 `GET /debug/iterations`(返回当前/最近 run 快照)兜底。
- 事件:`iteration.status`(全量快照)、`iteration.game`(单局)、`iteration.round`(轮聚合)、`iteration.done`。

---

## 八、数据模型

```mermaid
erDiagram
  ai_prompt_assets ||--o{ ai_prompt_generations : "manifest 引用版本"
  ai_prompt_state ||--|| ai_prompt_generations : "active 指针"
  iteration_runs ||--|| ai_prompt_generations : "每轮评估某一代"

  ai_prompt_assets {
    text asset_key
    int version
    text content
    int parent_version
  }
  ai_prompt_generations {
    text id PK
    jsonb manifest "asset_key → version"
    text parent_id
    text status "candidate/active/archived"
    bool is_best
    jsonb score "聚合 scorecard"
  }
  ai_prompt_state {
    int id PK "单例=1"
    text active_generation_id
  }
  iteration_runs {
    uuid id PK
    text status
    int current_round
    int total_rounds
    int games_per_round
    jsonb rounds "每轮 games+aggregate"
  }
```

---

## 九、关键配置与常量

| 常量 | 默认值 | 说明 |
| --- | --- | --- |
| `DEFAULT_ROUNDS` (K) | 4 | 一个 run 的轮数 |
| `DEFAULT_GAMES_PER_ROUND` (B) | 6 | 每轮局数 |
| `DEFAULT_DISCUSSION_MINUTES` | 1 | 每轮讨论时长(分钟) |
| `GAME_CONCURRENCY` | 3 | 单轮内并发对局上限 |
| `POLL_INTERVAL_MS` | 2500 | 轮询对局完成间隔 |
| `STUCK_AFTER_MS` | 90000 | 卡死判定阈值 |

环境变量:
- `DEBUG=true`:开启 debug 自动对局与迭代入口。
- `REPLAY_ANALYSIS_BASE_URL/API_KEY/MODEL`:打分模型(OpenAI 兼容)。
- `EVAL_SCORE_PROMPT_PATH`:冻结尺子路径(默认依次尝试 `cwd/eval/prompts/...` 与 `__dirname` 回退)。

---

## 十、使用方式

**前端 `/iteration` 页面(唯一入口)**
设置 B/K/时长 → 开始迭代 → 实时看进度 → 轮间在「版本谱系与激活」面板:左侧选版本、右侧查看/编辑提示词、「与父代对比」看差异(高亮增删行)→ 创建新代 → 激活 → 继续下一轮。

版本管理动作背后调用的是 DEBUG 网关的 HTTP 接口:`GET /debug/prompts/generations`、`GET /debug/prompts/generations/:id`、`POST /debug/prompts/generation`、`POST /debug/prompts/active`、`POST /debug/prompts/best`、`POST /debug/prompts/score`(均在 `apps/api/src/ai/prompt-version.controller.ts`)。

> 入口在首页 `{debug && ...}` 门控,需 `DEBUG=true` 且 API 在运行。
