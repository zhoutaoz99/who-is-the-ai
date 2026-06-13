#!/usr/bin/env node
// 一轮评估闭环:run-batch -> score -> aggregate,并回写 active 代分数。
// 用法: node eval/run-round.mjs --batch 6 [--minutes 1] [--concurrency 3]
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const flags = parseArgs(process.argv.slice(2));
const batch = Number(flags.batch ?? 6);
const minutes = flags.minutes ? Number(flags.minutes) : undefined;
const concurrency = Number(flags.concurrency ?? 3);

const ts = stamp();
const runDir = `eval/runs/${ts}`;
const replaysDir = `${runDir}/replays`;
const scoresDir = `${runDir}/scores`;
mkdirSync(replaysDir, { recursive: true });

console.log(`\n=== [1/3] run-batch: ${batch} 局 -> ${replaysDir} ===\n`);
run("run-batch.mjs", ["--batch", batch, "--out", replaysDir, "--concurrency", concurrency, ...(minutes ? ["--minutes", minutes] : [])]);

console.log(`\n=== [2/3] score -> ${scoresDir} ===\n`);
run("score.mjs", ["--in", replaysDir, "--out", scoresDir, "--concurrency", 2]);

console.log(`\n=== [3/3] aggregate -> ${runDir}/scorecard ===\n`);
run("aggregate.mjs", ["--in", scoresDir]);

console.log(`\n完成。产物目录: ${runDir}/`);

function run(script, args) {
  execFileSync(process.execPath, [`eval/${script}`, ...args], {
    stdio: "inherit",
    env: process.env,
  });
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

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
