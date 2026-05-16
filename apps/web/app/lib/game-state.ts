import { GamePhase, RoomSnapshot, RoundTickPayload } from "./game-types";

const PHASE_ORDER: Record<GamePhase, number> = {
  waiting: 0,
  discussion: 1,
  voting: 2,
  resolving: 3,
  game_over: 4,
};

export function applyRoundTickToRooms(
  rooms: RoomSnapshot[],
  payload: RoundTickPayload,
): RoomSnapshot[] {
  return rooms.map((room) => {
    if (room.id !== payload.roomId || room.status !== "playing") {
      return room;
    }

    if (payload.roundNo < room.currentRound) {
      return room;
    }

    if (
      payload.roundNo === room.currentRound &&
      PHASE_ORDER[payload.phase] < PHASE_ORDER[room.phase]
    ) {
      return room;
    }

    return {
      ...room,
      currentRound: payload.roundNo,
      phase: payload.phase,
      phaseEndsAt:
        payload.remainingMs > 0
          ? new Date(Date.now() + payload.remainingMs).toISOString()
          : room.phaseEndsAt,
    };
  });
}
