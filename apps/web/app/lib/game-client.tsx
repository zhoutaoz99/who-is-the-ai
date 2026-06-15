"use client";

import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { io, Socket } from "socket.io-client";
import { useAuth } from "./auth-client";
import { applyRoundTickToRooms } from "./game-state";
import {
  ActionResult,
  IterationGameResult,
  IterationRunStatus,
  RoomSnapshot,
  RoundTickPayload,
  ServerReadyPayload,
  SpeechDiscardedPayload,
  SpeechGeneratingPayload,
  StartIterationPayload,
} from "./game-types";

type GameClientContextValue = {
  debug: boolean;
  connected: boolean;
  pending: boolean;
  error: string;
  rooms: RoomSnapshot[];
  playerName: string;
  roomCode: string;
  speechGeneratings: SpeechGeneratingPayload[];
  speechDiscarded: SpeechDiscardedPayload | null;
  setPlayerName: (value: string) => void;
  setRoomCode: (value: string) => void;
  setError: (value: string) => void;
  getRoom: (roomId: string) => RoomSnapshot | null;
  getPlayerId: (roomId: string) => string | null;
  refreshRooms: (silent?: boolean) => Promise<{ ok: boolean; error?: string }>;
  createRoom: () => Promise<ActionResult>;
  createDebugAutoAiRoom: () => Promise<ActionResult>;
  joinRoom: (roomId?: string) => Promise<ActionResult>;
  leaveRoom: (roomId: string) => Promise<ActionResult>;
  reconnectRoom: (roomId: string) => Promise<ActionResult>;
  startGame: (roomId: string) => Promise<ActionResult>;
  addDebugAi: (
    roomId: string,
    playerType?: "human" | "ai",
    personaId?: string,
    modelId?: string,
  ) => Promise<ActionResult>;
  removeDebugAi: (roomId: string, aiPlayerId: string) => Promise<ActionResult>;
  updateDebugModel: (roomId: string, targetPlayerId: string, modelId: string) => Promise<ActionResult>;
  deleteDebugAutoAiRoom: (roomId: string) => Promise<ActionResult>;
  deleteRoom: (roomId: string) => Promise<ActionResult>;
  updateDiscussionDuration: (
    roomId: string,
    discussionDurationMinutes: number,
  ) => Promise<ActionResult>;
  updateDebugAutoAiSequentialSpeech: (
    roomId: string,
    sequentialSpeech: boolean,
  ) => Promise<ActionResult>;
  sendChat: (roomId: string, content: string) => Promise<ActionResult>;
  castVote: (roomId: string, targetPlayerId: string) => Promise<ActionResult>;
  stopGame: (roomId: string) => Promise<ActionResult>;
  fetchRoom: (roomId: string) => Promise<RoomSnapshot | null>;
  iterationRun: IterationRunStatus | null;
  startIteration: (payload: StartIterationPayload) => Promise<ActionResult>;
  continueIteration: () => Promise<ActionResult>;
  retryAutoEdit: () => Promise<ActionResult>;
  stopIteration: () => Promise<ActionResult>;
  refreshIteration: () => Promise<void>;
};

const API_URL =
  process.env.NEXT_PUBLIC_API_URL ||
  (typeof window !== "undefined"
    ? `${window.location.protocol}//${window.location.hostname}:3001`
    : "http://localhost:3001");
const PLAYER_NAME_KEY = "ai-werewolf-name";
const PLAYER_ID_PREFIX = "ai-werewolf-player-";

function speechGeneratingKey(payload: SpeechGeneratingPayload) {
  return [
    payload.roomId ?? "",
    payload.roundNo ?? "",
    payload.playerId,
    payload.startedAt ?? "",
  ].join(":");
}

function isSameSpeechGenerating(
  first: Pick<SpeechGeneratingPayload, "roomId" | "roundNo" | "playerId">,
  second: Pick<SpeechGeneratingPayload, "roomId" | "roundNo" | "playerId">,
) {
  return (
    first.playerId === second.playerId &&
    (!first.roomId || !second.roomId || first.roomId === second.roomId) &&
    (!first.roundNo || !second.roundNo || first.roundNo === second.roundNo)
  );
}

