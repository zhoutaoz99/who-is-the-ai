"use client";

import { useParams, useRouter } from "next/navigation";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../../lib/auth-client";
import { useGameClient } from "../../lib/game-client";
import { useRoomReconnect } from "../../lib/use-room-reconnect";
import type {
  PublicMessage,
  PublicVoteResult,
  RoomSnapshot,
} from "../../lib/game-types";
import {
  formatRemaining,
  getPlayerSeatNo,
  phaseLabel,
} from "../../lib/game-utils";

type TranscriptItem =
  | {
      type: "round";
      roundNo: number;
    }
  | {
      type: "message";
      message: PublicMessage;
    }
  | {
      type: "voteResult";
      roundNo: number;
      votes: PublicVoteResult[];
    };

/* ===== Icons ===== */
function IconSend(props: React.SVGProps<SVGSVGElement>) {
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
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
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

function IconRound(props: React.SVGProps<SVGSVGElement>) {
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

function IconWifiOff(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="12"
      height="12"
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

function IconSkull(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <circle cx="9" cy="12" r="1" />
      <circle cx="15" cy="12" r="1" />
      <path d="M8 20v2h8v-2" />
      <path d="M12 20V10" />
      <path d="M9 17h6" />
      <path d="M7 17H5a2 2 0 0 1-2-2v-4a6 6 0 0 1 6-6h6a6 6 0 0 1 6 6v4a2 2 0 0 1-2 2h-2" />
    </svg>
  );
}

function IconCheck(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function IconTrophy(props: React.SVGProps<SVGSVGElement>) {
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
      <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" />
      <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
      <path d="M4 22h16" />
      <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" />
      <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" />
      <path d="M18 2H6v7a6 6 0 0 0 12 0V2z" />
    </svg>
  );
}

function IconFrown(props: React.SVGProps<SVGSVGElement>) {
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
      <circle cx="12" cy="12" r="10" />
      <path d="M16 16s-1.5-2-4-2-4 2-4 2" />
      <line x1="9" y1="9" x2="9.01" y2="9" />
      <line x1="15" y1="9" x2="15.01" y2="9" />
    </svg>
  );
}

function IconTarget(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </svg>
  );
}

function IconMessage(props: React.SVGProps<SVGSVGElement>) {
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
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function IconSparkles(props: React.SVGProps<SVGSVGElement>) {
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
      <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
      <path d="M5 3v4" />
      <path d="M19 17v4" />
      <path d="M3 5h4" />
      <path d="M17 19h4" />
    </svg>
  );
}

/* ===== Seat colors ===== */
const SEAT_COLORS = [
  "#0f766e",
  "#2563eb",
  "#7c3aed",
  "#b42318",
  "#b54708",
  "#047857",
  "#0369a1",
  "#4338ca",
];

function getSeatColor(seatNo: number) {
  return SEAT_COLORS[(seatNo - 1) % SEAT_COLORS.length];
}

