// M5.14 评测调度:展开 scenarios×seeds×runs,并按成本层给出默认并发。

import type { Scenario } from "../scenario/types";

export type EvalCostTier = "decision" | "diagnostic" | "calibration";

export interface EvalTask {
  scenario: Scenario;
  seed: number;
  run: number;
}

export interface EvalScheduleInput {
  scenarios: Scenario[];
  seedsPerScenario: number;
  runsPerSeed: number;
  diagnose?: boolean;
  judgeModelIds?: string[];
  costTier?: EvalCostTier;
}

export function expandEvalTasks(input: Pick<EvalScheduleInput, "scenarios" | "seedsPerScenario" | "runsPerSeed">): EvalTask[] {
  const tasks: EvalTask[] = [];
  for (const scenario of input.scenarios) {
    for (let s = 0; s < input.seedsPerScenario; s += 1) {
      const seed = input.seedsPerScenario > 1 ? scenario.seed + s * 7919 : scenario.seed;
      for (let r = 0; r < input.runsPerSeed; r += 1) {
        tasks.push({ scenario, seed, run: r });
      }
    }
  }
  return tasks;
}

export function resolveCostTier(input: Pick<EvalScheduleInput, "diagnose" | "judgeModelIds" | "costTier">): EvalCostTier {
  if (input.costTier) return input.costTier;
  if (input.diagnose) return "diagnostic";
  if ((input.judgeModelIds?.length ?? 0) >= 2) return "calibration";
  return "decision";
}

export function concurrencyForCostTier(tier: EvalCostTier): number {
  const envKey =
    tier === "decision"
      ? "SANDBOX_DECISION_CONCURRENCY"
      : tier === "diagnostic"
        ? "SANDBOX_DIAGNOSTIC_CONCURRENCY"
        : "SANDBOX_CALIBRATION_CONCURRENCY";
  const configured = Number(process.env[envKey]);
  if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
  if (tier === "decision") return 3;
  if (tier === "diagnostic") return 2;
  return 1;
}
