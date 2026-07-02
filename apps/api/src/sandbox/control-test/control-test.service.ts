// 对照测试服务:在某个冻结评测集(set_id)上,把负/正/空三条 control 当 child,
// 与当前 champion(parent)做 child-vs-parent 配对评测,并核对流水线是否如预期反应。
//
// 它验证的是【优化流水线机器本身】对不对(噪声不被当信号、能抓烂、对真实改进方向敏感),
// 而不是 AI 好不好——后者要 holdout + 扩量 + 真人校准。
//
// 后台流式 run:startRun() 立即返回 run_id,execute() 在后台逐局推进并经 EventEmitter
// 发 status/game/control/done,由 ControlTestGateway 桥接到 socket(过程可视化)。
// run 态在内存驱动;每次状态推进把快照落 sandbox_control_test_runs(单例 id=1),
// 重启后 onModuleInit 恢复最近一次供回看。只回看不续接:未落定的 run 恢复时判为「已中断」。
//
// 复用编排器现成原语:PairedEvalService(配对评测+paired_cache)→ buildValidation → optimizeGate。
// 无副作用:control 子版本按内容哈希直接落 DB → 评测 → finally 删除,不进版本库/血脉。

import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { EventEmitter } from "node:events";
import { buildValidation } from "../aggregate/validation";
import type { ValidationReport } from "../aggregate/validation";
import type { MetricSummary } from "../aggregate/types";
import type { GameStatusPatch } from "../orchestrator/active-run";
import { optimizeGate } from "../orchestrator/gate";
import type { GateDecision } from "../orchestrator/gate";
import type { EvalPlan } from "../orchestrator/paired-eval";
import { PairedEvalService } from "../orchestrator/paired-eval";
import { OrchestratorService } from "../orchestrator/orchestrator.service";
import type { PromptVersion } from "../orchestrator/prompt-version";
import { SandboxRepository } from "../sandbox.repository";
import { isTraceOn, traceEvent } from "../shared/trace";
import { SandboxService } from "../sandbox.service";
import {
  ALL_CONTROL_KINDS,
  CONTROL_SPECS,
  controlVersionId,
  type ControlKind,
  type ControlSpec,
} from "./control-prompts";
import type {
  BucketView,
  ControlGameItem,
  ControlResult,
  ControlTestRun,
  MetricView,
} from "./control-test.types";

export interface ControlTestOptions {
  setId?: string;
  seedsPerScenario?: number;
  runsPerSeed?: number;
  judgeModelId?: string;
  discussionSeconds?: number;
  kinds?: ControlKind[];
  /** 逐对照确认:每条对照跑完后暂停,等人工确认再跑下一条(默认 false=连跑)。 */
  pauseBetweenControls?: boolean;
}

const DEFAULT_SET_ID = "baseline_smoke_v1";

@Injectable()
export class ControlTestService implements OnModuleInit {
  private readonly logger = new Logger(ControlTestService.name);
  /** 内部事件;ControlTestGateway 订阅后桥接到 socket。 */
  readonly events = new EventEmitter();

