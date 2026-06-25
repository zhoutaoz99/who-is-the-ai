"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "./lib/auth-client";
import { useGameClient } from "./lib/game-client";
import { humanCount, statusLabel, winnerLabel } from "./lib/game-utils";

const API_URL =
  process.env.NEXT_PUBLIC_API_URL ||
  (typeof window !== "undefined"
    ? `${window.location.protocol}//${window.location.hostname}:3001`
    : "http://localhost:3001");

function IconPlus(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function IconArrowRight(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M5 12h14M12 5l7 7-7 7" />
    </svg>
  );
}

function IconRefresh(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
    </svg>
  );
}

function IconUsers(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function IconUser(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

function IconSettings(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function IconLogout(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}

function IconChevronDown(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function UserAvatar({ name }: { name: string }) {
  const colors = [
    { bg: "#e6f4f1", text: "#0f766e" },
    { bg: "#dbeafe", text: "#1d4ed8" },
    { bg: "#ede9fe", text: "#7c3aed" },
    { bg: "#fce7f3", text: "#db2777" },
    { bg: "#fee2e2", text: "#dc2626" },
    { bg: "#ffedd5", text: "#ea580c" },
    { bg: "#fef3c7", text: "#ca8a04" },
    { bg: "#dcfce7", text: "#16a34a" },
    { bg: "#cffafe", text: "#0891b2" },
    { bg: "#e0e7ff", text: "#4f46e5" },
  ];
  const hash = name.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const color = colors[hash % colors.length];
  const initial = name.charAt(0).toUpperCase();

  return (
    <div
      className="avatar-circle"
      style={{ background: color.bg, color: color.text }}
    >
      {initial}
    </div>
  );
}

function IconBot(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <rect x="3" y="11" width="18" height="10" rx="2" />
      <circle cx="12" cy="5" r="2" />
      <path d="M12 7v4" />
      <line x1="8" y1="16" x2="8" y2="16.01" />
      <line x1="16" y1="16" x2="16" y2="16.01" />
    </svg>
  );
}

function IconEmpty(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="48"
      height="48"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  );
}

function IconMonitor(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

export default function Home() {
  const router = useRouter();
  const { user, pending: authPending, logout } = useAuth();
  const {
    debug,
    connected,
    pending,
    error,
    rooms,
    playerName,
    roomCode,
    setPlayerName,
    setRoomCode,
    setError,
    refreshRooms,
    createRoom,
    joinRoom,
    deleteRoom,
  } = useGameClient();
  const lobbyDisabled = pending || authPending || !user;

  const ROOMS_PER_PAGE = 5;
  const [roomPage, setRoomPage] = useState(1);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [sandboxPending, setSandboxPending] = useState(false);
  const [sandboxExamples, setSandboxExamples] = useState<
    Array<{ id: string; label: string; form: string }>
  >([]);
  const [selectedScenarioId, setSelectedScenarioId] = useState("");

  useEffect(() => {
    if (!debug) return;
    fetch(`${API_URL}/sandbox/examples`)
      .then((r) => r.json())
      .then((d: { ok: boolean; examples?: Array<{ id: string; label: string; form: string }> }) => {
        if (d.ok && d.examples) {
          setSandboxExamples(d.examples);
          setSelectedScenarioId(d.examples[0]?.id ?? "");
        }
      })
      .catch(() => {});
  }, [debug]);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const refreshRoomsRef = useRef(refreshRooms);
  refreshRoomsRef.current = refreshRooms;

  // Refresh room list immediately on mount and every 3 seconds (silent: no UI state change)
  useEffect(() => {
    if (!connected) return;
    void refreshRoomsRef.current(true);
    refreshTimerRef.current = setInterval(() => void refreshRoomsRef.current(true), 3000);

    function handleVisibility() {
      if (document.visibilityState === "visible") void refreshRoomsRef.current(true);
    }
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [connected]);

  const sortedRooms = rooms
    .filter((room) => !(room.sandboxScenarioId && room.status === "waiting"))
    .sort((a, b) => {
    if (a.status === "finished" && b.status !== "finished") return 1;
    if (a.status !== "finished" && b.status === "finished") return -1;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

  const totalPages = Math.max(1, Math.ceil(sortedRooms.length / ROOMS_PER_PAGE));
  const paginatedRooms = sortedRooms.slice(
    (roomPage - 1) * ROOMS_PER_PAGE,
    roomPage * ROOMS_PER_PAGE,
  );

  useEffect(() => {
    setRoomPage(1);
  }, [rooms.length]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        userMenuRef.current &&
        !userMenuRef.current.contains(event.target as Node)
      ) {
        setUserMenuOpen(false);
      }
    }
    if (userMenuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [userMenuOpen]);

  useEffect(() => {
    if (user) {
      setPlayerName(user.displayName);
    }
  }, [setPlayerName, user]);

  async function handleLogout() {
    await logout();
    setError("请先登录账号");
  }

  async function handleCreateRoom() {
    if (!user) {
      setError("请先登录账号");
      return;
    }

    const result = await createRoom();
    if (result.ok && result.room) {
      router.push(`/room/${result.room.id}`);
    }
  }

  // 离线沙盒:按所选示例场景建一个等待中的沙盒房,跳到配置页(可改模型/时长后再开局)。
  async function handleRunSandbox() {
    setError("");
    setSandboxPending(true);
    try {
      const res = await fetch(`${API_URL}/sandbox/prepare`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(selectedScenarioId ? { scenario_id: selectedScenarioId } : {}),
      });
      const data: { ok: boolean; roomId?: string; error?: string } = await res.json();
      if (data.ok && data.roomId) {
        router.push(`/sandbox/${data.roomId}`);
      } else {
        setError(data.error ?? "沙盒房创建失败");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "沙盒请求失败");
    } finally {
      setSandboxPending(false);
    }
  }

  async function handleJoinRoom(roomId?: string) {
    if (!user) {
      setError("请先登录账号");
      return;
    }

    const result = await joinRoom(roomId);
    if (result.ok && result.room) {
      router.push(`/room/${result.room.id}`);
    }
  }

  return (
    <main className="shell lobby-shell">
      <header className="lobby-header">
        <div className="lobby-brand">
          <div className="lobby-logo" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              width="28"
              height="28"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
            </svg>
          </div>
          <div>
            <p className="eyebrow">Who's the AI</p>
            <h1>谁是AI</h1>
          </div>
        </div>
        <div className="topbar-actions">
          <div
            className={`connection-pill ${connected ? "online" : "offline"}`}
          >
            <span
              className={`status-dot ${connected ? "online" : "offline"}`}
            />
            {connected ? "已连接" : "未连接"}
          </div>
          <div className="user-actions-group">
            {user ? (
              <div className="user-dropdown" ref={userMenuRef}>
                <button
                  className="account-badge account-badge--clickable"
                  disabled={authPending}
                  onClick={() => setUserMenuOpen(!userMenuOpen)}
                >
                  <UserAvatar name={user.displayName} />
                  <span>{user.displayName}</span>
                  <IconChevronDown
                    width="14"
                    height="14"
                    className={`dropdown-chevron ${userMenuOpen ? "open" : ""}`}
                  />
                </button>
                {userMenuOpen && (
                  <div className="dropdown-menu">
                    <div className="dropdown-header">
                      <UserAvatar name={user.displayName} />
                      <div className="dropdown-header-info">
                        <span className="dropdown-header-name">{user.displayName}</span>
                        <span className="dropdown-header-username">@{user.username}</span>
                      </div>
                    </div>
                    <div className="dropdown-divider" />
                    <button
                      className="dropdown-item"
                      onClick={() => {
                        setUserMenuOpen(false);
                        router.push("/profile");
                      }}
                    >
                      <IconSettings width="16" height="16" />
                      个人信息
                    </button>
                    <button
                      className="dropdown-item"
                      onClick={() => {
                        setUserMenuOpen(false);
                        handleLogout();
                      }}
                    >
                      <IconLogout width="16" height="16" />
                      退出登录
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <button
                className="action-pill action-pill--primary"
                onClick={() => router.push("/account")}
              >
                登录 / 注册
              </button>
            )}
          </div>
        </div>
      </header>

      <section className="lobby-grid">
        <section className="panel lobby-card">
          <div className="lobby-card-header">
            <div className="lobby-icon create-icon" aria-hidden="true">
              <IconPlus />
            </div>
            <div>
              <p className="eyebrow">Create Room</p>
              <h2>创建房间</h2>
            </div>
          </div>

          <label className="field">
            <span>昵称</span>
            <input
              value={user?.displayName ?? playerName}
              disabled
              maxLength={16}
              placeholder="登录后使用账号昵称"
              onChange={() => undefined}
            />
          </label>

          {!user && (
            <button className="secondary" onClick={() => router.push("/account")}>
              先登录账号
            </button>
          )}

          <button disabled={lobbyDisabled} onClick={handleCreateRoom}>
            创建房间
          </button>

          {debug && (
            <div className="debug-auto-ai-entry">
              <div className="lobby-card-header">
                <div className="lobby-icon debug-ai-icon" aria-hidden="true">
                  <svg
                    viewBox="0 0 24 24"
                    width="20"
                    height="20"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                    <path d="M21 3v6h-6" />
                  </svg>
                </div>
                <div>
                  <p className="eyebrow">Auto Iteration</p>
                  <h2>自动对局评估自迭代</h2>
                </div>
              </div>
              <p className="muted-text">
                批量跑无头对局、量化打分,配合版本库迭代 AI 提示词。
              </p>
              <button
                className="secondary"
                onClick={() => router.push("/iteration")}
              >
                进入自动迭代
              </button>
            </div>
          )}

          {debug && (
            <div className="sandbox-entry">
              <div className="lobby-card-header">
                <div className="lobby-icon debug-ai-icon" aria-hidden="true">
                  <IconBot width="20" height="20" />
                </div>
                <div>
                  <p className="eyebrow">Offline Sandbox</p>
                  <h2>离线沙盒对局</h2>
                </div>
              </div>
              <p className="muted-text">
                按场景(被测 AI + 侦探 + 填充)配置一局,改完参数后开局并实时观战。
              </p>
              {sandboxExamples.length > 0 && (
                <select
                  className="debug-ai-select"
                  value={selectedScenarioId}
                  disabled={sandboxPending}
                  onChange={(e) => setSelectedScenarioId(e.target.value)}
                >
                  {sandboxExamples.map((ex) => (
                    <option key={ex.id} value={ex.id}>
                      {ex.label}
                    </option>
                  ))}
                </select>
              )}
              <button
                className="secondary"
                disabled={sandboxPending}
                onClick={handleRunSandbox}
              >
                {sandboxPending ? "创建中…" : "配置沙盒对局"}
              </button>
            </div>
          )}

          <div className="lobby-divider" />

          <div className="lobby-card-header" style={{ marginTop: 2 }}>
            <div className="lobby-icon join-icon" aria-hidden="true">
              <IconArrowRight />
            </div>
            <div>
              <p className="eyebrow">Join Room</p>
              <h2>加入房间</h2>
            </div>
          </div>

          <label className="field">
            <span>房间号</span>
            <input
              value={roomCode}
              placeholder="例如 A1B2C3"
              onChange={(event) =>
                setRoomCode(event.target.value.toUpperCase())
              }
            />
          </label>

          <button
            className="secondary"
            disabled={lobbyDisabled}
            onClick={() => handleJoinRoom()}
          >
            加入房间
          </button>

          {error && <p className="error">{error}</p>}
        </section>

        <section className="panel lobby-card lobby-rooms">
          <div className="section-heading-row">
            <div className="lobby-card-header">
              <div className="lobby-icon rooms-icon" aria-hidden="true">
                <IconMonitor />
              </div>
              <div>
                <p className="eyebrow">Rooms</p>
                <h2>最近房间</h2>
              </div>
            </div>
            <button
              className="compact-button refresh-button"
              disabled={pending}
              onClick={() => void refreshRooms()}
            >
              <IconRefresh
                style={{ verticalAlign: "middle", marginRight: 4 }}
              />
              刷新
            </button>
          </div>

          {sortedRooms.length === 0 ? (
            <div className="empty-rooms">
              <IconEmpty />
              <p>暂无可加入的房间</p>
              <p className="muted-text" style={{ fontSize: 13 }}>
                点击上方「创建房间」开始一局新游戏
              </p>
            </div>
          ) : (
            <>
              <div className="room-list no-border">
                {paginatedRooms.map((room) => {
                  const humans = humanCount(room);
                  const maxHumans = room.config.maxHumanPlayers;
                  const aiCount = room.config.aiPlayerCount;
                  const isSandboxRoom = Boolean(room.sandboxScenarioId);
                  const fillPercent =
                    maxHumans > 0 ? (humans / maxHumans) * 100 : 0;
                  return (
                    <button
                      className="room-row"
                      key={room.id}
                      data-status={room.status}
                      disabled={
                        room.status === "playing" && !isSandboxRoom
                      }
                      onClick={() => {
                        if (room.status === "finished") {
                          router.push(`/game/${room.id}`);
                        } else if (room.status === "playing" && isSandboxRoom) {
                          router.push(`/game/${room.id}`);
                        } else if (isSandboxRoom) {
                          router.push(`/room/${room.id}`);
                        } else {
                          handleJoinRoom(room.id);
                        }
                      }}
                    >
                      <div className="room-row-main">
                        <div className="room-row-info">
                          <div className="room-row-id">{room.id}</div>
                          <div className="room-row-meta">
                            <span className={`room-tag ${room.status}`}>
                              {statusLabel(room.status)}
                            </span>
                            {room.status === "finished" && room.winner && (
                              <span className="room-tag winner">
                                {isSandboxRoom && room.winner === "human"
                                  ? "模拟真人获胜"
                                  : isSandboxRoom && room.winner === "ai"
                                    ? "AI 获胜"
                                    : winnerLabel(room.winner)}
                              </span>
                            )}
                            {room.status === "finished" && !room.winner && (
                              <span className="room-tag terminated">
                                手动停止
                              </span>
                            )}
                            {room.status !== "finished" && (
                              <>
                                <span className="room-stat">
                                  <IconUsers width="12" height="12" />
                                  {humans}/{maxHumans}
                                </span>
                                <span className="room-stat">
                                  <IconBot width="12" height="12" />
                                  {aiCount} AI
                                </span>
                                <div className="player-bar-track">
                                  <div
                                    className="player-bar-fill"
                                    style={{ width: `${fillPercent}%` }}
                                  />
                                </div>
                              </>
                            )}
                          </div>
                        </div>
                        {room.status === "waiting" && (
                          <div className="replay-room-actions">
                            <span className="room-join-hint">
                              {isSandboxRoom ? "管理 →" : "加入 →"}
                            </span>
                            {debug && (
                              <span
                                role="button"
                                tabIndex={0}
                                className="delete-link-btn"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (confirm("确定删除该房间？")) {
                                    void deleteRoom(room.id);
                                  }
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    e.stopPropagation();
                                    if (confirm("确定删除该房间？")) {
                                      void deleteRoom(room.id);
                                    }
                                  }
                                }}
                              >
                                删除
                              </span>
                            )}
                          </div>
                        )}
                        {room.status === "playing" && (
                          <div className="replay-room-actions">
                            {isSandboxRoom && (
                              <span className="room-join-hint">观察 →</span>
                            )}
                            {debug && (
                              <span
                                role="button"
                                tabIndex={0}
                                className="delete-link-btn"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (confirm("确定删除该房间？")) {
                                    void deleteRoom(room.id);
                                  }
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    e.stopPropagation();
                                    if (confirm("确定删除该房间？")) {
                                      void deleteRoom(room.id);
                                    }
                                  }
                                }}
                              >
                                删除
                              </span>
                            )}
                          </div>
                        )}
                        {room.status === "finished" && (
                          <div className="replay-room-actions">
                            <span className="replay-link-btn">对局记录 →</span>
                            {room.debug && (
                              <span
                                role="button"
                                tabIndex={0}
                                className="replay-link-btn"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  router.push(`/replay/${room.id}`);
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    e.stopPropagation();
                                    router.push(`/replay/${room.id}`);
                                  }
                                }}
                              >
                                复盘
                              </span>
                            )}
                            {debug && (
                              <span
                                role="button"
                                tabIndex={0}
                                className="delete-link-btn"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (confirm("确定删除该房间？")) {
                                    void deleteRoom(room.id);
                                  }
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    e.stopPropagation();
                                    if (confirm("确定删除该房间？")) {
                                      void deleteRoom(room.id);
                                    }
                                  }
                                }}
                              >
                                删除
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>

              {totalPages > 1 && (
                <div className="pagination-bar">
                  <button
                    className="page-btn"
                    disabled={roomPage <= 1}
                    onClick={() => setRoomPage((p) => Math.max(1, p - 1))}
                    aria-label="上一页"
                  >
                    ← 上一页
                  </button>
                  <div className="page-numbers">
                    {Array.from({ length: totalPages }, (_, i) => i + 1).map(
                      (page) => (
                        <button
                          key={page}
                          className={`page-num ${page === roomPage ? "active" : ""}`}
                          onClick={() => setRoomPage(page)}
                          aria-label={`第 ${page} 页`}
                        >
                          {page}
                        </button>
                      ),
                    )}
                  </div>
                  <button
                    className="page-btn"
                    disabled={roomPage >= totalPages}
                    onClick={() =>
                      setRoomPage((p) => Math.min(totalPages, p + 1))
                    }
                    aria-label="下一页"
                  >
                    下一页 →
                  </button>
                </div>
              )}

              <div className="room-list-footer">
                共 {sortedRooms.length} 个房间
                {totalPages > 1 && ` · 第 ${roomPage}/${totalPages} 页`}
              </div>
            </>
          )}
        </section>
      </section>
    </main>
  );
}
