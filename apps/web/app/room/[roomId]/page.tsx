"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { useGameClient } from "../../lib/game-client";
import { humanCount, statusLabel } from "../../lib/game-utils";

export default function WaitingRoomPage() {
  const params = useParams<{ roomId: string }>();
  const router = useRouter();
  const roomId = params.roomId.toUpperCase();
  const reconnectAttempted = useRef(false);
  const {
    connected,
    pending,
    error,
    playerName,
    setPlayerName,
    getRoom,
    getPlayerId,
    joinRoom,
    leaveRoom,
    reconnectRoom,
    startGame,
  } = useGameClient();

  const room = getRoom(roomId);
  const playerId = getPlayerId(roomId);
  const isOwner = Boolean(room && playerId && room.ownerPlayerId === playerId);
  const isJoined = Boolean(playerId);
  const isDisconnected = Boolean(
    playerId && room?.players.find((p) => p.id === playerId && !p.connected),
  );

  useEffect(() => {
    if (room?.status === "playing") {
      router.replace(`/game/${room.id}`);
    }
  }, [room?.id, room?.status, router]);

  // Auto-reconnect on page load/refresh
  useEffect(() => {
    if (!connected || reconnectAttempted.current) {
      return;
    }

    const storedPlayerId = getPlayerId(roomId);
    if (!storedPlayerId) {
      return;
    }

    const currentRoom = getRoom(roomId);
    if (!currentRoom) {
      return;
    }

    const playerInRoom = currentRoom.players.find((p) => p.id === storedPlayerId);
    if (!playerInRoom || playerInRoom.connected) {
      return;
    }

    reconnectAttempted.current = true;
    reconnectRoom(roomId);
  }, [connected, roomId, getPlayerId, getRoom, reconnectRoom]);

  async function handleJoinRoom() {
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
      <section className="topbar">
        <div>
          <p className="eyebrow">Waiting Room</p>
          <h1>房间 {roomId}</h1>
        </div>
        <div className={connected ? "status online" : "status offline"}>
          {connected ? "后端已连接" : "后端未连接"}
        </div>
      </section>

      {!room ? (
        <section className="panel waiting-card">
          <div>
            <p className="eyebrow">Join</p>
            <h2>加入等待房间</h2>
          </div>
          <label className="field">
            <span>昵称</span>
            <input
              value={playerName}
              maxLength={16}
              placeholder="输入你的玩家名"
              onChange={(event) => setPlayerName(event.target.value)}
            />
          </label>
          <button disabled={pending} onClick={handleJoinRoom}>
            加入房间
          </button>
          {error && <p className="error">{error}</p>}
          <button className="secondary" onClick={() => router.push("/")}>
            返回大厅
          </button>
        </section>
      ) : (
        <section className="waiting-layout">
          <div className="panel waiting-card">
            <div>
              <p className="eyebrow">{statusLabel(room.status)}</p>
              <h2>等待开局</h2>
            </div>

            <div className="room-code-box">
              <span>房间号</span>
              <strong>{room.id}</strong>
            </div>

            <div className="waiting-stats">
              <div>
                <span>真人玩家</span>
                <strong>
                  {humanCount(room)}/{room.config.maxHumanPlayers}
                </strong>
              </div>
              <div>
                <span>隐藏 AI</span>
                <strong>{room.config.aiPlayerCount}</strong>
              </div>
              <div>
                <span>总轮数</span>
                <strong>{room.config.maxRounds}</strong>
              </div>
              <div>
                <span>每轮时间</span>
                <strong>{Math.round(room.config.discussionDurationMs / 60_000)} 分钟</strong>
              </div>
            </div>

            {isDisconnected && (
              <p className="muted-text">正在重新连接...</p>
            )}

            {!isJoined && !isDisconnected && (
              <>
                <label className="field">
                  <span>昵称</span>
                  <input
                    value={playerName}
                    maxLength={16}
                    placeholder="输入你的玩家名"
                    onChange={(event) => setPlayerName(event.target.value)}
                  />
                </label>
                <button disabled={pending} onClick={handleJoinRoom}>
                  加入房间
                </button>
              </>
            )}

            {isJoined && isOwner && (
              <button disabled={!room.canStart || pending} onClick={handleStartGame}>
                开始游戏
              </button>
            )}

            {isJoined && !isOwner && <p className="muted-text">等待房主开始游戏</p>}
            {error && <p className="error">{error}</p>}
            <button className="secondary" disabled={pending} onClick={handleLeaveRoom}>
              返回大厅
            </button>
          </div>

          <div className="panel waiting-card">
            <div>
              <p className="eyebrow">Players</p>
              <h2>玩家列表</h2>
            </div>
            <div className="waiting-player-list">
              {room.players.map((player) => (
                <div className="player-row" key={player.id}>
                  <div>
                    <strong>
                      {player.seatNo}. {player.name}
                    </strong>
                    {player.id === playerId && <span className="self">你</span>}
                    {player.id === room.ownerPlayerId && <span className="self">房主</span>}
                  </div>
                  <div className="player-meta">
                    <span className={player.status === "alive" ? "alive" : "dead"}>
                      {player.status === "alive" ? "待命" : "出局"}
                    </span>
                    {!player.connected && <span className="muted">离线</span>}
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