function upsertSpeechGenerating(
  items: SpeechGeneratingPayload[] | undefined,
  payload: SpeechGeneratingPayload,
) {
  return [
    ...(items ?? []).filter((item) => !isSameSpeechGenerating(item, payload)),
    payload,
  ];
}

function removeSpeechGenerating(
  items: SpeechGeneratingPayload[] | undefined,
  payload: Pick<SpeechGeneratingPayload, "roomId" | "roundNo" | "playerId">,
) {
  const next = (items ?? []).filter((item) => !isSameSpeechGenerating(item, payload));
  return next.length > 0 ? next : undefined;
}

const GameClientContext = createContext<GameClientContextValue | null>(null);

export function GameClientProvider({ children }: { children: ReactNode }) {
  const { token, user } = useAuth();
  const socketRef = useRef<Socket | null>(null);
  const [debug, setDebug] = useState(false);
  const [connected, setConnected] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [rooms, setRooms] = useState<RoomSnapshot[]>([]);
  const [playerIds, setPlayerIds] = useState<Record<string, string>>({});
  const [playerName, setPlayerName] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [speechGeneratings, setSpeechGeneratings] = useState<SpeechGeneratingPayload[]>([]);
  const [speechDiscarded, setSpeechDiscarded] = useState<SpeechDiscardedPayload | null>(null);
  const [iterationRun, setIterationRun] = useState<IterationRunStatus | null>(null);
  const speechGeneratingClearTimersRef = useRef<Record<string, number>>({});
  const speechDiscardedClearTimerRef = useRef<number | null>(null);

  const clearSpeechGeneratingTimers = useCallback(() => {
    for (const timer of Object.values(speechGeneratingClearTimersRef.current)) {
      window.clearTimeout(timer);
    }
    speechGeneratingClearTimersRef.current = {};
  }, []);

  const clearSpeechDiscardedTimer = useCallback(() => {
    if (speechDiscardedClearTimerRef.current == null) {
      return;
    }

    window.clearTimeout(speechDiscardedClearTimerRef.current);
    speechDiscardedClearTimerRef.current = null;
  }, []);

  const clearResolvedSpeechGenerating = useCallback(
    (snapshot: RoomSnapshot) => {
      setSpeechGeneratings((current) => {
        if (current.length === 0) {
          return current;
        }

        const next = current.filter((item) => {
          if (item.roomId && item.roomId !== snapshot.id) {
            return true;
          }
          if (item.roundNo && item.roundNo !== snapshot.currentRound) {
            return false;
          }
          if (snapshot.status !== "playing" || snapshot.phase !== "discussion") {
            return false;
          }

          const startedAtMs = item.startedAt
            ? new Date(item.startedAt).getTime()
            : Number.NaN;
          const hasNewMessage = snapshot.messages.some((message) => {
            if (message.playerId !== item.playerId) {
              return false;
            }
            if (item.roundNo && message.roundNo !== item.roundNo) {
              return false;
            }
            if (!Number.isFinite(startedAtMs)) {
              return true;
            }

            return new Date(message.createdAt).getTime() >= startedAtMs - 1_000;
          });
          return !hasNewMessage;
        });
        return next.length === current.length ? current : next;
      });
    },
    [],
  );

  const upsertRoom = useCallback((snapshot: RoomSnapshot) => {
    clearResolvedSpeechGenerating(snapshot);
    setRooms((current) => {
      const existing = current.find((room) => room.id === snapshot.id);
      const next = current.filter((room) => room.id !== snapshot.id);

      if (!existing) {
        return [snapshot, ...next].slice(0, 12);
      }

      const snapshotIds = new Set(snapshot.messages.map((m) => m.id));
      const preservedMessages = existing.messages.filter(
        (m) => !snapshotIds.has(m.id),
      );
      const mergedMessages =
        preservedMessages.length > 0
          ? [...preservedMessages, ...snapshot.messages].sort(
              (a, b) =>
                new Date(a.createdAt).getTime() -
                new Date(b.createdAt).getTime(),
            )
          : snapshot.messages;

      return [{ ...snapshot, messages: mergedMessages }, ...next].slice(0, 12);
    });
  }, [clearResolvedSpeechGenerating]);

  const applyRoundTick = useCallback((payload: RoundTickPayload) => {
    setRooms((current) => applyRoundTickToRooms(current, payload));
  }, []);

  useEffect(() => {
    const storedName = window.localStorage.getItem(PLAYER_NAME_KEY);
    if (storedName) {
      setPlayerName(storedName);
    }

    const storedPlayerIds: Record<string, string> = {};
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith(PLAYER_ID_PREFIX)) {
        continue;
      }
      const roomId = key.slice(PLAYER_ID_PREFIX.length);
      const value = window.localStorage.getItem(key);
      if (roomId && value) {
        storedPlayerIds[roomId] = value;
      }
    }
    setPlayerIds(storedPlayerIds);
  }, []);

  useEffect(() => {
    const socket = io(API_URL, {
      transports: ["websocket", "polling"],
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      void refreshIteration();
    });
    socket.on("disconnect", () => {
      setConnected(false);
      clearSpeechGeneratingTimers();
      clearSpeechDiscardedTimer();
      setSpeechGeneratings([]);
      setSpeechDiscarded(null);
    });
    socket.on("server.ready", (payload: ServerReadyPayload) => {
      setDebug(Boolean(payload.debug));
      setRooms(payload.rooms);
    });

    const syncRoom = (snapshot: RoomSnapshot) => upsertRoom(snapshot);
    socket.on("room.updated", syncRoom);
    socket.on("game.started", syncRoom);
    socket.on("round.started", syncRoom);
    socket.on("vote.started", syncRoom);
    socket.on("vote.updated", syncRoom);
    socket.on("game.ended", syncRoom);
    socket.on("round.tick", applyRoundTick);

    // 迭代 run 实时事件:status 全量快照;game 单局进度按 gameIndex/roomId 合并。
    socket.on("iteration.status", (payload: IterationRunStatus) =>
      setIterationRun(payload),
    );
    socket.on("iteration.game", (payload: IterationGameResult) =>
      setIterationRun((current) =>
        current && current.status === "running"
          ? {
              ...current,
              currentRoundGames: upsertIterationGame(
                current.currentRoundGames,
                payload,
              ),
            }
          : current,
      ),
    );
    socket.on("iteration.round", () => {
      /* round 聚合已包含在随后的 iteration.status 全量快照中 */
    });
    socket.on("iteration.done", () => {
      /* completed 状态由随后的 iteration.status 全量快照携带 */
    });

    socket.on("player.speech.generating", (payload: SpeechGeneratingPayload) => {
      const nextPayload = {
        ...payload,
        startedAt: payload.startedAt ?? new Date().toISOString(),
      };
      setSpeechGeneratings((current) =>
        upsertSpeechGenerating(current, nextPayload),
      );
      setRooms((current) =>
        current.map((room) =>
          nextPayload.roomId && room.id !== nextPayload.roomId
            ? room
            : {
                ...room,
                speechGeneratings: upsertSpeechGenerating(
                  room.speechGeneratings,
                  nextPayload,
                ),
              },
        ),
      );
      setSpeechDiscarded((current) => {
        if (
          current?.playerId === nextPayload.playerId &&
          (!current.roomId || !nextPayload.roomId || current.roomId === nextPayload.roomId) &&
          (!current.roundNo || !nextPayload.roundNo || current.roundNo === nextPayload.roundNo)
        ) {
          clearSpeechDiscardedTimer();
          return null;
        }

        return current;
      });
      const timerKey = speechGeneratingKey(nextPayload);
      const existingTimer = speechGeneratingClearTimersRef.current[timerKey];
      if (existingTimer) {
        window.clearTimeout(existingTimer);
      }
      speechGeneratingClearTimersRef.current[timerKey] = window.setTimeout(() => {
        setSpeechGeneratings((current) =>
          current.filter((item) => speechGeneratingKey(item) !== timerKey),
        );
        setRooms((current) =>
          current.map((room) =>
            nextPayload.roomId && room.id !== nextPayload.roomId
              ? room
              : {
                  ...room,
                  speechGeneratings: removeSpeechGenerating(
                    room.speechGeneratings,
                    nextPayload,
                  ),
                },
          ),
        );
        delete speechGeneratingClearTimersRef.current[timerKey];
      }, 120_000);
    });
    socket.on("player.speech.discarded", (payload: SpeechDiscardedPayload) => {
      clearSpeechDiscardedTimer();
      const nextPayload = {
        ...payload,
        discardedAt: payload.discardedAt ?? new Date().toISOString(),
      };
      setSpeechGeneratings((current) =>
        current.filter((item) => !isSameSpeechGenerating(item, nextPayload)),
      );
      setRooms((current) =>
        current.map((room) =>
          nextPayload.roomId && room.id !== nextPayload.roomId
            ? room
            : {
                ...room,
                speechGeneratings: removeSpeechGenerating(
                  room.speechGeneratings,
                  nextPayload,
                ),
              },
        ),
      );
      setSpeechDiscarded(nextPayload);
      speechDiscardedClearTimerRef.current = window.setTimeout(() => {
        setSpeechDiscarded((current) => {
          if (
            current?.playerId === nextPayload.playerId &&
            current.roomId === nextPayload.roomId &&
            current.roundNo === nextPayload.roundNo &&
            current.discardedAt === nextPayload.discardedAt
          ) {
            return null;
          }

          return current;
        });
        speechDiscardedClearTimerRef.current = null;
      }, 4_000);
    });

    return () => {
      clearSpeechGeneratingTimers();
      clearSpeechDiscardedTimer();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [
    applyRoundTick,
    clearSpeechDiscardedTimer,
    clearSpeechGeneratingTimers,
    upsertRoom,
  ]);

  const rememberPlayer = useCallback((roomId: string, playerId: string) => {
    setPlayerIds((current) => ({
      ...current,
      [roomId]: playerId,
    }));
    window.localStorage.setItem(`${PLAYER_ID_PREFIX}${roomId}`, playerId);
  }, []);

  const forgetPlayer = useCallback((roomId: string) => {
    setPlayerIds((current) => {
      const next = { ...current };
      delete next[roomId];
      return next;
    });
    window.localStorage.removeItem(`${PLAYER_ID_PREFIX}${roomId}`);
  }, []);

  const emitAction = useCallback(
    <TPayload,>(event: string, payload: TPayload): Promise<ActionResult> => {
      setError("");
      const socket = socketRef.current;
      if (!socket || !connected) {
        const result = {
          ok: false,
          error: "后端尚未连接，请确认 API 服务已启动",
        };
        setError(result.error);
        return Promise.resolve(result);
      }

      setPending(true);
      return new Promise((resolve) => {
        socket
          .timeout(5_000)
          .emit(event, payload, (err: Error | null, result: ActionResult) => {
            setPending(false);
            if (err) {
              const timeoutResult = {
                ok: false,
                error: "请求超时，请稍后重试",
              };
              setError(timeoutResult.error);
              resolve(timeoutResult);
              return;
            }

            if (!result?.ok) {
              const failedResult = {
                ok: false,
                error: result?.error ?? "操作失败",
              };
              setError(failedResult.error);
              resolve(failedResult);
              return;
            }

            if (result.room) {
              upsertRoom(result.room);
              setRoomCode(result.room.id);
            }

            if (result.deletedRoomId) {
              setRooms((current) =>
                current.filter((room) => room.id !== result.deletedRoomId),
              );
            }

            if (result.room && result.playerId) {
              rememberPlayer(result.room.id, result.playerId);
            }

            resolve(result);
          });
      });
    },
    [connected, rememberPlayer, upsertRoom],
  );

  /** 拉取当前/最近一次迭代 run 的状态(首屏与断线重连兜底)。 */
  const refreshIteration = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/debug/iterations`);
      const json = await res.json();
      if (json?.ok) {
        setIterationRun(json.run ?? null);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const value = useMemo<GameClientContextValue>(() => {
    const normalizedName = (user?.displayName ?? playerName).trim();

    return {
      debug,
      connected,
      pending,
      error,
      rooms,
      playerName,
      roomCode,
      speechGeneratings,
      speechDiscarded,
      iterationRun,
      setPlayerName,
      setRoomCode,
      setError,
      getRoom: (roomId: string) =>
        rooms.find((room) => room.id === roomId.toUpperCase()) ?? null,
      getPlayerId: (roomId: string) => playerIds[roomId.toUpperCase()] ?? null,
      refreshRooms: (silent = false) => {
        if (!silent) setError("");
        const socket = socketRef.current;
        if (!socket || !connected) {
          const result = {
            ok: false,
            error: "后端尚未连接，请确认 API 服务已启动",
          };
          if (!silent) setError(result.error);
          return Promise.resolve(result);
        }

        if (!silent) setPending(true);
        return new Promise((resolve) => {
          socket
            .timeout(5_000)
            .emit(
              "room.list",
              {},
              (
                err: Error | null,
                result?: {
                  ok: boolean;
                  debug?: boolean;
                  error?: string;
                  rooms?: RoomSnapshot[];
                },
              ) => {
                if (!silent) setPending(false);
                if (err) {
                  const timeoutResult = {
                    ok: false,
                    error: "刷新超时，请稍后重试",
                  };
                  if (!silent) setError(timeoutResult.error);
                  resolve(timeoutResult);
                  return;
                }

                if (!result?.ok) {
                  const failedResult = {
                    ok: false,
                    error: result?.error ?? "刷新失败",
                  };
                  if (!silent) setError(failedResult.error);
                  resolve(failedResult);
                  return;
                }

                setDebug(Boolean(result.debug));
                setRooms((current) => {
                  const next = result.rooms ?? [];
                  if (
                    current.length === next.length &&
                    current.every(
                      (r, i) => JSON.stringify(r) === JSON.stringify(next[i]),
                    )
                  ) {
                    return current;
                  }
                  return next;
                });
                resolve({ ok: true });
              },
            );
        });
      },
      createRoom: async () => {
        if (!normalizedName) {
          const result = { ok: false, error: "请先输入昵称" };
          setError(result.error);
          return result;
        }

        window.localStorage.setItem(PLAYER_NAME_KEY, normalizedName);
        return emitAction("room.create", {
          authToken: token || undefined,
          playerName: normalizedName,
        });
      },
      createDebugAutoAiRoom: async () =>
        emitAction("debug.ai-room.create", {}),
      startIteration: async (payload: StartIterationPayload) =>
        emitAction<StartIterationPayload>("iteration.start", payload ?? {}),
      continueIteration: async () => emitAction("iteration.continue", {}),
      retryAutoEdit: async () => emitAction("iteration.retryAutoEdit", {}),
      stopIteration: async () => emitAction("iteration.stop", {}),
      refreshIteration,
      joinRoom: async (roomId?: string) => {
        const targetRoomId = (roomId ?? roomCode).trim().toUpperCase();
        if (!normalizedName) {
          const result = { ok: false, error: "请先输入昵称" };
          setError(result.error);
          return result;
        }
        if (!targetRoomId) {
          const result = { ok: false, error: "请输入房间号" };
          setError(result.error);
          return result;
        }

        window.localStorage.setItem(PLAYER_NAME_KEY, normalizedName);
        return emitAction("room.join", {
          authToken: token || undefined,
          roomId: targetRoomId,
          playerName: normalizedName,
        });
      },
      leaveRoom: async (roomId: string) => {
        const result = await emitAction("room.leave", {
          roomId: roomId.toUpperCase(),
          playerId: playerIds[roomId.toUpperCase()],
        });
        if (result.ok) {
          forgetPlayer(roomId.toUpperCase());
        }
        return result;
      },
      reconnectRoom: async (roomId: string) => {
        const storedPlayerId = playerIds[roomId.toUpperCase()];
        if (!storedPlayerId) {
          return { ok: false, error: "未找到玩家信息" };
        }
        return emitAction("room.reconnect", {
          roomId: roomId.toUpperCase(),
          playerId: storedPlayerId,
        });
      },
      startGame: (roomId: string) =>
        emitAction("game.start", {
          roomId,
          playerId: playerIds[roomId.toUpperCase()],
        }),
      addDebugAi: (
        roomId: string,
        playerType: "human" | "ai" = "ai",
        personaId?: string,
        modelId?: string,
      ) =>
        emitAction("debug.ai.add", {
          roomId,
          playerId: playerIds[roomId.toUpperCase()],
          playerType,
          personaId,
          modelId,
        }),
      removeDebugAi: (roomId: string, aiPlayerId: string) =>
        emitAction("debug.ai.remove", {
          roomId,
          playerId: playerIds[roomId.toUpperCase()],
          aiPlayerId,
        }),
      updateDebugModel: (roomId: string, targetPlayerId: string, modelId: string) =>
        emitAction("debug.ai.updateModel", {
          roomId,
          playerId: playerIds[roomId.toUpperCase()],
          targetPlayerId,
          modelId,
        }),
      deleteDebugAutoAiRoom: (roomId: string) =>
        emitAction("debug.ai-room.delete", {
          roomId,
          playerId: playerIds[roomId.toUpperCase()],
        }),
      deleteRoom: (roomId: string) =>
        emitAction("room.delete", { roomId }),
      updateDiscussionDuration: (
        roomId: string,
        discussionDurationMinutes: number,
      ) =>
        emitAction("room.duration.update", {
          roomId,
          playerId: playerIds[roomId.toUpperCase()],
          discussionDurationMinutes,
        }),
      updateDebugAutoAiSequentialSpeech: (roomId: string, sequentialSpeech: boolean) =>
        emitAction("debug.ai-room.sequentialSpeech.update", {
          roomId,
          playerId: playerIds[roomId.toUpperCase()],
          sequentialSpeech,
        }),
      sendChat: (roomId: string, content: string) =>
        emitAction("chat.send", {
          roomId,
          playerId: playerIds[roomId.toUpperCase()],
          content,
        }),
      castVote: (roomId: string, targetPlayerId: string) =>
        emitAction("vote.cast", {
          roomId,
          playerId: playerIds[roomId.toUpperCase()],
          targetPlayerId,
        }),
      stopGame: (roomId: string) =>
        emitAction("game.stop", {
          roomId,
          playerId: playerIds[roomId.toUpperCase()],
        }),
      fetchRoom: async (roomId: string) => {
        const upperId = roomId.toUpperCase();
        const local = rooms.find((r) => r.id === upperId);

        const socket = socketRef.current;
        if (socket && connected) {
          const observed = await new Promise<RoomSnapshot | null>((resolve) => {
            socket
              .timeout(5_000)
              .emit(
                "room.observe",
                { roomId: upperId },
                (err: Error | null, result?: ActionResult) => {
                  if (err || !result?.ok || !result.room) {
                    resolve(null);
                    return;
                  }

                  upsertRoom(result.room);
                  resolve(result.room);
                },
              );
          });

          if (observed) {
            return observed;
          }
        }

        if (local) return local;

        try {
          const response = await fetch(`${API_URL}/rooms/${upperId}`);
          const data = await response.json();
          if (data.ok && data.room) {
            upsertRoom(data.room);
            return data.room;
          }
        } catch {
          // ignore
        }
        return null;
      },
    };
  }, [
    connected,
    debug,
    emitAction,
    error,
    forgetPlayer,
    iterationRun,
    pending,
    playerIds,
    playerName,
    refreshIteration,
    roomCode,
    rooms,
    speechGeneratings,
    speechDiscarded,
    token,
    user?.displayName,
  ]);

  return (
    <GameClientContext.Provider value={value}>
      {children}
    </GameClientContext.Provider>
  );
}

export function useGameClient() {
  const context = useContext(GameClientContext);
  if (!context) {
    throw new Error("useGameClient must be used inside GameClientProvider");
  }
  return context;
}

function upsertIterationGame(
  games: IterationGameResult[],
  next: IterationGameResult,
): IterationGameResult[] {
  const idx = games.findIndex((game) =>
    (next.roomId && game.roomId === next.roomId) ||
    game.gameIndex === next.gameIndex,
  );
  const merged =
    idx >= 0
      ? games.map((game, i) => (i === idx ? { ...game, ...next } : game))
      : [...games, next];
  return merged.slice().sort((a, b) => (a.gameIndex ?? 0) - (b.gameIndex ?? 0));
}