/* ===== Main Page ===== */
export default function GamePage() {
  const params = useParams<{ roomId: string }>();
  const router = useRouter();
  const roomId = params.roomId.toUpperCase();
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const accountRefreshRoomRef = useRef<string | null>(null);
  const { refreshMe } = useAuth();
  const {
    connected,
    pending,
    error,
    getRoom,
    getPlayerId,
    reconnectRoom,
    sendChat,
    castVote,
    stopGame,
    fetchRoom,
    speechGenerating,
    speechDiscarded,
  } = useGameClient();

  const [chatDraft, setChatDraft] = useState("");
  const [votedTarget, setVotedTarget] = useState<string | null>(null);
  const [selectedVoteTarget, setSelectedVoteTarget] = useState<string | null>(
    null,
  );
  const [now, setNow] = useState(Date.now());
  const [fetchAttempted, setFetchAttempted] = useState(false);

  const room = getRoom(roomId);
  const storedPlayerId = getPlayerId(roomId);
  const playerId = room?.debugAutoAi ? null : storedPlayerId;

  useRoomReconnect({
    connected,
    disabled: !room || Boolean(room.debugAutoAi),
    roomId,
    getPlayerId,
    reconnectRoom,
  });

  useEffect(() => {
    if (room || fetchAttempted) return;
    setFetchAttempted(true);
    void fetchRoom(roomId);
  }, [room, fetchAttempted, fetchRoom, roomId]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [room?.messages.length, room?.voteResults.length]);

  useEffect(() => {
    if (room?.status === "waiting") {
      router.replace(`/room/${room.id}`);
    }
  }, [room?.id, room?.status, router]);

  useEffect(() => {
    if (room?.phase === "voting") {
      setVotedTarget(null);
      setSelectedVoteTarget(null);
    }
  }, [room?.currentRound, room?.phase]);

  useEffect(() => {
    if (
      !room ||
      room.status !== "finished" ||
      accountRefreshRoomRef.current === room.id
    ) {
      return;
    }

    accountRefreshRoomRef.current = room.id;
    void refreshMe();
  }, [refreshMe, room]);

  const currentPlayer = useMemo(() => {
    if (!room || !playerId || room.debugAutoAi) {
      return null;
    }
    return room.players.find((player) => player.id === playerId) ?? null;
  }, [room, playerId]);

  if (!room) {
    return (
      <main className="immersive-page">
        <section className="missing-game">
          <p className="eyebrow">Game</p>
          <h1>{fetchAttempted ? "对局未找到" : "正在加载对局"}</h1>
          <p>
            {fetchAttempted
              ? "该对局不存在或已被清理。"
              : "正在从服务器获取对局信息..."}
          </p>
          <button className="secondary" onClick={() => router.push("/")}>
            返回大厅
          </button>
        </section>
      </main>
    );
  }

  const remainingMs = room.phaseEndsAt
    ? Math.max(0, new Date(room.phaseEndsAt).getTime() - now)
    : 0;
  const latestOwnMessageAt = playerId
    ? room.messages.reduce((latest, message) => {
        if (message.playerId !== playerId) {
          return latest;
        }

        return Math.max(latest, new Date(message.createdAt).getTime());
      }, 0)
    : 0;
  const speakCooldownRemainingMs = latestOwnMessageAt
    ? Math.max(0, latestOwnMessageAt + room.config.speakCooldownMs - now)
    : 0;
  const canSpeakBase =
    room.phase === "discussion" &&
    currentPlayer?.status === "alive" &&
    room.status === "playing";
  const canSpeak = canSpeakBase && speakCooldownRemainingMs <= 0;
  const canVote =
    room.phase === "voting" &&
    currentPlayer?.status === "alive" &&
    room.status === "playing" &&
    !votedTarget;
  const alivePlayers = room.players.filter(
    (player) => player.status === "alive",
  );
  const selectedVotePlayer =
    alivePlayers.find((player) => player.id === selectedVoteTarget) ?? null;
  const transcriptItems = buildTranscriptItems(room);
  const isObserverMode = Boolean(room.debugAutoAi);

  const showSpeechGenerating =
    isObserverMode &&
    room.status === "playing" &&
    room.phase === "discussion" &&
    speechGenerating &&
    (!speechGenerating.roomId || speechGenerating.roomId === room.id) &&
    (!speechGenerating.roundNo || speechGenerating.roundNo === room.currentRound);
  const showSpeechDiscarded =
    isObserverMode &&
    speechDiscarded &&
    (!speechDiscarded.roomId || speechDiscarded.roomId === room.id) &&
    (!speechDiscarded.roundNo || speechDiscarded.roundNo === room.currentRound);

  const phaseTotalMs =
    room.phase === "discussion"
      ? room.config.discussionDurationMs
      : room.phase === "voting"
        ? room.config.voteDurationMs
        : 0;
  const phaseProgress =
    phaseTotalMs > 0 && remainingMs > 0
      ? remainingMs / phaseTotalMs
      : 0;

  async function handleSendChat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!room) {
      return;
    }

    const content = chatDraft.trim();
    if (!content) {
      return;
    }
    if (!canSpeak) {
      return;
    }

    const result = await sendChat(room.id, content);
    if (result.ok) {
      setChatDraft("");
    }
  }

  async function handleConfirmVote() {
    if (!room || !selectedVoteTarget) {
      return;
    }

    const result = await castVote(room.id, selectedVoteTarget);
    if (result.ok) {
      setVotedTarget(selectedVoteTarget);
    }
  }

  return (
    <main className="immersive-page">
      {/* ===== Topline ===== */}
      <header className="game-topline">
        <div className="game-topline-left">
          <h1>Room {room.id}</h1>
        </div>
        <div className="game-topline-meta">
          <div className="phase-pill">{phaseLabel(room.phase)}</div>
          <div
            className={`connection-badge ${connected ? "online" : "offline"}`}
          >
            <span className="connection-dot" />
            {connected ? "已连接" : "断开"}
          </div>
          <div
            className={`round-meter ${remainingMs <= 15_000 && remainingMs > 0 ? "critical" : room.phase !== "voting" && remainingMs <= 60_000 && remainingMs > 0 ? "warning" : ""}`}
          >
            <span>
              <IconRound
                width="12"
                height="12"
                style={{ verticalAlign: "middle", marginRight: 4 }}
              />
              第 {room.currentRound || 0}/{room.config.maxRounds} 轮
            </span>
            <div className="timer-box">
              <IconClock
                width="16"
                height="16"
                style={{ verticalAlign: "middle", marginRight: 4 }}
              />
              <strong>{formatRemaining(remainingMs)}</strong>
            </div>
            {remainingMs <= 15_000 && remainingMs > 0 && (
              <div className="timer-alert critical">
                <span className="alert-pulse" />
                即将结束！
              </div>
            )}
            {room.phase !== "voting" && remainingMs > 15_000 && remainingMs <= 60_000 && remainingMs > 0 && (
              <div className="timer-alert warning">
                剩余时间不足 1 分钟
              </div>
            )}
            {phaseTotalMs > 0 && remainingMs > 0 && (
              <div className="timer-track">
                <div
                  className="timer-fill"
                  style={{
                    width: `${phaseProgress * 100}%`,
                    transition: "width 1s linear",
                  }}
                />
              </div>
            )}
          </div>
        </div>
      </header>

      {/* ===== Result Banner ===== */}
      {room.status === "finished" && (
        <section
          className={`game-result-banner ${room.winner === "human" ? "win" : "loss"}`}
        >
          <div className="result-banner-left">
            <div className="result-icon">
              {room.winner === "human" ? <IconTrophy /> : <IconFrown />}
            </div>
            <div>
              <h2>
                {isObserverMode
                  ? room.winner === "human"
                    ? "模拟真人获胜"
                    : room.winner === "ai"
                      ? "AI 获胜"
                      : "AI 自动对抗结束"
                  : room.winner === "human"
                  ? "真人玩家获胜"
                  : room.winner === "ai"
                    ? "人类玩家失败"
                    : "游戏已中止"}
              </h2>
              <p>
                {isObserverMode
                  ? room.winner === "human"
                    ? "模拟真人成功识别并投票淘汰了所有 AI 玩家。"
                    : room.winner === "ai"
                      ? "AI 玩家成功隐藏身份，模拟真人未能将其全部淘汰。"
                      : "可返回大厅进入复盘查看模型行为记录。"
                  : room.winner === "human"
                  ? formatPointAwardSummary(room)
                  : room.winner === "ai"
                    ? "4 轮结束后仍有 AI 玩家在场，本局挑战失败。"
                    : "游戏被调试模式中止。"}
              </p>
            </div>
          </div>
          <div className="result-banner-actions">
            <button
              className="secondary"
              onClick={() => router.push(`/replay/${room.id}`)}
            >
              复盘
            </button>
            <button className="secondary" onClick={() => router.push("/")}>
              返回大厅
            </button>
          </div>
        </section>
      )}

      {/* ===== Game Stage ===== */}
      <section className="game-stage">
        {/* --- Left: Players --- */}
        <aside className="immersive-panel player-dock">
          <div className="panel-header">
            <div className="panel-header-icon player-icon">
              <IconTarget width="18" height="18" />
            </div>
            <div>
              <p className="eyebrow">Players</p>
              <h2>
                玩家{" "}
                <span className="panel-count">
                  {alivePlayers.length}/{room.players.length} 存活
                </span>
              </h2>
            </div>
          </div>
          <div className="player-dock-list">
            {room.players.map((player) => {
              const isSelf = player.id === playerId;
              const isGenerating = showSpeechGenerating && speechGenerating?.playerId === player.id;
              const isDiscarded = showSpeechDiscarded && speechDiscarded?.playerId === player.id;
              return (
                <div
                  className={`player-row game-player-row ${isSelf ? "is-self" : ""} ${player.status === "eliminated" ? "is-dead" : ""} ${isGenerating ? "is-generating" : ""}`}
                  key={player.id}
                >
                  <div
                    className="game-player-avatar"
                    style={{ backgroundColor: getSeatColor(player.seatNo) }}
                  >
                    {player.seatNo}
                  </div>
                  <div className="game-player-info">
                    <div className="game-player-name">
                      <strong>#{player.seatNo}</strong>
                      {isSelf && <span className="self">你</span>}
                      {player.revealedType && (
                        <span
                          className={`identity-tag ${player.revealedType}${player.simulated ? " simulated" : ""}`}
                        >
                          {player.revealedType === "ai"
                            ? "AI"
                            : player.simulated
                              ? "模拟真人"
                              : "真人"}
                        </span>
                      )}
                    </div>
                    <div className="game-player-status">
                      {player.status === "alive" ? (
                        <span className="alive">存活</span>
                      ) : (
                        <span className="dead">
                          <IconSkull
                            width="10"
                            height="10"
                            style={{ verticalAlign: "middle", marginRight: 2 }}
                          />
                          出局
                        </span>
                      )}
                      {!player.connected && player.status === "alive" && (
                        <span className="muted offline-tag">
                          <IconWifiOff
                            width="10"
                            height="10"
                            style={{ verticalAlign: "middle", marginRight: 2 }}
                          />
                          离线
                        </span>
                      )}
                      {isObserverMode && player.aiPersonaName && (
                        <span className="game-player-persona">{player.aiPersonaName}</span>
                      )}
                      {isObserverMode && player.aiModelId && (
                        <span className="game-player-model">{player.aiModelId}</span>
                      )}
                    </div>
                  </div>
                  {isGenerating && (
                    <span className="generating-tag">
                      生成中
                      <span className="typing-dots">
                        <span className="dot" />
                        <span className="dot" />
                        <span className="dot" />
                      </span>
                    </span>
                  )}
                  {isDiscarded && (
                    <span className="discarded-tag">已跳过</span>
                  )}
                </div>
              );
            })}
          </div>
        </aside>

        {/* --- Center: Transcript --- */}
        <section className="immersive-panel transcript">
          <div className="transcript-header">
            <div className="panel-header">
              <div className="panel-header-icon chat-icon">
                <IconMessage width="18" height="18" />
              </div>
              <div>
                <p className="eyebrow">Discussion</p>
                <h2>发言区</h2>
              </div>
            </div>
            <span className="msg-count">
              {room.messages.length} 条消息
            </span>
          </div>

          <div className="transcript-messages">
            {transcriptItems.length === 0 ? (
              <div className="transcript-empty">
                <IconSparkles
                  width="40"
                  height="40"
                  style={{ color: "#2dd4bf", opacity: 0.6 }}
                />
                <p>等待第一轮开始</p>
                <p className="muted-text" style={{ fontSize: 13 }}>
                  观察发言逻辑，找出隐藏的 AI 玩家
                </p>
              </div>
            ) : (
              transcriptItems.map((item) =>
                item.type === "round" ? (
                  <div
                    className="round-transition"
                    key={`round-${item.roundNo}`}
                  >
                    <span>ROUND {item.roundNo}</span>
                    <strong>发言开始</strong>
                    <p>
                      请根据编号玩家的发言、逻辑和投票倾向判断谁是 AI 玩家。
                    </p>
                  </div>
                ) : (
                  renderTranscriptItem(room, item, playerId, isObserverMode)
                ),
              )
            )}
            <div ref={messagesEndRef} />
          </div>

          {isObserverMode ? (
            <div className="observer-note">AI 自动对抗进行中</div>
          ) : (
            <form
              className="composer immersive-composer"
              onSubmit={handleSendChat}
            >
              <input
                value={chatDraft}
                maxLength={240}
                disabled={!canSpeak || pending}
                placeholder={
                  canSpeak
                    ? "输入发言，15 秒冷却..."
                    : speakCooldownRemainingMs > 0
                      ? `发言冷却中，还剩 ${formatCooldownSeconds(
                          speakCooldownRemainingMs,
                        )} 秒`
                      : "当前不可发言"
                }
                onChange={(event) => setChatDraft(event.target.value)}
              />
              <button
                disabled={!canSpeak || pending || !chatDraft.trim()}
                aria-label="发送"
                className="send-btn"
              >
                <IconSend />
              </button>
            </form>
          )}
        </section>

        {/* --- Right: Action --- */}
        <aside className="immersive-panel action-dock">
          <div className="panel-header">
            <div className="panel-header-icon action-icon">
              <IconTarget width="18" height="18" />
            </div>
            <div>
              <p className="eyebrow">Action</p>
              <h2>{room.phase === "voting" ? "投票" : "当前行动"}</h2>
            </div>
          </div>

          {room.phase !== "voting" && room.status !== "finished" && (
            <div className="phase-hint">
              <div className="phase-hint-title">
                <IconSparkles
                  width="16"
                  height="16"
                  style={{ color: "#2dd4bf" }}
                />
                <strong>{phaseLabel(room.phase)}</strong>
              </div>
              <p>
                观察发言逻辑、前后矛盾和跟票行为，投票阶段开始后选择怀疑对象。
              </p>
            </div>
          )}

          {room.phase === "voting" && isObserverMode && (
            <div className="phase-hint">
              <div className="phase-hint-title">
                <IconTarget
                  width="16"
                  height="16"
                  style={{ color: "#2dd4bf" }}
                />
                <strong>AI 自动投票中</strong>
              </div>
              <p>等待所有存活 AI 完成本轮投票。</p>
            </div>
          )}

          {room.phase === "voting" && !isObserverMode && (
            <>
              {votedTarget ? (
                <div className="phase-hint voted-hint">
                  <div className="phase-hint-title">
                    <IconCheck
                      width="18"
                      height="18"
                      style={{ color: "#34d399" }}
                    />
                    <strong>投票已提交</strong>
                  </div>
                  <p>等待本轮投票结束后公开结果。</p>
                </div>
              ) : (
                <>
                  <div className="vote-section-title">
                    <IconTarget
                      width="14"
                      height="14"
                      style={{ verticalAlign: "middle", marginRight: 4 }}
                    />
                    选择怀疑对象
                  </div>
                  <div className="vote-options vertical">
                    {alivePlayers
                      .filter((player) => player.id !== playerId)
                      .map((player) => (
                        <button
                          className={`vote-btn ${selectedVoteTarget === player.id ? "selected" : ""}`}
                          key={player.id}
                          disabled={!canVote || pending}
                          onClick={() => setSelectedVoteTarget(player.id)}
                        >
                          <span
                            className="vote-btn-avatar"
                            style={{
                              backgroundColor: getSeatColor(player.seatNo),
                            }}
                          >
                            {player.seatNo}
                          </span>
                          <span className="vote-btn-label">
                            #{player.seatNo}
                          </span>
                        </button>
                      ))}
                  </div>

                  {selectedVotePlayer && (
                    <div className="vote-confirm">
                      <p>
                        确认投给{" "}
                        <strong>#{selectedVotePlayer.seatNo}</strong>？
                      </p>
                      <div>
                        <button
                          className="secondary"
                          disabled={pending}
                          onClick={() => setSelectedVoteTarget(null)}
                        >
                          取消
                        </button>
                        <button
                          disabled={!canVote || pending}
                          onClick={handleConfirmVote}
                        >
                          确认投票
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {room.status === "finished" && (
            <div className="phase-hint">
              <div className="phase-hint-title">
                <IconSparkles
                  width="16"
                  height="16"
                  style={{ color: "#fcd34d" }}
                />
                <strong>身份已揭晓</strong>
              </div>
              <p>可以查看左侧玩家身份和完整发言记录。</p>
            </div>
          )}

          {room.debug && room.status === "playing" && (
            <button
              className="secondary"
              disabled={pending}
              onClick={() => stopGame(room.id)}
              style={{ marginTop: "1rem", width: "100%" }}
            >
              停止游戏（调试）
            </button>
          )}

          {error && <p className="error">{error}</p>}
        </aside>
      </section>
    </main>
  );
}

/* ===== Helpers ===== */
function buildTranscriptItems(room: RoomSnapshot): TranscriptItem[] {
  const maxMessageRound = room.messages.reduce(
    (maxRound, message) => Math.max(maxRound, message.roundNo),
    0,
  );
  const maxVoteRound = room.voteResults.reduce(
    (maxRound, vote) => Math.max(maxRound, vote.roundNo),
    0,
  );
  const maxRound = Math.max(room.currentRound, maxMessageRound, maxVoteRound);
  const items: TranscriptItem[] = [];

  for (let roundNo = 1; roundNo <= maxRound; roundNo += 1) {
    items.push({
      type: "round",
      roundNo,
    });

    for (const message of room.messages) {
      if (message.roundNo === roundNo) {
        items.push({
          type: "message",
          message,
        });
      }
    }

    if (isVoteResultVisibleForRound(room, roundNo)) {
      items.push({
        type: "voteResult",
        roundNo,
        votes: room.voteResults
          .filter((vote) => vote.roundNo === roundNo)
          .sort(
            (first, second) =>
              getSortableSeatNo(room, first.voterPlayerId) -
              getSortableSeatNo(room, second.voterPlayerId),
          ),
      });
    }
  }

  return items;
}

function renderTranscriptItem(
  room: RoomSnapshot,
  item: Exclude<TranscriptItem, { type: "round" }>,
  currentPlayerId?: string | null,
  isObserverMode?: boolean,
) {
  if (item.type === "voteResult") {
    return (
      <div className="vote-result-card" key={`vote-result-${item.roundNo}`}>
        <div className="vote-result-header">
          <IconTarget
            width="14"
            height="14"
            style={{ color: "#fde68a" }}
          />
          <strong>第 {item.roundNo} 轮投票结果</strong>
        </div>
        <div className="vote-result-body">
          <span>{formatVoteResultLine(room, item.votes)}</span>
          <span className="vote-result-sep">·</span>
          <span>{formatEliminationLine(room, item.roundNo)}</span>
        </div>
      </div>
    );
  }

  const seatNo = getPlayerSeatNo(room, item.message.playerId);
  const isAi = item.message.source === "ai";
  const messagePlayer = room.players.find(
    (player) => player.id === item.message.playerId,
  );
  const isSelf = item.message.playerId === currentPlayerId;

  return (
    <article
      className={`message immersive-message ${isAi ? "is-ai" : ""} ${isSelf ? "is-self-msg" : ""}`}
      key={item.message.id}
    >
      <div className="message-header">
        <div
          className="msg-avatar"
          style={{ backgroundColor: getSeatColor(Number(seatNo)) }}
        >
          {seatNo}
        </div>
        <div className="msg-meta">
          <strong>#{seatNo}</strong>
          <span>第 {item.message.roundNo} 轮</span>
          {item.message.source && (
            <span className={`msg-source ${isAi ? "ai" : "human"}${messagePlayer?.simulated ? " simulated" : ""}`}>
              {isAi ? "AI" : messagePlayer?.simulated ? "模拟真人" : "真人"}
            </span>
          )}
          {isObserverMode && messagePlayer?.aiPersonaName && (
            <span className="msg-source msg-persona">{messagePlayer.aiPersonaName}</span>
          )}
          {isObserverMode && messagePlayer?.aiModelId && (
            <span className="msg-source msg-model">{messagePlayer.aiModelId}</span>
          )}
        </div>
      </div>
      <p className="msg-content">{item.message.content}</p>
    </article>
  );
}

function isVoteResultVisibleForRound(room: RoomSnapshot, roundNo: number) {
  if (room.status === "finished" || room.phase === "game_over") {
    return roundNo <= room.currentRound;
  }

  if (roundNo < room.currentRound) {
    return true;
  }

  return room.currentRound === roundNo && room.phase === "resolving";
}

function getSortableSeatNo(room: RoomSnapshot, playerId: string) {
  return room.players.find((player) => player.id === playerId)?.seatNo ?? 999;
}

function formatVoteResultLine(room: RoomSnapshot, votes: PublicVoteResult[]) {
  if (votes.length === 0) {
    return "无人完成投票";
  }

  return votes
    .map(
      (vote) =>
        `#${getPlayerSeatNo(room, vote.voterPlayerId)}→#${getPlayerSeatNo(
          room,
          vote.targetPlayerId,
        )}`,
    )
    .join("，");
}

function formatEliminationLine(room: RoomSnapshot, roundNo: number) {
  const eliminatedPlayer = room.players.find(
    (player) => player.eliminatedRound === roundNo,
  );

  if (!eliminatedPlayer) {
    return "无人出局";
  }

  return `#${eliminatedPlayer.seatNo} 出局`;
}

function formatPointAwardSummary(room: RoomSnapshot) {
  if (room.pointAwards.length === 0) {
    return `本局奖励池 ${room.config.rewardPool} 积分，暂无可结算的存活真人玩家。`;
  }

  const awardLine = room.pointAwards
    .map(
      (award) =>
        `#${getPlayerSeatNo(room, award.playerId)} +${award.points}`,
    )
    .join("，");

  return `存活真人玩家平分 ${room.config.rewardPool} 积分：${awardLine}`;
}

function formatCooldownSeconds(ms: number) {
  return Math.ceil(ms / 1000);
}
