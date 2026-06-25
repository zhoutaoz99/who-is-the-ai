// 探测触发时点判定 + 边界处理(《场景与探测·Schema契约》§6)。

import type { Timing } from "../scenario/types";

export interface TimingContext {
  round: number;
  /** 本轮目前已发出的消息数(不含待投放的探测)。 */
  msgCountThisRound: number;
  /** 本轮被测 AI 是否已发言。 */
  aiSpokeThisRound: boolean;
}

/** 该 fire 是否"现在到期"(用于 first_turn / after_turn / after_ai_speaks)。last_turn 另算。 */
export function isProbeDue(
  timing: Timing,
  ctx: TimingContext,
): boolean {
  if (ctx.round !== ctx.round) return false; // noop
  if (timing.first_turn === true) return ctx.msgCountThisRound === 0;
  if (timing.after_turn != null) return ctx.msgCountThisRound >= timing.after_turn;
  if (timing.after_ai_speaks === true) return ctx.aiSpokeThisRound;
  return false;
}

/** 是否为 last_turn 时点(进入投票前投放)。 */
export function isLastTurnTiming(timing: Timing): boolean {
  return timing.last_turn === true;
}

/**
 * 选一个可派发的替代投放者:from_seat 已出局时,从存活的非 AI 槽位里确定性挑一个。
 * 返回 null = 无人可派(skipped_no_deliverer)。
 */
export function reassignDeliverer(
  aliveNonAiSeats: number[],
  originalSeat: number,
  seedParts: Array<number | string>,
): number | null {
  const pool = aliveNonAiSeats.filter((s) => s !== originalSeat);
  if (pool.length === 0) {
    // 原投放者已挂且无其他人,看原投放者是否还活着(调用方已判定),否则跳过
    return aliveNonAiSeats.length > 0 ? aliveNonAiSeats[0] : null;
  }
  pool.sort((a, b) => a - b);
  return pool[pickIndexDeterministic(pool.length, seedParts)];
}

function pickIndexDeterministic(length: number, seedParts: Array<number | string>): number {
  // 内联轻量哈希,避免与 rng 循环依赖(本文件保持无副作用导入)
  let h = 0x811c9dc5;
  for (const p of seedParts) {
    const s = String(p);
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 0x2f;
    h = Math.imul(h, 0x01000193);
  }
  const x = (h >>> 0) / 4294967296;
  return Math.floor(x * length);
}
