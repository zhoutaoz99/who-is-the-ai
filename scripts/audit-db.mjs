#!/usr/bin/env node
// 审计只读取数工具(direct-read 底座)。供"设计一致性审计 agent"直读已落盘的中间数据,
// 见 docs/audit/CHARTER.md §4.1。
//
// 设计要点:
//  - 连接串来自仓库根 .env 的 DATABASE_URL(本地、无鉴权)。
//  - 强制只读:所有查询跑在 `BEGIN TRANSACTION READ ONLY` 事务里,任何写操作会被 PG 拒绝
//    (对应章程 AUDIT-READONLY)。`query` 子命令额外做 SQL 前缀白名单。
//  - 输出统一为 JSON(stdout),便于 agent 解析。
//
// 用法:
//   node scripts/audit-db.mjs tables                 列出审计相关表 + 行数
//   node scripts/audit-db.mjs matches [limit]        最近对局(match_id, created_at)
//   node scripts/audit-db.mjs match <matchId>        整局 MatchRecord(jsonb)
//   node scripts/audit-db.mjs score <matchId>        该局 ScoreRecord(jsonb)
//   node scripts/audit-db.mjs generations [limit]    各代评测概览(generation_no 倒序)
//   node scripts/audit-db.mjs generation <genId>     某代完整 GenerationEval(jsonb)
//   node scripts/audit-db.mjs state                  编排器状态(jsonb)
//   node scripts/audit-db.mjs versions [limit]       提示词版本概览(不含正文)
//   node scripts/audit-db.mjs version <versionId>    某版本完整 prompt_text + meta
//   node scripts/audit-db.mjs ai-calls <roomId>      产品对局逐轮 AI 调用日志(ai_call_logs)
//   node scripts/audit-db.mjs query "SELECT ..."     任意只读 SQL(仅 select/with/explain/show/table)

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// 用 dotenv 读仓库根 .env;失败则回退已有环境变量。
try {
  require("dotenv").config({ path: path.join(repoRoot, ".env") });
} catch {
  /* dotenv 不可用时忽略,依赖外部已注入的环境变量 */
}

const { Pool } = require("pg");

const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!connectionString) {
  fail("未找到 DATABASE_URL(检查仓库根 .env 或环境变量)");
}

const AUDIT_TABLES = [
  "sandbox_match_records",
  "sandbox_score_records",
  "sandbox_generation_evals",
  "sandbox_orchestrator_state",
  "sandbox_prompt_versions",
  "sandbox_paired_cache",
  "sandbox_trace_events",
  "eval_prompt_assets",
  "eval_prompt_generations",
  "eval_prompt_state",
  "ai_call_logs",
  "game_rooms",
  "replay_exports",
];

const READ_PREFIX = /^\s*(select|with|explain|show|table)\b/i;

