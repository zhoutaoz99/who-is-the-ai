"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "../../lib/auth-client";
import { useGameClient } from "../../lib/game-client";
import { humanCount, statusLabel } from "../../lib/game-utils";
import { useRoomReconnect } from "../../lib/use-room-reconnect";

function IconCrown(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path d="M5 16L3 5l5.5 5L12 4l3.5 6L21 5l-2 11H5z" />
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

function IconUsers(props: React.SVGProps<SVGSVGElement>) {
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
      width="16"
      height="16"
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

function IconClock(props: React.SVGProps<SVGSVGElement>) {
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
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function IconRounds(props: React.SVGProps<SVGSVGElement>) {
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
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}

function IconArrowLeft(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M19 12H5M12 19l-7-7 7-7" />
    </svg>
  );
}

function IconPlay(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="currentColor"
      {...props}
    >
      <path d="M5 3l14 9-14 9V3z" />
    </svg>
  );
}

function IconWifiOff(props: React.SVGProps<SVGSVGElement>) {
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
      <line x1="1" y1="1" x2="23" y2="23" />
      <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55M5 12.55a10.94 10.94 0 0 1 5.17-2.39M10.71 5.05A16 16 0 0 1 22.58 9M1.42 9a15.91 15.91 0 0 1 4.7-2.88M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01" />
    </svg>
  );
}

function IconDoorOpen(props: React.SVGProps<SVGSVGElement>) {
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
      <path d="M13 4H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8" />
      <path d="M13 4V2l5 5h-4a1 1 0 0 1-1-1z" />
      <path d="M9 15l-2-2 2-2" />
    </svg>
  );
}

