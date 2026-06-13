# eval — AI 提示词自动对局评估闭环

把"跑一批无头对局 → 量化打分 → 聚合 scorecard"做成可重复的循环,配合 DB 版本库做提示词迭代。
**打分尺子(system-replay-score.txt)全程冻结**,只进化被测对象(AI 玩家提示词/人格)。

## 前置

1. API 在跑(`DEBUG=true`),默认连 `http://localhost:3001`(`API_BASE_URL` 可覆盖)。
2. `.env` 配好 `REPLAY_ANALYSIS_BASE_URL/API_KEY/MODEL`(打分模型,OpenAI 兼容)。
3. 首启 API 会自动播种 `gen-0001`(来自当前 `ai-player/*` 文件 + 默认人格库)。

## 一轮评估(B=6 局)

```bash
node eval/run-round.mjs --batch 6 --minutes 1 --concurrency 3
# 产物:eval/runs/<时间戳>/{replays/*, scores/*, scorecard.json, scorecard.md}
```

- `--minutes 1`:每轮讨论 1 分钟(最快)。`--batch N` 局数。`--concurrency` 并发上限。

也可分步:`run-batch.mjs` → `score.mjs` → `aggregate.mjs`(各自 `--in/--out`)。

## 迭代一个新版本(手动,本期不做自动编辑器)

```bash
# 1. 改某个 asset(文本模板直接编辑;personas 存 JSON 数组)
# 2. 从当前 active 代派生新代(只 bump 改动的 asset)
node eval/versions.mjs create --from gen-0001 \
  --asset ai-player/system-speech-strategy.txt=./tmp/strategy.txt \
  --note "收敛第一轮带节奏 tell"
# 3. 激活新代(引擎热切换,无需重启;回滚同理 set-active 旧代)
node eval/versions.mjs active gen-0002
# 4. 跑一轮评估对比 scorecard
node eval/run-round.mjs --batch 6 --minutes 1
# 5. 更好则标记为历史最佳(回滚目标);更差则回滚
node eval/versions.mjs best gen-0002     # 或 active gen-0001 回滚
```

`versions.mjs` 子命令:`list / show <id> / create / active <id> / best <id> / score <id> --file <score.json>`。

## scorecard 指标

- AI 胜率、平均存活 AI 数、平均轮数
- humanLikeScore / 自然度(AI vs 真人)/ 投票威胁定位(均值 ± 标准误)
- tells 命中(总次数 / 命中对局占比):round1PushVote、singleCharWhenNamed、sampleLineCopy、**lockstepBlockVote**、formulaicVoteReason、teammateMisfire、postProvocationSkip、templatePhrase
- 高频问题(topIssues 聚合)

## 版本感知

每局 `game.start` 时盖戳 `room.promptGenerationId = active 代号`;`GET /replay/:roomId/export` 返回的 JSON 带 `promptGenerationId`;
复盘分析(`/replay/analyze`)会注入**该局当时实际运行的那一代** AI 提示词,而非当前 active,避免迭代后回看旧局张冠李戴。

## 已知限制(引擎侧,非本工具)

- 对局阶段靠**进程内存定时器**推进;若 API 进程在对局中途重启(如 `nest --watch` 重编译),内存定时器丢失,该局会永久卡在当前 phase。
  `runOneGame` 内置卡死检测(phaseEndsAt 过期 >90s 即判该局失败并跳过),不会无限挂起。
  建议评估时关闭 `--watch` 或用独立构建实例跑,避免重编译打断对局。
