// 编排器 REST 接口(Phase 1:手动优化器——child 由调用方提供提示词文本)。
// - POST /sandbox/orchestrator/seed-baseline   播种 v0-baseline + 初始状态
// - GET  /sandbox/orchestrator/state           查 champion / 种群 / 代数 / 失败记忆
// - POST /sandbox/orchestrator/run-generation  跑一代(child vs champion),返回 GenerationEval

import { Body, Controller, Get, Post } from "@nestjs/common";
import type { Scenario } from "../scenario/types";
import { SandboxService } from "../sandbox.service";
import type { EvalPlan } from "./paired-eval";
import { OrchestratorService } from "./orchestrator.service";
import { toMeta } from "./prompt-version";
import type { PromptVersion, PromptVersionMeta } from "./prompt-version";

@Controller("sandbox/orchestrator")
export class OrchestratorController {
  constructor(
    private readonly orchestrator: OrchestratorService,
    private readonly sandbox: SandboxService,
  ) {}

  @Post("seed-baseline")
  seedBaseline(): { ok: boolean; champion: PromptVersionMeta; state: unknown } {
    const { champion, state } = this.orchestrator.init();
    return { ok: true, champion: toMeta(champion), state };
  }

  @Get("state")
  state(): { ok: boolean; state: unknown; champion: PromptVersionMeta | null } {
    const champion = this.orchestrator.getChampion();
    return { ok: true, state: this.orchestrator.getState(), champion: champion ? toMeta(champion) : null };
  }

  @Post("run-generation")
  async runGeneration(
    @Body()
    body: {
      child: Partial<PromptVersion> & { version_id: string; prompt_text: string };
      scenario_ids?: string[];
      seeds_per_scenario?: number;
      runs_per_seed?: number;
      judge_model_id?: string;
      discussion_seconds?: number;
      eval_set_version?: string;
    },
  ): Promise<{ ok: boolean; generation?: unknown; error?: string }> {
    try {
      if (!body?.child?.version_id || !body?.child?.prompt_text) {
        return { ok: false, error: "缺少 child.version_id / child.prompt_text" };
      }
      const state = this.orchestrator.getState();
      const child: PromptVersion = {
        version_id: body.child.version_id,
        parent_id: body.child.parent_id ?? state.champion,
        prompt_text: body.child.prompt_text,
        persona_scope: "shared",
        status: "candidate",
        hypothesis: body.child.hypothesis,
        target_dimension: body.child.target_dimension,
        edit_type: body.child.edit_type,
        created_at: new Date().toISOString(),
      };

      const scenarios: Scenario[] = (body.scenario_ids ?? [])
        .map((id) => this.sandbox.loadExampleScenario(id))
        .filter((s): s is Scenario => s != null);
      if (scenarios.length === 0) {
        return { ok: false, error: "缺少 scenario_ids 或无可加载的内置场景" };
      }

      const plan: EvalPlan = {
        scenarios,
        seedsPerScenario: body.seeds_per_scenario ?? 1,
        runsPerSeed: body.runs_per_seed ?? 3,
        judgeModelId: body.judge_model_id,
        discussionSeconds: body.discussion_seconds,
        evalSetVersion: body.eval_set_version ?? "optimize_v1",
      };

      const generation = await this.orchestrator.runGeneration(child, plan);
      return { ok: true, generation };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  @Post("run-generation-auto")
  async runGenerationAuto(
    @Body()
    body: {
      scenario_ids?: string[];
      seeds_per_scenario?: number;
      runs_per_seed?: number;
      assigned_target?: string;
      assigned_edit_type?: string;
      optimizer_model_id?: string;
      judge_model_id?: string;
      discussion_seconds?: number;
      eval_set_version?: string;
    },
  ): Promise<{ ok: boolean; generation?: unknown; proposal?: unknown; error?: string }> {
    try {
      const scenarios: Scenario[] = (body?.scenario_ids ?? [])
        .map((id) => this.sandbox.loadExampleScenario(id))
        .filter((s): s is Scenario => s != null);
      if (scenarios.length === 0) {
        return { ok: false, error: "缺少 scenario_ids 或无可加载的内置场景" };
      }
      const plan: EvalPlan = {
        scenarios,
        seedsPerScenario: body.seeds_per_scenario ?? 1,
        runsPerSeed: body.runs_per_seed ?? 3,
        judgeModelId: body.judge_model_id,
        discussionSeconds: body.discussion_seconds,
        evalSetVersion: body.eval_set_version ?? "optimize_v1",
      };
      const result = await this.orchestrator.runGenerationAuto(plan, {
        assignedTarget: body.assigned_target,
        assignedEditType: body.assigned_edit_type,
        optimizerModelId: body.optimizer_model_id,
      });
      return { ok: true, generation: result.generation, proposal: result.proposal };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
