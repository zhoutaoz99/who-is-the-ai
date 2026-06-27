// 编排器服务(F0 后台演进):
//  - runGenerationAuto 改后台 run:逐 phase 推进、逐局/逐 phase emit 进度事件。
//  - confirm 模式在 gating 后暂停 awaiting_confirmation,等人 accept/reject/edited。
//  - active_run 持久化 + 重启续接(awaiting 可续;运行中中断标 stopped)。
//  - 事件经 OrchestratorGateway 桥接到 socket orchestrator.*。
// 手动阻塞入口 runGeneration(传 child)保留;两路共用 settleGeneration。

import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { buildValidation } from "../aggregate/validation";
import { DEFAULT_AGG_CONFIG } from "../aggregate/types";
import type { ValidationReport } from "../aggregate/validation";
import { buildOptimizerInput, championProfile } from "../optimizer/input";
import { OptimizerService } from "../optimizer/propose";
import { validatePrompt } from "../optimizer/validate-prompt";
import type { PromptValidation } from "../optimizer/validate-prompt";
import { writeJsonFile } from "../shared/store";
import { optimizeGate } from "./gate";
import type { GateDecision } from "./gate";
import type { GenerationEval } from "./generation-eval";
import { PairedEvalService } from "./paired-eval";
import type { EvalPlan } from "./paired-eval";
import { PromptVersionStore } from "./prompt-version";
import type { PromptVersion, PromptVersionMeta } from "./prompt-version";
import { OrchestratorStateStore } from "./state";
import type { OrchestratorState } from "./state";
import type {
  ActiveRun,
  ActiveRunChild,
  ConfirmResult,
  GameItem,
  RunDecision,
  RunMode,
} from "./active-run";

const POPULATION_CAP = 5;

export interface OrchestratorSnapshot {
  champion: string;
  population: string[];
  generation: number;
  eval_set_version: string;
  tried_count: number;
  active_run: ActiveRun | null;
}

@Injectable()
export class OrchestratorService implements OnModuleInit {
  private readonly logger = new Logger(OrchestratorService.name);
  /** 内部事件;OrchestratorGateway 订阅后桥接到 socket。 */
  readonly events = new EventEmitter();

  private readonly generationsDir: string;
  /** 待确认的 resolver(runLoop 在 awaiting_confirmation 时 await 它)。 */
  private confirmResolver: ((r: ConfirmResult | "stop") => void) | null = null;
  private stopRequested = false;
  /** 活跃 run 的内存镜像(与 state.active_run 同步)。 */
  private activeRun: ActiveRun | null = null;

  constructor(
    private readonly promptStore: PromptVersionStore,
    private readonly stateStore: OrchestratorStateStore,
    private readonly pairedEval: PairedEvalService,
    private readonly optimizer: OptimizerService,
  ) {
    const root = process.env.SANDBOX_OUT_DIR ?? join(process.cwd(), "sandbox-out");
    this.generationsDir = join(root, "generations");
  }

  onModuleInit(): void {
    this.promptStore.seedBaselineIfMissing();
    const state = this.stateStore.load() ?? this.stateStore.seedBaseline();
    // 重启续接:仅 awaiting_confirmation 可续;运行中 phase 中断 → stopped。
    const run = state.active_run;
    if (run && run.phase !== "settled") {
      if (run.phase === "awaiting_confirmation") {
        this.activeRun = run;
        this.logger.log(`重启续接:run ${run.run_id} 处于 awaiting_confirmation`);
      } else {
        run.phase = "settled";
        run.decision = "stopped";
        run.error = "重启中断";
        run.settled_at = new Date().toISOString();
        state.active_run = null;
        state.updatedAt = new Date().toISOString();
        this.stateStore.save(state);
        this.logger.warn(`重启:run ${run.run_id} 运行中中断,标记 stopped`);
      }
    }
  }

  // ===== 只读 =====

  init(): { state: OrchestratorState } {
    this.promptStore.seedBaselineIfMissing();
    const state = this.stateStore.load() ?? this.stateStore.seedBaseline();
    return { state };
  }

  getState(): OrchestratorState {
    return this.stateStore.load() ?? this.stateStore.seedBaseline();
  }

  getChampion(): PromptVersion | null {
    return this.promptStore.load(this.getState().champion);
  }

