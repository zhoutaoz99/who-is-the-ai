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
  OrchestratorChild,
  OrchestratorGame,
  OrchestratorGate,
  OrchestratorSnapshot,
  OrchestratorStartPayload,
  OrchestratorValidate,
  OrchestratorValidation,
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
  joinRoom: (roomId?: string) => Promise<ActionResult>;
  leaveRoom: (roomId: string) => Promise<ActionResult>;
  reconnectRoom: (roomId: string) => Promise<ActionResult>;
  startGame: (roomId: string) => Promise<ActionResult>;
  updateSandboxPlayerModel: (roomId: string, targetPlayerId: string, modelId: string) => Promise<ActionResult>;
  deleteSandboxRoom: (roomId: string) => Promise<ActionResult>;
  deleteRoom: (roomId: string) => Promise<ActionResult>;
  updateDiscussionDuration: (
    roomId: string,
    discussionDurationMinutes: number,
  ) => Promise<ActionResult>;
  sendChat: (roomId: string, content: string) => Promise<ActionResult>;
  castVote: (roomId: string, targetPlayerId: string) => Promise<ActionResult>;
  stopGame: (roomId: string) => Promise<ActionResult>;
  fetchRoom: (roomId: string) => Promise<RoomSnapshot | null>;
  iterationRun: IterationRunStatus | null;
  startIteration: (payload: StartIterationPayload) => Promise<ActionResult>;
  continueIteration: () => Promise<ActionResult>;
  retryAutoOptimize: () => Promise<ActionResult>;
  stopIteration: () => Promise<ActionResult>;
  refreshIteration: () => Promise<void>;
  // ===== 编排器一代闭环(F) =====
  orchestratorRun: OrchestratorSnapshot | null;
  refreshOrchestrator: () => Promise<void>;
  startOrchestratorAuto: (
    payload: OrchestratorStartPayload,
  ) => Promise<{ ok: boolean; error?: string; run_id?: string }>;
  stopOrchestrator: () => Promise<{ ok: boolean; error?: string }>;
  terminateOrchestrator: () => Promise<{ ok: boolean; error?: string }>;
  deleteOrchestratorGeneration: (id: string) => Promise<{ ok: boolean; error?: string }>;
  deleteOrchestratorVersion: (id: string) => Promise<{ ok: boolean; error?: string }>;
  deleteOrchestratorTried: (versionId: string) => Promise<{ ok: boolean; error?: string }>;
  clearOrchestratorTried: () => Promise<{ ok: boolean; error?: string }>;
  confirmOrchestrator: (
    accept: boolean,
    edited?: string,
  ) => Promise<{ ok: boolean; error?: string }>;
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
  const [orchestratorRun, setOrchestratorRun] =
    useState<OrchestratorSnapshot | null>(null);
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
      void refreshOrchestrator();
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
      // 合并而非替换:socket 状态快照不含 id/createdAt 等字段,
      // 替换会丢失它们并使「自动优化已耗时」等依赖 updatedAt 的逻辑失效。
      setIterationRun((current) => (current ? { ...current, ...payload } : payload)),
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

    // 编排器一代闭环(F):status 全量快照;match/proposal/gate 增量合并进 active_run。
    socket.on("orchestrator.status", (payload: OrchestratorSnapshot) =>
      setOrchestratorRun(payload),
    );
    // 逐局状态:按 side×scenario×seed×run 就地 upsert;done 计数随之重算(与服务端一致)。
    socket.on("orchestrator.game", (payload: OrchestratorGame) =>
      setOrchestratorRun((cur) => {
        if (!cur?.active_run) return cur;
        const games = upsertOrchestratorGame(cur.active_run.progress.games, payload);
        return {
          ...cur,
          active_run: {
            ...cur.active_run,
            progress: {
              ...cur.active_run.progress,
              champion_done: games.filter(
                (g) =>
                  g.side === "champion" &&
                  (g.status === "finished" || g.status === "failed"),
              ).length,
              child_done: games.filter(
                (g) =>
                  g.side === "child" &&
                  (g.status === "finished" || g.status === "failed"),
              ).length,
              games,
            },
          },
        };
      }),
    );
    socket.on(
      "orchestrator.proposal",
      (payload: { child: OrchestratorChild; validate: OrchestratorValidate }) =>
        setOrchestratorRun((cur) =>
          cur?.active_run
            ? {
                ...cur,
                active_run: {
                  ...cur.active_run,
                  child: payload.child,
                  validate: payload.validate,
                },
              }
            : cur,
        ),
    );
    socket.on(
      "orchestrator.gate",
      (payload: { validation: OrchestratorValidation; gate: OrchestratorGate }) =>
        setOrchestratorRun((cur) =>
          cur?.active_run
            ? {
                ...cur,
                active_run: {
                  ...cur.active_run,
                  validation: payload.validation,
                  gate: payload.gate,
                },
              }
            : cur,
        ),
    );
    socket.on("orchestrator.done", () => {
      /* settled 由随后的 orchestrator.status(active_run=null) 携带 */
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

  /** 拉取编排器快照(首屏与断线重连兜底)。 */
  const refreshOrchestrator = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/sandbox/orchestrator/state`);
      const json = await res.json();
      if (json?.ok) {
        setOrchestratorRun(json.state ?? null);
      }
    } catch {
      /* ignore */
    }
  }, []);

  /** 编排器 REST 动作统一封装(kickoff/stop/confirm)。 */
  const orchestratorRest = useCallback(
    async (
      path: string,
      body: Record<string, unknown>,
    ): Promise<{ ok: boolean; error?: string; [key: string]: unknown }> => {
      setError("");
      try {
        const res = await fetch(`${API_URL}/sandbox/orchestrator/${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = await res.json();
        if (!json?.ok) setError(json?.error ?? "操作失败");
        return json as { ok: boolean; error?: string; [key: string]: unknown };
      } catch {
        const fail = { ok: false, error: "请求失败,请确认 API 服务已启动" };
        setError(fail.error);
        return fail;
      }
    },
    [],
  );

  const orchestratorDelete = useCallback(
    async (path: string): Promise<{ ok: boolean; error?: string }> => {
      setError("");
      try {
        const res = await fetch(`${API_URL}/sandbox/orchestrator/${path}`, {
          method: "DELETE",
        });
        const json = await res.json();
        if (!json?.ok) setError(json?.error ?? "操作失败");
        return json as { ok: boolean; error?: string };
      } catch {
        const fail = { ok: false, error: "请求失败,请确认 API 服务已启动" };
        setError(fail.error);
        return fail;
      }
    },
    [],
  );

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
      startIteration: async (payload: StartIterationPayload) =>
        emitAction<StartIterationPayload>("iteration.start", payload ?? {}),
      continueIteration: async () => emitAction("iteration.continue", {}),
      retryAutoOptimize: async () => emitAction("iteration.retryAutoOptimize", {}),
      stopIteration: async () => emitAction("iteration.stop", {}),
      refreshIteration,
      orchestratorRun,
      refreshOrchestrator,
      startOrchestratorAuto: (payload: OrchestratorStartPayload) =>
        orchestratorRest(
          "run-generation-auto",
          payload as unknown as Record<string, unknown>,
        ) as Promise<{ ok: boolean; error?: string; run_id?: string }>,
      stopOrchestrator: () =>
        orchestratorRest("stop", {}) as Promise<{ ok: boolean; error?: string }>,
      terminateOrchestrator: () =>
        orchestratorRest("terminate", {}) as Promise<{ ok: boolean; error?: string }>,
      deleteOrchestratorGeneration: (id: string) =>
        orchestratorDelete(`generations/${encodeURIComponent(id)}`),
      deleteOrchestratorVersion: (id: string) =>
        orchestratorDelete(`versions/${encodeURIComponent(id)}`),
      deleteOrchestratorTried: (versionId: string) =>
        orchestratorDelete(`tried/${encodeURIComponent(versionId)}`),
      clearOrchestratorTried: () => orchestratorDelete("tried"),
      confirmOrchestrator: (accept: boolean, edited?: string) =>
        orchestratorRest("confirm", {
          accept,
          edited_prompt_text: edited,
        }) as Promise<{ ok: boolean; error?: string }>,
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
      updateSandboxPlayerModel: (roomId: string, targetPlayerId: string, modelId: string) =>
        emitAction("sandbox.player.updateModel", {
          roomId,
          playerId: playerIds[roomId.toUpperCase()],
          targetPlayerId,
          modelId,
        }),
      deleteSandboxRoom: (roomId: string) =>
        emitAction("sandbox.room.delete", {
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
    orchestratorRest,
    orchestratorRun,
    pending,
    playerIds,
    playerName,
    refreshIteration,
    refreshOrchestrator,
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

/** 从 match 事件载荷中去掉 progress 字段(进度计数已合并到 active_run.progress)。 */
function upsertOrchestratorGame(
  games: OrchestratorGame[],
  g: OrchestratorGame,
): OrchestratorGame[] {
  const idx = games.findIndex(
    (x) =>
      x.side === g.side &&
      x.scenario_id === g.scenario_id &&
      x.seed === g.seed &&
      x.run === g.run,
  );
  if (idx < 0) return [...games, g];
  const next = games.slice();
  next[idx] = { ...next[idx], ...g };
  return next;
}