function fail(msg) {
  process.stderr.write(`audit-db: ${msg}\n`);
  process.exit(1);
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

// 在只读事务内执行查询:任何写都会被 PG 拒绝。
async function readQuery(pool, sql, params = []) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    const res = await client.query(sql, params);
    await client.query("COMMIT");
    return res.rows;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function run() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    printUsage();
    return;
  }

  const pool = new Pool({ connectionString, max: 2 });
  try {
    switch (cmd) {
      case "tables": {
        const rows = [];
        for (const t of AUDIT_TABLES) {
          try {
            const r = await readQuery(pool, `SELECT count(*)::int AS n FROM ${t}`);
            rows.push({ table: t, rows: r[0].n });
          } catch {
            rows.push({ table: t, rows: null, note: "不存在或不可读" });
          }
        }
        out(rows);
        break;
      }
      case "matches": {
        const limit = clampLimit(args[0], 20);
        const rows = await readQuery(
          pool,
          `SELECT match_id, created_at FROM sandbox_match_records
           ORDER BY created_at DESC LIMIT $1`,
          [limit],
        );
        out(rows);
        break;
      }
      case "match": {
        const id = requireArg(args[0], "matchId");
        const rows = await readQuery(
          pool,
          `SELECT data FROM sandbox_match_records WHERE match_id = $1`,
          [id],
        );
        out(rows[0]?.data ?? null);
        break;
      }
      case "score": {
        const id = requireArg(args[0], "matchId");
        const rows = await readQuery(
          pool,
          `SELECT data FROM sandbox_score_records WHERE match_id = $1 LIMIT 1`,
          [id],
        );
        out(rows[0]?.data ?? null);
        break;
      }
      case "generations": {
        const limit = clampLimit(args[0], 50);
        const rows = await readQuery(
          pool,
          `SELECT generation_id, generation_no FROM sandbox_generation_evals
           ORDER BY generation_no DESC LIMIT $1`,
          [limit],
        );
        out(rows);
        break;
      }
      case "generation": {
        const id = requireArg(args[0], "generationId");
        const rows = await readQuery(
          pool,
          `SELECT data FROM sandbox_generation_evals WHERE generation_id = $1`,
          [id],
        );
        out(rows[0]?.data ?? null);
        break;
      }
      case "state": {
        const rows = await readQuery(
          pool,
          `SELECT data, updated_at FROM sandbox_orchestrator_state ORDER BY updated_at DESC LIMIT 1`,
        );
        out(rows[0] ?? null);
        break;
      }
      case "versions": {
        const limit = clampLimit(args[0], 50);
        const rows = await readQuery(
          pool,
          `SELECT version_id, status, length(prompt_text) AS prompt_len, meta
           FROM sandbox_prompt_versions LIMIT $1`,
          [limit],
        );
        out(rows);
        break;
      }
      case "version": {
        const id = requireArg(args[0], "versionId");
        const rows = await readQuery(
          pool,
          `SELECT version_id, status, prompt_text, meta
           FROM sandbox_prompt_versions WHERE version_id = $1`,
          [id],
        );
        out(rows[0] ?? null);
        break;
      }
      case "ai-calls": {
        const roomId = requireArg(args[0], "roomId");
        const rows = await readQuery(
          pool,
          `SELECT * FROM ai_call_logs WHERE room_id = $1 ORDER BY round_no, created_at`,
          [roomId],
        );
        out(rows);
        break;
      }
      case "trace": {
        const id = requireArg(args[0], "matchId");
        const limit = clampLimit(args[1], 200);
        const rows = await readQuery(
          pool,
          `SELECT id, created_at, kind, stage, run_id, data FROM sandbox_trace_events
           WHERE match_id = $1 ORDER BY created_at, id LIMIT $2`,
          [id, limit],
        );
        out(rows);
        break;
      }
      case "trace-run": {
        const id = requireArg(args[0], "runId");
        const limit = clampLimit(args[1], 200);
        const rows = await readQuery(
          pool,
          `SELECT id, created_at, kind, stage, match_id, data FROM sandbox_trace_events
           WHERE run_id = $1 ORDER BY created_at, id LIMIT $2`,
          [id, limit],
        );
        out(rows);
        break;
      }
      case "manifest": {
        const id = requireArg(args[0], "matchId");
        const byKind = await readQuery(
          pool,
          `SELECT kind, stage, count(*)::int AS n FROM sandbox_trace_events
           WHERE match_id = $1 GROUP BY kind, stage ORDER BY kind, stage`,
          [id],
        );
        const match = await readQuery(
          pool,
          `SELECT 1 FROM sandbox_match_records WHERE match_id = $1`,
          [id],
        );
        const score = await readQuery(
          pool,
          `SELECT 1 FROM sandbox_score_records WHERE match_id = $1 LIMIT 1`,
          [id],
        );
        out({
          match_id: id,
          match_record: match.length > 0,
          score_record: score.length > 0,
          trace_events: byKind,
          hint: "trace 为空时,确认 API 以 AUDIT_TRACE=1 启动后再跑对局/评分",
        });
        break;
      }
      case "query": {
        const sql = args.join(" ").trim();
        if (!sql) fail('用法: query "SELECT ..."');
        if (!READ_PREFIX.test(sql)) {
          fail("仅允许只读 SQL(select / with / explain / show / table)");
        }
        const rows = await readQuery(pool, sql);
        out(rows);
        break;
      }
      default:
        fail(`未知命令: ${cmd}(用 help 查看用法)`);
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  } finally {
    await pool.end().catch(() => {});
  }
}

function requireArg(v, name) {
  if (!v) fail(`缺少参数: ${name}`);
  return v;
}

function clampLimit(v, def) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), 500);
}

function printUsage() {
  out({
    tool: "audit-db",
    readonly: true,
    connection: "DATABASE_URL from repo-root .env",
    commands: {
      tables: "列出审计相关表 + 行数",
      "matches [limit]": "最近对局(match_id, created_at)",
      "match <matchId>": "整局 MatchRecord(jsonb)",
      "score <matchId>": "该局 ScoreRecord(jsonb)",
      "generations [limit]": "各代评测概览",
      "generation <genId>": "某代完整 GenerationEval",
      state: "编排器状态",
      "versions [limit]": "提示词版本概览(不含正文)",
      "version <versionId>": "某版本完整 prompt_text + meta",
      "ai-calls <roomId>": "产品对局逐轮 AI 调用日志(ai_call_logs)",
      "trace <matchId> [limit]": "该局 trace 事件(🟡 LLM 原文 / 🔴 聚合;需 AUDIT_TRACE=1)",
      "trace-run <runId> [limit]": "某 run 的 trace 事件(如 control-test 聚合产物)",
      "manifest <matchId>": "该局可用数据索引(MatchRecord/ScoreRecord/trace 计数)",
      'query "SELECT ..."': "任意只读 SQL",
    },
  });
}

run();
