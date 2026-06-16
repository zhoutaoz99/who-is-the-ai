/**
 * 评估打分聚合工具(纯函数)。
 * 单局模型输出采用最小结构化文本协议: [[score]] + [[analysis]]。
 */

export const ISSUE_CODES = [
  "ROUND1_PUSH_VOTE",
  "SINGLE_CHAR_WHEN_NAMED",
  "SAMPLE_LINE_COPY",
  "LOCKSTEP_BLOCK_VOTE",
  "FORMULAIC_VOTE_REASON",
  "TEAMMATE_MISFIRE",
  "POST_PROVOCATION_SKIP",
  "TEMPLATE_PHRASE",
  "WEAK_SUSPICION",
  "OVER_DEFENSIVE",
  "LOW_THREAT_TARGETING",
  "LOW_CONTEXT_AWARENESS",
] as const;

export type IssueCode = (typeof ISSUE_CODES)[number];
export type AssessmentConfidence = "low" | "medium" | "high";

export interface GameAssessmentObjective {
  aiWin: boolean;
  aiSurvivors: number;
  roundsPlayed: number;
  aiPersonas: string[];
  perAi: Array<{ personaId: string; eliminatedRound: number | null }>;
}

export interface GameAssessmentMachine {
  humanLikeScore: number;
  naturalnessAiVsHuman: number;
  voteThreatTargeting: number;
  issueCounts: Partial<Record<IssueCode, number>>;
  primaryIssueCodes: IssueCode[];
  confidence?: AssessmentConfidence;
}

export interface GameAssessmentAnalysis {
  summary: string;
  evidence: string[];
  fixHint: string;
  rawText: string;
}

export interface ModelAssessment {
  machine: GameAssessmentMachine;
  analysis: GameAssessmentAnalysis;
  rawModelOutput: string;
}

export interface GameAssessment extends ModelAssessment {
  objective: GameAssessmentObjective;
}

export interface Scorecard {
  n: number;
  aiWinRate: number;
  aiSurvivorsMean: number;
  roundsPlayedMean: number;
  humanLikeScore: { mean: number; se: number };
  naturalnessAiVsHuman: { mean: number; se: number };
  voteThreatTargeting: { mean: number; se: number };
  issueCounts: Partial<Record<IssueCode, number>>;
  issueGameRates: Partial<Record<IssueCode, number>>;
  primaryIssues: Array<{ code: IssueCode; count: number }>;
  confidenceMix: Partial<Record<AssessmentConfidence, number>>;
  generatedAt: string;
}

const ISSUE_CODE_SET = new Set<string>(ISSUE_CODES);
const CONFIDENCE_SET = new Set<string>(["low", "medium", "high"]);

const round2 = (x: number) => Math.round(x * 100) / 100;

const mean = (arr: number[]) =>
  arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

const se = (arr: number[]) => {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const sd = Math.sqrt(mean(arr.map((x) => (x - m) ** 2)));
  return sd / Math.sqrt(arr.length);
};

const clampInt = (value: number, min: number, max: number): number => {
  const rounded = Math.round(value);
  if (!Number.isFinite(rounded)) return min;
  return Math.max(min, Math.min(max, rounded));
};

export function aggregateAssessments(scores: GameAssessment[]): Scorecard {
  const n = scores.length;
  if (n === 0) {
    return {
      n: 0,
      aiWinRate: 0,
      aiSurvivorsMean: 0,
      roundsPlayedMean: 0,
      humanLikeScore: { mean: 0, se: 0 },
      naturalnessAiVsHuman: { mean: 0, se: 0 },
      voteThreatTargeting: { mean: 0, se: 0 },
      issueCounts: {},
      issueGameRates: {},
      primaryIssues: [],
      confidenceMix: {},
      generatedAt: new Date().toISOString(),
    };
  }

  const aiWins = scores.filter((s) => s.objective.aiWin).length;
  const issueCounts: Partial<Record<IssueCode, number>> = {};
  const issueGameRates: Partial<Record<IssueCode, number>> = {};
  const primaryIssueCounts = new Map<IssueCode, number>();
  const confidenceMix: Partial<Record<AssessmentConfidence, number>> = {};

  for (const code of ISSUE_CODES) {
    const vals = scores.map((s) => Number(s.machine.issueCounts[code] ?? 0));
    const total = vals.reduce((a, b) => a + b, 0);
    if (total > 0) issueCounts[code] = total;
    const gameRate = vals.filter((v) => v > 0).length / n;
    if (gameRate > 0) issueGameRates[code] = round2(gameRate);
  }

  for (const score of scores) {
    for (const code of score.machine.primaryIssueCodes) {
      primaryIssueCounts.set(code, (primaryIssueCounts.get(code) ?? 0) + 1);
    }
    const confidence = score.machine.confidence;
    if (confidence) confidenceMix[confidence] = (confidenceMix[confidence] ?? 0) + 1;
  }

  const primaryIssues = [...primaryIssueCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([code, count]) => ({ code, count }));

  const num = (sel: (s: GameAssessment) => number | undefined) =>
    scores.map((s) => Number(sel(s) ?? 0));

  return {
    n,
    aiWinRate: aiWins / n,
    aiSurvivorsMean: round2(mean(num((s) => s.objective.aiSurvivors))),
    roundsPlayedMean: round2(mean(num((s) => s.objective.roundsPlayed))),
    humanLikeScore: {
      mean: round2(mean(num((s) => s.machine.humanLikeScore))),
      se: round2(se(num((s) => s.machine.humanLikeScore))),
    },
    naturalnessAiVsHuman: {
      mean: round2(mean(num((s) => s.machine.naturalnessAiVsHuman))),
      se: round2(se(num((s) => s.machine.naturalnessAiVsHuman))),
    },
    voteThreatTargeting: {
      mean: round2(mean(num((s) => s.machine.voteThreatTargeting))),
      se: round2(se(num((s) => s.machine.voteThreatTargeting))),
    },
    issueCounts,
    issueGameRates,
    primaryIssues,
    confidenceMix,
    generatedAt: new Date().toISOString(),
  };
}

