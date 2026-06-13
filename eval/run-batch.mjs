#!/usr/bin/env node
// 跑一批无头对局,逐局拉取 replay 导出 JSON 存盘。
// 用法: node eval/run-batch.mjs --batch 6 --out eval/runs/<ts>/replays [--minutes 1] [--concurrency 3]
import { mkdirSync, writeFileSync } from "node:fs";
import { loadEnv, runOneGame, fetchReplayExport, runWithConcurrency, sleep } from "./lib.mjs";

loadEnv();

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

const flags = parseArgs(process.argv.slice(2));
const batch = Number(flags.batch ?? 6);
const outDir = flags.out ?? `eval/runs/${stamp()}/replays`;
const minutes = flags.minutes ? Number(flags.minutes) : undefined;
const concurrency = Number(flags.concurrency ?? 3);

mkdirSync(outDir, { recursive: true });

console.log(`跑 ${batch} 局(并发 ${concurrency}),输出目录 ${outDir}`);
const meta = [];

await runWithConcurrency(
  Array.from({ length: batch }, (_, i) => i),
  concurrency,
  async (i) => {
    const start = Date.now();
    try {
      const { roomId, winner } = await runOneGame({
        discussionMinutes: minutes,
        log: (msg) => console.log(`  [game ${i + 1}] ${msg}`),
      });
      const replay = await fetchReplayExport(roomId);
      const file = `${outDir}/replay-${roomId}.json`;
      writeFileSync(file, JSON.stringify(replay, null, 2));
      const dur = Math.round((Date.now() - start) / 1000);
      meta.push({ index: i, roomId, winner, gen: replay.promptGenerationId, durSec: dur, file });
      console.log(`[${i + 1}/${batch}] ${roomId} winner=${winner} gen=${replay.promptGenerationId ?? "-"} (${dur}s)`);
    } catch (err) {
      meta.push({ index: i, error: String(err.message ?? err) });
      console.error(`[${i + 1}/${batch}] 失败: ${err.message ?? err}`);
    }
  },
);

const metaFile = `${outDir}/batch-meta.json`;
writeFileSync(metaFile, JSON.stringify(meta, null, 2));
const ok = meta.filter((m) => !m.error).length;
console.log(`完成 ${ok}/${batch} 局,元数据见 ${metaFile}`);

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