export default function WaitingRoomPage() {
  const params = useParams<{ roomId: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const roomId = params.roomId.toUpperCase();
  const {
    connected,
    pending,
    error,
    playerName,
    setPlayerName,
    setError,
    getRoom,
    getPlayerId,
    joinRoom,
    leaveRoom,
    reconnectRoom,
    startGame,
  } = useGameClient();

  const room = getRoom(roomId);
  const playerId = getPlayerId(roomId);
  const isOwner = Boolean(
    room && playerId && room.ownerPlayerId === playerId,
  );
  const isJoined = Boolean(playerId);
  const isDisconnected = Boolean(
    playerId && room?.players.find((p) => p.id === playerId && !p.connected),
  );

  useEffect(() => {
    if (room?.status === "playing") {
      router.replace(`/game/${room.id}`);
    }
  }, [room?.id, room?.status, router]);

  useEffect(() => {
    if (user) {
      setPlayerName(user.displayName);
    }
  }, [setPlayerName, user]);

  useRoomReconnect({ connected, roomId, getPlayerId, reconnectRoom });

  async function handleJoinRoom() {
    if (!user) {
      setError("请先登录账号");
      return;
    }

    const result = await joinRoom(roomId);
    if (result.ok && result.room?.status === "playing") {
      router.replace(`/game/${result.room.id}`);
    }
  }

  async function handleLeaveRoom() {
    if (isJoined) {
      await leaveRoom(roomId);
    }
    router.push("/");
  }

  async function handleStartGame() {
    if (!room) {
      return;
    }
    const result = await startGame(room.id);
    if (result.ok && result.room) {
      router.replace(`/game/${result.room.id}`);
    }
  }

  return (
    <main className="shell waiting-shell">
      <header className="lobby-header">
        <div className="lobby-brand">
          <button
            className="logo-back"
            onClick={() => router.push("/")}
            aria-label="返回大厅"
          >
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
            <p className="eyebrow">Waiting Room</p>
            <h1>房间 {roomId}</h1>
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
          {!user && (
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

      {!room ? (
        <section className="panel waiting-card waiting-join">
          <div className="waiting-join-hero">
            <div className="join-icon-circle">
              <IconDoorOpen width="32" height="32" />
            </div>
            <h2>加入等待房间</h2>
            <p className="muted-text">
              房间 {roomId} 正在等待玩家加入，快来一起游戏吧！
            </p>
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

          <button
            className="primary-action"
            disabled={pending || !user}
            onClick={handleJoinRoom}
          >
            加入房间
          </button>

          {!user && (
            <button className="secondary" onClick={() => router.push("/account")}>
              先登录账号
            </button>
          )}

          {error && <p className="error">{error}</p>}

          <button className="secondary" onClick={() => router.push("/")}>
            <IconArrowLeft
              width="16"
              height="16"
              style={{ verticalAlign: "middle", marginRight: 6 }}
            />
            返回大厅
          </button>
        </section>
      ) : (
        <section className="waiting-layout">
          <div className="panel waiting-card">
            <div className="room-status-header">
              <span className={`room-status-badge ${room.status}`}>
                {statusLabel(room.status)}
              </span>
            </div>

            <div className="room-code-display">
              <span>房间号</span>
              <strong>{room.id}</strong>
            </div>

            <div className="waiting-stats waiting-stats-grid">
              <div className="stat-card">
                <IconUsers
                  width="18"
                  height="18"
                  style={{ color: "var(--accent)" }}
                />
                <span>真人玩家</span>
                <strong>
                  {humanCount(room)}/{room.config.maxHumanPlayers}
                </strong>
              </div>
              <div className="stat-card">
                <IconBot
                  width="18"
                  height="18"
                  style={{ color: "#2563eb" }}
                />
                <span>AI 玩家</span>
                <strong>{room.config.aiPlayerCount}</strong>
              </div>
              <div className="stat-card">
                <IconRounds
                  width="18"
                  height="18"
                  style={{ color: "#7c3aed" }}
                />
                <span>总轮数</span>
                <strong>{room.config.maxRounds}</strong>
              </div>
              <div className="stat-card">
                <IconClock
                  width="18"
                  height="18"
                  style={{ color: "#b54708" }}
                />
                <span>发言时间</span>
                <strong>
                  {Math.round(room.config.discussionDurationMs / 60_000)} 分钟
                </strong>
              </div>
            </div>

            {isDisconnected && (
              <div className="reconnect-toast">
                <span className="spinner" />
                正在重新连接...
              </div>
            )}

            {!isJoined && !isDisconnected && (
              <div className="waiting-actions-group">
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
                <button
                  className="primary-action"
                  disabled={pending || !user}
                  onClick={handleJoinRoom}
                >
                  加入房间
                </button>
                {!user && (
                  <button
                    className="secondary"
                    onClick={() => router.push("/account")}
                  >
                    先登录账号
                  </button>
                )}
              </div>
            )}

            {isJoined && isOwner && (
              <div className="waiting-actions-group">
                <button
                  className="primary-action start-game-btn"
                  disabled={!room.canStart || pending}
                  onClick={handleStartGame}
                >
                  <IconPlay
                    width="20"
                    height="20"
                    style={{ verticalAlign: "middle", marginRight: 8 }}
                  />
                  开始游戏
                </button>
                {!room.canStart && (
                  <p className="muted-text canstart-hint">
                    等待更多玩家加入后才能开始
                  </p>
                )}
              </div>
            )}

            {isJoined && !isOwner && (
              <div className="waiting-hint-box">
                <span className="spinner" />
                等待房主开始游戏
              </div>
            )}

            {error && <p className="error">{error}</p>}

            <button
              className="secondary leave-btn"
              disabled={pending}
              onClick={handleLeaveRoom}
            >
              <IconArrowLeft
                width="16"
                height="16"
                style={{ verticalAlign: "middle", marginRight: 6 }}
              />
              返回大厅
            </button>
          </div>

          <div className="panel waiting-card">
            <div className="section-heading-row">
              <div className="lobby-card-header">
                <div className="lobby-icon players-icon" aria-hidden="true">
                  <IconUsers width="20" height="20" />
                </div>
                <div>
                  <p className="eyebrow">Players</p>
                  <h2>玩家列表</h2>
                </div>
              </div>
              <div className="player-count-badge">
                {room.players.length} 人
              </div>
            </div>

            <div className="waiting-player-list">
              {room.players.map((player, index) => {
                const isSelf = player.id === playerId;
                const isRoomOwner = player.id === room.ownerPlayerId;
                const seatBgColors = [
                  "#0f766e",
                  "#2563eb",
                  "#7c3aed",
                  "#b42318",
                  "#b54708",
                  "#047857",
                  "#0369a1",
                  "#4338ca",
                ];
                const seatBg =
                  seatBgColors[(player.seatNo - 1) % seatBgColors.length];

                return (
                  <div
                    className={`player-row waiting-player-row ${isSelf ? "is-self" : ""} ${!player.connected ? "is-offline" : ""}`}
                    key={player.id}
                    style={{ animationDelay: `${index * 0.05}s` }}
                  >
                    <div
                      className="player-avatar"
                      style={{ backgroundColor: seatBg }}
                    >
                      {player.seatNo}
                    </div>
                    <div className="player-row-body">
                      <div className="player-row-name">
                        <strong>{player.name}</strong>
                        {isSelf && <span className="self">你</span>}
                        {isRoomOwner && (
                          <span className="owner-badge">
                            <IconCrown
                              width="12"
                              height="12"
                              style={{ verticalAlign: "middle", marginRight: 3 }}
                            />
                            房主
                          </span>
                        )}
                      </div>
                      <div className="player-row-status">
                        {player.status === "alive" ? (
                          <span className="alive">待命</span>
                        ) : (
                          <span className="dead">出局</span>
                        )}
                        {!player.connected && (
                          <span className="muted offline-badge">
                            <IconWifiOff
                              width="10"
                              height="10"
                              style={{ verticalAlign: "middle", marginRight: 3 }}
                            />
                            离线
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}

              {Array.from({
                length: Math.max(
                  0,
                  room.config.maxHumanPlayers -
                    room.players.length,
                ),
              }).map((_, i) => (
                <div
                  className="player-row waiting-player-row is-empty"
                  key={`empty-${i}`}
                >
                  <div className="player-avatar empty-avatar">
                    <IconUser width="16" height="16" />
                  </div>
                  <div className="player-row-body">
                    <span className="muted-text" style={{ fontSize: 14 }}>
                      虚位以待
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}
    </main>
  );
}
