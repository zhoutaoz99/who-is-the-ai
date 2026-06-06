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
  RoomSnapshot,
  RoundTickPayload,
  ServerReadyPayload,
} from "./game-types";

type GameClientContextValue = {
  debug: boolean;
  connected: boolean;
  pending: boolean;
  error: string;
  rooms: RoomSnapshot[];
  playerName: string;
  roomCode: string;
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
  updateDebugAutoAiFastMode: (
    roomId: string,
    fastMode: boolean,
  ) => Promise<ActionResult>;
  sendChat: (roomId: string, content: string) => Promise<ActionResult>;
  castVote: (roomId: string, targetPlayerId: string) => Promise<ActionResult>;
  stopGame: (roomId: string) => Promise<ActionResult>;
  fetchRoom: (roomId: string) => Promise<RoomSnapshot | null>;
};

const API_URL =
  process.env.NEXT_PUBLIC_API_URL ||
  (typeof window !== "undefined"
    ? `${window.location.protocol}//${window.location.hostname}:3001`
    : "http://localhost:3001");
const PLAYER_NAME_KEY = "ai-werewolf-name";
const PLAYER_ID_PREFIX = "ai-werewolf-player-";

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

  const upsertRoom = useCallback((snapshot: RoomSnapshot) => {
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
  }, []);

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

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));
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

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [applyRoundTick, upsertRoom]);

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
      updateDebugAutoAiFastMode: (roomId: string, fastMode: boolean) =>
        emitAction("debug.ai-room.fastMode.update", {
          roomId,
          playerId: playerIds[roomId.toUpperCase()],
          fastMode,
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
    pending,
    playerIds,
    playerName,
    roomCode,
    rooms,
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
