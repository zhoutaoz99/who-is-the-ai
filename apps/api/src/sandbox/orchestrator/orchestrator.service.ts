// 编排器服务(F0 后台演进):
//  - runGenerationAuto 改后台 run:逐 phase 推进、逐局/逐 phase emit 进度事件。
//  - confirm 模式在 gating 后暂停 awaiting_confirmation,等人 accept/reject/edited。
//  - active_run 持久化 + 重启续接(awaiting 可续;运行中中断标 stopped)。
//  - 事件经 OrchestratorGateway 桥接到 socket orchestrator.*。
// 手动阻塞入口 runGeneration(传 child)保留;两路共用 settleGeneration。

import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { EventEmitter } from "node:events";
import { buildValidation } from "../aggregate/validation";
import { DEFAULT_AGG_CONFIG } from "../aggregate/types";
import type { ValidationReport } from "../aggregate/validation";
import { assignTargets } from "../optimizer/assign-targets";
import { buildOptimizerInput, championProfile } from "../optimizer/input";
import { typeOfTarget } from "../optimizer/operators";
import { OptimizerService } from "../optimizer/propose";
import { marginScore, updatePopulation } from "./population";
import { emptyScoreboard, updateScoreboard } from "../optimizer/scoreboard";
import { evaluateHypothesis } from "../optimizer/tried-and-rejected";
import { validatePrompt } from "../optimizer/validate-prompt";
import type { PromptValidation } from "../optimizer/validate-prompt";
import { SandboxRepository } from "../sandbox.repository";
import { optimizeGate } from "./gate";
import type { GateDecision } from "./gate";
import type { GenerationEval } from "./generation-eval";
import { buildHoldoutSummary, holdoutGate } from "./holdout-eval";
import type { HoldoutDecision, HoldoutSummary } from "./holdout-eval";
import { PairedEvalService } from "./paired-eval";
import type { EvalPlan } from "./paired-eval";
import { BASELINE_VERSION_ID, PromptVersionStore } from "./prompt-version";
import type { PromptVersion, PromptVersionMeta } from "./prompt-version";
import { OrchestratorStateStore } from "./state";
import type { OrchestratorState, TriedAndRejectedEntry } from "./state";
import type {
  ActiveRun,
  ActiveRunChild,
  ConfirmResult,
  GameItem,
  HoldoutRun,
  RunDecision,
  RunMode,
} from "./active-run";

const POPULATION_CAP = 5;
/** 每代靶子预算(assign_targets 取前 N 弱点配算子;单线贪心取首个,多子并行待后续)。 */
const K_CHILDREN = 4;

export interface OrchestratorSnapshot {
  champion: string;
  population: string[];
  generation: number;
  eval_set_version: string;
  tried_count: number;
  /** 失败记忆全量(前台查看/删除用)。 */
  tried_and_rejected: TriedAndRejectedEntry[];
  active_run: ActiveRun | null;
}

@Injectable()
export class OrchestratorService implements OnModuleInit {
  private readonly logger = new Logger(OrchestratorService.name);
  /** 内部事件;OrchestratorGateway 订阅后桥接到 socket。 */
  readonly events = new EventEmitter();

  /** 待确认的 resolver(runLoop 在 awaiting_confirmation 时 await 它)。 */
  private confirmResolver: ((r: ConfirmResult | "stop") => void) | null = null;
  private stopRequested = false;
  /** terminate 中:runLoop 的 settleStopped/recordGameStatus 见此旗即退避,由 terminate 接管清理。 */
  private terminating = false;
  /** 本 run 开始前的 state 快照(terminate 回滚用;kickoff 时捕获,新 run 时刷新)。 */
  private runStartSnapshot: OrchestratorState | null = null;
  /** 活跃 run 的内存镜像(与 state.active_run 同步)。 */
  private activeRun: ActiveRun | null = null;

