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
import type { AssignedTarget } from "../optimizer/assign-targets";
import { isDuplicate } from "../optimizer/dedupe";
import { buildOptimizerInput, championProfile, LOCKED_SECTIONS, type WeakDimension } from "../optimizer/input";
import { typeOfTarget } from "../optimizer/operators";
import { OptimizerService } from "../optimizer/propose";
import { marginScore, sampleParents, updatePopulation } from "./population";
import { emptyScoreboard, updateScoreboard, type OperatorScoreboard } from "../optimizer/scoreboard";
import { compressTried, evaluateHypothesis } from "../optimizer/tried-and-rejected";
import { validatePrompt } from "../optimizer/validate-prompt";
import type { PromptValidation, RequiredExcerpt } from "../optimizer/validate-prompt";
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
/** 每代靶子预算(assign_targets 取前 N 弱点配算子;自动模式默认生成 K 个候选)。 */
const K_CHILDREN = 4;

interface CandidateResult {
  child: PromptVersion;
  validate: PromptValidation;
  validation: ValidationReport;
  gate: GateDecision;
  holdout?: HoldoutSummary;
  decision: "promoted" | "rejected";
}

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
    if (
      state?.active_run?.child?.version_id === versionId ||
      state?.active_run?.children?.some((c) => c.version_id === versionId)
    ) {
      throw new Error("不能删除活跃 run 的候选(先终止或确认本代)");
    }
    this.promptStore.deleteVersion(versionId);
  }

  /** 将一个稳定历史版本重新激活为 champion(用于人工回滚 / 真人校准翻车后的执行动作)。 */
  async activateVersion(versionId: string): Promise<void> {
    const state = this.stateStore.load() ?? this.stateStore.seedBaseline();
    if (state.active_run && state.active_run.phase !== "settled") {
      throw new Error("有活跃 run 时不能切换 champion(请先确认/终止)");
    }
    const target = this.promptStore.load(versionId);
    if (!target) throw new Error(`版本不存在:${versionId}`);
    if (target.status === "candidate" || target.status === "rejected") {
      throw new Error(`只能重激活 champion/accepted/baseline 这类稳定版本,当前状态=${target.status}`);
    }
    if (state.calibration?.frozen) {
      // 《真人校准》§6:相关性漂移期冻结晋升,人工也不得绕过(先跑校准确认回升或解冻)。
      throw new Error(`晋升已被真人校准冻结(verdict=${state.calibration.verdict});先跑校准确认相关性回升或解冻`);
    }
    if (state.champion === versionId) return;

    const previousChampion = state.champion;
    this.promptStore.patchStatus(previousChampion, { status: "accepted" });
    this.promptStore.patchStatus(versionId, { status: "champion" });

    state.champion = versionId;
    state.population = updatePopulation(
      state.population,
      versionId,
      versionId,
      POPULATION_CAP,
      (id) => marginScore(this.promptStore.loadMeta(id) ?? target),
    );
    state.active_run = null;
    state.updatedAt = new Date().toISOString();
    this.stateStore.save(state);
    await this.stateStore.flush();
    this.emitStatus();
    this.logger.warn(`重激活 champion:${previousChampion} → ${versionId}`);
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
    const validate = validatePrompt(childVersion, championVersion, {
      lengthBudgetPct: 0.15,
      requiredExcerpts: this.requiredExcerptsFor(childVersion, championVersion),
    });
    if (!validate.ok) {
      return await this.settleGeneration({
        championBeforeId: championVersion.version_id,
        child: childVersion,
        decision: "rejected",
        validation: emptyValidation(championVersion.version_id, childVersion.version_id),
        gate: {
          decision: "reject",
          reasons: [`validate_prompt 失败: ${validate.reasons.join("; ")}`],
          marginVerdict: null,
        },
        evalSetVersion: plan.evalSetVersion,
      });
    }
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
        judgeModelIds: plan.judgeModelIds,
        diagnose: plan.diagnose,
        costTier: plan.costTier,
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

    // 2) 优化器提案:assign_targets 产 K 个靶子;每个靶子单独调用一次优化器。
    this.setPhase("optimizing");
    const profile = championProfile(championScores);
    const state = this.stateStore.load()!;
    const board = state.operator_scoreboard ?? emptyScoreboard();
    const parentVersions = this.sampleParentVersions(champion, state);
    const targetPlans = buildTargetPlans(opts, profile.weakDimensions, board);
    const proposedChildren: PromptVersion[] = [];
    run.children = [];
    run.selected_child_id = undefined;
    for (let i = 0; i < targetPlans.length; i += 1) {
      const planTarget = targetPlans[i];
      const parent = parentVersions[i % parentVersions.length] ?? champion;
      const target =
        planTarget.assigned_target ?? profile.weakDimensions[0]?.metric ?? "blind_suspicion_margin";
      const editType = planTarget.assigned_edit_type || undefined;
      const input = buildOptimizerInput(
        parent,
        profile,
        target,
        editType,
        state.tried_and_rejected,
      );
      const proposal = await this.optimizer.propose(input, {
        basedOn: parent.version_id,
        optimizerModelId: opts.optimizerModelId,
      });
      if (proposal && !isDuplicate(proposal.child, proposedChildren)) {
        proposedChildren.push(proposal.child);
      }
      if (this.stopRequested) return this.settleStopped("用户停止");
    }
    if (!opts.assignedTarget && !opts.assignedEditType) {
      const pair = this.pickCrossoverPair(champion, state);
      if (pair) {
        const proposal = await this.optimizer.crossover(
          {
            base: pair.base,
            donor: pair.donor,
            baseTraits: pair.baseTraits,
            donorTrait: pair.donorTrait,
            donorExcerpt: pair.donorExcerpt,
            lockedSections: LOCKED_SECTIONS,
            triedAndRejected: compressTried(state.tried_and_rejected).slice(0, 20),
            lengthBudget: `不超过底版长度 +15%(底版约 ${pair.base.prompt_text.length} 字)`,
          },
          { optimizerModelId: opts.optimizerModelId },
        );
        if (proposal && !isDuplicate(proposal.child, proposedChildren)) {
          proposedChildren.push(proposal.child);
        }
      }
    }
    if (this.stopRequested) return this.settleStopped("用户停止");
    if (proposedChildren.length === 0) return this.settleStopped("优化器未产出可用候选");

    // 3) 校验全部候选
    this.setPhase("validating");
    const results: CandidateResult[] = [];
    const validChildren: Array<{ child: PromptVersion; validate: PromptValidation }> = [];
    for (const child of proposedChildren) {
      this.promptStore.save({ ...child, status: "candidate" });
      const parent = this.promptStore.load(child.parent_id ?? champion.version_id) ?? champion;
      const validate = validatePrompt(child, parent, {
        lengthBudgetPct: 0.15,
        requiredExcerpts: this.requiredExcerptsFor(child, parent),
      });
      const childView = toActiveRunChild(child, validate);
      this.upsertRunChild(childView);
      run.child = childView;
      run.validate = validate;
      run.selected_child_id = child.version_id;
      this.persistRun();
      this.emitProposal(childView, validate);
      if (!validate.ok) {
        const failGate: GateDecision = {
          decision: "reject",
          reasons: [`validate_prompt 失败: ${validate.reasons.join("; ")}`],
          marginVerdict: null,
        };
        childView.gate = failGate;
        childView.validation = emptyValidation(champion.version_id, child.version_id);
        childView.decision = "rejected";
        this.upsertRunChild(childView);
        results.push({
          child,
          validate,
          decision: "rejected",
          validation: childView.validation,
          gate: failGate,
        });
      } else {
        validChildren.push({ child, validate });
      }
    }
    this.persistRun();
    if (this.stopRequested) return this.settleStopped("用户停止");
    if (validChildren.length === 0) {
      const selected = results[0];
      if (!selected) return this.settleStopped("所有候选校验失败");
      await this.settleGenerationMulti({
        championBeforeId: champion.version_id,
        selectedChildId: selected.child.version_id,
        selectedDecision: "rejected",
        results,
        evalSetVersion: plan.evalSetVersion,
      });
      return this.settleRunDone("rejected");
    }

    // 4) 批量评测 child。候选之间共享 champion 评分;child 侧总进度按候选数扩展。
    this.setPhase("evaluating_child");
    run.progress.child_total = run.progress.champion_total * validChildren.length;
    this.persistRun();
    const childScoresByVersion = await this.pairedEval.runVersionsEval(
      validChildren.map((item) => item.child),
      plan,
      {
        onGameStatus: (child, patch) =>
          this.recordGameStatus({ side: "child", child_id: child.version_id, ...patch }),
        shouldStop: () => this.stopRequested,
      },
    );
    if (this.stopRequested) return this.settleStopped("用户停止");

    this.setPhase("gating");
    for (const item of validChildren) {
      const childView = this.findRunChild(item.child.version_id) ?? toActiveRunChild(item.child, item.validate);
      run.child = childView;
      run.selected_child_id = item.child.version_id;
      run.validate = item.validate;
      this.persistRun();
      const childScores = childScoresByVersion.get(item.child.version_id) ?? [];
      const validation = buildValidation(championScores, childScores);
      const gate = optimizeGate(validation);
      childView.validation = validation;
      childView.gate = gate;
      childView.score = validationScore(validation);
      run.validation = validation;
      run.gate = gate;
      this.upsertRunChild(childView);
      this.persistRun();
      this.emitGate(validation, gate);
      results.push({
        child: item.child,
        validate: item.validate,
        decision: "rejected",
        validation,
        gate,
      });
    }

    // 5.5) 在通过优化集闸的候选中按主 margin 选择,逐个留出复核,直到找到泛化也过闸的候选。
    let selected = selectBestCandidate(results) ?? results[0];
    let selectedHoldoutPass = selected.gate.decision === "promote";
    const promoteCandidates = results
      .filter((r) => r.validate.ok && r.gate.decision === "promote")
      .sort((a, b) => validationScore(a.validation) - validationScore(b.validation));
    for (const candidate of promoteCandidates) {
      this.setPhase("evaluating_holdout");
      const childView = this.findRunChild(candidate.child.version_id) ?? toActiveRunChild(candidate.child, candidate.validate);
      run.child = childView;
      run.selected_child_id = candidate.child.version_id;
      this.persistRun();
      const review = await this.runHoldoutReview(champion, candidate.child, plan, {
        onGameStatus: (patch) =>
          this.recordHoldoutGameStatus({ ...patch, child_id: candidate.child.version_id }),
        shouldStop: () => this.stopRequested,
      });
      if (this.stopRequested) return this.settleStopped("用户停止");
      if (!review) {
        selected = candidate;
        selectedHoldoutPass = true;
        break;
      }
      candidate.holdout = review.summary;
      if (run.holdout) {
        run.holdout.validation = review.validation;
        run.holdout.decision = review.decision;
      }
      childView.holdout = run.holdout;
      this.upsertRunChild(childView);
      this.persistRun();
      this.emitHoldout(review.summary, review.decision);
      if (review.decision.decision === "pass") {
        selected = candidate;
        selectedHoldoutPass = true;
        break;
      }
      selected = candidate;
      selectedHoldoutPass = false;
    }

    run.child = this.findRunChild(selected.child.version_id) ?? toActiveRunChild(selected.child, selected.validate);
    run.selected_child_id = selected.child.version_id;
    run.validation = selected.validation;
    run.gate = selected.gate;
    run.validate = selected.validate;
    this.persistRun();

    // 6) confirm 暂停 / auto 自动落定。auto 决策 = 选中候选过优化集闸 AND 过留出闸。
    if (run.mode === "confirm") {
      this.setPhase("awaiting_confirmation");
      const res = await this.awaitConfirm();
      if (res === "stop") return this.settleStopped("用户停止");
      const decision: "promoted" | "rejected" = res.accept ? "promoted" : "rejected";
      selected.decision = decision;
      await this.settleGenerationMulti({
        championBeforeId: champion.version_id,
        selectedChildId: selected.child.version_id,
        selectedDecision: decision,
        results,
        evalSetVersion: plan.evalSetVersion,
        editedPromptText: res.edited,
      });
      return this.settleRunDone(decision);
    }
    const autoDecision: "promoted" | "rejected" =
      selected.gate.decision === "promote" && selectedHoldoutPass ? "promoted" : "rejected";
    selected.decision = autoDecision;
    await this.settleGenerationMulti({
      championBeforeId: champion.version_id,
      selectedChildId: selected.child.version_id,
      selectedDecision: autoDecision,
      results,
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
    const selectedId = run.selected_child_id ?? run.child?.version_id;
    if (!selectedId || !run.child || !run.validation || !run.gate) {
      throw new Error("待确认 run 数据不完整");
    }
    this.activeRun = run;
    const child = this.promptStore.load(selectedId);
    if (!child) throw new Error(`候选版本缺失: ${selectedId}`);
    const decision: "promoted" | "rejected" = accept ? "promoted" : "rejected";
    const results = rebuildCandidateResults(run, child, decision);
    await this.settleGenerationMulti({
      championBeforeId: run.champion_id,
      selectedChildId: child.version_id,
      selectedDecision: decision,
      results,
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
    const childIds = new Set<string>([
      ...(run.children ?? []).map((c) => c.version_id),
      ...(run.child?.version_id ? [run.child.version_id] : []),
    ]);
    for (const childId of childIds) {
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
        (g.child_id ?? "") === (item.child_id ?? "") &&
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
        (g.child_id ?? "") === (item.child_id ?? "") &&
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

  private upsertRunChild(child: ActiveRunChild): void {
    if (!this.activeRun) return;
    const children = this.activeRun.children ?? [];
    const idx = children.findIndex((c) => c.version_id === child.version_id);
    if (idx >= 0) {
      const next = children.slice();
      next[idx] = { ...next[idx], ...child };
      this.activeRun.children = next;
    } else {
      this.activeRun.children = [...children, child];
    }
  }

  private findRunChild(versionId: string): ActiveRunChild | undefined {
    return this.activeRun?.children?.find((c) => c.version_id === versionId);
  }

  private sampleParentVersions(champion: PromptVersion, state: OrchestratorState): PromptVersion[] {
    const population = state.population
      .map((id) => this.promptStore.load(id))
      .filter((v): v is PromptVersion => v != null);
    const parentIds = sampleParents(champion.version_id, population, Math.min(2, Math.max(1, population.length)));
    const parents = parentIds
      .map((id) => this.promptStore.load(id))
      .filter((v): v is PromptVersion => v != null);
    return parents.length > 0 ? parents : [champion];
  }

  private pickCrossoverPair(
    champion: PromptVersion,
    state: OrchestratorState,
  ): { base: PromptVersion; donor: PromptVersion; baseTraits: string; donorTrait: string; donorExcerpt: string } | null {
    const versions = uniqueVersions([
      champion,
      ...state.population
        .map((id) => this.promptStore.load(id))
        .filter((v): v is PromptVersion => v != null),
    ]).filter(hasAcceptedTrait);
    if (versions.length < 2) return null;

    const pairs: Array<{ a: PromptVersion; b: PromptVersion; score: number }> = [];
    for (let i = 0; i < versions.length; i += 1) {
      for (let j = i + 1; j < versions.length; j += 1) {
        const a = versions[i];
        const b = versions[j];
        if (traitTarget(a) === traitTarget(b)) continue;
        pairs.push({ a, b, score: marginScore(a) + marginScore(b) });
      }
    }
    pairs.sort((x, y) => x.score - y.score);
    const pair = pairs[0];
    if (!pair) return null;
    const base = marginScore(pair.a) <= marginScore(pair.b) ? pair.a : pair.b;
    const donor = base.version_id === pair.a.version_id ? pair.b : pair.a;
    return {
      base,
      donor,
      baseTraits: this.describeVersionTraits(base),
      donorTrait: describeVersionTrait(donor),
      donorExcerpt: this.extractTraitExcerpt(donor),
    };
  }

  private requiredExcerptsFor(child: PromptVersion, parent: PromptVersion): RequiredExcerpt[] {
    if (!child.crossover) return [];
    const out: RequiredExcerpt[] = [];
    for (const item of this.collectAcceptedTraits(parent)) {
      out.push({
        label: `base:${item.version_id}:${item.trait.target}`,
        text: item.trait.excerpt,
        minLineOverlap: 0.8,
      });
    }
    const donor = this.promptStore.load(child.crossover.donor);
    if (donor?.accepted_trait?.excerpt) {
      out.push({
        label: `donor:${donor.version_id}:${donor.accepted_trait.target}`,
        text: donor.accepted_trait.excerpt,
        minLineOverlap: 0.25,
      });
    }
    return out;
  }

  private describeVersionTraits(version: PromptVersion): string {
    const traits = this.collectAcceptedTraits(version)
      .slice(0, 8)
      .map((item) => describeVersionTrait(item.version));
    return traits.length > 0 ? traits.join("\n") : "(暂无明确胜招元数据;至少保住底版当前已验证指标)";
  }

  private collectAcceptedTraits(
    version: PromptVersion,
  ): Array<{ version_id: string; version: PromptVersion; trait: NonNullable<PromptVersion["accepted_trait"]> }> {
    const traits: Array<{ version_id: string; version: PromptVersion; trait: NonNullable<PromptVersion["accepted_trait"]> }> = [];
    let cur: PromptVersion | null = version;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.version_id) && traits.length < 12) {
      seen.add(cur.version_id);
      if (cur.accepted_trait) {
        traits.push({ version_id: cur.version_id, version: cur, trait: cur.accepted_trait });
      }
      cur = cur.parent_id ? this.promptStore.load(cur.parent_id) : null;
    }
    return traits;
  }

  private extractTraitExcerpt(version: PromptVersion): string {
    return version.accepted_trait?.excerpt ?? "";
  }

  /** 多候选一代落定:同一代只晋升一个候选,其余候选统一记 rejected/tried。 */
  private async settleGenerationMulti(args: {
    championBeforeId: string;
    selectedChildId: string;
    selectedDecision: "promoted" | "rejected";
    results: CandidateResult[];
    evalSetVersion: string;
    editedPromptText?: string;
  }): Promise<GenerationEval> {
    const state = this.stateStore.load() ?? this.stateStore.seedBaseline();
    const { championBeforeId, selectedChildId, selectedDecision, results, evalSetVersion, editedPromptText } = args;
    const generationNo = state.generation + 1;
    const triedAdded: string[] = [];
    let championAfter = state.champion;

    for (const result of results) {
      const isSelected = result.child.version_id === selectedChildId;
      const decision: "promoted" | "rejected" = isSelected ? selectedDecision : "rejected";
      result.decision = decision;

      if (decision === "promoted") {
        const finalChild =
          editedPromptText && isSelected ? { ...result.child, prompt_text: editedPromptText } : result.child;
        const parent = this.promptStore.load(finalChild.parent_id ?? championBeforeId);
        const promotedChild = {
          ...finalChild,
          accepted_trait: buildAcceptedTrait(finalChild, parent),
        };
        result.child = promotedChild;
        this.promptStore.save({ ...promotedChild, status: "candidate" });
        const frozen = state.calibration?.frozen ? state.calibration.reason || "真人校准冻结晋升" : null;
        if (frozen) {
          // 《真人校准》§6:冻结期不让 Goodhart 嫌疑版本上线;保留候选、记元数据,但不换 champion。
          this.promptStore.patchStatus(promotedChild.version_id, {
            validated_metrics: summarize(result.validation),
            eval_set_version: evalSetVersion,
            accepted_trait: promotedChild.accepted_trait,
          });
          this.logger.warn(`晋升被真人校准冻结:${promotedChild.version_id} 暂不上线(${frozen})`);
        } else {
          this.promptStore.patchStatus(promotedChild.version_id, {
            status: "champion",
            validated_metrics: summarize(result.validation),
            eval_set_version: evalSetVersion,
            accepted_trait: promotedChild.accepted_trait,
          });
          if (state.champion !== promotedChild.version_id) {
            this.promptStore.patchStatus(state.champion, { status: "accepted" });
          }
          state.champion = promotedChild.version_id;
          championAfter = promotedChild.version_id;
          state.population = updatePopulation(
            state.population,
            promotedChild.version_id,
            promotedChild.version_id,
            POPULATION_CAP,
            (id) => marginScore(this.promptStore.loadMeta(id) ?? promotedChild),
          );
          this.logger.log(`晋升:${promotedChild.version_id} 成为新 champion`);
        }
      } else {
        this.promptStore.patchStatus(result.child.version_id, { status: "rejected" });
        const reasonParts = [...result.gate.reasons];
        if (result.holdout && !result.holdout.holds) {
          reasonParts.push(...result.holdout.reasons.map((r) => `[holdout] ${r}`));
        }
        if (!isSelected) {
          reasonParts.push("同代未选中:已有排序更优/留出更稳的候选");
        } else if (result.gate.decision === "promote" && selectedDecision === "rejected") {
          reasonParts.push("人工拒绝或留出复核未通过");
        }
        const hypo = evaluateHypothesis(result.child.target_dimension, result.validation);
        if (!hypo.held) reasonParts.push(`[假设推翻] ${hypo.note}`);
        state.tried_and_rejected.push({
          version_id: result.child.version_id,
          hypothesis: result.child.hypothesis,
          target_dimension: result.child.target_dimension,
          edit_type: result.child.edit_type,
          reason: reasonParts.join("; ") || "未过闸/未选中",
          generation: generationNo,
        });
        triedAdded.push(result.child.version_id);
        this.logger.log(`拒绝:${result.child.version_id}`);
      }

      const tType = typeOfTarget(result.child.target_dimension ?? "");
      if (tType && result.child.edit_type) {
        state.operator_scoreboard = updateScoreboard(
          state.operator_scoreboard ?? emptyScoreboard(),
          tType,
          result.child.edit_type,
          decision === "promoted",
        );
      }
    }

    state.generation = generationNo;
    state.eval_set_version = evalSetVersion;
    state.updatedAt = new Date().toISOString();
    const generation_id = `gen_${state.generation}_${selectedChildId}`;
    const genEval: GenerationEval = {
      generation_id,
      generation: state.generation,
      eval_set_version: evalSetVersion,
      mode: "scripted_intent",
      champion_before: championBeforeId,
      children_evaluated: results.map((result) => ({
        child_id: result.child.version_id,
        based_on: result.child.parent_id ?? championBeforeId,
        hypothesis: result.child.hypothesis,
        target_dimension: result.child.target_dimension,
        edit_type: result.child.edit_type,
        validation: result.validation,
        gate: result.gate,
        holdout: result.holdout,
        decision: result.decision,
      })),
      champion_after: championAfter,
      population_after: state.population,
      tried_and_rejected_added: triedAdded,
      human_calibration_ref: state.calibration?.calibration_id,
      timestamp: new Date().toISOString(),
    };
    this.stateStore.save(state);
    await this.repo.upsertGenerationEval(genEval);
    await this.stateStore.flush();
    return genEval;
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
    let recordedChild = child;

    if (decision === "promoted") {
      const finalChild = editedPromptText ? { ...child, prompt_text: editedPromptText } : child;
      const parent = this.promptStore.load(finalChild.parent_id ?? championBeforeId);
      const promotedChild = {
        ...finalChild,
        accepted_trait: buildAcceptedTrait(finalChild, parent),
      };
      recordedChild = promotedChild;
      this.promptStore.save({ ...promotedChild, status: "candidate" });
      const frozen = state.calibration?.frozen ? state.calibration.reason || "真人校准冻结晋升" : null;
      if (frozen) {
        // 《真人校准》§6:冻结期保留候选、记元数据,但不换 champion。
        this.promptStore.patchStatus(promotedChild.version_id, {
          validated_metrics: summarize(validation),
          eval_set_version: evalSetVersion,
          accepted_trait: promotedChild.accepted_trait,
        });
        this.logger.warn(`晋升被真人校准冻结:${promotedChild.version_id} 暂不上线(${frozen})`);
      } else {
        this.promptStore.patchStatus(promotedChild.version_id, {
          status: "champion",
          validated_metrics: summarize(validation),
          eval_set_version: evalSetVersion,
          accepted_trait: promotedChild.accepted_trait,
        });
        if (state.champion !== promotedChild.version_id) {
          this.promptStore.patchStatus(state.champion, { status: "accepted" });
        }
        state.champion = promotedChild.version_id;
        // M5.10 种群:按 validated margin 排名 + 精英保留(champion 恒在)+ 截到 cap。
        state.population = updatePopulation(
          state.population,
          promotedChild.version_id,
          promotedChild.version_id,
          POPULATION_CAP,
          (id) => marginScore(this.promptStore.loadMeta(id) ?? promotedChild),
        );
        this.logger.log(`晋升:${promotedChild.version_id} 成为新 champion`);
      }
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
    const tType = typeOfTarget(recordedChild.target_dimension ?? "");
    if (tType && recordedChild.edit_type) {
      state.operator_scoreboard = updateScoreboard(
        state.operator_scoreboard ?? emptyScoreboard(),
        tType,
        recordedChild.edit_type,
        decision === "promoted",
      );
    }

    state.generation += 1;
    state.eval_set_version = evalSetVersion;
    state.updatedAt = new Date().toISOString();
    const generation_id = `gen_${state.generation}_${recordedChild.version_id}`;
    const genEval: GenerationEval = {
      generation_id,
      generation: state.generation,
      eval_set_version: evalSetVersion,
      mode: "scripted_intent",
      champion_before: championBeforeId,
      children_evaluated: [
        {
          child_id: recordedChild.version_id,
          based_on: recordedChild.parent_id ?? championBeforeId,
          hypothesis: recordedChild.hypothesis,
          target_dimension: recordedChild.target_dimension,
          edit_type: recordedChild.edit_type,
          validation,
          gate,
          holdout,
          decision,
        },
      ],
      champion_after: state.champion,
      population_after: state.population,
      tried_and_rejected_added: decision === "rejected" ? [recordedChild.version_id] : [],
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
    if (run && state) {
      for (const child of run.children ?? (run.child ? [run.child] : [])) {
        state.tried_and_rejected.push({
          version_id: child.version_id,
          hypothesis: child.hypothesis,
          target_dimension: child.target,
          edit_type: child.edit_type,
          reason: `停止: ${reason}`,
          generation: run.generation,
        });
      }
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

function toActiveRunChild(child: PromptVersion, validate?: PromptValidation): ActiveRunChild {
  return {
    version_id: child.version_id,
    based_on: child.parent_id ?? undefined,
    target: child.target_dimension ?? "",
    edit_type: child.edit_type ?? "",
    crossover: child.crossover,
    hypothesis: child.hypothesis,
    prompt_text: child.prompt_text,
    validate,
  };
}

function buildTargetPlans(
  opts: { assignedTarget?: string; assignedEditType?: string },
  weakDimensions: WeakDimension[],
  board: OperatorScoreboard,
): AssignedTarget[] {
  if (opts.assignedTarget || opts.assignedEditType) {
    return [
      {
        assigned_target: opts.assignedTarget ?? weakDimensions[0]?.metric ?? "blind_suspicion_margin",
        assigned_edit_type: (opts.assignedEditType ?? "") as AssignedTarget["assigned_edit_type"],
      },
    ];
  }
  const assigned = assignTargets(weakDimensions, K_CHILDREN, board);
  if (assigned.length > 0) return assigned;
  return [{ assigned_target: weakDimensions[0]?.metric ?? "blind_suspicion_margin", assigned_edit_type: "" }];
}

function uniqueVersions(versions: PromptVersion[]): PromptVersion[] {
  const seen = new Set<string>();
  const out: PromptVersion[] = [];
  for (const version of versions) {
    if (seen.has(version.version_id)) continue;
    seen.add(version.version_id);
    out.push(version);
  }
  return out;
}

function hasAcceptedTrait(version: PromptVersion): boolean {
  return Boolean(version.accepted_trait?.target && version.accepted_trait.excerpt.trim());
}

function traitTarget(version: PromptVersion): string {
  return (version.accepted_trait?.target ?? "").trim();
}

function describeVersionTrait(version: PromptVersion): string {
  const trait = version.accepted_trait;
  if (!trait) return `${version.version_id}: (无 accepted_trait)`;
  return `${version.version_id}: ${trait.summary}; target=${trait.target}; edit_type=${trait.edit_type}; hypothesis=${trait.hypothesis ?? "无"}`;
}

function buildAcceptedTrait(
  child: PromptVersion,
  parent: PromptVersion | null,
): NonNullable<PromptVersion["accepted_trait"]> {
  const target = child.target_dimension?.trim() || child.crossover?.grafted_trait || "unknown";
  const editType = child.edit_type?.trim() || "unknown";
  const excerpt = changedExcerpt(child.prompt_text, parent?.prompt_text ?? "");
  return {
    target,
    edit_type: editType,
    hypothesis: child.hypothesis,
    summary: child.crossover?.grafted_trait || `${editType} → ${target}`,
    excerpt,
    source: child.crossover ? "crossover" : "mutation",
  };
}

function changedExcerpt(childText: string, parentText: string): string {
  if (!parentText.trim()) return limitLines(childText);
  const parentLines = new Set(parentText.split("\n").map((line) => line.trim()).filter(Boolean));
  const changed = childText
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !parentLines.has(trimmed);
    })
    .join("\n")
    .trim();
  return limitLines(changed || childText);
}

function limitLines(text: string, maxLines = 16): string {
  const lines = text.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
  return lines.slice(0, maxLines).join("\n");
}

function validationScore(validation: ValidationReport): number {
  const point = validation.buckets[0]?.metrics["blind_suspicion_margin"]?.point;
  return typeof point === "number" ? point : Number.POSITIVE_INFINITY;
}

function selectBestCandidate(results: CandidateResult[]): CandidateResult | null {
  if (results.length === 0) return null;
  const promoted = results
    .filter((r) => r.validate.ok && r.gate.decision === "promote")
    .sort((a, b) => validationScore(a.validation) - validationScore(b.validation));
  if (promoted[0]) return promoted[0];
  return [...results].sort((a, b) => validationScore(a.validation) - validationScore(b.validation))[0];
}

function rebuildCandidateResults(
  run: ActiveRun,
  selectedChild: PromptVersion,
  selectedDecision: "promoted" | "rejected",
): CandidateResult[] {
  const children = run.children && run.children.length > 0 ? run.children : run.child ? [run.child] : [];
  return children.map((child) => {
    const prompt = child.version_id === selectedChild.version_id
      ? selectedChild
      : {
          version_id: child.version_id,
          parent_id: child.based_on ?? run.champion_id,
          prompt_text: child.prompt_text,
          persona_scope: "shared" as const,
          status: "candidate" as const,
          hypothesis: child.hypothesis,
          target_dimension: child.target,
          edit_type: child.edit_type,
          crossover: child.crossover,
          created_at: new Date().toISOString(),
        };
    return {
      child: prompt,
      validate: child.validate ?? { ok: true, reasons: [] },
      validation: child.validation ?? run.validation ?? emptyValidation(run.champion_id, child.version_id),
      gate: child.gate ?? run.gate ?? { decision: "reject", reasons: ["待确认 run 缺少闸门结果"], marginVerdict: null },
      holdout: child.holdout ? holdoutSummaryOf(child.holdout) : child.version_id === selectedChild.version_id ? holdoutSummaryOf(run.holdout) : undefined,
      decision: child.version_id === selectedChild.version_id ? selectedDecision : "rejected",
    };
  });
}
