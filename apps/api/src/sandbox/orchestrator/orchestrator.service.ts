// M5.9 编排器主循环(单线贪心):champion vs child 配对评测 → 聚合 → 闸门 → 晋升/拒绝。
// 三道闸在 Phase 1 只装第一道(配对 + 显著性);留出复核/真人校准在 Phase 2/4。
// child 由调用方提供(MVP:手动优化器 M4.6;M4 接 LLM 优化器后自动产)。

import { Injectable, Logger } from "@nestjs/common";
import { join } from "node:path";
import { buildValidation } from "../aggregate/validation";
import type { ValidationReport } from "../aggregate/validation";
import { buildOptimizerInput, championProfile } from "../optimizer/input";
import { OptimizerService } from "../optimizer/propose";
import { validatePrompt } from "../optimizer/validate-prompt";
import type { PromptValidation } from "../optimizer/validate-prompt";
import { writeJsonFile } from "../shared/store";
import { optimizeGate } from "./gate";
import type { ChildEval, GenerationEval } from "./generation-eval";
import { PairedEvalService } from "./paired-eval";
import type { EvalPlan } from "./paired-eval";
import { PromptVersionStore, toMeta } from "./prompt-version";
import type { PromptVersion, PromptVersionMeta } from "./prompt-version";
import { OrchestratorStateStore } from "./state";
import type { OrchestratorState, TriedAndRejectedEntry } from "./state";

const POPULATION_CAP = 5;

