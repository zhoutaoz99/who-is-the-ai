#!/usr/bin/env node
// 用冻结的 rubric 给一批 replay 逐局打分,输出严格 JSON。
// 用法: node eval/score.mjs --in eval/runs/<ts>/replays --out eval/runs/<ts>/scores
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnv, scoreWithModel, runWithConcurrency } from "./lib.mjs";

loadEnv();

const flags = parseArgs(process.argv.slice(2));
const inDir = flags.in;
const outDir = flags.out;
if (!inDir || !outDir) {
  console.error("需要 --in <replays目录> --out <scores目录>");
  process.exit(1);
}
const concurrency = Number(flags.concurrency ?? 2);
mkdirSync(outDir, { recursive: true });

const rubric = readFileSync(new URL("./prompts/system-replay-score.txt", import.meta.url), "utf-8");
const files = readdirSync(inDir).filter((f) => f.startsWith("replay-") && f.endsWith(".json"));
console.log(`打分 ${files.length} 份 replay`);

await runWithConcurrency(files, concurrency, async (file) => {
  const replay = JSON.parse(readFileSync(join(inDir, file), "utf-8"));
  const roomId = replay.roomId;
  const userPrompt = JSON.stringify(replay);
  const target = join(outDir, `score-${roomId}.json`);
  try {
    const score = await scoreWithModel(rubric, userPrompt);
    writeFileSync(target, JSON.stringify({ roomId, ...score }, null, 2));
    console.log(`score ${roomId}: aiWin=${score.aiWin} humanLike=${score.humanLikeScore}`);
  } catch (err) {
    writeFileSync(target, JSON.stringify({ roomId, error: String(err.message ?? err) }, null, 2));
    console.error(`score ${roomId} 失败: ${err.message ?? err}`);
  }
});
console.log("打分完成");

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
