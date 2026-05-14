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
import { ActionResult, RoomSnapshot, ServerReadyPayload } from "./game-types";

type GameClientContextValue = {
  connected: boolean;
  pending: boolean;
  error: string;
  rooms: RoomSnapshot[];
  playerName: string;
  roomCode: string;
  discussionMinutes: number;
  setPlayerName: (value: string) => void;
  setRoomCode: (value: string) => void;
  setDiscussionMinutes: (value: number) => void;
  setError: (value: string) => void;
  getRoom: (roomId: string) => RoomSnapshot | null;
  getPlayerId: (roomId: string) => string | null;
  refreshRooms: () => Promise<{ ok: boolean; error?: string }>;
  createRoom: () => Promise<ActionResult>;
  joinRoom: (roomId?: string) => Promise<ActionResult>;
  leaveRoom: (roomId: string) => Promise<ActionResult>;
  reconnectRoom: (roomId: string) => Promise<ActionResult>;
  startGame: (roomId: string) => Promise<ActionResult>;
  sendChat: (roomId: string, content: string) => Promise<ActionResult>;
  castVote: (roomId: string, targetPlayerId: string) => Promise<ActionResult>;
};

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
const PLAYER_NAME_KEY = "ai-werewolf-name";
const PLAYER_ID_PREFIX = "ai-werewolf-player-";

const GameClientContext = createContext<GameClientContextValue | null>(null);

export function GameClientProvider({ children }: { children: ReactNode }) {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [rooms, setRooms] = useState<RoomSnapshot[]>([]);
  const [playerIds, setPlayerIds] = useState<Record<string, string>>({});
  const [playerName, setPlayerName] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [discussionMinutes, setDiscussionMinutes] = useState(5);

  const upsertRoom = useCallback((snapshot: RoomSnapshot) => {
    setRooms((current) => {
      const next = current.filter((room) => room.id !== snapshot.id);
      return [snapshot, ...next].slice(0, 12);
    });
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
      setRooms(payload.rooms);
    });

    const syncRoom = (snapshot: RoomSnapshot) => upsertRoom(snapshot);
    socket.on("room.updated", syncRoom);
    socket.on("game.started", syncRoom);
    socket.on("round.started", syncRoom);
    socket.on("vote.started", syncRoom);
    socket.on("vote.updated", syncRoom);
    socket.on("game.ended", syncRoom);

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [upsertRoom]);

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
    const normalizedName = playerName.trim();

    return {
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
      getRoom: (roomId: string) =>
        rooms.find((room) => room.id === roomId.toUpperCase()) ?? null,
      getPlayerId: (roomId: string) => playerIds[roomId.toUpperCase()] ?? null,
      refreshRooms: () => {
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
            .emit(
              "room.list",
              {},
              (
                err: Error | null,
                result?: { ok: boolean; error?: string; rooms?: RoomSnapshot[] },
              ) => {
                setPending(false);
                if (err) {
                  const timeoutResult = {
                    ok: false,
                    error: "刷新超时，请稍后重试",
                  };
                  setError(timeoutResult.error);
                  resolve(timeoutResult);
                  return;
                }

                if (!result?.ok) {
                  const failedResult = {
                    ok: false,
                    error: result?.error ?? "刷新失败",
                  };
                  setError(failedResult.error);
                  resolve(failedResult);
                  return;
                }

                setRooms(result.rooms ?? []);
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
          playerName: normalizedName,
          discussionDurationMinutes: Math.max(1, Math.floor(discussionMinutes)),
        });
      },
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
      sendChat: (roomId: string, content: string) =>
        emitAction("chat.send", {
          roomId,
          content,
        }),
      castVote: (roomId: string, targetPlayerId: string) =>
        emitAction("vote.cast", {
          roomId,
          targetPlayerId,
        }),
    };
  }, [
    connected,
    discussionMinutes,
    emitAction,
    error,
    forgetPlayer,
    pending,
    playerIds,
    playerName,
    roomCode,
    rooms,
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
