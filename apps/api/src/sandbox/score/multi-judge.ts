// M2.11 多裁判集成。《裁判评分模块》§7。
// 用 2–3 个不同模型族的裁判降低单一裁判系统偏差(别让优化器学会专钻某一个裁判)。
// 聚合:连续量(每标签可疑度)取【截尾均值】(抗离群);否决/二值项【多数表决】;
//   记 judge_agreement(裁判间一致度),低一致样本转人工抽查。
// 运行 N 个裁判需 N 个 model id + API key(真机);本模块的【聚合逻辑】是纯函数,可离线测。

import { Injectable, Logger } from "@nestjs/common";
import type { MatchRecord } from "../match-record/types";
import type { AnonymizedView } from "./anonymize";
import { BlindSuspicionScorer, relativizeFromScores } from "./blind-suspicion";
import type { BlindSuspicion } from "./types";

/** 单个裁判在某局的可疑度读数(每存活标签一个分 + 该裁判 id)。 */
export interface JudgeReading {
  judgeModel: string;
  scores: Record<string, number>; // 标签 → 0–100
}

export interface MultiJudgeResult {
  suspicion: BlindSuspicion; // 聚合后的相对量(margin/rank/ai_final)
  judges: string[]; // 实际成功参评的裁判
  judge_agreement: number | null; // 0–1;null=不足 2 个裁判无法算
  ok: boolean;
}

@Injectable()
export class MultiJudgeScorer {
  private readonly logger = new Logger(MultiJudgeScorer.name);

  constructor(private readonly blind: BlindSuspicionScorer) {}

  /**
   * 在 N 个裁判模型上各跑一遍盲测,聚合成一份相对量 + 一致度。
   * 任一裁判成功即产出(用成功者聚合);全失败 → ok=false。
   */
  async score(
    match: MatchRecord,
    view: AnonymizedView,
    judgeModelIds: string[],
  ): Promise<MultiJudgeResult> {
    const readings: JudgeReading[] = [];
    for (const id of judgeModelIds) {
      const res = await this.blind.score(match, view, id);
      if (res.ok && res.suspicion.per_round[0]) {
        readings.push({ judgeModel: res.judgeModel, scores: res.suspicion.per_round[0].scores });
      } else {
        this.logger.warn(`多裁判:裁判 ${id} 失败,跳过`);
      }
    }
    if (readings.length === 0) {
      return {
        suspicion: { per_round: [], ai_final: null, suspicion_rank: null, suspicion_margin: null },
        judges: [],
        judge_agreement: null,
        ok: false,
      };
    }
    const agg = aggregateReadings(readings, view.aliveLabels);
    const suspicion = relativizeFromScores(agg, view.aiLabel, view.aliveLabels, view.scoringRound);
    // 多裁判聚合后逐条解释无法保留(assessments 缺省);仅标出 AI 标签供打分详情回看。
    suspicion.ai_label = view.aiLabel;
    return {
      suspicion,
      judges: readings.map((r) => r.judgeModel),
      judge_agreement: judgeAgreement(readings, view.aiLabel),
      ok: true,
    };
  }
}

/** 截尾均值聚合每标签可疑度(纯函数):去掉最高/最低各一个(裁判 ≥3 时),抗离群。 */
export function aggregateReadings(
  readings: JudgeReading[],
  aliveLabels: string[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const label of aliveLabels) {
    const vals = readings
      .map((r) => r.scores[label])
      .filter((v): v is number => typeof v === "number");
    out[label] = vals.length > 0 ? trimmedMean(vals) : 50;
  }
  return out;
}

/** 截尾均值:≥3 个值时去掉一个最大、一个最小后取均;否则普通均值。 */
export function trimmedMean(values: number[]): number {
  if (values.length === 0) return 0;
  if (values.length < 3) return values.reduce((a, b) => a + b, 0) / values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const inner = sorted.slice(1, sorted.length - 1);
  return inner.reduce((a, b) => a + b, 0) / inner.length;
}

/**
 * 裁判一致度(0–1):基于各裁判给 AI 标签打分的离散程度。
 * agreement = 1 − stddev(aiScores)/50,clamp[0,1]。分歧越大 → 越接近 0(转人工抽查)。
 * 不足 2 个裁判 → null(无法度量一致)。
 */
export function judgeAgreement(readings: JudgeReading[], aiLabel: string): number | null {
  const aiScores = readings
    .map((r) => r.scores[aiLabel])
    .filter((v): v is number => typeof v === "number");
  if (aiScores.length < 2) return null;
  const m = aiScores.reduce((a, b) => a + b, 0) / aiScores.length;
  const variance = aiScores.reduce((a, b) => a + (b - m) ** 2, 0) / aiScores.length;
  const sd = Math.sqrt(variance);
  return Math.max(0, Math.min(1, 1 - sd / 50));
}
