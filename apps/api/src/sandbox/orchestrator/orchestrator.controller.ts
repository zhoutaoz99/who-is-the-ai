// 编排器 REST 接口(F0.6)。
// - POST /sandbox/orchestrator/seed-baseline        播种 baseline + 初始状态
// - GET  /sandbox/orchestrator/state                快照(state + active_run + champion)
// - POST /sandbox/orchestrator/run-generation       手动阻塞(传 child.prompt_text)
// - POST /sandbox/orchestrator/run-generation-auto  非阻塞 kickoff → 返回 run_id(进度走 socket)
// - POST /sandbox/orchestrator/stop                 中止活跃 run(优雅,保留 tried 记忆)
// - POST /sandbox/orchestrator/terminate            终止活跃 run 并回滚到本代开始前(丢弃候选)
// - POST /sandbox/orchestrator/confirm              人机确认 {accept, edited_prompt_text?}
// - GET  /sandbox/orchestrator/generations          历史代列表
// - GET  /sandbox/orchestrator/generations/:id      单代详情
// - GET  /sandbox/orchestrator/versions             PromptVersion 元数据列表
// - GET  /sandbox/orchestrator/versions/:id         单版本(含 prompt_text,diff 用)

import { Body, Controller, Delete, Get, Param, Post } from "@nestjs/common";
import type { Scenario } from "../scenario/types";
import { SandboxService } from "../sandbox.service";
import type { EvalSetSummary } from "../sandbox.service";
import {
  calibrationVerdict,
  correlationProxyVsReal,
  shouldRollback,
  type CalibrationPair,
} from "./calibration";
import { metricsComparable, planRebaseline, rebaselineRequired } from "./eval-set-version";
import type { EvalPlan } from "./paired-eval";
import { OrchestratorService } from "./orchestrator.service";
import { toMeta } from "./prompt-version";
import type { PromptVersion, PromptVersionMeta } from "./prompt-version";
import type { EvalCostTier } from "./scheduler";

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
      set_id?: string;
      scenario_ids?: string[];
      seeds_per_scenario?: number;
      runs_per_seed?: number;
      judge_model_id?: string;
      judge_model_ids?: string[] | string;
      diagnose?: boolean;
      cost_tier?: string;
      discussion_seconds?: number;
      eval_set_version?: string;
    },
  ): Promise<{ ok: boolean; generation?: unknown; error?: string }> {
    try {
      if (!body?.child?.version_id || !body?.child?.prompt_text) {
        return { ok: false, error: "缺少 child.version_id / child.prompt_text" };
      }
      const { scenarios, holdoutScenarios, evalSetVersion } = this.resolveEvalInputs(body);
      if (scenarios.length === 0) return { ok: false, error: "缺少 set_id/scenario_ids 或无可加载的场景" };
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
      const plan: EvalPlan = this.buildPlan(scenarios, body, evalSetVersion, holdoutScenarios);
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
      set_id?: string;
      scenario_ids?: string[];
      mode?: string;
      assigned_target?: string;
      assigned_edit_type?: string;
      optimizer_model_id?: string;
      judge_model_id?: string;
      judge_model_ids?: string[] | string;
      diagnose?: boolean;
      cost_tier?: string;
      discussion_seconds?: number;
      seeds_per_scenario?: number;
      runs_per_seed?: number;
      eval_set_version?: string;
    },
  ): Promise<{ ok: boolean; run_id?: string; error?: string }> {
    try {
      const { scenarios, holdoutScenarios, evalSetVersion } = this.resolveEvalInputs(body ?? {});
      if (scenarios.length === 0) {
        return { ok: false, error: "缺少 set_id/scenario_ids 或无可加载的场景" };
      }
      const plan: EvalPlan = this.buildPlan(scenarios, body ?? {}, evalSetVersion, holdoutScenarios);
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

  /** 终止活跃 run 并回滚到本代开始前(丢弃候选版本、恢复 champion/代数/失败记忆)。 */
  @Post("terminate")
  async terminate(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.orchestrator.terminate();
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
  async generations(): Promise<{ ok: boolean; generations: unknown[] }> {
    return { ok: true, generations: await this.orchestrator.listGenerations() };
  }

  @Get("generations/:id")
  async generation(
    @Param("id") id: string,
  ): Promise<{ ok: boolean; generation?: unknown; error?: string }> {
    const g = await this.orchestrator.getGeneration(id);
    return g ? { ok: true, generation: g } : { ok: false, error: "未找到该代" };
  }

  /** 删除一条历史代记录。 */
  @Delete("generations/:id")
  async deleteGeneration(
    @Param("id") id: string,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.orchestrator.deleteGeneration(id);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: msg(err) };
    }
  }

  /** 内置评测集清单(前台选 set_id 用)。 */
  @Get("eval-sets")
  evalSets(): { ok: boolean; sets: EvalSetSummary[] } {
    return { ok: true, sets: this.sandbox.getEvalSetList() };
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

  /** 重激活一个稳定历史版本为 champion(人工回滚 / 校准翻车后使用)。 */
  @Post("versions/:id/activate")
  async activateVersion(
    @Param("id") id: string,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.orchestrator.activateVersion(id);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: msg(err) };
    }
  }

  /**
   * 真人校准体检(M5.11):调用方传入 proxy/real 配对样本,返回相关性裁决。
   * 不自动改 champion;真人批次接入后由调用方按 rollback=true 决策回滚。
   */
  @Post("calibration/check")
  calibrationCheck(
    @Body()
    body: {
      pairs?: CalibrationPair[];
      threshold?: number;
      sandbox_improved?: boolean;
      real_regressed?: boolean;
    },
  ): { ok: boolean; result?: unknown; verdict?: unknown; rollback?: boolean; error?: string } {
    const pairs = Array.isArray(body?.pairs) ? body.pairs : [];
    if (pairs.length === 0) return { ok: false, error: "缺少 pairs" };
    const result = correlationProxyVsReal(pairs, body.threshold);
    return {
      ok: true,
      result,
      verdict: calibrationVerdict(result),
      rollback: shouldRollback(body?.sandbox_improved === true, body?.real_regressed === true),
    };
  }

  /**
   * 评测集升级重基线计划(M5.12):判断当前 state.eval_set_version 与目标集是否可比/需重跑。
   */
  @Post("rebaseline-plan")
  rebaselinePlan(
    @Body() body: { set_id?: string; target_eval_set_version?: string; version_id?: string },
  ): { ok: boolean; required?: boolean; comparable?: boolean; plan?: unknown; error?: string } {
    const state = this.orchestrator.getState();
    let target = body?.target_eval_set_version;
    if (!target && body?.set_id) {
      const set = this.sandbox.loadEvalSet(body.set_id);
      if (!set) return { ok: false, error: `未找到评测集 ${body.set_id}` };
      target = set.eval_set_version;
    }
    if (!target) return { ok: false, error: "缺少 set_id 或 target_eval_set_version" };
    const versionId = body?.version_id || state.champion;
    const meta = this.orchestrator.listVersions().find((v) => v.version_id === versionId);
    return {
      ok: true,
      required: rebaselineRequired(state.eval_set_version, target),
      comparable: meta ? metricsComparable(meta, target) : false,
      plan: planRebaseline(versionId, state.eval_set_version, target),
    };
  }

  /** 删除一个提示词版本(禁止删 champion / baseline / 活跃候选;服务端再校验)。 */
  @Delete("versions/:id")
  async deleteVersion(
    @Param("id") id: string,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      this.orchestrator.deleteVersion(id);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: msg(err) };
    }
  }

  /** 清空全部失败记忆。 */
  @Delete("tried")
  async clearTried(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.orchestrator.clearTried();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: msg(err) };
    }
  }

  /** 删除一条失败记忆(按 version_id)。 */
  @Delete("tried/:versionId")
  async removeTried(
    @Param("versionId") versionId: string,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.orchestrator.removeTried(versionId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: msg(err) };
    }
  }

  private loadScenarios(ids?: string[]): Scenario[] {
    return (ids ?? [])
      .map((id) => this.sandbox.loadExampleScenario(id))
      .filter((s): s is Scenario => s != null);
  }

  /**
   * 解析待评测场景与绑定的 eval_set_version:
   * - 传 set_id → optimize 半驱动本环(accept gate),holdout 半作第二道闸(留出复核,M5.7);
   *   version 取自清单(set_id@version)。holdout 为空时留出闸优雅跳过。
   * - 否则回退到裸 scenario_ids + 自由 eval_set_version(默认 optimize_v1),无 holdout。
   */
  private resolveEvalInputs(body: {
    set_id?: string;
    scenario_ids?: string[];
    eval_set_version?: string;
  }): { scenarios: Scenario[]; holdoutScenarios: Scenario[]; evalSetVersion: string } {
    if (body?.set_id) {
      const set = this.sandbox.loadEvalSet(body.set_id);
      if (!set) throw new Error(`未找到评测集 ${body.set_id}`);
      return {
        scenarios: set.optimize,
        holdoutScenarios: set.holdout,
        evalSetVersion: set.eval_set_version,
      };
    }
    return {
      scenarios: this.loadScenarios(body?.scenario_ids),
      holdoutScenarios: [],
      evalSetVersion: body?.eval_set_version ?? "optimize_v1",
    };
  }

  private buildPlan(
    scenarios: Scenario[],
    body: {
      seeds_per_scenario?: number;
      runs_per_seed?: number;
      judge_model_id?: string;
      judge_model_ids?: string[] | string;
      diagnose?: boolean;
      cost_tier?: string;
      discussion_seconds?: number;
    },
    evalSetVersion: string,
    holdoutScenarios: Scenario[] = [],
  ): EvalPlan {
    return {
      scenarios,
      holdoutScenarios,
      seedsPerScenario: body.seeds_per_scenario ?? 1,
      runsPerSeed: body.runs_per_seed ?? 3,
      judgeModelId: body.judge_model_id,
      judgeModelIds: parseModelIds(body.judge_model_ids),
      diagnose: body.diagnose === true,
      costTier: parseCostTier(body.cost_tier),
      discussionSeconds: body.discussion_seconds,
      evalSetVersion,
    };
  }
}

function parseModelIds(value: string[] | string | undefined): string[] | undefined {
  if (Array.isArray(value)) {
    const ids = value.map((v) => String(v).trim()).filter(Boolean);
    return ids.length > 0 ? ids : undefined;
  }
  if (typeof value !== "string") return undefined;
  const ids = value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  return ids.length > 0 ? ids : undefined;
}

function parseCostTier(value: string | undefined): EvalCostTier | undefined {
  return value === "decision" || value === "diagnostic" || value === "calibration" ? value : undefined;
}
