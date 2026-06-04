"use client";

import { useEffect, useRef } from "react";
import { ActionResult } from "./game-types";

type UseRoomReconnectOptions = {
  connected: boolean;
  disabled?: boolean;
  roomId: string;
  getPlayerId: (roomId: string) => string | null;
  reconnectRoom: (roomId: string) => Promise<ActionResult>;
};

export function useRoomReconnect({
  connected,
  disabled = false,
  roomId,
  getPlayerId,
  reconnectRoom,
}: UseRoomReconnectOptions) {
  const reconnectAttempted = useRef(false);

  useEffect(() => {
    if (!connected) {
      reconnectAttempted.current = false;
    }
  }, [connected]);

  useEffect(() => {
    if (disabled || !connected || reconnectAttempted.current) {
      return;
    }

    const storedPlayerId = getPlayerId(roomId);
    if (!storedPlayerId) {
      return;
    }

    reconnectAttempted.current = true;
    void reconnectRoom(roomId);
  }, [connected, disabled, roomId, getPlayerId, reconnectRoom]);
}
