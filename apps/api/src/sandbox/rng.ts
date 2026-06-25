/**
 * 确定性 RNG(纯函数,无状态):用于沙盒场景层随机(probe 实例轮换、平票兜底等),
 * 保证 seed+run_index 相同时可复现。LLM 本身非逐字复现(设计稿已承认),这里只管非 LLM 随机。
 */

/** mulberry32:给定 32 位种子返回 [0,1) 的 PRNG 函数。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 把任意多个整数派生成一个稳定的 32 位种子(FNV-1a 变体)。 */
export function deriveSeed(...parts: Array<number | string>): number {
  let h = 0x811c9dc5;
  for (const part of parts) {
    const s = String(part);
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    // 分隔,避免 "12"+"3" 与 "1"+"23" 撞种子
    h ^= 0x2f;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 用派生种子从数组里确定性地取一个下标。 */
export function pickIndex(length: number, ...seedParts: Array<number | string>): number {
  if (length <= 0) return 0;
  const rng = mulberry32(deriveSeed(...seedParts));
  return Math.floor(rng() * length);
}

/** 用派生种子确定性地打乱数组(返回新数组)。 */
export function shuffle<T>(items: readonly T[], ...seedParts: Array<number | string>): T[] {
  const rng = mulberry32(deriveSeed(...seedParts));
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
