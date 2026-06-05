"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { AiCallLog, DebugCallResponse, ReplayData } from "../../lib/replay-types";
import type {
  PublicMessage,
  PublicVoteResult,
  RoomSnapshot,
} from "../../lib/game-types";

const API_URL =
  process.env.NEXT_PUBLIC_API_URL ||
  (typeof window !== "undefined"
    ? `${window.location.protocol}//${window.location.hostname}:3001`
    : "http://localhost:3001");

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

function callTypeLabel(type: string) {
  switch (type) {
    case "speech-strategy":
      return "发言策略";
    case "speech-expression":
      return "发言表达";
    case "vote":
      return "投票决策";
    case "sim-human-speech":
      return "模拟真人发言";
    case "sim-human-vote":
      return "模拟真人投票";
    default:
      return type;
  }
}

function winnerLabel(winner: string | null) {
  switch (winner) {
    case "human":
      return "真人获胜";
    case "ai":
      return "AI 获胜";
    default:
      return "已中止";
  }
}

type TimelineItem =
  | { type: "message"; msg: PublicMessage; aiCalls: AiCallLog[] }
  | { type: "voteRound"; roundNo: number; votes: PublicVoteResult[]; aiCalls: AiCallLog[] }
  | { type: "skip"; call: AiCallLog };

function isSkipCall(call: AiCallLog): boolean {
  if (call.callType !== "speech-strategy" && call.callType !== "sim-human-speech") return false;
  try {
    const parsed = JSON.parse(call.rawResponse);
    return parsed.type === "skip";
  } catch {
    return false;
  }
}

