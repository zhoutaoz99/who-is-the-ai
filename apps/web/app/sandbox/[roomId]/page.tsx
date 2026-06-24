"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useGameClient } from "../../lib/game-client";
import type { RoomSnapshot } from "../../lib/game-types";

const API_URL =
  process.env.NEXT_PUBLIC_API_URL ||
  (typeof window !== "undefined"
    ? `${window.location.protocol}//${window.location.hostname}:3001`
    : "http://localhost:3001");

type Role = "ai_under_test" | "detective" | "filler";

interface RosterEntry {
  slot: number;
  role: Role;
  persona_id: string;
  temperature?: number;
  base_intent?: string;
}

interface SandboxConfig {
  scenario_id: string;
  seed: number;
  mode: string;
  vote_policy: string;
  form: string;
  ai_under_test_slot: number;
  prompt_version_id: string;
  roster: RosterEntry[];
  intent_schedule: Array<{ round: number; slot: number; intent: string }>;
}

const ROLE_LABEL: Record<Role, string> = {
  ai_under_test: "被测 AI",
  detective: "侦探",
  filler: "填充",
};

const ROLE_STYLE: Record<Role, React.CSSProperties> = {
  ai_under_test: { background: "#fee2e2", color: "#b42318" },
  detective: { background: "#dbeafe", color: "#1d4ed8" },
  filler: { background: "#f3f4f6", color: "#6b7280" },
};

const SEAT_BG = [
  "#0f766e",
  "#2563eb",
  "#7c3aed",
  "#b42318",
  "#b54708",
  "#047857",
];

