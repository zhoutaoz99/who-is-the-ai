// 编排器 REST 接口(F0.6)。
// - POST /sandbox/orchestrator/seed-baseline        播种 baseline + 初始状态
// - GET  /sandbox/orchestrator/state                快照(state + active_run + champion)
// - POST /sandbox/orchestrator/run-generation       手动阻塞(传 child.prompt_text)
// - POST /sandbox/orchestrator/run-generation-auto  非阻塞 kickoff → 返回 run_id(进度走 socket)
// - POST /sandbox/orchestrator/stop                 中止活跃 run
// - POST /sandbox/orchestrator/confirm              人机确认 {accept, edited_prompt_text?}
// - GET  /sandbox/orchestrator/generations          历史代列表
// - GET  /sandbox/orchestrator/generations/:id      单代详情
// - GET  /sandbox/orchestrator/versions             PromptVersion 元数据列表
// - GET  /sandbox/orchestrator/versions/:id         单版本(含 prompt_text,diff 用)

import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import type { Scenario } from "../scenario/types";
import { SandboxService } from "../sandbox.service";
import type { EvalPlan } from "./paired-eval";
import { OrchestratorService } from "./orchestrator.service";
import { toMeta } from "./prompt-version";
import type { PromptVersion, PromptVersionMeta } from "./prompt-version";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

@Controller("sandbox/orchestrator")
export class OrchestratorController {
  constructor(
    private readonly orchestrator: OrchestratorService,
    private readonly sandbox: SandboxService,
  ) {}

  @Post("seed-baseline")
  seedBaseline(): { ok: boolean; state: unknown; champion: PromptVersionMeta | null } {
    this.orchestrator.init();
    const champion = this.orchestrator.getChampion();
    return { ok: true, state: this.orchestrator.getSnapshot(), champion: champion ? toMeta(champion) : null };
  }

  @Get("state")
  state(): { ok: boolean; state: unknown; champion: PromptVersionMeta | null } {
    const champion = this.orchestrator.getChampion();
    return { ok: true, state: this.orchestrator.getSnapshot(), champion: champion ? toMeta(champion) : null };
  }

  /** 手动阻塞:调用方提供 child 提示词文本,同步跑完一代返回 GenerationEval。 */
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
      const scenarios = this.loadScenarios(body.scenario_ids);
      if (scenarios.length === 0) return { ok: false, error: "缺少 scenario_ids 或无可加载的内置场景" };
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
      const plan: EvalPlan = this.buildPlan(scenarios, body);
      const generation = await this.orchestrator.runGeneration(child, plan);
      return { ok: true, generation };
    } catch (err) {
      return { ok: false, error: msg(err) };
    }
  }

  /** 自动非阻塞 kickoff:起 active_run,后台跑,立即返回 run_id;进度走 socket。 */
  @Post("run-generation-auto")
  async runGenerationAuto(
    @Body()
    body: {
      scenario_ids?: string[];
      mode?: string;
      assigned_target?: string;
      assigned_edit_type?: string;
      optimizer_model_id?: string;
      judge_model_id?: string;
      discussion_seconds?: number;
      seeds_per_scenario?: number;
      runs_per_seed?: number;
      eval_set_version?: string;
    },
  ): Promise<{ ok: boolean; run_id?: string; error?: string }> {
    try {
      const scenarios = this.loadScenarios(body?.scenario_ids);
      if (scenarios.length === 0) {
        return { ok: false, error: "缺少 scenario_ids 或无可加载的内置场景" };
      }
      const plan: EvalPlan = this.buildPlan(scenarios, body ?? {});
      const { run_id } = await this.orchestrator.startGenerationAuto(plan, {
        mode: body?.mode === "auto" ? "auto" : "confirm",
        assignedTarget: body?.assigned_target,
        assignedEditType: body?.assigned_edit_type,
        optimizerModelId: body?.optimizer_model_id,
      });
      return { ok: true, run_id };
    } catch (err) {
      return { ok: false, error: msg(err) };
    }
  }

  @Post("stop")
  async stop(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.orchestrator.stop();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: msg(err) };
    }
  }

  @Post("confirm")
  async confirm(
    @Body() body: { accept?: boolean; edited_prompt_text?: string },
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.orchestrator.confirm(body?.accept === true, body?.edited_prompt_text);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: msg(err) };
    }
  }

  @Get("generations")
  generations(): { ok: boolean; generations: unknown[] } {
    return { ok: true, generations: this.orchestrator.listGenerations() };
  }

  @Get("generations/:id")
  generation(@Param("id") id: string): { ok: boolean; generation?: unknown; error?: string } {
    const g = this.orchestrator.getGeneration(id);
    return g ? { ok: true, generation: g } : { ok: false, error: "未找到该代" };
  }

  @Get("versions")
  versions(): { ok: boolean; versions: PromptVersionMeta[] } {
    return { ok: true, versions: this.orchestrator.listVersions() };
  }

  @Get("versions/:id")
  version(@Param("id") id: string): { ok: boolean; version?: PromptVersion; error?: string } {
    const v = this.orchestrator.getVersion(id);
    return v ? { ok: true, version: v } : { ok: false, error: "未找到该版本" };
  }

  private loadScenarios(ids?: string[]): Scenario[] {
    return (ids ?? [])
      .map((id) => this.sandbox.loadExampleScenario(id))
      .filter((s): s is Scenario => s != null);
  }

  private buildPlan(
    scenarios: Scenario[],
    body: {
      seeds_per_scenario?: number;
      runs_per_seed?: number;
      judge_model_id?: string;
      discussion_seconds?: number;
      eval_set_version?: string;
    },
  ): EvalPlan {
    return {
      scenarios,
      seedsPerScenario: body.seeds_per_scenario ?? 1,
      runsPerSeed: body.runs_per_seed ?? 3,
      judgeModelId: body.judge_model_id,
      discussionSeconds: body.discussion_seconds,
      evalSetVersion: body.eval_set_version ?? "optimize_v1",
    };
  }
}