  constructor(
    private readonly promptStore: PromptVersionStore,
    private readonly stateStore: OrchestratorStateStore,
    private readonly pairedEval: PairedEvalService,
    private readonly optimizer: OptimizerService,
    private readonly repo: SandboxRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    // 先把 state / prompt-version 内存缓存从 DB 装入,再 seed/续接。
    await this.promptStore.init();
    await this.stateStore.init();
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
      tried_and_rejected: s.tried_and_rejected,
      active_run: this.getActiveRun(),
    };
  }

  async listGenerations(): Promise<GenerationEval[]> {
    return this.repo.listGenerations();
  }

  async getGeneration(generationId: string): Promise<GenerationEval | null> {
    return this.repo.getGeneration(generationId);
  }

  /** 删除一条历史代记录(纯历史日志;不影响 champion/代数计数等当前状态)。 */
  async deleteGeneration(generationId: string): Promise<void> {
    await this.repo.deleteGeneration(generationId);
  }

  listVersions(): PromptVersionMeta[] {
    return this.promptStore.list();
  }

  getVersion(id: string): PromptVersion | null {
    return this.promptStore.load(id);
  }

  /**
   * 删除一个提示词版本。禁止删除:当前 champion、baseline 种子、活跃 run 的候选
   * (删了会让迭代状态/血脉失锚)。其余(candidate/accepted/rejected)可删。
   * 注意:删除后该 version_id 若仍出现在 population/tried_and_rejected 里,只是悬空引用(无害)。
   */
  deleteVersion(versionId: string): void {
    const state = this.stateStore.load();
    if (versionId === BASELINE_VERSION_ID) {
      throw new Error("不能删除 baseline 种子版本");
    }
    if (state && versionId === state.champion) {
      throw new Error("不能删除当前 champion");
    }
    if (state?.active_run?.child?.version_id === versionId) {
      throw new Error("不能删除活跃 run 的候选(先终止或确认本代)");
    }
    this.promptStore.deleteVersion(versionId);
  }

  /** 删除一条失败记忆(按 version_id;同 version_id 的条目一并移除)。 */
  async removeTried(versionId: string): Promise<void> {
    const state = this.stateStore.load();
    if (!state) return;
    const before = state.tried_and_rejected.length;
    state.tried_and_rejected = state.tried_and_rejected.filter(
      (e) => e.version_id !== versionId,
    );
    if (state.tried_and_rejected.length === before) return;
    state.updatedAt = new Date().toISOString();
    this.stateStore.save(state);
    await this.stateStore.flush();
  }

  /** 清空全部失败记忆。 */
  async clearTried(): Promise<void> {
    const state = this.stateStore.load();
    if (!state || state.tried_and_rejected.length === 0) return;
    state.tried_and_rejected = [];
    state.updatedAt = new Date().toISOString();
    this.stateStore.save(state);
    await this.stateStore.flush();
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

    // 过优化集闸 → 留出复核(M5.7);未过闸则不必跑 holdout。
    let holdoutSummary: HoldoutSummary | undefined;
    let holdoutPass = true;
    if (gate.decision === "promote") {
      const review = await this.runHoldoutReview(championVersion, childVersion, plan);
      if (review) {
        holdoutSummary = review.summary;
        holdoutPass = review.decision.decision === "pass";
      }
    }
    const decision = gate.decision === "promote" && holdoutPass ? "promoted" : "rejected";
    return await this.settleGeneration({
      championBeforeId: championVersion.version_id,
      child: childVersion,
      decision,
      validation,
      gate,
      holdout: holdoutSummary,
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
        discussionSeconds: plan.discussionSeconds,
        judgeModelId: plan.judgeModelId,
        optimizerModelId: opts.optimizerModelId,
        assignedTarget: opts.assignedTarget,
      },
      progress: { champion_done: 0, champion_total: total, child_done: 0, child_total: total, games: [] },
      started_at: new Date().toISOString(),
    };
    this.stopRequested = false;
    this.terminating = false;
    this.confirmResolver = null;
    // 捕获本代开始前的 state 快照(此时 active_run 必为 null),供 terminate 回滚。
    this.runStartSnapshot = JSON.parse(JSON.stringify(state)) as OrchestratorState;
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

    // 2) 优化器提案:assign_targets(覆盖 top-N 弱点 + 战绩排序)。
    //    单线贪心取首个可定向靶子(K 并行待后续);手动 opts 可覆盖靶子/算子。
    this.setPhase("optimizing");
    const profile = championProfile(championScores);
    const state = this.stateStore.load()!;
    const board = state.operator_scoreboard ?? emptyScoreboard();
    const assigned = assignTargets(profile.weakDimensions, K_CHILDREN, board);
    const topAssigned = assigned.find((a) => a.assigned_target != null);
    const target =
      opts.assignedTarget ?? topAssigned?.assigned_target ?? profile.weakDimensions[0]?.metric ?? "blind_suspicion_margin";
    const editType = opts.assignedEditType ?? topAssigned?.assigned_edit_type ?? undefined;
    const input = buildOptimizerInput(champion, profile, target, editType, state.tried_and_rejected);
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

    // 5) 优化集闸门
    this.setPhase("gating");
    const validation = buildValidation(championScores, childScores);
    const gate = optimizeGate(validation);
    run.validation = validation;
    run.gate = gate;
    this.persistRun();
    this.emitGate(validation, gate);

    // 5.5) 留出复核(M5.7):仅过优化集闸时跑;无 holdout 配置则跳过(holdoutSummary=undefined)。
    let holdoutSummary: HoldoutSummary | undefined;
    let holdoutPass = true;
    if (gate.decision === "promote") {
      this.setPhase("evaluating_holdout");
      const review = await this.runHoldoutReview(champion, proposal.child, plan, {
        onGameStatus: (patch) => this.recordHoldoutGameStatus(patch),
        shouldStop: () => this.stopRequested,
      });
      if (this.stopRequested) return this.settleStopped("用户停止");
      if (review) {
        holdoutSummary = review.summary;
        holdoutPass = review.decision.decision === "pass";
        if (run.holdout) {
          run.holdout.validation = review.validation;
          run.holdout.decision = review.decision;
        }
        this.persistRun();
        this.emitHoldout(review.summary, review.decision);
      }
    }

    // 6) confirm 暂停 / auto 自动落定。auto 决策 = 过优化集闸 AND 过留出闸。
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
        holdout: holdoutSummary,
        evalSetVersion: plan.evalSetVersion,
        editedPromptText: res.edited,
      });
      return this.settleRunDone(decision);
    }
    const autoDecision: "promoted" | "rejected" =
      gate.decision === "promote" && holdoutPass ? "promoted" : "rejected";
    await this.settleGeneration({
      championBeforeId: champion.version_id,
      child: proposal.child,
      decision: autoDecision,
      validation,
      gate,
      holdout: holdoutSummary,
      evalSetVersion: plan.evalSetVersion,
    });
    return this.settleRunDone(autoDecision);
  }

  /**
   * 留出复核(M5.7):子/父在 holdout split 上配对评测 → holdoutGate。
   * plan 无 holdoutScenarios(或空)→ 返回 null(优雅跳过,如冒烟集无 holdout)。
   * 在 active_run.holdout 上初始化进度结构(供过程可视化逐局回填)。
   */
  private async runHoldoutReview(
    champion: PromptVersion,
    child: PromptVersion,
    plan: EvalPlan,
    opts: { onGameStatus?: (patch: GameItem) => void; shouldStop?: () => boolean } = {},
  ): Promise<{ validation: ValidationReport; decision: HoldoutDecision; summary: HoldoutSummary } | null> {
    const holdoutScenarios = plan.holdoutScenarios ?? [];
    if (holdoutScenarios.length === 0) {
      this.logger.log(`留出复核跳过:评测集 ${plan.evalSetVersion} 无 holdout 场景`);
      return null;
    }
    const holdoutPlan: EvalPlan = { ...plan, scenarios: holdoutScenarios, holdoutScenarios: undefined };
    const perSide = holdoutScenarios.length * plan.seedsPerScenario * plan.runsPerSeed;
    if (this.activeRun) {
      this.activeRun.holdout = {
        eval_set: plan.evalSetVersion,
        champion_total: perSide,
        champion_done: 0,
        child_total: perSide,
        child_done: 0,
        games: [],
      };
      this.persistRun();
    }

    const championScores = await this.pairedEval.runVersionEval(champion, holdoutPlan, {
      onGameStatus: (patch) => opts.onGameStatus?.({ side: "champion", ...patch }),
      shouldStop: opts.shouldStop,
    });
    if (opts.shouldStop?.()) return null;
    const childScores = await this.pairedEval.runVersionEval(child, holdoutPlan, {
      onGameStatus: (patch) => opts.onGameStatus?.({ side: "child", ...patch }),
      shouldStop: opts.shouldStop,
    });
    if (opts.shouldStop?.()) return null;

    const validation = buildValidation(championScores, childScores);
    const decision = holdoutGate(validation);
    const summary = buildHoldoutSummary(plan.evalSetVersion, validation, decision);
    this.logger.log(
      `留出复核 ${child.version_id}: ${decision.decision}(margin point=${decision.marginPoint ?? "?"})${decision.decision === "fail" ? " — " + decision.reasons.join("; ") : ""}`,
    );
    return { validation, decision, summary };
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
      holdout: holdoutSummaryOf(run.holdout),
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

  /**
   * 终止活跃 run 并【回滚到本代开始前】:丢弃本次候选版本、恢复 champion/代数/失败记忆/
   * 种群/评测集版本、清 active_run。与 stop()(优雅停止,保留 tried 记忆)不同 —— terminate
   * 视本次 run 从未发生。terminating 旗让后台 runLoop 的 settleStopped/recordGameStatus 退避,
   * 由本方法独占清理(非阻塞,in-flight 对局照常跑完但其回调被守卫忽略)。
   */
  async terminate(): Promise<void> {
    const state = this.stateStore.load();
    const run = state?.active_run;
    if (!run || run.phase === "settled") return;

    this.stopRequested = true;
    this.terminating = true;
    if (this.confirmResolver) {
      // 唤醒 awaiting_confirmation,让 runLoop 走到 stopRequested 检查后退出。
      this.confirmResolver("stop");
      this.confirmResolver = null;
    }

    // 1) 回滚 orchestrator 状态到本代开始前(快照;无快照则就地清 active_run)。
    const restored: OrchestratorState = this.runStartSnapshot
      ? (JSON.parse(JSON.stringify(this.runStartSnapshot)) as OrchestratorState)
      : state
        ? { ...state, active_run: null }
        : this.stateStore.seedBaseline();
    restored.active_run = null;
    restored.updatedAt = new Date().toISOString();
    this.stateStore.save(restored);
    await this.stateStore.flush();

    // 2) 丢弃本次候选版本(optimizing/validating 阶段才存在)。
    const childId = run.child?.version_id;
    if (childId) {
      this.promptStore.deleteVersion(childId);
    }

    // 3) 清理 run 镜像 + 通知前台(terminating 保持到下一代开始时才复位,
    //    期间后台 runLoop 的 settleStopped/recordGameStatus 见旗退避)。
    this.activeRun = null;
    this.events.emit("done", {
      run_id: run.run_id,
      generation: run.generation,
      decision: "terminated",
      champion_after: restored.champion,
    });
    this.emitStatus();
    this.logger.warn(`run 终止并回滚: ${run.run_id}`);
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
    // terminate 后/无活跃 run:忽略后台 in-flight 对局的回调(回滚已发生,不再计入)。
    if (!this.activeRun || this.terminating) return;
    const run = this.activeRun;
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

  /** 留出复核逐局状态:写入 run.holdout.games(独立于优化集 games)+ 重算 done + emit holdout_game。 */
  private recordHoldoutGameStatus(item: GameItem): void {
    if (!this.activeRun || this.terminating) return;
    const ho = this.activeRun.holdout;
    if (!ho) return;
    const idx = ho.games.findIndex(
      (g) =>
        g.side === item.side &&
        g.scenario_id === item.scenario_id &&
        g.seed === item.seed &&
        g.run === item.run,
    );
    if (idx >= 0) ho.games[idx] = { ...ho.games[idx], ...item };
    else ho.games.push(item);
    const done = (side: GameItem["side"]) =>
      ho.games.filter((g) => g.side === side && (g.status === "finished" || g.status === "failed")).length;
    ho.champion_done = done("champion");
    ho.child_done = done("child");
    this.persistRun();
    this.events.emit("holdout_game", item);
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
    holdout?: HoldoutSummary;
    evalSetVersion: string;
    editedPromptText?: string;
  }): Promise<GenerationEval> {
    const state = this.stateStore.load() ?? this.stateStore.seedBaseline();
    const { championBeforeId, child, decision, validation, gate, holdout, evalSetVersion, editedPromptText } = args;

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
      state.champion = finalChild.version_id;
      // M5.10 种群:按 validated margin 排名 + 精英保留(champion 恒在)+ 截到 cap。
      state.population = updatePopulation(
        state.population,
        finalChild.version_id,
        finalChild.version_id,
        POPULATION_CAP,
        (id) => marginScore(this.promptStore.loadMeta(id) ?? finalChild),
      );
      this.logger.log(`晋升:${finalChild.version_id} 成为新 champion`);
    } else {
      this.promptStore.patchStatus(child.version_id, { status: "rejected" });
      // 拒绝理由合并:优化集闸 + 留出闸(背答案常表现为优化集过、holdout 不过)+ M4.11 假设回环。
      const reasonParts = [...gate.reasons];
      if (holdout && !holdout.holds) {
        reasonParts.push(...holdout.reasons.map((r) => `[holdout] ${r}`));
      }
      // M4.11 假设验证:目标维度是否真按预测改善?推翻则显式记入(优化器下次换思路)。
      const hypo = evaluateHypothesis(child.target_dimension, validation);
      if (!hypo.held) reasonParts.push(`[假设推翻] ${hypo.note}`);
      state.tried_and_rejected.push({
        version_id: child.version_id,
        hypothesis: child.hypothesis,
        target_dimension: child.target_dimension,
        edit_type: child.edit_type,
        reason: reasonParts.join("; ") || "未过闸/人工拒绝",
        generation: state.generation + 1,
      });
      this.logger.log(`拒绝:${child.version_id}`);
    }

    // M4.9 战绩表更新:(破绽类型, edit_type) 这一格记一次(accepted=晋升)。自由名额无类型 → 跳过。
    const tType = typeOfTarget(child.target_dimension ?? "");
    if (tType && child.edit_type) {
      state.operator_scoreboard = updateScoreboard(
        state.operator_scoreboard ?? emptyScoreboard(),
        tType,
        child.edit_type,
        decision === "promoted",
      );
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
          holdout,
          decision,
        },
      ],
      champion_after: state.champion,
      population_after: state.population,
      tried_and_rejected_added: decision === "rejected" ? [child.version_id] : [],
      timestamp: new Date().toISOString(),
    };
    this.stateStore.save(state);
    await this.repo.upsertGenerationEval(genEval);
    // 关键落定:等 state(champion 指针)落库完成,避免重启回退。
    await this.stateStore.flush();
    return genEval;
  }

  /** runLoop 正常落定后:标记 active_run settled + 清除 + emit done/status。 */
  private async settleRunDone(decision: RunDecision): Promise<void> {
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
    await this.stateStore.flush();
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
  private async settleStopped(reason: string): Promise<void> {
    // terminate 已接管清理并回滚:后台 runLoop 退到这里时直接退避,不再写 tried/状态。
    if (this.terminating) return;
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
    await this.stateStore.flush();
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
  private emitHoldout(summary: HoldoutSummary, decision: HoldoutDecision): void {
    this.events.emit("holdout", { summary, decision });
  }
}

/** 从持久化的 run.holdout 重建 GenerationEval 用的 holdout 摘要(重启续接 confirm 用)。 */
function holdoutSummaryOf(holdout: HoldoutRun | undefined): HoldoutSummary | undefined {
  if (!holdout?.validation || !holdout.decision) return undefined;
  return buildHoldoutSummary(holdout.eval_set, holdout.validation, holdout.decision);
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