export default function SandboxConfigPage() {
  const params = useParams<{ roomId: string }>();
  const router = useRouter();
  const roomId = params.roomId.toUpperCase();

  const {
    connected,
    pending,
    error,
    setError,
    getRoom,
    fetchRoom,
    updateDiscussionDuration,
    updateDebugModel,
    deleteDebugAutoAiRoom,
  } = useGameClient();

  const [config, setConfig] = useState<SandboxConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [durationMin, setDurationMin] = useState(1);
  const lastSyncedDurationRef = useRef<number | null>(null);

  const room = getRoom(roomId);

  // 拉取房间快照(socket observe,后续编辑/状态变更实时更新)。
  useEffect(() => {
    void fetchRoom(roomId);
  }, [roomId, fetchRoom]);

  // 拉取场景静态配置。
  useEffect(() => {
    let cancelled = false;
    setConfigError(null);
    fetch(`${API_URL}/sandbox/${roomId}/config`)
      .then((res) => res.json())
      .then((data: { ok: boolean; config?: SandboxConfig; error?: string }) => {
        if (cancelled) return;
        if (data.ok && data.config) {
          setConfig(data.config);
        } else {
          setConfigError(data.error ?? "加载场景配置失败");
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setConfigError(err instanceof Error ? err.message : "请求失败");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [roomId]);

  // 讨论时长:随房间快照同步本地草稿。
  useEffect(() => {
    if (!room) return;
    const minutes = Math.max(1, Math.round(room.config.discussionDurationMs / 60_000));
    lastSyncedDurationRef.current = minutes;
    setDurationMin(minutes);
  }, [room?.id, room?.config.discussionDurationMs]);

  // 讨论时长:草稿变化时提交(防抖)。
  useEffect(() => {
    if (!room || room.status !== "waiting") return;
    const minutes = Math.max(1, Math.floor(durationMin));
    if (lastSyncedDurationRef.current === minutes) return;
    const timer = window.setTimeout(() => {
      void updateDiscussionDuration(room.id, minutes).then((result) => {
        if (result.ok) lastSyncedDurationRef.current = minutes;
      });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [durationMin, room, updateDiscussionDuration]);

  // 对局已开始 → 跳观战页。
  useEffect(() => {
    if (room?.status === "playing" || room?.status === "finished") {
      router.replace(`/game/${room.id}`);
    }
  }, [room?.id, room?.status, router]);

  async function handleStart() {
    if (!room) return;
    setStarting(true);
    setError("");
    try {
      const res = await fetch(`${API_URL}/sandbox/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomId: room.id }),
      });
      const data: { ok: boolean; error?: string } = await res.json();
      if (data.ok) {
        router.replace(`/game/${room.id}`);
      } else {
        setError(data.error ?? "开局失败");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "开局请求失败");
    } finally {
      setStarting(false);
    }
  }

  async function handleBackToLobby() {
    if (room?.debugAutoAi && room.status === "waiting") {
      await deleteDebugAutoAiRoom(room.id);
    }
    router.push("/");
  }

  const models = room?.config.availableModels ?? [];
  const defaultModelId = models.find((m) => m.default)?.id ?? models[0]?.id ?? "";

  // roster(slot=座位号) 与房间 players(按 seatNo) 合并,取实时模型/人格/玩家 id。
  const rosterRows = (config?.roster ?? [])
    .slice()
    .sort((a, b) => a.slot - b.slot)
    .map((entry) => {
      const player = room?.players.find((p) => p.seatNo === entry.slot) ?? null;
      return { entry, player };
    });

  return (
    <main className="shell waiting-shell">
      <header className="lobby-header">
        <div className="lobby-brand">
          <button className="logo-back" onClick={handleBackToLobby} aria-label="返回大厅">
            <svg
              viewBox="0 0 24 24"
              width="22"
              height="22"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
            </svg>
          </button>
          <div>
            <p className="eyebrow">Offline Sandbox</p>
            <h1>沙盒对局配置 · {roomId}</h1>
          </div>
        </div>
        <div className={`connection-pill ${connected ? "online" : "offline"}`}>
          <span className={`status-dot ${connected ? "online" : "offline"}`} />
          {connected ? "已连接" : "未连接"}
        </div>
      </header>

      {configError ? (
        <section className="panel waiting-card">
          <p className="error">{configError}</p>
          <button className="secondary" onClick={() => router.push("/")}>
            返回大厅
          </button>
        </section>
      ) : !config || !room ? (
        <section className="panel waiting-card">
          <p className="muted-text">加载场景配置…</p>
        </section>
      ) : (
        <section className="waiting-layout">
          <div className="panel waiting-card">
            <div className="room-code-display">
              <span>场景</span>
              <strong>{config.scenario_id}</strong>
            </div>

            <div className="waiting-stats waiting-stats-grid">
              <div className="stat-card">
                <span>形态</span>
                <strong>{config.form === "full_match" ? "整局" : config.form}</strong>
              </div>
              <div className="stat-card">
                <span>模式</span>
                <strong>{config.mode === "scripted_intent" ? "固定剧本" : config.mode}</strong>
              </div>
              <div className="stat-card">
                <span>投票</span>
                <strong>{config.vote_policy === "live" ? "live 真投" : config.vote_policy}</strong>
              </div>
              <div className="stat-card">
                <span>种子</span>
                <strong>{config.seed}</strong>
              </div>
              <div className="stat-card">
                <span>被测 AI</span>
                <strong>{config.ai_under_test_slot}号</strong>
              </div>
              <div className="stat-card">
                <span>提示词版本</span>
                <strong>{config.prompt_version_id}</strong>
              </div>
            </div>

            <div className="waiting-actions-group">
              <button
                className="primary-action start-game-btn"
                disabled={!room.canStart || starting || pending}
                onClick={handleStart}
              >
                {starting ? "开局中…" : "开始对局"}
              </button>
              {!room.canStart && (
                <p className="muted-text canstart-hint">需要至少 1 名 AI 和 1 名模拟真人</p>
              )}

              {room.status === "waiting" && (
                <div className="debug-room-settings">
                  <label className="field">
                    <span>每轮发言时间（分钟）</span>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={durationMin}
                      disabled={pending}
                      onChange={(e) =>
                        setDurationMin(Math.max(1, Number(e.target.value) || 1))
                      }
                    />
                  </label>
                </div>
              )}
            </div>

            {error && <p className="error">{error}</p>}

            <button className="secondary leave-btn" disabled={pending} onClick={handleBackToLobby}>
              返回大厅
            </button>
          </div>

          <div className="panel waiting-card">
            <div className="section-heading-row">
              <div className="lobby-card-header">
                <div className="lobby-icon players-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                  </svg>
                </div>
                <div>
                  <p className="eyebrow">Roster</p>
                  <h2>阵容（按玩家编号）</h2>
                </div>
              </div>
              <div className="player-count-badge">{rosterRows.length} 人</div>
            </div>

            <div className="waiting-player-list">
              {rosterRows.map(({ entry, player }) => {
                const seatBg = SEAT_BG[(entry.slot - 1) % SEAT_BG.length];
                const isAiUnderTest = entry.role === "ai_under_test";
                const liveModel = player?.aiModelId || defaultModelId;
                return (
                  <div
                    className={`player-row waiting-player-row ${isAiUnderTest ? "is-ai" : "is-simulated-human"}`}
                    key={entry.slot}
                  >
                    <div className="player-avatar" style={{ backgroundColor: seatBg }}>
                      {entry.slot}
                    </div>
                    <div className="player-row-body">
                      <div className="player-row-name">
                        <strong>{player?.name ?? `${entry.slot}号`}</strong>
                        <span className="identity-tag" style={ROLE_STYLE[entry.role]}>
                          {ROLE_LABEL[entry.role]}
                        </span>
                        {player?.aiPersonaName && (
                          <span className="waiting-persona-tag">{player.aiPersonaName}</span>
                        )}
                        {entry.temperature != null && (
                          <span className="waiting-persona-tag model-tag">
                            temp {entry.temperature}
                          </span>
                        )}
                        {models.length > 0 && player ? (
                          <select
                            className="debug-ai-select debug-model-inline"
                            value={liveModel}
                            disabled={pending}
                            onChange={(e) => {
                              if (player) void updateDebugModel(room.id, player.id, e.target.value);
                            }}
                          >
                            {models.map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.id}
                                {m.default ? " *" : ""}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="waiting-persona-tag model-tag">{liveModel || "默认"}</span>
                        )}
                      </div>
                      {entry.base_intent && (
                        <div className="player-row-status">
                          <span className="muted-text" style={{ fontSize: 13 }}>
                            立场：{entry.base_intent}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {config.intent_schedule.length > 0 && (
              <>
                <div className="section-heading-row" style={{ marginTop: 16 }}>
                  <div className="lobby-card-header">
                    <div>
                      <p className="eyebrow">Intent Schedule</p>
                      <h2>逐轮意图（剧本）</h2>
                    </div>
                  </div>
                </div>
                <div className="waiting-player-list">
                  {config.intent_schedule
                    .slice()
                    .sort((a, b) => a.round - b.round || a.slot - b.slot)
                    .map((d, i) => (
                      <div className="player-row waiting-player-row" key={i}>
                        <div className="player-avatar" style={{ backgroundColor: SEAT_BG[(d.slot - 1) % SEAT_BG.length] }}>
                          {d.slot}
                        </div>
                        <div className="player-row-body">
                          <div className="player-row-name">
                            <strong>第 {d.round} 轮 · {d.slot}号</strong>
                          </div>
                          <div className="player-row-status">
                            <span className="muted-text" style={{ fontSize: 13 }}>{d.intent}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                </div>
              </>
            )}
          </div>
        </section>
      )}
    </main>
  );
}
