#!/usr/bin/env node
// 聚合一批发分数为 scorecard.json + scorecard.md,并可回写当前 active 代的分数。
// 用法: node eval/aggregate.mjs --in eval/runs/<ts>/scores [--gen gen-0001] [--write]
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { loadEnv, API_BASE } from "./lib.mjs";

loadEnv();

const flags = parseArgs(process.argv.slice(2));
const inDir = flags.in;
if (!inDir) {
  console.error("需要 --in <scores目录>");
  process.exit(1);
}
const outDir = dirname(inDir); // scorecard 与 scores 同级

const files = fs.readdirSync(inDir).filter((f) => f.startsWith("score-") && f.endsWith(".json"));
const scores = [];
for (const f of files) {
  const s = JSON.parse(fs.readFileSync(join(inDir, f), "utf-8"));
  if (!s.error) scores.push(s);
}
if (!scores.length) {
  console.error("无有效分数");
  process.exit(1);
}

const n = scores.length;
const mean = (arr) => (arr.reduce((a, b) => a + b, 0) / arr.length);
const stddev = (arr) => {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(mean(arr.map((x) => (x - m) ** 2)));
};
const se = (arr) => stddev(arr) / Math.sqrt(arr.length);
const pct = (arr) => Math.round((mean(arr) * 100) / n) / 100; // 占比均值

const aiWins = scores.filter((s) => s.aiWin).length;
const tellKeys = [
  "round1PushVote",
  "singleCharWhenNamed",
  "sampleLineCopy",
  "lockstepBlockVote",
  "formulaicVoteReason",
  "teammateMisfire",
  "postProvocationSkip",
  "templatePhrase",
];
const tellSums = {};
const tellGames = {}; // 至少命中 1 次的对局数
for (const k of tellKeys) {
  const vals = scores.map((s) => Number(s.tells?.[k] ?? 0));
  tellSums[k] = vals.reduce((a, b) => a + b, 0);
  tellGames[k] = vals.filter((v) => v > 0).length;
}

const humanLike = scores.map((s) => Number(s.humanLikeScore ?? 0));
const nat = scores.map((s) => Number(s.naturalnessAiVsHuman ?? 0));
const vt = scores.map((s) => Number(s.voteThreatTargeting ?? 0));

const scorecard = {
  n,
  aiWinRate: aiWins / n,
  aiSurvivorsMean: mean(scores.map((s) => Number(s.aiSurvivors ?? 0))),
  roundsPlayedMean: mean(scores.map((s) => Number(s.roundsPlayed ?? 0))),
  humanLikeScore: { mean: round2(mean(humanLike)), se: round2(se(humanLike)) },
  naturalnessAiVsHuman: { mean: round2(mean(nat)), se: round2(se(nat)) },
  voteThreatTargeting: { mean: round2(mean(vt)), se: round2(se(vt)) },
  tells: tellSums,
  tellGameRates: Object.fromEntries(tellKeys.map((k) => [k, tellGames[k] / n])),
  topIssues: topIssuesAggregate(scores),
  generatedAt: new Date().toISOString(),
};

fs.writeFileSync(join(outDir, "scorecard.json"), JSON.stringify(scorecard, null, 2));
fs.writeFileSync(join(outDir, "scorecard.md"), renderMd(scorecard));
console.log(`已生成 ${join(outDir, "scorecard.json")} 与 scorecard.md`);
console.log(renderMd(scorecard));

if (flags.gen && flags.write) {
  await writeScore(flags.gen, scorecard);
}

async function writeScore(gen, score) {
  const res = await fetch(`${API_BASE()}/debug/prompts/score`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ generationId: gen, score }),
  });
  const json = await res.json();
  console.log(json.ok ? `已回写 ${gen} 分数` : `回写失败: ${json.error}`);
}

function topIssuesAggregate(scores) {
  const counts = new Map();
  for (const s of scores) {
    for (const issue of s.topIssues ?? []) {
      const key = String(issue).trim();
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([issue, count]) => ({ issue, count }));
}

function round2(x) { return Math.round(x * 100) / 100; }

function renderMd(sc) {
  const lines = [];
  lines.push(`# Scorecard (${sc.n} 局)`);
  lines.push("");
  lines.push(`- AI 胜率: **${pctStr(sc.aiWinRate)}**`);
  lines.push(`- 平均存活 AI 数: ${round2(sc.aiSurvivorsMean)} / 平均轮数: ${round2(sc.roundsPlayedMean)}`);
  lines.push(`- humanLikeScore: ${sc.humanLikeScore.mean} ± ${sc.humanLikeScore.se}`);
  lines.push(`- 自然度(AI vs 真人, 1-5): ${sc.naturalnessAiVsHuman.mean} ± ${sc.naturalnessAiVsHuman.se}`);
  lines.push(`- 投票威胁定位 (1-5): ${sc.voteThreatTargeting.mean} ± ${sc.voteThreatTargeting.se}`);
  lines.push("");
  lines.push(`## tells(总命中次数 / 命中对局占比)`);
  for (const k of tellKeys) {
    lines.push(`- ${k}: ${sc.tells[k]} 次 / ${pctStr(sc.tellGameRates[k])} 对局`);
  }
  lines.push("");
  lines.push(`## 高频问题`);
  for (const t of sc.topIssues) lines.push(`- (${t.count}) ${t.issue}`);
  return lines.join("\n");
}

function pctStr(x) { return `${Math.round(x * 1000) / 10}%`; }

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) flags[k] = true;
      else { flags[k] = next; i++; }
    }
  }
  return flags;
}
