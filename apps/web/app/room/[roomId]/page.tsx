"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
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

function IconTrash(props: React.SVGProps<SVGSVGElement>) {
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
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M19 6l-1 16H6L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
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

export default function WaitingRoomPage() {
  const params = useParams<{ roomId: string }>();
  const router = useRouter();
  const { user, pending: authPending, logout } = useAuth();
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
    addDebugAi,
    removeDebugAi,
    updateDebugModel,
    deleteDebugAutoAiRoom,
    updateDiscussionDuration,
    updateDebugAutoAiFastMode,
  } = useGameClient();

  const room = getRoom(roomId);
  const playerId = getPlayerId(roomId);
  const isDebugAutoAiRoom = Boolean(room?.debugAutoAi);
  const personaOptions = room?.config.aiPersonas ?? [];
  const modelOptions = room?.config.availableModels ?? [];
  const defaultModelId = modelOptions.find((m) => m.default)?.id ?? modelOptions[0]?.id ?? "";
  const usedAiPersonaIds = new Set(
    room?.players.flatMap((player) =>
      player.aiPersonaId ? [player.aiPersonaId] : [],
    ) ?? [],
  );
  const debugAiPlayers =
    room?.players.filter((player) => player.revealedType === "ai") ?? [];
  const debugSimulatedHumanPlayers =
    room?.players.filter(
      (player) => player.revealedType === "human" && player.simulated,
    ) ?? [];
  const debugAiCount = debugAiPlayers.length;
  const debugSimulatedHumanCount = debugSimulatedHumanPlayers.length;
  const canAddDebugAi =
    isDebugAutoAiRoom || debugAiCount < (room?.config.aiPlayerCount ?? 0);
  const isOwner = Boolean(
    room && playerId && room.ownerPlayerId === playerId,
  );
  const canControlRoom = Boolean(
    room && (isOwner || (room.debug && isDebugAutoAiRoom)),
  );
  const canEditDiscussionDuration = Boolean(
    room?.status === "waiting" && canControlRoom,
  );
  const canManageDebugAi = Boolean(
    room?.debug && room.status === "waiting" && canControlRoom,
  );
  const isJoined = Boolean(playerId && !isDebugAutoAiRoom);
  const isDisconnected = Boolean(
    playerId &&
      !isDebugAutoAiRoom &&
      room?.players.find((p) => p.id === playerId && !p.connected),
  );
  const [selectedPersonaId, setSelectedPersonaId] = useState("");
  const [selectedModelId, setSelectedModelId] = useState("");

  useEffect(() => {
    if (!selectedModelId && defaultModelId) {
      setSelectedModelId(defaultModelId);
    }
  }, [selectedModelId, defaultModelId]);

  const [selectedDebugPlayerType, setSelectedDebugPlayerType] =
    useState<"ai" | "human">("ai");
  const isAddingDebugAi = selectedDebugPlayerType === "ai";
  const availablePersonaOptions = isDebugAutoAiRoom
    ? personaOptions
    : personaOptions.filter((persona) => !usedAiPersonaIds.has(persona.id));
  const selectedDebugPersonaId =
    isAddingDebugAi &&
    canAddDebugAi &&
    selectedPersonaId &&
    (isDebugAutoAiRoom || !usedAiPersonaIds.has(selectedPersonaId))
      ? selectedPersonaId
      : (canAddDebugAi ? (availablePersonaOptions[0]?.id ?? "") : "");
  const [discussionMinutesDraft, setDiscussionMinutesDraft] = useState(1);
  const lastSyncedDiscussionMinutesRef = useRef<number | null>(null);

  useEffect(() => {
    if (!room) {
      return;
    }

    const minutes = Math.max(
      1,
      Math.round(room.config.discussionDurationMs / 60_000),
    );
    lastSyncedDiscussionMinutesRef.current = minutes;
    setDiscussionMinutesDraft(minutes);
  }, [room?.id, room?.config.discussionDurationMs]);

  useEffect(() => {
    const targetRoomId = room?.id;
    if (!targetRoomId || !canEditDiscussionDuration) {
      return;
    }

    const minutes = Math.max(1, Math.floor(discussionMinutesDraft));
    if (lastSyncedDiscussionMinutesRef.current === minutes) {
      return;
    }

    const timer = window.setTimeout(() => {
      void updateDiscussionDuration(targetRoomId, minutes).then((result) => {
        if (result.ok) {
          lastSyncedDiscussionMinutesRef.current = minutes;
        }
      });
    }, 350);

    return () => window.clearTimeout(timer);
  }, [
    canEditDiscussionDuration,
    discussionMinutesDraft,
    room?.id,
    updateDiscussionDuration,
  ]);

  function handleUpdateFastMode(nextFastMode: boolean) {
    if (!room || !canEditDiscussionDuration || !isDebugAutoAiRoom) {
      return;
    }

    void updateDebugAutoAiFastMode(room.id, nextFastMode);
  }

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

  useRoomReconnect({
    connected,
    disabled: !room || isDebugAutoAiRoom,
    roomId,
    getPlayerId,
    reconnectRoom,
  });

  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

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

  async function handleLogout() {
    await logout();
    setError("请先登录账号");
  }

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

  async function handleReturnToLobby() {
    if (room?.debugAutoAi && room.status === "waiting") {
      await deleteDebugAutoAiRoom(room.id);
    } else if (isJoined && !room?.debugAutoAi) {
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

  async function handleAddDebugAi() {
    if (!room) {
      return;
    }
    if (selectedDebugPlayerType === "ai" && !selectedDebugPersonaId) {
      return;
    }

    await addDebugAi(
      room.id,
      selectedDebugPlayerType,
      selectedDebugPlayerType === "ai" ? selectedDebugPersonaId : undefined,
      selectedModelId || undefined,
    );
  }

  async function handleRemoveDebugAi(aiPlayerId: string) {
    if (!room) {
      return;
    }
    await removeDebugAi(room.id, aiPlayerId);
  }

  return (
    <main className="shell waiting-shell">
      <header className="lobby-header">
        <div className="lobby-brand">
          <button
            className="logo-back"
            onClick={handleReturnToLobby}
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
                <span>{room.debugAutoAi ? "模拟真人" : "真人玩家"}</span>
                <strong>
                  {room.debugAutoAi
                    ? debugSimulatedHumanCount
                    : `${humanCount(room)}/${room.config.maxHumanPlayers}`}
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

            {!isJoined && !isDisconnected && !isDebugAutoAiRoom && (
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

            {canControlRoom && (
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
                    {isDebugAutoAiRoom
                      ? "需要至少 1 名 AI 和 1 名模拟真人"
                      : "等待更多玩家加入后才能开始"}
                  </p>
                )}
                {canEditDiscussionDuration && (
                  <div className="debug-room-settings">
                    <label className="field">
                      <span>每轮发言时间（分钟）</span>
                      <input
                        type="number"
                        min={1}
                        step={1}
                        value={discussionMinutesDraft}
                        disabled={pending}
                        onChange={(event) =>
                          setDiscussionMinutesDraft(
                            Math.max(1, Number(event.target.value) || 1),
                          )
                        }
                      />
                    </label>
                    {isDebugAutoAiRoom && (
                      <label className="debug-fast-mode-toggle">
                        <input
                          type="checkbox"
                          checked={room.debugAutoAiFastMode === true}
                          disabled={pending}
                          onChange={(event) =>
                            handleUpdateFastMode(event.target.checked)
                          }
                        />
                        <span>快速模式</span>
                      </label>
                    )}
                  </div>
                )}
                {canManageDebugAi && personaOptions.length > 0 && (
                  <div className="debug-ai-controls">
                    <div className="debug-ai-header">
                      <span>调试玩家</span>
                      <strong>
                        {isDebugAutoAiRoom
                          ? `AI ${debugAiCount} / 模拟真人 ${debugSimulatedHumanCount}`
                          : `${debugAiCount}/${room.config.aiPlayerCount}`}
                      </strong>
                    </div>
                    <div className="debug-ai-row">
                      <select
                        className="debug-ai-select"
                        value={selectedDebugPlayerType}
                        disabled={pending || !isDebugAutoAiRoom}
                        onChange={(event) =>
                          setSelectedDebugPlayerType(
                            event.target.value === "human" ? "human" : "ai",
                          )
                        }
                      >
                        <option value="ai">AI 玩家</option>
                        <option value="human" disabled={!isDebugAutoAiRoom}>
                          模拟真人
                        </option>
                      </select>
                      {isAddingDebugAi && (
                        <select
                          className="debug-ai-select"
                          value={selectedDebugPersonaId}
                          disabled={
                            pending ||
                            (!isDebugAutoAiRoom && !canAddDebugAi) ||
                            availablePersonaOptions.length === 0
                          }
                          onChange={(event) =>
                            setSelectedPersonaId(event.target.value)
                          }
                        >
                          {!canAddDebugAi && (
                            <option value="">AI 名额已满</option>
                          )}
                          {canAddDebugAi &&
                            availablePersonaOptions.length === 0 && (
                              <option value="">人格已添加完</option>
                            )}
                          {personaOptions.map((persona) => {
                            const used =
                              !isDebugAutoAiRoom &&
                              usedAiPersonaIds.has(persona.id);
                            return (
                              <option
                                disabled={used}
                                key={persona.id}
                                value={persona.id}
                              >
                                {persona.name}
                                {used ? "（已添加）" : ""}
                              </option>
                            );
                          })}
                        </select>
                      )}
                      {isDebugAutoAiRoom && modelOptions.length > 0 && (
                        <select
                          className="debug-ai-select"
                          value={selectedModelId}
                          disabled={pending}
                          onChange={(event) =>
                            setSelectedModelId(event.target.value)
                          }
                        >
                          {modelOptions.map((model) => (
                            <option key={model.id} value={model.id}>
                              {model.id}{model.default ? " (默认)" : ""}
                            </option>
                          ))}
                        </select>
                      )}
                      <button
                        className="secondary debug-ai-add-btn"
                        disabled={
                          pending ||
                          (!isDebugAutoAiRoom && (!isAddingDebugAi || !canAddDebugAi)) ||
                          (isAddingDebugAi && !selectedDebugPersonaId)
                        }
                        onClick={handleAddDebugAi}
                      >
                        {isAddingDebugAi ? "添加 AI" : "添加模拟真人"}
                      </button>
                    </div>
                  </div>
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
              onClick={handleReturnToLobby}
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
                const isSelf = !isDebugAutoAiRoom && player.id === playerId;
                const isRoomOwner = !isDebugAutoAiRoom && player.id === room.ownerPlayerId;
                const isAi = player.revealedType === "ai";
                const isSimulatedHuman =
                  player.revealedType === "human" && player.simulated;
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
                    className={`player-row waiting-player-row ${isSelf ? "is-self" : ""} ${isAi ? "is-ai" : ""} ${isSimulatedHuman ? "is-simulated-human" : ""} ${!player.connected ? "is-offline" : ""}`}
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
                        {isAi && <span className="identity-tag ai">AI</span>}
                        {isSimulatedHuman && (
                          <span className="identity-tag human simulated">
                            模拟真人
                          </span>
                        )}
                        {player.aiPersonaName && (
                          <span className="waiting-persona-tag">
                            {player.aiPersonaName}
                          </span>
                        )}
                        {canManageDebugAi && modelOptions.length > 0 && (isAi || isSimulatedHuman) ? (
                          <select
                            className="debug-ai-select debug-model-inline"
                            value={player.aiModelId || defaultModelId}
                            disabled={pending}
                            onChange={(event) => {
                              if (room) {
                                void updateDebugModel(room.id, player.id, event.target.value);
                              }
                            }}
                          >
                            {modelOptions.map((model) => (
                              <option key={model.id} value={model.id}>
                                {model.id}{model.default ? " *" : ""}
                              </option>
                            ))}
                          </select>
                        ) : player.aiModelId ? (
                          <span className="waiting-persona-tag model-tag">
                            {player.aiModelId}
                          </span>
                        ) : null}
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
                    {canManageDebugAi && (isAi || isSimulatedHuman) && (
                      <button
                        className="debug-ai-remove-btn"
                        disabled={pending}
                        onClick={() => handleRemoveDebugAi(player.id)}
                        aria-label={`删除 ${player.name}`}
                      >
                        <IconTrash />
                        删除
                      </button>
                    )}
                  </div>
                );
              })}

              {Array.from({
                length: Math.max(
                  0,
                  room.debugAutoAi
                    ? 0
                    : room.config.maxHumanPlayers - humanCount(room),
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