  getActiveRun(): ActiveRun | null {
    return this.activeRun ?? this.stateStore.load()?.active_run ?? null;
  }

  getSnapshot(): OrchestratorSnapshot {
    const s = this.getState();
    return {
      champion: s.champion,
      population: s.population,
      generation: s.generation,
      eval_set_version: s.eval_set_version,
      tried_count: s.tried_and_rejected.length,
      active_run: this.getActiveRun(),
    };
  }

  listGenerations(): GenerationEval[] {
    if (!existsSync(this.generationsDir)) return [];
    return readdirSync(this.generationsDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(this.generationsDir, f), "utf-8")) as GenerationEval;
        } catch {
          return null;
        }
      })
      .filter((g): g is GenerationEval => g != null)
      .sort((a, b) => b.generation - a.generation);
  }

  getGeneration(generationId: string): GenerationEval | null {
    const file = join(this.generationsDir, `${generationId}.json`);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf-8")) as GenerationEval;
    } catch {
      return null;
    }
  }

  listVersions(): PromptVersionMeta[] {
    return this.promptStore.list();
  }

  getVersion(id: string): PromptVersion | null {
    return this.promptStore.load(id);
  }

  // ===== 手动阻塞入口(传 child;保留)=====

  async runGeneration(child: PromptVersion, plan: EvalPlan): Promise<GenerationEval> {
    const { state } = this.init();
    const championVersion = this.promptStore.load(state.champion);
    if (!championVersion) throw new Error(`champion 缺失: ${state.champion}`);
    if (!this.promptStore.load(child.version_id)) {
      this.promptStore.save({ ...child, status: "candidate" });
    }
    const childVersion = this.promptStore.load(child.version_id)!;
    const parentScores = await this.pairedEval.runVersionEval(championVersion, plan);
    const childScores = await this.pairedEval.runVersionEval(childVersion, plan);
    const validation = buildValidation(parentScores, childScores);
    const gate = optimizeGate(validation);
    const decision = gate.decision === "promote" ? "promoted" : "rejected";
    return await this.settleGeneration({
      championBeforeId: championVersion.version_id,
      child: childVersion,
      decision,
      validation,
      gate,
      evalSetVersion: plan.evalSetVersion,
    });
  }

  // ===== F0 后台自动闭环 =====

  /** 非阻塞 kickoff:起 active_run,后台跑 runLoop,立即返回 run_id。进度走 socket。 */
  async startGenerationAuto(
    plan: EvalPlan,
    opts: { mode?: RunMode; assignedTarget?: string; assignedEditType?: string; optimizerModelId?: string },
  ): Promise<{ run_id: string }> {
    const state = this.stateStore.load() ?? this.stateStore.seedBaseline();
    if (state.active_run && state.active_run.phase !== "settled") {
      throw new Error("已有活跃 run(先 stop 或 confirm)");
    }
    const champion = this.promptStore.load(state.champion);
    if (!champion) throw new Error(`champion 缺失: ${state.champion}`);

    const total = plan.scenarios.length * plan.seedsPerScenario * plan.runsPerSeed;
    const run_id = `run_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.activeRun = {
      run_id,
      phase: "evaluating_champion",
      mode: opts.mode ?? "confirm",
      generation: state.generation + 1,
      champion_id: champion.version_id,
      plan_summary: {
        scenarios: plan.scenarios.map((s) => s.scenario_id),
        seedsPerScenario: plan.seedsPerScenario,
        runsPerSeed: plan.runsPerSeed,
        evalSetVersion: plan.evalSetVersion,
      },
      progress: { champion_done: 0, champion_total: total, child_done: 0, child_total: total, games: [] },
      started_at: new Date().toISOString(),
    };
    this.stopRequested = false;
    this.confirmResolver = null;
    state.active_run = this.activeRun;
    this.stateStore.save(state);
    this.emitStatus();
    this.logger.log(
      `kickoff run ${run_id}(mode=${this.activeRun.mode}, champion=${champion.version_id}, 场景 ${plan.scenarios.length} × seed${plan.seedsPerScenario} × run${plan.runsPerSeed})`,
    );

    void this.runLoop(plan, opts).catch((err) => {
      this.settleStopped(err instanceof Error ? err.message : String(err));
    });
    return { run_id };
  }

  /** 后台主循环:eval_champion → optimize → validate → eval_child → gate → confirm/auto。 */
  private async runLoop(
    plan: EvalPlan,
    opts: { assignedTarget?: string; assignedEditType?: string; optimizerModelId?: string },
  ): Promise<void> {
    const run = this.activeRun!;
    const champion = this.promptStore.load(run.champion_id)!;

    // 1) 评测 champion
    this.setPhase("evaluating_champion");
    const championScores = await this.pairedEval.runVersionEval(champion, plan, {
      onGameStatus: (patch) => this.recordGameStatus({ side: "champion", ...patch }),
      shouldStop: () => this.stopRequested,
    });
    if (this.stopRequested) return this.settleStopped("用户停止");

    // 2) 优化器提案
    this.setPhase("optimizing");
    const profile = championProfile(championScores);
    const target =
      opts.assignedTarget ?? profile.weakDimensions[0]?.metric ?? "blind_suspicion_margin";
    const state = this.stateStore.load()!;
    const input = buildOptimizerInput(champion, profile, target, opts.assignedEditType, state.tried_and_rejected);
    const proposal = await this.optimizer.propose(input, {
      basedOn: champion.version_id,
      optimizerModelId: opts.optimizerModelId,
    });
    if (this.stopRequested) return this.settleStopped("用户停止");
    if (!proposal) return this.settleStopped("优化器未产出可用候选");

    // 3) 校验
    this.setPhase("validating");
    this.promptStore.save({ ...proposal.child, status: "candidate" });
    const validate = validatePrompt(proposal.child, champion, { lengthBudgetPct: 0.15 });
    run.child = {
      version_id: proposal.child.version_id,
      target: proposal.child.target_dimension ?? target,
      edit_type: proposal.child.edit_type ?? "",
      hypothesis: proposal.child.hypothesis,
      prompt_text: proposal.child.prompt_text,
    };
    run.validate = validate;
    this.persistRun();
    this.emitProposal(run.child, validate);
    if (this.stopRequested) return this.settleStopped("用户停止");
    if (!validate.ok) {
      // validate 失败:按 rejected 落定(记 tried_and_rejected + 历史代)
      const failGate: GateDecision = {
        decision: "reject",
        reasons: [`validate_prompt 失败: ${validate.reasons.join("; ")}`],
        marginVerdict: null,
      };
      run.gate = failGate;
      await this.settleGeneration({
        championBeforeId: champion.version_id,
        child: proposal.child,
        decision: "rejected",
        validation: emptyValidation(champion.version_id, proposal.child.version_id),
        gate: failGate,
        evalSetVersion: plan.evalSetVersion,
      });
      return this.settleRunDone("rejected");
    }

    // 4) 评测 child
    this.setPhase("evaluating_child");
    const childScores = await this.pairedEval.runVersionEval(proposal.child, plan, {
      onGameStatus: (patch) => this.recordGameStatus({ side: "child", ...patch }),
      shouldStop: () => this.stopRequested,
    });
    if (this.stopRequested) return this.settleStopped("用户停止");

    // 5) 闸门
    this.setPhase("gating");
    const validation = buildValidation(championScores, childScores);
    const gate = optimizeGate(validation);
    run.validation = validation;
    run.gate = gate;
    this.persistRun();
    this.emitGate(validation, gate);

    // 6) confirm 暂停 / auto 自动落定
    if (run.mode === "confirm") {
      this.setPhase("awaiting_confirmation");
      const res = await this.awaitConfirm();
      if (res === "stop") return this.settleStopped("用户停止");
      const decision: "promoted" | "rejected" = res.accept ? "promoted" : "rejected";
      await this.settleGeneration({
        championBeforeId: champion.version_id,
        child: proposal.child,
        decision,
        validation,
        gate,
        evalSetVersion: plan.evalSetVersion,
        editedPromptText: res.edited,
      });
      return this.settleRunDone(decision);
    }
    const autoDecision: "promoted" | "rejected" = gate.decision === "promote" ? "promoted" : "rejected";
    await this.settleGeneration({
      championBeforeId: champion.version_id,
      child: proposal.child,
      decision: autoDecision,
      validation,
      gate,
      evalSetVersion: plan.evalSetVersion,
    });
    return this.settleRunDone(autoDecision);
  }

  /** 人机确认:live run 在 awaiting → 唤醒 resolver;重启后 → 从持久化 settle。 */
  async confirm(accept: boolean, edited?: string): Promise<void> {
    if (this.confirmResolver) {
      this.confirmResolver({ accept, edited });
      this.confirmResolver = null;
      return;
    }
    const state = this.stateStore.load();
    const run = state?.active_run;
    if (!run || run.phase !== "awaiting_confirmation") {
      throw new Error("无待确认的 run");
    }
    if (!run.child || !run.validation || !run.gate) {
      throw new Error("待确认 run 数据不完整");
    }
    this.activeRun = run;
    const child = this.promptStore.load(run.child.version_id);
    if (!child) throw new Error(`候选版本缺失: ${run.child.version_id}`);
    const decision: "promoted" | "rejected" = accept ? "promoted" : "rejected";
    await this.settleGeneration({
      championBeforeId: run.champion_id,
      child,
      decision,
      validation: run.validation,
      gate: run.gate,
      evalSetVersion: run.plan_summary.evalSetVersion,
      editedPromptText: edited,
    });
    this.settleRunDone(decision);
  }

  async stop(): Promise<void> {
    const run = this.stateStore.load()?.active_run;
    if (!run || run.phase === "settled") return;
    this.stopRequested = true;
    if (run.phase === "awaiting_confirmation") {
      if (this.confirmResolver) {
        this.confirmResolver("stop");
        this.confirmResolver = null;
      } else {
        this.activeRun = run;
        this.settleStopped("用户停止");
      }
    }
    // 运行中 phase:stopRequested 由 runLoop 的 shouldStop 捕获 → settleStopped
  }

  // ===== run 内部辅助 =====

  private awaitConfirm(): Promise<ConfirmResult | "stop"> {
    return new Promise((resolve) => {
      this.confirmResolver = resolve;
    });
  }

  private setPhase(phase: ActiveRun["phase"]): void {
    if (!this.activeRun) return;
    this.activeRun.phase = phase;
    this.persistRun();
    this.emitStatus();
  }

  /** 逐局状态就地 upsert(以 side×scenario×seed×run 为 key)+ 从 games 重算 done 计数 + emit game。 */
  private recordGameStatus(item: GameItem): void {
    const run = this.activeRun!;
    const games = run.progress.games;
    const idx = games.findIndex(
      (g) =>
        g.side === item.side &&
        g.scenario_id === item.scenario_id &&
        g.seed === item.seed &&
        g.run === item.run,
    );
    if (idx >= 0) games[idx] = { ...games[idx], ...item };
    else games.push(item);
    // done 计数从 games[] 重算(idempotent,防并发重复计数)。
    run.progress.champion_done = games.filter(
      (g) => g.side === "champion" && (g.status === "finished" || g.status === "failed"),
    ).length;
    run.progress.child_done = games.filter(
      (g) => g.side === "child" && (g.status === "finished" || g.status === "failed"),
    ).length;
    this.persistRun();
    this.events.emit("game", item);
  }

  private persistRun(): void {
    const s = this.stateStore.load();
    if (s) {
      s.active_run = this.activeRun;
      s.updatedAt = new Date().toISOString();
      this.stateStore.save(s);
    }
  }

  /** promote/reject + 状态更新 + GenerationEval 落盘(手动/自动两路共用)。 */
  private async settleGeneration(args: {
    championBeforeId: string;
    child: PromptVersion;
    decision: "promoted" | "rejected";
    validation: ValidationReport;
    gate: GateDecision;
    evalSetVersion: string;
    editedPromptText?: string;
  }): Promise<GenerationEval> {
    const state = this.stateStore.load() ?? this.stateStore.seedBaseline();
    const { championBeforeId, child, decision, validation, gate, evalSetVersion, editedPromptText } = args;

    if (decision === "promoted") {
      const finalChild = editedPromptText ? { ...child, prompt_text: editedPromptText } : child;
      this.promptStore.save({ ...finalChild, status: "candidate" });
      this.promptStore.patchStatus(finalChild.version_id, {
        status: "champion",
        validated_metrics: summarize(validation),
        eval_set_version: evalSetVersion,
      });
      if (state.champion !== finalChild.version_id) {
        this.promptStore.patchStatus(state.champion, { status: "accepted" });
      }
      state.population = [
        finalChild.version_id,
        ...state.population.filter((id) => id !== finalChild.version_id),
      ].slice(0, POPULATION_CAP);
      state.champion = finalChild.version_id;
      this.logger.log(`晋升:${finalChild.version_id} 成为新 champion`);
    } else {
      this.promptStore.patchStatus(child.version_id, { status: "rejected" });
      state.tried_and_rejected.push({
        version_id: child.version_id,
        hypothesis: child.hypothesis,
        target_dimension: child.target_dimension,
        edit_type: child.edit_type,
        reason: gate.reasons.join("; ") || "未过闸/人工拒绝",
        generation: state.generation + 1,
      });
      this.logger.log(`拒绝:${child.version_id}`);
    }

    state.generation += 1;
    state.eval_set_version = evalSetVersion;
    state.updatedAt = new Date().toISOString();
    const generation_id = `gen_${state.generation}_${child.version_id}`;
    const genEval: GenerationEval = {
      generation_id,
      generation: state.generation,
      eval_set_version: evalSetVersion,
      mode: "scripted_intent",
      champion_before: championBeforeId,
      children_evaluated: [
        {
          child_id: child.version_id,
          based_on: child.parent_id ?? championBeforeId,
          hypothesis: child.hypothesis,
          target_dimension: child.target_dimension,
          edit_type: child.edit_type,
          validation,
          gate,
          decision,
        },
      ],
      champion_after: state.champion,
      population_after: state.population,
      tried_and_rejected_added: decision === "rejected" ? [child.version_id] : [],
      timestamp: new Date().toISOString(),
    };
    this.stateStore.save(state);
    await writeJsonFile(this.generationsDir, `${generation_id}.json`, genEval);
    return genEval;
  }

  /** runLoop 正常落定后:标记 active_run settled + 清除 + emit done/status。 */
  private settleRunDone(decision: RunDecision): void {
    const run = this.activeRun;
    if (run) {
      run.phase = "settled";
      run.decision = decision;
      run.settled_at = new Date().toISOString();
    }
    const state = this.stateStore.load();
    if (state) {
      state.active_run = null;
      state.updatedAt = new Date().toISOString();
      this.stateStore.save(state);
    }
    this.events.emit("done", {
      run_id: run?.run_id,
      generation: run?.generation,
      decision,
      champion_after: state?.champion,
    });
    this.activeRun = null;
    this.confirmResolver = null;
    this.emitStatus();
  }

  /** 异常/停止落定:记 tried(若有候选)+ 标 stopped + emit done。 */
  private settleStopped(reason: string): void {
    const run = this.activeRun;
    const state = this.stateStore.load();
    if (run?.child && state) {
      state.tried_and_rejected.push({
        version_id: run.child.version_id,
        hypothesis: run.child.hypothesis,
        target_dimension: run.child.target,
        edit_type: run.child.edit_type,
        reason: `停止: ${reason}`,
        generation: run.generation,
      });
    }
    if (run) {
      run.phase = "settled";
      run.decision = "stopped";
      run.error = reason;
      run.settled_at = new Date().toISOString();
    }
    if (state) {
      state.active_run = null;
      state.updatedAt = new Date().toISOString();
      this.stateStore.save(state);
    }
    this.events.emit("done", {
      run_id: run?.run_id,
      generation: run?.generation,
      decision: "stopped",
      champion_after: state?.champion,
      error: reason,
    });
    this.activeRun = null;
    this.confirmResolver = null;
    this.stopRequested = false;
    this.emitStatus();
    this.logger.warn(`run 停止: ${reason}`);
  }

  // ===== 事件 emit =====

  private emitStatus(): void {
    this.events.emit("status", this.getSnapshot());
  }
  private emitProposal(child: ActiveRunChild, validate: PromptValidation): void {
    this.events.emit("proposal", { child, validate });
  }
  private emitGate(validation: ValidationReport, gate: GateDecision): void {
    this.events.emit("gate", { validation, gate });
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

function emptyValidation(parentVersion: string, childVersion: string): ValidationReport {
  return { parentVersion, childVersion, config: DEFAULT_AGG_CONFIG, buckets: [] };
}