function buildTimeline(
  messages: PublicMessage[],
  votes: PublicVoteResult[],
  aiCalls: AiCallLog[],
  playerMap: Map<string, RoomSnapshot["players"][number]>,
): TimelineItem[] {
  const items: TimelineItem[] = [];

  // Separate strategy and expression calls per player+round, keep chronological order
  // Skip strategy calls are excluded from matching — they produce no message
  const strategyCalls = new Map<string, AiCallLog[]>();
  const expressionCalls = new Map<string, AiCallLog[]>();
  const simHumanSpeechCalls = new Map<string, AiCallLog[]>();
  for (const call of aiCalls) {
    const key = `${call.aiPlayerId}:${call.roundNo}`;
    if (call.callType === "speech-strategy" && !isSkipCall(call)) {
      const list = strategyCalls.get(key) ?? [];
      list.push(call);
      strategyCalls.set(key, list);
    } else if (call.callType === "speech-expression") {
      const list = expressionCalls.get(key) ?? [];
      list.push(call);
      expressionCalls.set(key, list);
    } else if (call.callType === "sim-human-speech" && !isSkipCall(call)) {
      const list = simHumanSpeechCalls.get(key) ?? [];
      list.push(call);
      simHumanSpeechCalls.set(key, list);
    }
  }

  // Track how many messages each AI player has sent per round (for index-based matching)
  const aiMsgIndex = new Map<string, number>();
  // Track which strategy calls were consumed (matched to messages)
  const consumedCallIds = new Set<string>();

  // Build lookup: vote calls per round
  const voteCallsByRound = new Map<number, AiCallLog[]>();
  for (const call of aiCalls) {
    if (call.callType === "vote" || call.callType === "sim-human-vote") {
      const list = voteCallsByRound.get(call.roundNo) ?? [];
      list.push(call);
      voteCallsByRound.set(call.roundNo, list);
    }
  }

  // Identify skip calls (unconsumed strategy calls with type:"skip")
  const skipCalls = aiCalls.filter((c) => isSkipCall(c));

  // Merge messages and votes into a single timeline
  const voteRoundMap = new Map<number, PublicVoteResult[]>();
  for (const vote of votes) {
    const list = voteRoundMap.get(vote.roundNo) ?? [];
    list.push(vote);
    voteRoundMap.set(vote.roundNo, list);
  }

  // Track which vote rounds we've already inserted
  const insertedVoteRounds = new Set<number>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const player = playerMap.get(msg.playerId);
    const isAi = player?.revealedType === "ai";
    const isSimulatedHuman = player?.revealedType === "human" && player.simulated;
    let msgCalls: AiCallLog[] = [];

    if (isAi || isSimulatedHuman) {
      const key = `${msg.playerId}:${msg.roundNo}`;
      const idx = aiMsgIndex.get(key) ?? 0;
      aiMsgIndex.set(key, idx + 1);

      if (isAi) {
        const expr = expressionCalls.get(key)?.[idx];
        const strat = strategyCalls.get(key)?.[idx];
        if (strat) { msgCalls.push(strat); consumedCallIds.add(strat.id); }
        if (expr) { msgCalls.push(expr); consumedCallIds.add(expr.id); }
      } else {
        const speech = simHumanSpeechCalls.get(key)?.[idx];
        if (speech) { msgCalls.push(speech); consumedCallIds.add(speech.id); }
      }
    }

    items.push({ type: "message", msg, aiCalls: msgCalls });

    // Insert votes for this round after the last message of the round
    const roundVotes = voteRoundMap.get(msg.roundNo);
    if (roundVotes && !insertedVoteRounds.has(msg.roundNo)) {
      const remainingMsgs = messages.slice(i + 1);
      const hasMoreInRound = remainingMsgs.some((m) => m.roundNo === msg.roundNo);
      if (!hasMoreInRound) {
        insertedVoteRounds.add(msg.roundNo);
        items.push({
          type: "voteRound",
          roundNo: msg.roundNo,
          votes: roundVotes,
          aiCalls: voteCallsByRound.get(msg.roundNo) ?? [],
        });
      }
    }
  }

  // Add vote rounds that have no messages
  for (const [roundNo, roundVotes] of voteRoundMap) {
    if (!insertedVoteRounds.has(roundNo)) {
      items.push({
        type: "voteRound",
        roundNo,
        votes: roundVotes,
        aiCalls: voteCallsByRound.get(roundNo) ?? [],
      });
    }
  }

  // Add skip items for unconsumed skip calls, interleaved chronologically with messages
  const unconsumedSkips = skipCalls.filter((c) => !consumedCallIds.has(c.id));
  for (const skipCall of unconsumedSkips) {
    const skipTime = new Date(skipCall.createdAt).getTime();
    const skipItem: TimelineItem = { type: "skip", call: skipCall };

    // Find insertion point: first item in the same round whose time is after the skip
    let insertIdx = -1;
    for (let j = 0; j < items.length; j++) {
      const item = items[j];
      // Skip items in different rounds
      const itemRound = item.type === "message" ? item.msg.roundNo
        : item.type === "voteRound" ? item.roundNo
        : item.call.roundNo;
      if (itemRound !== skipCall.roundNo) continue;

      const itemTime = item.type === "message"
        ? new Date(item.msg.createdAt).getTime()
        : item.type === "voteRound"
          ? skipTime + 1 // votes go after all skip/message items in the round
          : new Date(item.call.createdAt).getTime();

      if (itemTime > skipTime) {
        insertIdx = j;
        break;
      }
    }

    if (insertIdx >= 0) {
      items.splice(insertIdx, 0, skipItem);
    } else {
      // No later item in this round found; insert before the vote round
      const voteIdx = items.findIndex((item) => item.type === "voteRound" && item.roundNo === skipCall.roundNo);
      if (voteIdx >= 0) {
        items.splice(voteIdx, 0, skipItem);
      } else {
        items.push(skipItem);
      }
    }
  }

  return items;
}

function AiCallGroup({ calls, systemPrompts }: { calls: AiCallLog[]; systemPrompts: Record<string, string> }) {
  const expressionCall = calls.find((c) => c.callType === "speech-expression");
  const template = expressionCall?.templatePrompt ?? expressionCall?.userPrompt ?? "";
  const [expressionUserPrompt, setExpressionUserPrompt] = useState(
    expressionCall?.userPrompt ?? "",
  );

  function applyStrategyToExpression(strategyOutput: string) {
    if (!expressionCall) return;
    setExpressionUserPrompt(
      template.replace(/\{\{speechStrategy\}\}/, strategyOutput),
    );
  }

  return (
    <div className="replay-msg-ai-calls">
      {calls.map((call) => (
        <AiCallInline
          key={call.id}
          call={call}
          systemPrompt={systemPrompts[call.callType] ?? ""}
          onApplyStrategy={call.callType === "speech-strategy" ? applyStrategyToExpression : undefined}
          managedUserPrompt={call.callType === "speech-expression" ? expressionUserPrompt : undefined}
          onManagedUserPromptChange={call.callType === "speech-expression" ? setExpressionUserPrompt : undefined}
        />
      ))}
    </div>
  );
}