export function parseAssessmentText(content: string): ModelAssessment {
  const normalized = stripCodeFence(content).replace(/\r\n/g, "\n");
  const scoreText = extractSection(normalized, "score");
  if (!scoreText.trim()) {
    throw new Error(`打分返回缺少 [[score]] 段: ${content.slice(0, 200)}`);
  }
  const analysisText = extractSection(normalized, "analysis");
  return {
    machine: parseScoreSection(scoreText),
    analysis: parseAnalysisSection(analysisText),
    rawModelOutput: content,
  };
}

function stripCodeFence(content: string): string {
  const trimmed = content.trim();
  const match = trimmed.match(/^```(?:text|markdown)?\s*([\s\S]*?)```$/i);
  return match ? match[1].trim() : trimmed;
}

function extractSection(content: string, name: "score" | "analysis"): string {
  const section = `[[${name}]]`;
  const start = content.toLowerCase().indexOf(section);
  if (start < 0) return "";
  const rest = content.slice(start + section.length);
  const next = rest.search(/\n\s*\[\[(score|analysis)\]\]/i);
  return (next >= 0 ? rest.slice(0, next) : rest).trim();
}

function parseScoreSection(text: string): GameAssessmentMachine {
  const fields = new Map<string, string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    fields.set(key, value);
  }

  const humanLikeRaw = fields.get("human_like_score");
  const naturalnessRaw = fields.get("naturalness_ai_vs_human");
  const targetingRaw = fields.get("vote_threat_targeting");
  if (!humanLikeRaw || !naturalnessRaw || !targetingRaw) {
    throw new Error("打分 [[score]] 缺少 human_like_score / naturalness_ai_vs_human / vote_threat_targeting");
  }

  const confidenceRaw = fields.get("confidence")?.toLowerCase();
  return {
    humanLikeScore: clampInt(Number(humanLikeRaw), 0, 100),
    naturalnessAiVsHuman: clampInt(Number(naturalnessRaw), 1, 5),
    voteThreatTargeting: clampInt(Number(targetingRaw), 1, 5),
    issueCounts: parseIssueCounts(fields.get("issue_counts") ?? ""),
    primaryIssueCodes: parseIssueCodes(fields.get("primary_issue_codes") ?? "").slice(0, 3),
    confidence: CONFIDENCE_SET.has(confidenceRaw ?? "")
      ? (confidenceRaw as AssessmentConfidence)
      : undefined,
  };
}

function parseIssueCounts(value: string): Partial<Record<IssueCode, number>> {
  const result: Partial<Record<IssueCode, number>> = {};
  for (const part of value.split(",")) {
    const [rawCode, rawCount] = part.split("=");
    const code = rawCode?.trim();
    if (!code || !ISSUE_CODE_SET.has(code)) continue;
    const count = clampInt(Number(rawCount), 0, 999);
    if (count > 0) result[code as IssueCode] = count;
  }
  return result;
}

function parseIssueCodes(value: string): IssueCode[] {
  const result: IssueCode[] = [];
  for (const rawCode of value.split(",")) {
    const code = rawCode.trim();
    if (!ISSUE_CODE_SET.has(code)) continue;
    if (!result.includes(code as IssueCode)) result.push(code as IssueCode);
  }
  return result;
}

function parseAnalysisSection(text: string): GameAssessmentAnalysis {
  const lines = text.split("\n");
  const evidence: string[] = [];
  let summary = "";
  let fixHint = "";
  let inEvidence = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const lower = line.toLowerCase();
    if (lower.startsWith("summary:")) {
      summary = line.slice("summary:".length).trim();
      inEvidence = false;
      continue;
    }
    if (lower.startsWith("evidence:")) {
      const inline = line.slice("evidence:".length).trim();
      if (inline) evidence.push(stripBullet(inline));
      inEvidence = true;
      continue;
    }
    if (lower.startsWith("fix_hint:")) {
      fixHint = line.slice("fix_hint:".length).trim();
      inEvidence = false;
      continue;
    }
    if (inEvidence && /^[-*]\s+/.test(line)) {
      evidence.push(stripBullet(line));
    }
  }

  return {
    summary,
    evidence: evidence.slice(0, 5),
    fixHint,
    rawText: text.trim(),
  };
}

function stripBullet(value: string): string {
  return value.replace(/^[-*]\s+/, "").trim();
}