  private activeRun: ControlTestRun | null = null;
  private stopRequested = false;
  /** 逐对照确认模式下,后台 execute 在对照之间挂起时的放行回调(继续/停止都调它)。 */
  private continueSignal: (() => void) | null = null;
  /** 串行化持久化,保证落库顺序与状态推进一致(最后的 settle 快照必胜出)。 */
  private persistChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly sandbox: SandboxService,
    private readonly orchestrator: OrchestratorService,
    private readonly pairedEval: PairedEvalService,
    private readonly repo: SandboxRepository,
  ) {}

  /** 重启后恢复最近一次 run 供回看。后台 execute() 已随进程消亡,故未落定的一律判中断(设计:不续接)。 */
  async onModuleInit(): Promise<void> {
    try {
      const persisted = await this.repo.loadControlTestRun();
      if (!persisted) return;
      if (persisted.phase !== "settled") {
        persisted.phase = "settled";
        persisted.decision = "stopped";
        persisted.stopping = false;
        persisted.overall_pass = false;
        persisted.error = persisted.error ?? "服务重启,run 已中断(测试工具不做续接)";
        persisted.settled_at = persisted.settled_at ?? new Date().toISOString();
      }
      this.activeRun = persisted;
      this.logger.log(`恢复对照测试 run ${persisted.run_id}(phase=${persisted.phase})`);
    } catch (err) {
      this.logger.warn(`恢复对照测试 run 失败: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** 当前 run 快照(首屏 / 断线重连 / 落定后回看;settled 的 run 会保留到下次启动)。 */
  getActiveRun(): ControlTestRun | null {
    return this.activeRun;
  }

  /** 非阻塞 kickoff:校验 → 建 run → 后台 execute → 立即返回 run_id。进度走 socket。 */
  startRun(opts: ControlTestOptions = {}): { run_id: string } {
    if (this.activeRun && this.activeRun.phase !== "settled") {
      throw new Error("已有活跃对照测试(先停止或等其完成)");
    }
    const setId = opts.setId ?? DEFAULT_SET_ID;
    const set = this.sandbox.loadEvalSet(setId);
    if (!set) throw new Error(`未找到评测集 ${setId}`);
    if (set.optimize.length === 0) throw new Error(`评测集 ${setId} 的 optimize 半为空,无可评测场景`);
    const parent = this.orchestrator.getChampion();
    if (!parent) throw new Error("champion 缺失(先 POST /sandbox/orchestrator/seed-baseline)");

    const plan: EvalPlan = {
      scenarios: set.optimize,
      seedsPerScenario: opts.seedsPerScenario ?? 1,
      runsPerSeed: opts.runsPerSeed ?? 3,
      judgeModelId: opts.judgeModelId,
      discussionSeconds: opts.discussionSeconds,
      evalSetVersion: set.eval_set_version,
    };
    const kinds = opts.kinds?.length ? opts.kinds : ALL_CONTROL_KINDS;
    const pauseBetween = !!opts.pauseBetweenControls;

    const run_id = `ctl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.activeRun = {
      run_id,
      phase: "evaluating_parent",
      set_id: set.set_id,
      eval_set_version: set.eval_set_version,
      parent_version_id: parent.version_id,
      plan: {
        scenarios: plan.scenarios.map((s) => s.scenario_id),
        seedsPerScenario: plan.seedsPerScenario,
        runsPerSeed: plan.runsPerSeed,
      },
      kinds,
      pause_between_controls: pauseBetween,
      games: [],
      controls: [],
      caveats: [],
      started_at: new Date().toISOString(),
    };
    this.stopRequested = false;
    this.continueSignal = null;
    this.emitStatus();
    this.logger.log(`对照测试 kickoff ${run_id} set=${set.set_id} parent=${parent.version_id} kinds=${kinds.join(",")} pause=${pauseBetween}`);

    void this.execute(plan, parent, kinds, set.holdout.length, pauseBetween).catch((err) => {
      this.settle("stopped", err instanceof Error ? err.message : String(err));
    });
    return { run_id };
  }

  /** 请求停止当前 run(局间生效)。停止是协作式的:置标志 + 立刻 emit 一次状态,
   *  让前台当场进入「停止中…」;真正落定要等在跑的对局(最多并发数局)跑完。
   *  若正卡在逐对照确认,一并放行 execute 让它走到 settle。 */
  stop(): void {
    if (this.activeRun && this.activeRun.phase !== "settled") {
      this.stopRequested = true;
      this.activeRun.stopping = true;
      this.activeRun.awaiting_confirmation = false;
      this.activeRun.next_kind = undefined;
      this.emitStatus();
      this.releaseWait();
    }
  }

  /** 人工确认继续:放行下一条对照(仅在 awaiting_confirmation 时有效)。 */
  continue(): void {
    if (!this.activeRun || this.activeRun.phase === "settled") return;
    if (!this.activeRun.awaiting_confirmation) return;
    this.activeRun.awaiting_confirmation = false;
    this.activeRun.next_kind = undefined;
    this.emitStatus();
    this.releaseWait();
  }

  /** 挂起 execute,直到 continue()/stop() 放行。 */
  private awaitContinue(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.continueSignal = resolve;
    });
  }

  /** 放行挂起中的 execute(无挂起则空操作)。 */
  private releaseWait(): void {
    const resolve = this.continueSignal;
    this.continueSignal = null;
    resolve?.();
  }

  // ===== 后台执行 =====

  private async execute(
    plan: EvalPlan,
    parent: PromptVersion,
    kinds: ControlKind[],
    holdoutCount: number,
    pauseBetween: boolean,
  ): Promise<void> {
    // 1) 父代评测一次(三对照复用 paired_cache)。
    this.setPhase("evaluating_parent");
    const parentScores = await this.pairedEval.runVersionEval(parent, plan, {
      onGameStatus: (patch) => this.recordGame("parent", patch),
      shouldStop: () => this.stopRequested,
    });
    if (this.stopRequested) return this.settle("stopped", "用户停止");

    // 2) 逐个对照:落 DB → 评测 → 配对做差 → 闸门 → 核对。
    this.setPhase("running_controls");
    const created: string[] = [];
    try {
      for (let i = 0; i < kinds.length; i += 1) {
        if (this.stopRequested) break;
        const kind = kinds[i];
        const spec = CONTROL_SPECS[kind];
        const child = this.buildChild(spec, parent);
        if (this.activeRun) this.activeRun.current_kind = kind;
        // 关键:await 落 DB 再评测,确保对局运行时 ai.service 能读到 control 正文
        // (否则 loadPromptVersionText 返回 null → 回退默认提示词 → 对照失效)。
        await this.repo.upsertPromptVersion(child);
        created.push(child.version_id);

        const childScores = await this.pairedEval.runVersionEval(child, plan, {
          onGameStatus: (patch) => this.recordGame(kind, patch),
          shouldStop: () => this.stopRequested,
        });
        if (this.stopRequested) break;

        const validation = buildValidation(parentScores, childScores);
        if (isTraceOn()) {
          traceEvent({
            kind: "aggregate",
            stage: "control_test_validation",
            run_id: this.activeRun?.run_id,
            data: { control_kind: kind, validation },
          });
        }
        const gate = optimizeGate(validation);
        const result = this.assess(spec, child.version_id, validation, gate);
        if (this.activeRun) {
          this.activeRun.controls.push(result);
          this.activeRun.current_kind = undefined;
        }
        this.events.emit("control", result);
        this.emitStatus();

        // 逐对照确认:该条已出结果,若还有下一条且未停止,挂起等人工放行。
        const nextKind = kinds[i + 1];
        if (pauseBetween && nextKind && !this.stopRequested) {
          if (this.activeRun) {
            this.activeRun.awaiting_confirmation = true;
            this.activeRun.next_kind = nextKind;
            this.activeRun.current_kind = undefined;
          }
          this.emitStatus();
          await this.awaitContinue();
          if (this.stopRequested) break;
        }
      }
    } finally {
      for (const id of created) {
        await this.repo.deletePromptVersion(id).catch((err) => {
          this.logger.warn(`清理 control 版本 ${id} 失败: ${err instanceof Error ? err.message : err}`);
        });
      }
    }

    if (this.stopRequested) return this.settle("stopped", "用户停止");
    if (this.activeRun) this.activeRun.caveats = this.buildCaveats(holdoutCount, this.activeRun.controls);
    this.settle("done");
  }

  private buildChild(spec: ControlSpec, parent: PromptVersion): PromptVersion {
    const text = spec.build(parent.prompt_text);
    return {
      version_id: controlVersionId(spec.kind, text),
      parent_id: parent.version_id,
      prompt_text: text,
      persona_scope: "shared",
      status: "candidate",
      hypothesis: `[control:${spec.kind}] ${spec.label}`,
      created_at: new Date().toISOString(),
    };
  }

  /** 逐局状态就地 upsert(side×scenario×seed×run)+ emit game。 */
  private recordGame(side: string, patch: GameStatusPatch): void {
    if (!this.activeRun) return;
    const item: ControlGameItem = { side, ...patch };
    const games = this.activeRun.games;
    const idx = games.findIndex(
      (g) =>
        g.side === side &&
        g.scenario_id === item.scenario_id &&
        g.seed === item.seed &&
        g.run === item.run,
    );
    if (idx >= 0) games[idx] = { ...games[idx], ...item };
    else games.push(item);
    this.events.emit("game", item);
  }

  private setPhase(phase: ControlTestRun["phase"]): void {
    if (!this.activeRun) return;
    this.activeRun.phase = phase;
    this.emitStatus();
  }

  private settle(decision: "done" | "stopped", error?: string): void {
    if (this.activeRun) {
      this.activeRun.phase = "settled";
      this.activeRun.decision = decision;
      this.activeRun.error = error;
      this.activeRun.current_kind = undefined;
      this.activeRun.stopping = false;
      this.activeRun.awaiting_confirmation = false;
      this.activeRun.next_kind = undefined;
      this.activeRun.overall_pass =
        decision === "done" &&
        this.activeRun.controls.length > 0 &&
        this.activeRun.controls.every((c) => c.pass);
      this.activeRun.settled_at = new Date().toISOString();
    }
    this.stopRequested = false;
    this.continueSignal = null;
    this.emitStatus();
    this.events.emit("done", {
      run_id: this.activeRun?.run_id,
      decision,
      overall_pass: this.activeRun?.overall_pass,
      error,
    });
    this.logger.log(`对照测试落定 ${this.activeRun?.run_id} decision=${decision}${error ? ` (${error})` : ""}`);
  }

  private emitStatus(): void {
    this.events.emit("status", this.activeRun);
    this.persist();
  }

  /** 把当前 run 快照排队落库(重启后回看用)。深拷贝定格当前态,串行化保证顺序;失败不影响主流程。 */
  private persist(): void {
    if (!this.activeRun) return;
    const snapshot: ControlTestRun = JSON.parse(JSON.stringify(this.activeRun));
    this.persistChain = this.persistChain
      .then(() => this.repo.saveControlTestRun(snapshot))
      .catch((err) =>
        this.logger.warn(`持久化对照测试 run 失败: ${err instanceof Error ? err.message : err}`),
      );
  }

  // ===== 判定 =====

  /** 核对单条对照是否如预期(验流水线机器,不是验 AI)。 */
  private assess(
    spec: ControlSpec,
    childVersionId: string,
    validation: ValidationReport,
    gate: GateDecision,
  ): ControlResult {
    const buckets = validation.buckets.map((b) => toBucketView(b.form, b.nScenarios, b.metrics));
    const notes: string[] = [];

    if (buckets.length === 0) {
      return {
        kind: spec.kind,
        label: spec.label,
        child_version_id: childVersionId,
        expectation: spec.expectation,
        gate,
        buckets,
        pass: false,
        notes: ["无配对数据(父子无共同 scenario,seed),无法判定——检查对局是否大量失败"],
      };
    }

    const marginVerdicts = buckets.map((b) => b.margin?.verdict);
    const marginImproved = marginVerdicts.includes("improved");
    const marginRegressed = marginVerdicts.includes("regressed");
    const allMarginInconclusive = buckets.every((b) => b.margin?.verdict === "inconclusive");
    const anyProbeRegressed = buckets.some((b) => b.probe_pass.some((p) => p.verdict === "regressed"));
    const vetoRegressed = buckets.some((b) => b.veto_rate?.verdict === "regressed");
    const survivalRegressed = buckets.some((b) => b.rounds_survived?.verdict === "regressed");
    const rejected = gate.decision === "reject";

    let pass = false;
    switch (spec.kind) {
      case "null":
        pass = allMarginInconclusive && rejected;
        if (marginImproved || marginRegressed) notes.push("A-A 却出现显著判定(把噪声当信号),流水线异常");
        if (!rejected) notes.push("A-A 不应过闸(同提示词不该被判进步)");
        break;
      case "negative":
        pass = rejected && (marginRegressed || anyProbeRegressed || vetoRegressed);
        if (!rejected) notes.push("烂提示词竟过闸 → 决策信号失灵(最严重)");
        if (!(marginRegressed || anyProbeRegressed || vetoRegressed)) {
          notes.push("无任何近真值信号判退步 → 可能 N 太小、裁判未生效或 auto_eval 未点火");
        }
        break;
      case "positive":
        pass = !marginRegressed && !anyProbeRegressed && !vetoRegressed && !survivalRegressed;
        if (marginRegressed) notes.push("真实改进被判 regressed → 方向判反");
        if (anyProbeRegressed) notes.push("probe_pass 退步 → 对探测改进不敏感或判反");
        if (!marginImproved) notes.push("未达 improved(N=6 下属预期;看点估计方向即可)");
        break;
    }

    return {
      kind: spec.kind,
      label: spec.label,
      child_version_id: childVersionId,
      expectation: spec.expectation,
      gate,
      buckets,
      pass,
      notes,
    };
  }

  private buildCaveats(holdoutCount: number, controls: ControlResult[]): string[] {
    const caveats: string[] = [];
    if (holdoutCount === 0) {
      caveats.push("评测集 holdout 为空:本测只覆盖第一道闸(optimize 配对+显著性),不验泛化/过拟合。");
    }
    const n = controls[0]?.buckets[0]?.nScenarios ?? 0;
    if (n > 0 && n < 10) {
      caveats.push(`N=场景数=${n}(<10):CI 偏宽、Wilcoxon p=null,除负对照外多判 inconclusive 属正常,别据此对 AI 下结论。`);
    }
    caveats.push("本测验证的是【优化流水线机器】是否正常,不是【AI 是否更像人】。后者需 holdout + 扩量 + 真人校准。");
    return caveats;
  }
}

function toMetricView(s: MetricSummary | undefined): MetricView | null {
  if (!s) return null;
  return { key: s.key, point: s.point, ci95: s.ci95, verdict: s.verdict };
}

function toBucketView(
  form: string,
  nScenarios: number,
  metrics: Record<string, MetricSummary>,
): BucketView {
  const probe_pass: MetricView[] = [];
  for (const [key, summary] of Object.entries(metrics)) {
    if (key.startsWith("probe_pass:")) {
      const v = toMetricView(summary);
      if (v) probe_pass.push(v);
    }
  }
  return {
    form,
    nScenarios,
    margin: toMetricView(metrics["blind_suspicion_margin"]),
    rounds_survived: toMetricView(metrics["rounds_survived"]),
    plurality_rate: toMetricView(metrics["plurality_rate"]),
    veto_rate: toMetricView(metrics["veto_rate"]),
    probe_pass,
  };
}