function EditablePrompt({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="replay-prompt-block">
      <div className="replay-prompt-label">{label}</div>
      <textarea
        className="replay-prompt-textarea"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
    </div>
  );
}

function AiCallInline({
  call,
  systemPrompt: initialSystemPrompt,
  onApplyStrategy,
  managedUserPrompt,
  onManagedUserPromptChange,
}: {
  call: AiCallLog;
  systemPrompt: string;
  onApplyStrategy?: (output: string) => void;
  managedUserPrompt?: string;
  onManagedUserPromptChange?: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState(initialSystemPrompt);
  const [localUserPrompt, setLocalUserPrompt] = useState(call.userPrompt);

  const userPrompt = managedUserPrompt ?? localUserPrompt;
  const setUserPrompt = onManagedUserPromptChange ?? setLocalUserPrompt;

  const [debugResponse, setDebugResponse] = useState<string | null>(null);
  const [debugThinking, setDebugThinking] = useState<string | null>(null);
  const [debugLoading, setDebugLoading] = useState(false);
  const [debugError, setDebugError] = useState<string | null>(null);

  async function handleDebugCall() {
    setDebugLoading(true);
    setDebugError(null);
    setDebugResponse(null);
    setDebugThinking(null);
    try {
      const res = await fetch(`${API_URL}/replay/debug/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemPrompt,
          userPrompt,
          model: call.modelName,
          temperature: call.temperature,
          reasoningEffort: call.reasoningEffort,
        }),
      });
      const data: DebugCallResponse = await res.json();
      if (data.ok) {
        setDebugResponse(data.rawResponse ?? null);
        setDebugThinking(data.thinkingContent ?? null);
      } else {
        setDebugError(data.error ?? "调用失败");
      }
    } catch (err) {
      setDebugError(err instanceof Error ? err.message : "网络错误");
    } finally {
      setDebugLoading(false);
    }
  }

  function handleReset() {
    setSystemPrompt(initialSystemPrompt);
    setUserPrompt(call.userPrompt);
    setDebugResponse(null);
    setDebugThinking(null);
    setDebugError(null);
  }

  return (
    <div className="replay-ai-call-inline">
      <span
        role="button"
        tabIndex={0}
        className="replay-ai-call-toggle"
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => { if (e.key === "Enter") setOpen(!open); }}
      >
        <span className={`replay-call-type ${call.callType}`}>
          {callTypeLabel(call.callType)}
        </span>
        <span className="replay-model-tag">{call.modelName}</span>
        <span className="replay-expand-icon">{open ? "▾" : "▸"}</span>
      </span>
      {open && (
        <div className="replay-ai-call-body">
          <div className="replay-call-info">
            <span>模型: {call.modelName}</span>
            <span>温度: {call.temperature}</span>
            <span>推理: {call.reasoningEffort}</span>
            <span>{new Date(call.createdAt).toLocaleString()}</span>
          </div>
          <EditablePrompt label="系统提示词 (System Prompt)" value={systemPrompt} onChange={setSystemPrompt} />
          <EditablePrompt label="用户提示词 (User Prompt)" value={userPrompt} onChange={setUserPrompt} />
          <div className="replay-original-response">
            <div className="replay-prompt-label">原始响应 (Raw Response)</div>
            <pre className="replay-prompt-content">{call.rawResponse}</pre>
          </div>
          <div className="replay-debug-actions">
            <button
              className="replay-debug-btn"
              disabled={debugLoading}
              onClick={handleDebugCall}
            >
              {debugLoading ? "调用中..." : "重新调用"}
            </button>
            <button
              className="replay-reset-btn"
              onClick={handleReset}
            >
              重置
            </button>
            {onApplyStrategy && debugResponse && (
              <button
                className="replay-apply-strategy-btn"
                onClick={() => onApplyStrategy(debugResponse)}
              >
                应用到表达层
              </button>
            )}
          </div>
          {debugThinking && (
            <div className="replay-debug-result">
              <div className="replay-prompt-label">思考过程 (Thinking)</div>
              <pre className="replay-prompt-content">{debugThinking}</pre>
            </div>
          )}
          {debugResponse && (
            <div className="replay-debug-result">
              <div className="replay-prompt-label">调试响应</div>
              <pre className="replay-prompt-content">{debugResponse}</pre>
            </div>
          )}
          {debugError && (
            <div className="replay-debug-error">{debugError}</div>
          )}
        </div>
      )}
    </div>
  );
}

export default function ReplayPage() {
  const params = useParams<{ roomId: string }>();
  const router = useRouter();
  const roomId = params.roomId.toUpperCase();

  const [data, setData] = useState<ReplayData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [localPrompts, setLocalPrompts] = useState<Record<string, string>>({});
  const [showSkips, setShowSkips] = useState(false);
  const [includeUserPrompt, setIncludeUserPrompt] = useState(false);

  useEffect(() => {
    fetch(`${API_URL}/replay/${roomId}`)
      .then((res) => res.json())
      .then((json: ReplayData) => {
        setData(json);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [roomId]);

  useEffect(() => {
    fetch(`${API_URL}/replay/debug/prompts`)
      .then((res) => res.json())
      .then((prompts: Record<string, string>) => setLocalPrompts(prompts))
      .catch(() => {});
  }, []);

  if (loading) {
    return (
      <main className="replay-page">
        <div className="replay-loading">加载复盘中...</div>
      </main>
    );
  }

  if (error || !data?.ok || !data.room) {
    return (
      <main className="replay-page">
        <div className="replay-error">
          <p>{error || data?.error || "复盘数据加载失败"}</p>
          <button onClick={() => router.push("/")}>返回大厅</button>
        </div>
      </main>
    );
  }

  const room = data.room;
  const aiCallLogs = data.aiCallLogs;
  const playerMap = new Map(room.players.map((p) => [p.id, p]));
  const seatMap = new Map(room.players.map((p) => [p.id, p.seatNo]));

  // Group by round
  const roundMap = new Map<number, { roundNo: number; messages: PublicMessage[]; votes: PublicVoteResult[]; aiCalls: AiCallLog[] }>();
  const maxRound = Math.max(room.currentRound, ...aiCallLogs.map((l) => l.roundNo), 1);
  for (let r = 1; r <= maxRound; r++) {
    roundMap.set(r, { roundNo: r, messages: [], votes: [], aiCalls: [] });
  }
  for (const msg of room.messages) {
    roundMap.get(msg.roundNo)?.messages.push(msg);
  }
  for (const vote of room.voteResults) {
    roundMap.get(vote.roundNo)?.votes.push(vote);
  }
  for (const call of aiCallLogs) {
    roundMap.get(call.roundNo)?.aiCalls.push(call);
  }
  const rounds = [...roundMap.values()];

  function handleExport(
    room: NonNullable<ReplayData["room"]>,
    aiCallLogs: AiCallLog[],
    includeSkips: boolean,
    includeUserPrompt: boolean,
  ) {
    const stripAiCall = (call: AiCallLog) => {
      const base = {
        callType: call.callType,
        aiPlayerName: call.aiPlayerName,
        aiPlayerSeatNo: call.aiPlayerSeatNo,
        modelName: call.modelName,
        rawResponse: call.rawResponse,
        createdAt: call.createdAt,
      };
      if (includeUserPrompt) {
        return { ...base, userPrompt: call.userPrompt };
      }
      return base;
    };

    const exportData = {
      roomId: room.id,
      winner: room.winner,
      currentRound: room.currentRound,
      config: room.config,
      players: room.players
        .slice()
        .sort((a, b) => a.seatNo - b.seatNo)
        .map((p) => ({
          seatNo: p.seatNo,
          name: p.name,
          revealedType: p.revealedType ?? null,
          simulated: p.simulated ?? false,
          aiPersonaId: p.aiPersonaId ?? null,
          aiPersonaName: p.aiPersonaName ?? null,
          status: p.status,
          eliminatedRound: p.eliminatedRound ?? null,
        })),
      rounds: rounds.map((r) => {
        const timeline = buildTimeline(r.messages, r.votes, r.aiCalls, playerMap);
        const messages: Record<string, unknown>[] = [];
        const voteRounds: { votes: Record<string, unknown>[]; aiCalls: Record<string, unknown>[] }[] = [];
        for (const item of timeline) {
          if (item.type === "message") {
            messages.push({
              seatNo: seatMap.get(item.msg.playerId) ?? "?",
              playerName: item.msg.playerName,
              content: item.msg.content,
              source: item.msg.source ?? null,
              createdAt: item.msg.createdAt,
              aiCalls: item.aiCalls.map(stripAiCall),
            });
          } else if (item.type === "skip" && includeSkips) {
            let reason = "";
            try {
              const parsed = JSON.parse(item.call.rawResponse);
              reason = parsed.reason ?? "";
            } catch { /* ignore */ }
            messages.push({
              type: "skip",
              seatNo: item.call.aiPlayerSeatNo,
              playerName: item.call.aiPlayerName,
              reason,
              createdAt: item.call.createdAt,
            });
          } else if (item.type === "voteRound") {
            const voteCallMap = new Map(item.aiCalls.map((c) => [c.aiPlayerId, c.id]));
            voteRounds.push({
              votes: item.votes.map((v) => {
                const voterCallId = voteCallMap.get(v.voterPlayerId);
                const voterCall = voterCallId ? item.aiCalls.find((c) => c.id === voterCallId) : undefined;
                return {
                  voterSeatNo: seatMap.get(v.voterPlayerId) ?? "?",
                  voterName: playerMap.get(v.voterPlayerId)?.name ?? "?",
                  targetSeatNo: seatMap.get(v.targetPlayerId) ?? "?",
                  targetName: playerMap.get(v.targetPlayerId)?.name ?? "?",
                  ...(voterCall ? { aiCall: stripAiCall(voterCall) } : {}),
                };
              }),
            });
          }
        }
        return {
          roundNo: r.roundNo,
          messages,
          votes: voteRounds[0] ?? { votes: [] },
        };
      }),
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `replay-${room.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="replay-page">
      {/* Header */}
      <header className="replay-header">
        <div className="replay-header-left">
          <h1>复盘 - Room {room.id}</h1>
          <span className={`replay-result ${room.winner === "human" ? "win" : room.winner === "ai" ? "loss" : "aborted"}`}>
            {winnerLabel(room.winner)}
          </span>
        </div>
        <div className="replay-header-actions">
          <label className="replay-toggle-switch">
            <input
              type="checkbox"
              checked={showSkips}
              onChange={(e) => setShowSkips(e.target.checked)}
            />
            <span className="replay-toggle-slider" />
            <span className="replay-toggle-label">显示 Skip 记录</span>
          </label>
          <label className="replay-toggle-switch">
            <input
              type="checkbox"
              checked={includeUserPrompt}
              onChange={(e) => setIncludeUserPrompt(e.target.checked)}
            />
            <span className="replay-toggle-slider" />
            <span className="replay-toggle-label">导出用户提示词</span>
          </label>
          <button className="secondary" onClick={() => handleExport(room, aiCallLogs, showSkips, includeUserPrompt)}>
            导出 JSON
          </button>
          <button className="secondary" onClick={() => router.push("/")}>
            返回大厅
          </button>
        </div>
      </header>

      {/* Player Overview */}
      <section className="replay-section">
        <h2>玩家概览</h2>
        <div className="replay-players">
          {room.players
            .slice()
            .sort((a, b) => a.seatNo - b.seatNo)
            .map((player) => (
              <div
                key={player.id}
                className={`replay-player ${player.status === "eliminated" ? "eliminated" : ""}`}
              >
                <div
                  className="replay-player-avatar"
                  style={{ backgroundColor: getSeatColor(player.seatNo) }}
                >
                  {player.seatNo}
                </div>
                <div className="replay-player-info">
                  <strong>#{player.seatNo} {player.name}</strong>
                  <div className="replay-player-tags">
                    {player.revealedType && (
                      <span className={`identity-tag ${player.revealedType}`}>
                        {player.revealedType === "ai" ? "AI" : "真人"}
                      </span>
                    )}
                    {player.aiPersonaName && (
                      <span className="replay-persona-tag">
                        {player.aiPersonaName}
                      </span>
                    )}
                    {player.status === "eliminated" ? (
                      <span className="replay-dead">第{player.eliminatedRound}轮淘汰</span>
                    ) : (
                      <span className="replay-alive">存活</span>
                    )}
                  </div>
                </div>
              </div>
            ))}
        </div>
      </section>

      {/* Round-by-round detail */}
      {rounds.map((round) => {
        const timeline = buildTimeline(round.messages, round.votes, round.aiCalls, playerMap);

        return (
          <section key={round.roundNo} className="replay-section">
            <h2>第 {round.roundNo} 轮</h2>

            <div className="replay-timeline">
              {timeline.map((item, idx) => {
                if (item.type === "skip") {
                  if (!showSkips) return null;
                  let reason = "";
                  try {
                    const parsed = JSON.parse(item.call.rawResponse);
                    reason = parsed.reason ?? "";
                  } catch { /* ignore */ }
                  return (
                    <div key={`skip-${item.call.id}`} className="replay-timeline-item replay-skip-item">
                      <div className="replay-skip-row">
                        <span
                          className="replay-msg-avatar"
                          style={{ backgroundColor: getSeatColor(item.call.aiPlayerSeatNo) }}
                        >
                          {item.call.aiPlayerSeatNo}
                        </span>
                        <div className="replay-skip-body">
                          <strong>{item.call.aiPlayerName}</strong>
                          <span className="replay-skip-badge">Skip</span>
                          {reason && <span className="replay-skip-reason">{reason}</span>}
                        </div>
                        <span className="replay-skip-time">{new Date(item.call.createdAt).toLocaleTimeString()}</span>
                      </div>
                      <div className="replay-msg-ai-calls">
                        <AiCallInline call={item.call} systemPrompt={localPrompts[item.call.callType] ?? ""} />
                      </div>
                    </div>
                  );
                }

                if (item.type === "message") {
                  const seatNo = seatMap.get(item.msg.playerId) ?? "?";
                  const player = playerMap.get(item.msg.playerId);
                  return (
                    <div key={`msg-${item.msg.id}`} className="replay-timeline-item">
                      <div className="replay-message">
                        <span
                          className="replay-msg-avatar"
                          style={{ backgroundColor: getSeatColor(Number(seatNo)) }}
                        >
                          {seatNo}
                        </span>
                        <div className="replay-msg-body">
                          <strong>{item.msg.playerName}</strong>
                          {item.msg.source && (
                            <span className={`identity-tag mini ${item.msg.source}${player?.simulated ? " simulated" : ""}`}>
                              {item.msg.source === "ai" ? "AI" : player?.simulated ? "模拟真人" : "真人"}
                            </span>
                          )}
                          <p>{item.msg.content}</p>
                        </div>
                        <span className="replay-msg-time">{new Date(item.msg.createdAt).toLocaleTimeString()}</span>
                      </div>
                      {item.aiCalls.length > 0 && (
                        <AiCallGroup calls={item.aiCalls} systemPrompts={localPrompts} />
                      )}
                    </div>
                  );
                }

                // voteRound
                const voteCallMap = new Map(item.aiCalls.map((c) => [c.aiPlayerId, c]));
                return (
                  <div key={`vote-${item.roundNo}-${idx}`} className="replay-timeline-item">
                    <div className="replay-votes">
                      {item.votes.map((vote) => {
                        const voterSeat = seatMap.get(vote.voterPlayerId) ?? "?";
                        const targetSeat = seatMap.get(vote.targetPlayerId) ?? "?";
                        const voter = playerMap.get(vote.voterPlayerId);
                        const target = playerMap.get(vote.targetPlayerId);
                        const voterCall = voteCallMap.get(vote.voterPlayerId);
                        return (
                          <div key={vote.id}>
                            <div className="replay-vote">
                              <span className="replay-vote-voter">
                                <span
                                  className="replay-msg-avatar"
                                  style={{ backgroundColor: getSeatColor(Number(voterSeat)) }}
                                >
                                  {voterSeat}
                                </span>
                                {voter?.name ?? voterSeat}号
                              </span>
                              <span className="replay-vote-arrow">→</span>
                              <span className="replay-vote-target">
                                <span
                                  className="replay-msg-avatar"
                                  style={{ backgroundColor: getSeatColor(Number(targetSeat)) }}
                                >
                                  {targetSeat}
                                </span>
                                {target?.name ?? targetSeat}号
                              </span>
                            </div>
                            {voterCall && (
                              <div className="replay-msg-ai-calls">
                                <AiCallInline call={voterCall} systemPrompt={localPrompts[voterCall.callType] ?? ""} />
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}

      {aiCallLogs.length === 0 && (
        <div className="replay-empty-logs">
          暂无 AI 调用记录（可能未在调试模式下进行此对局）
        </div>
      )}
    </main>
  );
}
