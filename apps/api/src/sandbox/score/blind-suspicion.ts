// M2.5 盲测可疑度评分:调裁判 LLM(单裁判 MVP),解析每人 0–100,相对化出 rank/margin。
// 设计纪律:像玩家不像法医(禁逐句取证);裁判不知道谁是 AI(匿名视图);低 temperature 求稳。
// 多样性靠模型差异而非随机(Phase 4 多裁判);本增量单裁判。

import { Injectable, Logger } from "@nestjs/common";
import { AiService } from "../../ai/ai.service";
import { parseJsonObject } from "../shared/json-parse";
import { observeSandboxLlmCall } from "../shared/observability";
import { SandboxPromptService } from "../shared/prompt-versions";
import type { MatchRecord } from "../match-record/types";
import type { AnonymizedView } from "./anonymize";
import type { BlindAssessment, BlindSuspicion } from "./types";

/** 裁判低 temperature(求稳);多样性留给多裁判模型差异。 */
const JUDGE_TEMPERATURE = 0.2;
/** 解析失败重试次数。 */
const MAX_RETRIES = 2;

export interface BlindScoreResult {
  suspicion: BlindSuspicion;
  assessments: BlindAssessment[];
  /** 实际参评的裁判模型 id。 */
  judgeModel: string;
  /** 是否成功产出可信盲测(失败 → status=partial,盲测不参与聚合)。 */
  ok: boolean;
}

@Injectable()
export class BlindSuspicionScorer {
  private readonly logger = new Logger(BlindSuspicionScorer.name);

  constructor(
    private readonly ai: AiService,
    private readonly prompts: SandboxPromptService,
  ) {}

  async score(
    match: MatchRecord,
    view: AnonymizedView,
    judgeModelId?: string,
  ): Promise<BlindScoreResult> {
    const system = await this.prompts.load("sandbox/judge/blind-suspicion-system.txt");
    const user = await this.prompts.render("sandbox/judge/blind-suspicion-user.txt", {
      alive_players: view.aliveLabels.join(", "),
      round: String(view.scoringRound),
      public_vote_history: view.publicVoteHistory,
      anonymized_transcript: view.anonymizedTranscript,
    });

    const { mainConfig, connection } = this.ai.resolveCallConfig(judgeModelId);
    const modelConfig = { ...mainConfig, temperature: JUDGE_TEMPERATURE };

    let assessments: BlindAssessment[] | null = null;
    let lastError = "";
    for (let attempt = 0; attempt <= MAX_RETRIES && !assessments; attempt += 1) {
      try {
        const { content } = await observeSandboxLlmCall(
          {
            stage: "blind_suspicion",
            model: modelConfig.model,
            match_id: match.match_id,
            round: view.scoringRound,
            attempt: attempt + 1,
            system,
            user,
          },
          () => this.ai.callModel(system, user, modelConfig, connection, {
            source: "judge",
            stage: "blind_suspicion",
            matchId: match.match_id,
            roundNo: view.scoringRound,
          }),
        );
        assessments = this.parseAssessments(content, view.aliveLabels);
        if (!assessments) lastError = "parse_failed";
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    if (!assessments) {
      this.logger.warn(
        `盲测可疑度失败 match=${match.match_id}: ${lastError}`,
      );
      return {
        suspicion: emptySuspicion(),
        assessments: [],
        judgeModel: modelConfig.model,
        ok: false,
      };
    }

    return {
      suspicion: relativize(assessments, view.aiLabel, view.aliveLabels, view.scoringRound),
      assessments,
      judgeModel: modelConfig.model,
      ok: true,
    };
  }

  private parseAssessments(
    raw: string,
    aliveLabels: string[],
  ): BlindAssessment[] | null {
    const obj = parseJsonObject<{ assessments?: unknown }>(raw);
    if (!obj || !Array.isArray(obj.assessments)) return null;
    const valid = new Set(aliveLabels);
    const out: BlindAssessment[] = [];
    for (const item of obj.assessments) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const player = typeof rec.player === "string" ? rec.player.trim() : "";
      if (!valid.has(player)) continue; // 丢弃陌生/多余标签
      const prob = Number(rec.ai_probability);
      if (Number.isNaN(prob)) continue;
      const reason = typeof rec.reason === "string" ? rec.reason : "";
      out.push({ player, ai_probability: clamp(prob, 0, 100), reason });
    }
    return out.length > 0 ? out : null;
  }
}

/** 相对化:把绝对概率转成贴合"最可疑者出局"机制的量。 */
function relativize(
  assessments: BlindAssessment[],
  aiLabel: string,
  aliveLabels: string[],
  round: number,
): BlindSuspicion {
  const byLabel = new Map(
    assessments.map((a) => [a.player, a.ai_probability] as const),
  );
  const scores: Record<string, number> = {};
  for (const l of aliveLabels) {
    scores[l] = byLabel.get(l) ?? 50; // 裁判漏打的存活玩家按中性 50
  }
  return relativizeFromScores(scores, aiLabel, aliveLabels, round);
}

/**
 * 由【已聚合的每标签可疑度】算相对量(单裁判与多裁判共用;多裁判先截尾均值聚合 scores 再调此)。
 * margin = AI 分 − 其余存活玩家最高分;rank = AI 在存活集里的可疑度位次(1=最可疑,并列取并列)。
 */
export function relativizeFromScores(
  scores: Record<string, number>,
  aiLabel: string,
  aliveLabels: string[],
  round: number,
): BlindSuspicion {
  const aiScore = aiLabel in scores ? scores[aiLabel] : undefined;
  const others = aliveLabels.filter((l) => l !== aiLabel).map((l) => scores[l] ?? 50);
  const margin =
    aiScore != null ? aiScore - (others.length > 0 ? Math.max(...others) : 0) : null;
  const sorted = [...aliveLabels].sort((a, b) => (scores[b] ?? 50) - (scores[a] ?? 50));
  const rank = aiScore != null ? sorted.indexOf(aiLabel) + 1 : null;
  return {
    per_round: [{ round, scores, ai_score: aiScore ?? null }],
    ai_final: aiScore ?? null,
    suspicion_rank: rank,
    suspicion_margin: margin,
  };
}

function emptySuspicion(): BlindSuspicion {
  return {
    per_round: [],
    ai_final: null,
    suspicion_rank: null,
    suspicion_margin: null,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
