# Who's the AI

"谁是AI"是一款社交聊天推理游戏——真人玩家与 AI 玩家混在一起，通过自由发言和投票找出隐藏的 AI。本仓库是它的最小可运行版本，采用推荐选型中的前后台方案：

- 前端：`Next.js App Router + React + TypeScript`
- 后端：`NestJS + Socket.IO + TypeScript`
- 数据存储：`PostgreSQL`
- 缓存与会话：`Redis`

当前版本先跑通实时玩法闭环。规划事项统一维护在 [`docs/FollowUpPlan.md`](docs/FollowUpPlan.md)。

## 功能范围

- 账号注册、登录、退出登录
- 个人信息查看、昵称修改
- 新账号初始分配 1000 积分
- 登录后使用账号昵称创建或加入房间
- 创建房间
- 创建房间时可设置每轮发言时间，默认 5 分钟，最小 1 分钟
- 加入房间
- 1 到 5 名真人玩家开局
- 自动加入 2 名隐藏 AI 玩家
- 讨论阶段自由发言
- 15 秒发言冷却
- 服务端轮次倒计时
- 投票阶段投票出局
- AI 模板发言和规则投票
- 4 轮后仍有 AI 模拟玩家存活则人类玩家失败
- AI 模拟玩家全部出局则真人胜利，存活真人玩家平分 2000 积分
- 游戏结束后揭示玩家身份

账号数据持久化在 PostgreSQL。登录会话写入 Redis；房间和对局状态写入 PostgreSQL 的 `jsonb` 字段，并通过 Redis 缓存热房间数据。

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

## Docker 部署

使用 `docker compose` 一键启动全部服务（API、前端、PostgreSQL、Redis）。

### 1. 配置环境变量

从示例文件复制并填入必填项：

```bash
cp .env.example .env
```

编辑 `.env`，至少填写 `AI_API_KEY`：

```bash
AI_API_KEY=sk-your-key-here
```

一键复盘分析使用独立模型配置，不复用对局 AI 模型：

```bash
REPLAY_ANALYSIS_BASE_URL=https://api.example.com/v1
REPLAY_ANALYSIS_API_KEY=sk-your-replay-analysis-key
REPLAY_ANALYSIS_MODEL=your-review-model
```

其余变量均有默认值，按需修改。`DATABASE_URL` 和 `REDIS_URL` 无需修改，`docker-compose.yml` 已使用容器内部主机名。

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

后端支持以下环境变量：

```bash
PORT=3001
WEB_ORIGIN=http://localhost:3000
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/ai_werewolf
REDIS_URL=redis://127.0.0.1:6379
SESSION_TTL_SECONDS=604800
ROOM_CACHE_TTL_SECONDS=3600
ROUND_DURATION_MS=300000
VOTE_DURATION_MS=30000
```

`ROUND_DURATION_MS` 是创建房间时未传入配置的后端默认值。前端创建房间时会传入分钟数，并由后端强制限制最小 1 分钟。

服务启动时会自动创建所需的 `accounts` 和 `game_rooms` 表。未设置 `DATABASE_URL` 时，后端默认连接 `127.0.0.1:5432/ai_werewolf`，用户名和密码均为 `postgres`；未设置 `REDIS_URL` 时默认连接 `redis://127.0.0.1:6379`。

前端支持以下环境变量：

```bash
NEXT_PUBLIC_API_URL=http://localhost:3001
```

## 构建

```bash
npm run build
```

## 目录结构

```text
apps/
  api/    NestJS + Socket.IO 后端
  web/    Next.js 前端
docs/     玩法与实现方案文档
scripts/  本地开发脚本
```
