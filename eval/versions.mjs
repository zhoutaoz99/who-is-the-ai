#!/usr/bin/env node
// AI 提示词版本库命令行工具(包装 /debug/prompts/* 接口)。
// 用法见 usage()。默认连接 http://localhost:3001,可用 API_BASE_URL 覆盖。
import { readFileSync } from "node:fs";

const BASE = (process.env.API_BASE_URL ?? "http://localhost:3001").replace(/\/+$/, "");

async function http(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { ok: false, error: text };
  }
  if (!res.ok || json.ok === false) {
    console.error(`[${method} ${path}] 失败:`, json.error ?? text);
    process.exit(1);
  }
  return json;
}

function usage() {
  console.log(`用法:
  versions.mjs list
  versions.mjs show <genId>
  versions.mjs create --from <genId> --asset <key>=<path> [--asset ...] [--note <text>]
  versions.mjs active <genId>
  versions.mjs best <genId>
  versions.mjs score <genId> --file <path>

asset key 例: ai-player/system-speech-strategy.txt  ai-player/personas
  (personas 文件为 JSON 数组)`);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a.startsWith("--")) {
      if (a.includes("=")) {
        const [k, ...rest] = a.slice(2).split("=");
        flags[k] = rest.join("=");
      } else {
        const k = a.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          flags[k] = true;
        } else {
          flags[k] = next;
          i += 1;
        }
      }
    } else {
      positional.push(a);
    }
    i += 1;
  }
  return { positional, flags };
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const { positional, flags } = parseArgs(rest);

  switch (cmd) {
    case "list": {
      const data = await http("GET", "/debug/prompts/generations");
      console.log(`active = ${data.active}\n`);
      for (const g of data.generations) {
        const tag = [
          g.id === data.active ? "ACTIVE" : null,
          g.isBest ? "BEST" : null,
          g.status,
        ]
          .filter(Boolean)
          .join(" ");
        console.log(
          `${g.id}  [${tag}]  parent=${g.parentId ?? "-"}  ${g.note ?? ""}`,
        );
      }
      break;
    }
    case "show": {
      const genId = positional[0];
      if (!genId) return usage();
      const data = await http("GET", `/debug/prompts/generations/${genId}`);
      const g = data.generation;
      console.log(`generation: ${g.generationId}`);
      console.log("prompts:");
      for (const [k, v] of Object.entries(g.prompts)) {
        console.log(`  - ${k} (${String(v).length} chars)`);
      }
      console.log(`personas: ${g.personas.length} 个`);
      break;
    }
    case "create": {
      const assets = Array.isArray(flags.asset) ? flags.asset : [flags.asset].filter(Boolean);
      if (!assets.length || !flags.from) return usage();
      const changedAssets = {};
      for (const spec of assets) {
        const idx = spec.indexOf("=");
        if (idx < 0) {
          console.error(`--asset 格式错误(需 key=path): ${spec}`);
          process.exit(1);
        }
        const key = spec.slice(0, idx);
        const path = spec.slice(idx + 1);
        changedAssets[key] = readFileSync(path, "utf-8");
      }
      const data = await http("POST", "/debug/prompts/generation", {
        fromGenId: flags.from,
        changedAssets,
        note: flags.note,
      });
      console.log(`已创建代 ${data.generation.id}(继承自 ${data.generation.parentId})`);
      console.log("manifest:", JSON.stringify(data.generation.manifest, null, 2));
      break;
    }
    case "active": {
      const genId = positional[0];
      if (!genId) return usage();
      const data = await http("POST", "/debug/prompts/active", { generationId: genId });
      console.log(`已激活 ${data.active}`);
      break;
    }
    case "best": {
      const genId = positional[0];
      if (!genId) return usage();
      await http("POST", "/debug/prompts/best", { generationId: genId });
      console.log(`已标记 ${genId} 为历史最佳`);
      break;
    }
    case "score": {
      const genId = positional[0];
      if (!genId || !flags.file) return usage();
      const score = JSON.parse(readFileSync(flags.file, "utf-8"));
      await http("POST", "/debug/prompts/score", { generationId: genId, score });
      console.log(`已回写 ${genId} 的分数`);
      break;
    }
    default:
      usage();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
