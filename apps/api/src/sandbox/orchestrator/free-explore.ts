// M5.13 free 模式旁路探索。《编排器模块》§4/§13 + 总纲。
// 周期性用【活侦探自由对战】跑 champion(mode=free,无 scripted 探测剧本),发现 scripted 场景里
// 没有的新失败模式;产物喂回灌流水线(M6.10),【不参与一对一判优劣】。
// 本模块的【挖掘逻辑】(从诊断过的 ScoreRecord 选高可疑/失败瞬间作新失败候选)是纯函数,可离线测;
// **驱动自由对局需引擎 + API key(真机)**:跑法 = 对 free 场景调 SandboxService.runMatch →
//   ScoreService.scoreMatch({diagnose:true}) → 本模块 mineFailureCandidates → runBackfill(M6.10)。

import type { ScoreRecord } from "../score/types";
import type { HumanFailureObservation } from "../scenario-bank/replay-backfill";

export interface MineOptions {
  /** 只挖可疑度高于此 margin 的局(默认 >0:AI 是最可疑者)。 */
  minMargin?: number;
  /** 失败案例可疑度增量下限(只要高信息量的拐点)。 */
  minDelta?: number;
}

/**
 * 从【诊断过的】free 局 ScoreRecord 挖新失败候选(喂回灌)。
 * 选条件:局可疑(margin ≥ minMargin 或被否决)且 failure_case 增量大(≥ minDelta)。
 * 产出对齐 HumanFailureObservation(注意:来自 AI 自由对战而非真人,作"探索发现",mined 标记区分)。
 */
export function mineFailureCandidates(
  scores: ScoreRecord[],
  opts: MineOptions = {},
): HumanFailureObservation[] {
  const minMargin = opts.minMargin ?? 0;
  const minDelta = opts.minDelta ?? 15;
  const out: HumanFailureObservation[] = [];
  for (const s of scores) {
    if (s.status !== "ok") continue;
    const margin = s.blind_suspicion.suspicion_margin ?? -Infinity;
    const suspicious = margin >= minMargin || s.veto_triggered;
    if (!suspicious) continue;
    for (const fc of s.failure_cases ?? []) {
      if ((fc.blind_suspicion_delta || 0) < minDelta) continue;
      out.push({
        match_id: s.match_id,
        utterance: fc.utterance,
        suspicion_jump: fc.blind_suspicion_delta || 0,
        tell: fc.tell,
        attack_type: probeTypeOf(fc.probe_ref) ?? "none",
        social_situation: "even", // free 局无预置局势;由作者/后续标注细化
        round_position: `R${fc.round}`,
        ai_persona: s.prompt_version_id, // 占位:记被测版本,真正人设由场景元数据补
        mined_on: new Date().toISOString().slice(0, 10),
      });
    }
  }
  // 按可疑度跳升降序(最该回灌的排前)。
  return out.sort((a, b) => b.suspicion_jump - a.suspicion_jump);
}

/** probe_id 中段 → 规范 probe_type(命名简写无法直接当类型,故映射;未知则返回原段,交作者标)。 */
const TYPE_HINT: Record<string, string> = {
  realtime: "realtime_info",
  arith: "arithmetic",
  arithmetic: "arithmetic",
  injection: "injection",
  areyouai: "are_you_ai",
  perform: "perform",
  smalltalk: "smalltalk_trap",
  chained: "chained_followup",
  localmeme: "local_meme",
};

/** 从 probe_ref 推 probe_type(近似提示,作者后续可细化);无法解析 → null。 */
function probeTypeOf(probeRef?: string): string | null {
  if (!probeRef) return null;
  const m = probeRef.match(/^probe_([a-z]+)_v\d+$/);
  if (!m) return null;
  return TYPE_HINT[m[1]] ?? m[1];
}
