# Who's the AI

"谁是AI"是一款社交聊天推理游戏——真人玩家与 AI 玩家混在一起，通过自由发言和投票找出隐藏的 AI。采用推荐选型中的前后台方案：

- 前端：`Next.js App Router + React + TypeScript`
- 后端：`NestJS + Socket.IO + TypeScript`
- 数据存储：`PostgreSQL`
- 缓存与会话：`Redis`

仓库现在包含两条互相喂养的回路：

- **在线产品对局**：真人 + 隐藏 AI 的实时房间，就是玩家实际玩的那局游戏。
- **离线优化沙盒**：复用同一套产品运行时（`GameService`）跑场景化对局，再用裁判打分 → 聚合 → 优化器 → 编排器代际循环来评测和迭代对局 AI 的提示词；配套对照测试、真人校准、提示词版本库、LLM 用量统计与复盘导出等工具。

系统全景可视化导览见 [`overview/`](overview/)：GitHub 不会直接渲染仓库里的 HTML，点[**在线预览**](https://raw.githack.com/zhoutaoz99/ai-werewolf/main/overview/index.html)即可查看渲染后的页面（经 raw.githack CDN 提供），或克隆仓库后用浏览器打开 `overview/index.html`（零构建、零依赖）。规划与待办统一维护在 [`docs/Roadmap.md`](docs/Roadmap.md)，文档总览见 [`docs/README.md`](docs/README.md)。

## 对局截图

一局离线沙盒对局（阵容：被测 AI + 侦探 + 填充）的界面——左侧玩家面板、中间发言区、右侧当前行动。本局侦探在第 2 轮通过投票识别并淘汰了被测 AI，侦探方获胜。

| 对局界面与第 1 轮发言 | 第 2 轮投票淘汰被测 AI |
| :---: | :---: |
| [![谁是AI 对局界面：玩家面板与发言区](docs/assets/screenshot-match-1.png)](docs/assets/screenshot-match-1.png) | [![第 2 轮投票结果淘汰被测 AI](docs/assets/screenshot-match-2.png)](docs/assets/screenshot-match-2.png) |

## 功能范围

### 对局玩法

- 账号注册、登录、退出登录
- 个人信息查看、昵称修改
- 新账号初始分配 1000 积分
- 登录后使用账号昵称创建或加入房间
- 创建房间时可设置每轮发言时间，默认 5 分钟，最小 1 分钟
- 1 到 5 名真人玩家开局，自动加入 2 名隐藏 AI 玩家
- 讨论阶段自由发言，15 秒发言冷却，服务端轮次倒计时
- 投票阶段投票出局（平票或全员未投票则本轮无人出局）
- AI 玩家由大模型驱动发言（v4.0 单层发言：一次调用直接产出聊天内容）与投票，带跨轮次记忆与人格库
- 4 轮后仍有 AI 玩家存活则人类玩家失败
- AI 玩家全部出局则真人胜利，存活真人玩家平分 2000 积分
- 游戏结束后揭示玩家身份，支持赛后复盘页与 replay 导出（JSON 导出 / 存库）
- 断线重连（30 秒宽限）

### 离线优化与运维工具

- **离线沙盒对局**：按场景（roster / 台词 / 种子）跑场景化对局到终局，落盘 `MatchRecord`
- **裁判打分**：单裁判盲测打分、多裁判校准、逐轮可疑度轨迹与八维量表诊断
- **编排器**：提示词版本的代际循环，含配对显著性闸门、留出集评估与探测轮换
- **对照测试**：父/空/负/正等对照臂的 A/B 评测，配合优化器补洞
- **真人校准**：真人对局回灌与校准批次，作为防自欺闸门
- **提示词 / 评估尺子版本库**：asset 版本 + 代际 + active（champion）指针
- **LLM 用量统计**：token、缓存命中率、耗时等按模型/来源聚合（`/llm-stats` 页）
- **审计 trace**：`AUDIT_TRACE=1` 时把 LLM 原始 I/O 与聚合中间产物落库供审计
- **复盘导出**：赛后把对局快照 + AI 调用日志导出为结构化 JSON 并存库（`replay_exports`）
- 前端配套页面：大厅、对局、复盘、历史、账号、沙盒、编排器、对照测试、LLM 统计

账号数据持久化在 PostgreSQL。登录会话写入 Redis；房间和对局状态写入 PostgreSQL 的 `jsonb` 字段，并通过 Redis 缓存热房间数据。离线沙盒的对局记录、打分、版本与校准产物也统一落在 PostgreSQL 的 `jsonb` 文档表中。

## 目录结构

```text
apps/
  api/    NestJS + Socket.IO 后端
    src/ai/        对局 AI（单层发言、人格库、提示词加载、LLM 用量统计）
    src/game/      对局规则、状态机、Socket 网关
    src/replay/    复盘导出（对局快照 + AI 调用日志 → JSON / 存库）
    src/sandbox/   离线优化沙盒（场景引擎、裁判打分、优化器、编排器、对照测试、校准）
    src/auth/      账号与鉴权
    src/data/      PostgreSQL 与 Redis 访问层
  web/    Next.js 前端（大厅、对局、复盘、沙盒、编排器、对照测试、LLM 统计等页面）
docs/     玩法与实现方案文档（gameplay/、design/、audit/、Roadmap.md）
overview/ 系统全景可视化导览（零构建，浏览器直接打开 index.html）
scripts/  本地开发脚本
```

## 本地启动

安装依赖：

```bash
npm install
```

启动前后端开发服务：

```bash
npm run dev
```

启动 API 前需先准备 PostgreSQL 和 Redis。项目 PostgreSQL 使用宿主机 `5432`，Redis 使用 `6379`。

对局 AI 的模型与密钥配置在根目录 `ai-models.json`（从 `ai-models.example.json` 复制并填入每个模型条目的 `apiKey`）；未配置时 AI 会跳过发言。每个条目支持 `openai` / `claude` 两种格式。沙盒裁判、优化器等评估用途默认复用 `ai-models.json` 中标记 `default` 的端点。

```bash
docker run -d \
  --name ai-werewolf-postgres \
  -e POSTGRES_DB=ai_werewolf \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -v ai-werewolf-postgres-data:/var/lib/postgresql/data \
  -p 5432:5432 \
  postgres:16

docker run -d \
  --name ai-werewolf-redis \
  -v ai-werewolf-redis-data:/data \
  -p 6379:6379 \
  redis:7-alpine \
  redis-server --appendonly yes
```

如果端口仍有冲突，只修改 `-p` 左侧宿主机端口，例如 `-p 5434:5432` 或 `-p 6380:6379`，并同步更新下方的 `DATABASE_URL` 或 `REDIS_URL`。

默认地址：

- 前端：http://localhost:3000
- 后端：http://localhost:3001
- 健康检查：http://localhost:3001/health

如需产出生产构建（前后端一并编译，供部署或 Docker 镜像使用），运行：

```bash
npm run build
```

## Docker 部署

使用 `docker compose` 一键启动全部服务（API、前端、PostgreSQL、Redis）。

### 1. 配置环境变量

从示例文件复制并填入必填项：

```bash
cp .env.example .env
```

复制 AI 模型配置示例文件并填入各模型条目的 `apiKey`（对局 AI 的模型与密钥都在 `ai-models.json` 中配置，不读 `.env`）：

```bash
cp ai-models.example.json ai-models.json
# 编辑 ai-models.json，把每个条目的 apiKey 改成你自己的密钥
```

`.env` 其余变量均有默认值，按需修改。`DATABASE_URL` 和 `REDIS_URL` 无需修改，`docker-compose.yml` 已使用容器内部主机名。

### 2. 构建并启动

```bash
docker compose up -d --build
```

### 3. 访问服务

- 前端：http://localhost:3000
- 后端：http://localhost:3001
- 健康检查：http://localhost:3001/health

### 4. 自定义端口

如需修改宿主机暴露的端口，在 `.env` 中添加：

```bash
API_PORT=3001
WEB_PORT=3000
NEXT_PUBLIC_API_URL=http://localhost:3001
```

### 5. 常用命令

```bash
# 查看日志
docker compose logs -f api
docker compose logs -f web

# 停止服务
docker compose down

# 停止并清除数据卷
docker compose down -v
```

## 可选环境变量

后端支持以下环境变量（完整清单与说明见 [`.env.example`](.env.example)）：

```bash
PORT=3001
WEB_ORIGIN=http://localhost:3000
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/ai_werewolf
REDIS_URL=redis://127.0.0.1:6379
SESSION_TTL_SECONDS=604800
ROOM_CACHE_TTL_SECONDS=3600
ROUND_DURATION_MS=300000
VOTE_DURATION_MS=60000

# 离线沙盒评测并发（各成本层同时最多几局并发，见 .env.example 详解）
SANDBOX_DECISION_CONCURRENCY=3     # 决策评测（默认 3，对照测试用的就是这个）
SANDBOX_DIAGNOSTIC_CONCURRENCY=2   # 诊断评测（默认 2）
SANDBOX_CALIBRATION_CONCURRENCY=1  # 校准评测（默认 1）

# 其它开关
SIMULATED_HUMAN_INTENSITY=normal   # 模拟真人强度：normal | high
AUDIT_TRACE=0                      # =1 时把审计 trace（LLM 原始 I/O、聚合中间产物）落库
LOG_LEVELS=log,error,warn          # NestJS 日志级别；加 debug 可打印原始 LLM 请求体
# DEBUG=true                       # 调试模式：允许中途停止对局
```

`ROUND_DURATION_MS` 是创建房间时未传入配置的后端默认值。前端创建房间时会传入分钟数，并由后端强制限制最小 1 分钟。

服务启动时会自动创建所需的数据库表，包括：

- 产品对局：`accounts`、`game_rooms`、`ai_call_logs`、`replay_exports`
- 提示词与评估尺子版本库：`ai_prompt_*`、`eval_prompt_*`
- 离线沙盒：`sandbox_match_records`、`sandbox_score_records`、`sandbox_generation_evals`、`sandbox_prompt_versions`、`sandbox_orchestrator_state`、`sandbox_control_test_runs`、`sandbox_calibration_runs`、`sandbox_human_matches`、`sandbox_trace_events` 等
- LLM 用量：`llm_usage_logs`

未设置 `DATABASE_URL` 时，后端默认连接 `127.0.0.1:5432/ai_werewolf`，用户名和密码均为 `postgres`；未设置 `REDIS_URL` 时默认连接 `redis://127.0.0.1:6379`。

前端支持以下环境变量：

```bash
NEXT_PUBLIC_API_URL=http://localhost:3001
```
