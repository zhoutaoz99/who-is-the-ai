"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "./lib/auth-client";
import { useGameClient } from "./lib/game-client";
import { humanCount, statusLabel, winnerLabel } from "./lib/game-utils";

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
    connected,
    pending,
    error,
    rooms,
    playerName,
    roomCode,
    discussionMinutes,
    setPlayerName,
    setRoomCode,
    setDiscussionMinutes,
    setError,
    refreshRooms,
    createRoom,
    joinRoom,
  } = useGameClient();
  const lobbyDisabled = pending || authPending || !user;

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
            <p className="eyebrow">AI Werewolf MVP</p>
            <h1>AI 狼人杀</h1>
          </div>
        </div>
        <div className="topbar-actions">
          {user && (
            <div className="status account-status">
              <IconUsers
                width="14"
                height="14"
                style={{ marginRight: 6, verticalAlign: "middle" }}
              />
              {user.displayName}
            </div>
          )}
          {user ? (
            <>
              <button
                className="compact-button"
                disabled={authPending}
                onClick={() => router.push("/profile")}
              >
                个人信息
              </button>
              <button
                className="compact-button"
                disabled={authPending}
                onClick={handleLogout}
              >
                退出
              </button>
            </>
          ) : (
            <button
              className="compact-button"
              onClick={() => router.push("/account")}
            >
              登录 / 注册
            </button>
          )}
          <div className={connected ? "status online" : "status offline"}>
            <span
              className={`status-dot ${connected ? "online" : "offline"}`}
            />
            {connected ? "后端已连接" : "后端未连接"}
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

          <label className="field">
            <span>每轮发言时间（分钟）</span>
            <input
              type="number"
              min={1}
              step={1}
              value={discussionMinutes}
              onChange={(event) =>
                setDiscussionMinutes(Math.max(1, Number(event.target.value) || 1))
              }
            />
          </label>

          <button disabled={lobbyDisabled} onClick={handleCreateRoom}>
            创建房间
          </button>

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

          {rooms.length === 0 ? (
            <div className="empty-rooms">
              <IconEmpty />
              <p>暂无可加入的房间</p>
              <p className="muted-text" style={{ fontSize: 13 }}>
                点击上方「创建房间」开始一局新游戏
              </p>
            </div>
          ) : (
            <div className="room-list no-border">
              {[...rooms]
                .sort((a, b) => {
                  if (a.status === "finished" && b.status !== "finished")
                    return 1;
                  if (a.status !== "finished" && b.status === "finished")
                    return -1;
                  return 0;
                })
                .map((room) => {
                  const humans = humanCount(room);
                  const maxHumans = room.config.maxHumanPlayers;
                  const aiCount = room.config.aiPlayerCount;
                  const fillPercent =
                    maxHumans > 0 ? (humans / maxHumans) * 100 : 0;
                  return (
                    <button
                      className="room-row"
                      key={room.id}
                      data-status={room.status}
                      disabled={room.status !== "waiting" || lobbyDisabled}
                      onClick={() => handleJoinRoom(room.id)}
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
                                {winnerLabel(room.winner)}
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
                          <span className="room-join-hint">加入 →</span>
                        )}
                      </div>
                    </button>
                  );
                })}
            </div>
          )}
        </section>
      </section>
    </main>
  );
}
