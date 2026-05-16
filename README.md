# AI Werewolf MVP

AI 狼人杀的最小可运行版本，采用推荐选型中的前后台方案：

- 前端：`Next.js App Router + React + TypeScript`
- 后端：`NestJS + Socket.IO + TypeScript`
- MVP 状态存储：内存

当前版本先跑通实时玩法闭环。规划事项统一维护在 [`docs/FollowUpPlan.md`](docs/FollowUpPlan.md)。

## 功能范围

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
- AI 模拟玩家全部出局则真人胜利
- 游戏结束后揭示玩家身份

## 本地启动

安装依赖：

```bash
npm install
```

启动前后端开发服务：

```bash
npm run dev
```

默认地址：

- 前端：http://localhost:3000
- 后端：http://localhost:3001
- 健康检查：http://localhost:3001/health

## 可选环境变量

后端支持以下环境变量：

```bash
PORT=3001
WEB_ORIGIN=http://localhost:3000
ROUND_DURATION_MS=300000
VOTE_DURATION_MS=30000
```

`ROUND_DURATION_MS` 是创建房间时未传入配置的后端默认值。前端创建房间时会传入分钟数，并由后端强制限制最小 1 分钟。

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
