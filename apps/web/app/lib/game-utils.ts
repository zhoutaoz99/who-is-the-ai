import { GamePhase, RoomSnapshot, RoomStatus } from "./game-types";

export function humanCount(room: RoomSnapshot) {
  if (room.status === "finished") {
    return room.players.filter((player) => player.revealedType === "human").length;
  }

  if (room.status === "waiting") {
    if (room.players.some((player) => player.revealedType === "ai")) {
      return room.players.filter((player) => player.revealedType !== "ai")
        .length;
    }
    return room.players.length;
  }

  return Math.max(0, room.players.length - room.config.aiPlayerCount);
}

export function getPlayerSeatNo(room: RoomSnapshot, playerId: string) {
  return room.players.find((player) => player.id === playerId)?.seatNo ?? "?";
}

export function statusLabel(status: RoomStatus) {
  switch (status) {
    case "waiting":
      return "等待中";
    case "playing":
      return "游戏中";
    case "finished":
      return "已结束";
  }
}

export function winnerLabel(winner: "human" | "ai" | null) {
  switch (winner) {
    case "human":
      return "真人获胜";
    case "ai":
      return "AI 获胜";
    default:
      return "";
  }
}

export function sandboxWinnerLabel(winner: "human" | "ai" | null) {
  switch (winner) {
    case "human":
      return "侦探方获胜";
    case "ai":
      return "被测AI获胜";
    default:
      return "";
  }
}

export function phaseLabel(phase: GamePhase) {
  switch (phase) {
    case "waiting":
      return "等待开局";
    case "discussion":
      return "自由发言";
    case "voting":
      return "投票阶段";
    case "resolving":
      return "结算中";
    case "game_over":
      return "游戏结束";
  }
}

export function formatRemaining(ms: number) {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