@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger(OrchestratorService.name);
  private readonly generationsDir: string;

  constructor(
    private readonly promptStore: PromptVersionStore,
    private readonly stateStore: OrchestratorStateStore,
    private readonly pairedEval: PairedEvalService,
    private readonly optimizer: OptimizerService,
  ) {
    const root = process.env.SANDBOX_OUT_DIR ?? join(process.cwd(), "sandbox-out");
    this.generationsDir = join(root, "generations");
  }

  /** 初始化:播种 baseline 提示词 + 状态。 */
  init(): { champion: PromptVersion; state: OrchestratorState } {
    const champion = this.promptStore.seedBaselineIfMissing();
    const state = this.stateStore.load() ?? this.stateStore.seedBaseline();
    return { champion, state };
  }

  getState(): OrchestratorState {
    return this.stateStore.load() ?? this.stateStore.seedBaseline();
  }

  getChampion(): PromptVersion | null {
    return this.promptStore.load(this.getState().champion);
  }

  /** 单线贪心一代。 */
  async runGeneration(child: PromptVersion, plan: EvalPlan): Promise<GenerationEval> {
    const { state } = this.init();
    const championVersion = this.promptStore.load(state.champion);
    if (!championVersion) {
      throw new Error(`champion 提示词版本缺失: ${state.champion}`);
    }
    // 持久化候选(若新)。
    if (!this.promptStore.load(child.version_id)) {
      this.promptStore.save({ ...child, status: "candidate" });
    }
    const childVersion = this.promptStore.load(child.version_id)!;

    this.logger.log(
      `第 ${state.generation + 1} 代:champion=${state.champion} vs child=${child.version_id}(场景 ${plan.scenarios.length} × seed${plan.seedsPerScenario} × run${plan.runsPerSeed})`,
    );

    const parentScores = await this.pairedEval.runVersionEval(championVersion, plan);
    const childScores = await this.pairedEval.runVersionEval(childVersion, plan);
    const validation = buildValidation(parentScores, childScores);
    const gate = optimizeGate(validation);

    const childEval: ChildEval = {
      child_id: child.version_id,
      based_on: child.parent_id ?? state.champion,
      hypothesis: child.hypothesis,
      target_dimension: child.target_dimension,
      edit_type: child.edit_type,
      validation,
      gate,
      decision: gate.decision,
    };

    const triedAdded: string[] = [];
    if (gate.decision === "promote") {
      this.promptStore.patchStatus(child.version_id, {
        status: "champion",
        validated_metrics: summarize(validation),
        eval_set_version: plan.evalSetVersion,
      });
      if (state.champion !== child.version_id) {
        this.promptStore.patchStatus(state.champion, { status: "accepted" });
      }
      state.population = [
        child.version_id,
        ...state.population.filter((id) => id !== child.version_id),
      ].slice(0, POPULATION_CAP);
      state.champion = child.version_id;
      this.logger.log(`晋升:${child.version_id} 成为新 champion`);
    } else {
      this.promptStore.patchStatus(child.version_id, { status: "rejected" });
      const entry: TriedAndRejectedEntry = {
        version_id: child.version_id,
        hypothesis: child.hypothesis,
        target_dimension: child.target_dimension,
        edit_type: child.edit_type,
        reason: gate.reasons.join("; ") || "未过闸",
        generation: state.generation + 1,
      };
      state.tried_and_rejected.push(entry);
      triedAdded.push(child.version_id);
      this.logger.log(`拒绝:${child.version_id} → ${gate.reasons.join("; ")}`);
    }

    state.generation += 1;
    state.eval_set_version = plan.evalSetVersion;
    state.updatedAt = new Date().toISOString();
    this.stateStore.save(state);

    const genEval: GenerationEval = {
      generation: state.generation,
      eval_set_version: plan.evalSetVersion,
      mode: "scripted_intent",
      champion_before: championVersion.version_id,
      children_evaluated: [childEval],
      champion_after: state.champion,
      population_after: state.population,
      tried_and_rejected_added: triedAdded,
      timestamp: new Date().toISOString(),
    };
    await writeJsonFile(
      this.generationsDir,
      `gen_${String(state.generation).padStart(3, "0")}_${child.version_id}.json`,
      genEval,
    );
    return genEval;
  }

  /**
   * M4 自动闭环(Phase 1 全自动):eval champion → 弱点画像 → 优化器单候选提案 →
   * validate_prompt →(过)runGeneration 配对评测+闸门 / (不过)记 tried_and_rejected。
   * assigned_target 缺省时自动取 champion 最弱维度。
   */
  async runGenerationAuto(
    plan: EvalPlan,
    opts: { assignedTarget?: string; assignedEditType?: string; optimizerModelId?: string },
  ): Promise<{
    generation: GenerationEval | null;
    proposal: { child: PromptVersionMeta; validation: PromptValidation } | null;
  }> {
    const { champion, state } = this.init();
    const championScores = await this.pairedEval.runVersionEval(champion, plan);

    const profile = championProfile(championScores);
    const target =
      opts.assignedTarget ?? profile.weakDimensions[0]?.metric ?? "blind_suspicion_margin";
    this.logger.log(
      `自动优化:champion=${champion.version_id} target=${target}(弱点 ${profile.weakDimensions.length} 个,margin=${profile.meanMargin ?? "?"})`,
    );

    const input = buildOptimizerInput(
      champion,
      profile,
      target,
      opts.assignedEditType,
      state.tried_and_rejected,
    );
    const proposal = await this.optimizer.propose(input, {
      basedOn: champion.version_id,
      optimizerModelId: opts.optimizerModelId,
    });
    if (!proposal) {
      return { generation: null, proposal: null };
    }

    const validation = validatePrompt(proposal.child, champion, { lengthBudgetPct: 0.15 });
    if (!validation.ok) {
      const cur = this.stateStore.load() ?? state;
      cur.tried_and_rejected.push({
        version_id: proposal.child.version_id,
        hypothesis: proposal.child.hypothesis,
        target_dimension: proposal.child.target_dimension,
        edit_type: proposal.child.edit_type,
        reason: `validate_prompt 失败: ${validation.reasons.join("; ")}`,
        generation: cur.generation + 1,
      });
      cur.updatedAt = new Date().toISOString();
      this.stateStore.save(cur);
      this.logger.warn(
        `候选 ${proposal.child.version_id} 校验失败: ${validation.reasons.join("; ")}`,
      );
      return { generation: null, proposal: { child: toMeta(proposal.child), validation } };
    }

    const generation = await this.runGeneration(proposal.child, plan);
    return { generation, proposal: { child: toMeta(proposal.child), validation } };
  }
}

/** 从 validation 抽一版 validated_metrics(同 eval_set_version 下可比)。 */
function summarize(validation: ValidationReport): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const bucket of validation.buckets) {
    const margin = bucket.metrics["blind_suspicion_margin"];
    out[`${bucket.form}.blind_suspicion_margin`] = margin
      ? { point: margin.point, ci95: margin.ci95, verdict: margin.verdict }
      : null;
  }
  return out;
}
