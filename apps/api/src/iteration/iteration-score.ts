/**
 * 评估打分聚合工具(纯函数)。
 * 给定一批单局结构化打分,聚合成 scorecard。
 */

export const TELL_KEYS = [
  "round1PushVote",
  "singleCharWhenNamed",
  "sampleLineCopy",
  "lockstepBlockVote",
  "formulaicVoteReason",
  "teammateMisfire",
  "postProvocationSkip",
  "templatePhrase",
] as const;

export type TellKey = (typeof TELL_KEYS)[number];

/** 单局打分(对齐打分尺子输出的 JSON 结构)。 */
export interface GameScore {
  aiWin?: boolean;
  aiSurvivors?: number;
  roundsPlayed?: number;
  humanLikeScore?: number;
  naturalnessAiVsHuman?: number;
  voteThreatTargeting?: number;
  tells?: Partial<Record<TellKey, number>>;
  topIssues?: string[];
}

export interface Scorecard {
  n: number;
  aiWinRate: number;
  aiSurvivorsMean: number;
  roundsPlayedMean: number;
  humanLikeScore: { mean: number; se: number };
  naturalnessAiVsHuman: { mean: number; se: number };
  voteThreatTargeting: { mean: number; se: number };
  tells: Record<string, number>;
  tellGameRates: Record<string, number>;
  topIssues: Array<{ issue: string; count: number }>;
  generatedAt: string;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

const mean = (arr: number[]) =>
  arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

const se = (arr: number[]) => {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const sd = Math.sqrt(mean(arr.map((x) => (x - m) ** 2)));
  return sd / Math.sqrt(arr.length);
};

export function aggregateScores(scores: GameScore[]): Scorecard {
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
      tells: {},
      tellGameRates: {},
      topIssues: [],
      generatedAt: new Date().toISOString(),
    };
  }

  const aiWins = scores.filter((s) => s.aiWin).length;
  const tells: Record<string, number> = {};
  const tellGameRates: Record<string, number> = {};
  for (const k of TELL_KEYS) {
    const vals = scores.map((s) => Number(s.tells?.[k] ?? 0));
    tells[k] = vals.reduce((a, b) => a + b, 0);
    tellGameRates[k] = vals.filter((v) => v > 0).length / n;
  }

  const num = (sel: (s: GameScore) => number | undefined) =>
    scores.map((s) => Number(sel(s) ?? 0));

  const counts = new Map<string, number>();
  for (const s of scores) {
    for (const issue of s.topIssues ?? []) {
      const key = String(issue).trim();
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const topIssues = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([issue, count]) => ({ issue, count }));

  return {
    n,
    aiWinRate: aiWins / n,
    aiSurvivorsMean: round2(mean(num((s) => s.aiSurvivors))),
    roundsPlayedMean: round2(mean(num((s) => s.roundsPlayed))),
    humanLikeScore: {
      mean: round2(mean(num((s) => s.humanLikeScore))),
      se: round2(se(num((s) => s.humanLikeScore))),
    },
    naturalnessAiVsHuman: {
      mean: round2(mean(num((s) => s.naturalnessAiVsHuman))),
      se: round2(se(num((s) => s.naturalnessAiVsHuman))),
    },
    voteThreatTargeting: {
      mean: round2(mean(num((s) => s.voteThreatTargeting))),
      se: round2(se(num((s) => s.voteThreatTargeting))),
    },
    tells,
    tellGameRates,
    topIssues,
    generatedAt: new Date().toISOString(),
  };
}
