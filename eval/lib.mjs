// eval 闭环共享工具:加载 .env、调用打分模型、跑无头对局、拉取 replay 导出。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { io } from "socket.io-client";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

/** 从项目根 .env 读取键值(极简解析,无需 dotenv 依赖)。 */
export function loadEnv() {
  const text = readFileSync(join(ROOT, ".env"), "utf-8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

export const API_BASE = () =>
  (process.env.API_BASE_URL ?? "http://localhost:3001").replace(/\/+$/, "");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 调用 OpenAI 兼容的 chat/completions,强制 JSON 输出,返回解析后的对象。 */
export async function scoreWithModel(systemPrompt, userPrompt) {
  const baseURL = (process.env.REPLAY_ANALYSIS_BASE_URL ?? "").replace(/\/+$/, "");
  const apiKey = process.env.REPLAY_ANALYSIS_API_KEY;
  const model = process.env.REPLAY_ANALYSIS_MODEL;
  if (!baseURL || !apiKey || !model) {
    throw new Error("缺少 REPLAY_ANALYSIS_BASE_URL/API_KEY/MODEL 环境变量");
  }
  const res = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: Number(process.env.REPLAY_ANALYSIS_TEMPERATURE ?? 0.2),
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`打分模型 ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? "";
  return JSON.parse(content);
}

/** 创建并跑完一局无头 debug 自动对局,返回 roomId + 结果快照。 */
export async function runOneGame({ discussionMinutes, timeoutMs = 12 * 60_000, log = () => {} }) {
  const client = io(API_BASE(), {
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
    transports: ["websocket"],
  });
  try {
    await connectOrThrow(client, 15_000);
    log("connected");

    const created = await emitAck(client, "debug.ai-room.create", {
      fastMode: true,
      ...(discussionMinutes ? { discussionDurationMinutes: discussionMinutes } : {}),
    });
    if (!created?.ok) throw new Error(`建房失败: ${created?.error ?? "?"}`);
    const { room, playerId } = created;
    const roomId = room.id;
    log(`room=${roomId}`);

    // 显式 observe 以加入房间,确保收到 room-scoped 广播(game.ended 等)。
    await emitAck(client, "room.observe", { roomId }).catch(() => {});

    const started = await emitAck(client, "game.start", { roomId, playerId });
    if (!started?.ok) throw new Error(`开局失败: ${started?.error ?? "?"}`);
    log("started");

    // 主用 HTTP 轮询(无状态、可靠);WS game.ended 作为加速路径。
    const snapshot = await waitForFinished(roomId, timeoutMs, client, log);
    return { roomId, winner: snapshot.winner, currentRound: snapshot.currentRound };
  } finally {
    client.disconnect();
  }
}

/** 以 HTTP 轮询为主检测对局结束,WS game.ended 作为加速。 */
async function waitForFinished(roomId, timeoutMs, client, log) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      client.off("game.ended");
      reject(new Error(`对局超时(${timeoutMs}ms): ${roomId}`));
    }, timeoutMs);

    // WS 加速路径
    client.on("game.ended", (snap) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log("ended(ws)");
      resolve(snap);
    });

    // HTTP 轮询主路径
    (async () => {
      let stuckSince = 0;
      while (!settled) {
        await sleep(3000);
        if (settled) break;
        try {
          const res = await fetch(`${API_BASE()}/rooms/${roomId}`);
          const json = await res.json();
          const room = json?.room;
          if (room?.status === "finished") {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            client.off("game.ended");
            log("ended(http)");
            resolve(room);
            return;
          }
          // 卡死检测:对局仍在进行但 phaseEndsAt 已过期超过 90s,
          // 多半是服务端进程重启导致内存定时器丢失(引擎固有脆弱点)。直接判失败。
          if (room?.status === "playing" && room.phaseEndsAt) {
            const overdueMs = Date.now() - new Date(room.phaseEndsAt).getTime();
            if (overdueMs > 90_000) {
              if (stuckSince === 0) {
                stuckSince = Date.now();
                log(`疑似卡死(phase=${room.phase}, 已过期 ${Math.round(overdueMs / 1000)}s),再观察 30s`);
              } else if (Date.now() - stuckSince > 30_000) {
                settled = true;
                clearTimeout(timer);
                client.off("game.ended");
                reject(new Error(`对局卡死(phase=${room.phase}, rnd=${room.currentRound}, phaseEndsAt 已过期);可能服务端重启导致定时器丢失`));
                return;
              }
            }
          }
        } catch {
          /* 瞬时失败,下一轮重试 */
        }
      }
    })().catch(() => {});
  });
}

function connectOrThrow(client, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (client.connected) return resolve();
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onErr = (err) => {
      cleanup();
      reject(new Error(`socket 连接失败: ${err?.message ?? err}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("socket 连接超时"));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      client.off("connect", onConnect);
      client.off("connect_error", onErr);
    }
    client.on("connect", onConnect);
    client.on("connect_error", onErr);
  });
}

/** 拉取某房间的服务端 replay 导出 JSON(含 promptGenerationId)。 */
export async function fetchReplayExport(roomId) {
  const res = await fetch(`${API_BASE()}/replay/${roomId}/export`);
  const json = await res.json();
  if (!json?.ok) throw new Error(`拉取 replay 失败 ${roomId}: ${json?.error}`);
  return json.data;
}

function emitAck(client, event, payload) {
  return new Promise((resolve, reject) => {
    client.timeout(20_000).emit(event, payload, (err, resp) => {
      if (err) reject(err);
      else resolve(resp);
    });
  });
}

/** 限制并发地跑任务。 */
export async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
