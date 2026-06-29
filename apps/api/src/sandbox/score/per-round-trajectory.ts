// M2.6 逐轮可疑度轨迹(失败定位用)。《裁判评分模块》§4.1/§6。
// 在【每轮结束的时点】对增量转录各跑一次盲测可疑度 → 一条可疑度轨迹;
// 轨迹里【跳升最大的那一轮】= 失败发生轮(喂给诊断裁判作 FOCUS_ROUND)。
// 成本:逐轮盲测是主开销,故仅在【需要定位的局】(诊断路径)跑;常规评测只局末一次(blind-suspicion.ts)。

import { Injectable, Logger } from "@nestjs/common";
import type { MatchRecord } from "../match-record/types";
import { buildAnonymizedView } from "./anonymize";
import { BlindSuspicionScorer } from "./blind-suspicion";
import type { BlindSuspicion, RoundSuspicion } from "./types";

export interface TrajectoryResult {
  /** 决策用盲测(per_round=全轨迹;rank/margin/ai_final 取评估轮切片)。 */
  suspicion: BlindSuspicion;
  /** 跳升最大的轮(失败轮);轨迹不足两点 → 取唯一/最后一轮;无有效分 → null。 */
  failureRound: number | null;
  /** 任一轮盲测成功即 true(全失败 → 退回局末单测语义)。 */
  ok: boolean;
}

@Injectable()
export class PerRoundTrajectoryScorer {
  private readonly logger = new Logger(PerRoundTrajectoryScorer.name);

  constructor(private readonly blind: BlindSuspicionScorer) {}

  /**
   * 跑逐轮轨迹:从 start_round 到评估轮(AI 出局轮或最后一轮),逐轮末跑盲测。
   * AI 出局后不再打分(出局者不计入相对化)。
   */
  async run(match: MatchRecord, judgeModelId?: string): Promise<TrajectoryResult> {
    const finalView = buildAnonymizedView(match);
    const scoringRound = finalView.scoringRound;
    const startRound = match.start_round;

    const perRound: RoundSuspicion[] = [];
    let anyOk = false;
    let scoringSlice: BlindSuspicion | null = null;

    for (let round = startRound; round <= scoringRound; round += 1) {
      const view = buildAnonymizedView(match, { atRound: round });
      // 该轮 AI 不在存活集(已出局)→ 跳过(理论上 ≤ scoringRound 不会发生,稳妥兜底)。
      if (!view.aliveLabels.includes(view.aiLabel)) continue;
      const res = await this.blind.score(match, view, judgeModelId);
      if (!res.ok) {
        this.logger.warn(`逐轮盲测失败 match=${match.match_id} round=${round}`);
        continue;
      }
      anyOk = true;
      const slice = res.suspicion.per_round[0];
      if (slice) perRound.push(slice);
      if (round === scoringRound) scoringSlice = res.suspicion;
    }

    // 评估轮切片缺失(末轮失败)→ 退用轨迹最后一条成功切片重算 rank/margin。
    if (!scoringSlice && perRound.length > 0) {
      const last = perRound[perRound.length - 1];
      scoringSlice = deriveSuspicion(last);
    }

    const suspicion: BlindSuspicion = {
      per_round: perRound,
      ai_final: scoringSlice?.ai_final ?? null,
      suspicion_rank: scoringSlice?.suspicion_rank ?? null,
      suspicion_margin: scoringSlice?.suspicion_margin ?? null,
    };

    return { suspicion, failureRound: findFailureRound(perRound), ok: anyOk };
  }
}

/**
 * 失败轮 = ai_score 相对上一轮跳升最大的轮(纯函数,便于单测)。
 * 轨迹 < 2 点:返回唯一一条的轮;空 → null。首轮无前值,从第二条起比 delta。
 * 全程无跳升(delta≤0)仍返回 ai_score 最高的轮(最危险点)作兜底定位。
 */
export function findFailureRound(perRound: RoundSuspicion[]): number | null {
  const pts = perRound.filter((r) => r.ai_score != null);
  if (pts.length === 0) return null;
  if (pts.length === 1) return pts[0].round;

  let bestRound = pts[0].round;
  let bestDelta = -Infinity;
  for (let i = 1; i < pts.length; i += 1) {
    const delta = (pts[i].ai_score as number) - (pts[i - 1].ai_score as number);
    if (delta > bestDelta) {
      bestDelta = delta;
      bestRound = pts[i].round;
    }
  }
  // 无任何正跳升 → 退回 ai_score 峰值轮(整体最危险处)。
  if (bestDelta <= 0) {
    let peak = pts[0];
    for (const p of pts) if ((p.ai_score as number) > (peak.ai_score as number)) peak = p;
    return peak.round;
  }
  return bestRound;
}

/** 由单轮切片重算 rank/margin(末轮盲测失败时的兜底)。 */
function deriveSuspicion(slice: RoundSuspicion): BlindSuspicion {
  const scores = slice.scores;
  const ai = slice.ai_score;
  const labels = Object.keys(scores);
  const aiLabel = labels.find((l) => scores[l] === ai);
  const others = labels.filter((l) => l !== aiLabel).map((l) => scores[l]);
  const margin = ai != null ? ai - (others.length > 0 ? Math.max(...others) : 0) : null;
  const sorted = [...labels].sort((a, b) => scores[b] - scores[a]);
  const rank = ai != null && aiLabel ? sorted.indexOf(aiLabel) + 1 : null;
  return { per_round: [slice], ai_final: ai, suspicion_rank: rank, suspicion_margin: margin };
}
