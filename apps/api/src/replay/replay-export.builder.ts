import type { PublicVoteResult, RoomSnapshot } from "../game/game.types";
import type { AiCallLog } from "./replay.types";

/**
 * 服务端版本的 replay 导出构建器,从 apps/web/app/replay/[roomId]/page.tsx 移植,
 * 产出与现有 replay-*.json 完全一致的结构(额外可带 promptGenerationId)。
 * 匹配方式与前端一致:按 round_no + 玩家 + 时间序做 index 匹配。
 */

type PublicMessage = RoomSnapshot["messages"][number];
type PublicPlayer = RoomSnapshot["players"][number];

type TimelineItem =
  | { type: "message"; msg: PublicMessage; aiCalls: AiCallLog[] }
  | {
      type: "voteRound";
      roundNo: number;
      votes: PublicVoteResult[];
      aiCalls: AiCallLog[];
    }
  | { type: "skip"; call: AiCallLog };

function isSkipCall(call: AiCallLog): boolean {
  if (call.callType !== "speech-strategy" && call.callType !== "sim-human-speech")
    return false;
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
  playerMap: Map<string, PublicPlayer>,
): TimelineItem[] {
  const items: TimelineItem[] = [];

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

  const aiMsgIndex = new Map<string, number>();
  const consumedCallIds = new Set<string>();

  const voteCallsByRound = new Map<number, AiCallLog[]>();
  for (const call of aiCalls) {
    if (call.callType === "vote" || call.callType === "sim-human-vote") {
      const list = voteCallsByRound.get(call.roundNo) ?? [];
      list.push(call);
      voteCallsByRound.set(call.roundNo, list);
    }
  }

  const skipCalls = aiCalls.filter((c) => isSkipCall(c));

  const voteRoundMap = new Map<number, PublicVoteResult[]>();
  for (const vote of votes) {
    const list = voteRoundMap.get(vote.roundNo) ?? [];
    list.push(vote);
    voteRoundMap.set(vote.roundNo, list);
  }

  const insertedVoteRounds = new Set<number>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const player = playerMap.get(msg.playerId);
    const isAi = player?.revealedType === "ai";
    const isSimulatedHuman =
      player?.revealedType === "human" && player.simulated;
    const msgCalls: AiCallLog[] = [];

    if (isAi || isSimulatedHuman) {
      const key = `${msg.playerId}:${msg.roundNo}`;
      const idx = aiMsgIndex.get(key) ?? 0;
      aiMsgIndex.set(key, idx + 1);

      if (isAi) {
        const expr = expressionCalls.get(key)?.[idx];
        const strat = strategyCalls.get(key)?.[idx];
        if (strat) {
          msgCalls.push(strat);
          consumedCallIds.add(strat.id);
        }
        if (expr) {
          msgCalls.push(expr);
          consumedCallIds.add(expr.id);
        }
      } else {
        const speech = simHumanSpeechCalls.get(key)?.[idx];
        if (speech) {
          msgCalls.push(speech);
          consumedCallIds.add(speech.id);
        }
      }
    }

    items.push({ type: "message", msg, aiCalls: msgCalls });

    const roundVotes = voteRoundMap.get(msg.roundNo);
    if (roundVotes && !insertedVoteRounds.has(msg.roundNo)) {
      const remainingMsgs = messages.slice(i + 1);
      const hasMoreInRound = remainingMsgs.some(
        (m) => m.roundNo === msg.roundNo,
      );
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

  const unconsumedSkips = skipCalls.filter((c) => !consumedCallIds.has(c.id));
  for (const skipCall of unconsumedSkips) {
    const skipTime = new Date(skipCall.createdAt).getTime();
    const skipItem: TimelineItem = { type: "skip", call: skipCall };

    let insertIdx = -1;
    for (let j = 0; j < items.length; j++) {
      const item = items[j];
      const itemRound =
        item.type === "message"
          ? item.msg.roundNo
          : item.type === "voteRound"
            ? item.roundNo
            : item.call.roundNo;
      if (itemRound !== skipCall.roundNo) continue;

      const itemTime =
        item.type === "message"
          ? new Date(item.msg.createdAt).getTime()
          : item.type === "voteRound"
            ? skipTime + 1
            : new Date(item.call.createdAt).getTime();

      if (itemTime > skipTime) {
        insertIdx = j;
        break;
      }
    }

    if (insertIdx >= 0) {
      items.splice(insertIdx, 0, skipItem);
    } else {
      const voteIdx = items.findIndex(
        (item) => item.type === "voteRound" && item.roundNo === skipCall.roundNo,
      );
      if (voteIdx >= 0) {
        items.splice(voteIdx, 0, skipItem);
      } else {
        items.push(skipItem);
      }
    }
  }

  return items;
}

export function buildReplayExportData(
  room: RoomSnapshot,
  aiCallLogs: AiCallLog[],
  options: {
    includeSkips: boolean;
    includeUserPrompt: boolean;
    promptGenerationId?: string;
  },
): Record<string, unknown> {
  const { includeSkips, includeUserPrompt, promptGenerationId } = options;
  const playerMap = new Map(room.players.map((p) => [p.id, p]));
  const seatMap = new Map(room.players.map((p) => [p.id, p.seatNo]));

  const roundMap = new Map<
    number,
    {
      roundNo: number;
      messages: PublicMessage[];
      votes: PublicVoteResult[];
      aiCalls: AiCallLog[];
    }
  >();
  const maxRound = Math.max(
    room.currentRound,
    ...aiCallLogs.map((l) => l.roundNo),
    1,
  );
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

  return {
    roomId: room.id,
    ...(promptGenerationId ? { promptGenerationId } : {}),
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
      const voteRounds: { votes: Record<string, unknown>[] }[] = [];
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
          } catch {
            /* ignore */
          }
          messages.push({
            type: "skip",
            seatNo: item.call.aiPlayerSeatNo,
            playerName: item.call.aiPlayerName,
            reason,
            createdAt: item.call.createdAt,
          });
        } else if (item.type === "voteRound") {
          const voteCallMap = new Map(
            item.aiCalls.map((c) => [c.aiPlayerId, c.id]),
          );
          voteRounds.push({
            votes: item.votes.map((v) => {
              const voterCallId = voteCallMap.get(v.voterPlayerId);
              const voterCall = voterCallId
                ? item.aiCalls.find((c) => c.id === voterCallId)
                : undefined;
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
}
