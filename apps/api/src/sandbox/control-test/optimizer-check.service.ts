// 优化器自检服务(零对局):验"优化器本身"是否有效——给它一个挖了坑的种子,看它产出的
// 子代提示词是否恢复了被挖的具体处理。不跑任何对局,只用合成诊断 + 1 次优化器调用 + 覆盖判定。
//
// 与对照测试(验评估链)解耦:本模块只验"诊断进 → 编辑出"是否对路;"好编辑能否被流水线
// credit"由对照测试的正对照负责。两者组合 = 优化器有效性,无需端到端跑优化器。
//
// 后台流式:startRun() 立即返回 run_id,逐坑经 EventEmitter 发 status/hole/done,
// 由 ControlTestGateway 桥接 optcheck.* 到 socket。run 态仅存内存。

import { Injectable, Logger } from "@nestjs/common";
import { EventEmitter } from "node:events";
import { AiService } from "../../ai/ai.service";
import { buildOptimizerInput } from "../optimizer/input";
import type { ChampionProfile } from "../optimizer/input";
import { OptimizerService } from "../optimizer/propose";
import { validatePrompt } from "../optimizer/validate-prompt";
import { BASELINE_VERSION_ID, PromptVersionStore } from "../orchestrator/prompt-version";
import type { PromptVersion } from "../orchestrator/prompt-version";
import { parseJsonObject } from "../shared/json-parse";
import {
  DIGGABLE_HOLES,
  digHole,
  findHole,
  keywordCovered,
  type DiggableHole,
} from "./optimizer-holes";
import type { OptCoverage, OptHoleResult, OptimizerCheckRun } from "./optimizer-check.types";

export interface OptimizerCheckOptions {
  holeIds?: string[];
  optimizerModelId?: string;
  judgeModelId?: string;
}

const JUDGE_TEMPERATURE = 0;

@Injectable()
export class OptimizerCheckService {
  private readonly logger = new Logger(OptimizerCheckService.name);
  readonly events = new EventEmitter();

  private activeRun: OptimizerCheckRun | null = null;
  private stopRequested = false;

  constructor(
    private readonly optimizer: OptimizerService,
    private readonly ai: AiService,
    private readonly promptStore: PromptVersionStore,
  ) {}

  getActiveRun(): OptimizerCheckRun | null {
    return this.activeRun;
  }

  /** 可挖的坑清单(前台选择用)。 */
  listHoles(): Array<Pick<DiggableHole, "id" | "target" | "probe_type" | "reference">> {
    return DIGGABLE_HOLES.map((h) => ({
      id: h.id,
      target: h.target,
      probe_type: h.probe_type,
      reference: h.reference,
    }));
  }

  /** 非阻塞 kickoff:建 run → 后台 execute → 立即返回 run_id。 */
  startRun(opts: OptimizerCheckOptions = {}): { run_id: string } {
    if (this.activeRun && this.activeRun.phase !== "settled") {
      throw new Error("已有活跃优化器自检(先停止或等其完成)");
    }
    const holes = (opts.holeIds?.length ? opts.holeIds : DIGGABLE_HOLES.map((h) => h.id))
      .map((id) => findHole(id))
      .filter((h): h is DiggableHole => !!h);
    if (holes.length === 0) throw new Error("未选到任何可挖的坑");

    const run_id = `opt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.activeRun = {
      run_id,
      phase: "running",
      base_version_id: BASELINE_VERSION_ID,
      optimizer_model_id: opts.optimizerModelId,
      judge_model_id: opts.judgeModelId,
      holes: holes.map((h) => ({
        hole_id: h.id,
        target: h.target,
        probe_type: h.probe_type,
        status: "pending",
        pass: false,
        notes: [],
      })),
      started_at: new Date().toISOString(),
    };
    this.stopRequested = false;
    this.emitStatus();
    this.logger.log(`优化器自检 kickoff ${run_id} holes=${holes.map((h) => h.id).join(",")}`);

    void this.execute(holes, opts).catch((err) => {
      this.settle("stopped", err instanceof Error ? err.message : String(err));
    });
    return { run_id };
  }

  stop(): void {
    if (this.activeRun && this.activeRun.phase !== "settled") this.stopRequested = true;
  }

  // ===== 后台执行 =====

  private async execute(holes: DiggableHole[], opts: OptimizerCheckOptions): Promise<void> {
    const base = this.promptStore.load(BASELINE_VERSION_ID) ?? this.promptStore.seedBaselineIfMissing();

    for (const hole of holes) {
      if (this.stopRequested) break;
      try {
        await this.runHole(base, hole, opts);
      } catch (err) {
        this.patchHole(hole.id, {
          status: "failed",
          pass: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (this.stopRequested) return this.settle("stopped", "用户停止");
    this.settle("done");
  }

  private async runHole(
    base: PromptVersion,
    hole: DiggableHole,
    opts: OptimizerCheckOptions,
  ): Promise<void> {
    if (this.activeRun) this.activeRun.current_hole = hole.id;
    this.patchHole(hole.id, { status: "proposing" });

    // 1) 挖坑:删掉该纪律行,造种子(仅内存,不落库——零对局无人读 DB)。
    const dig = digHole(base.prompt_text, hole.marker);
    if (!dig.removed) {
      this.patchHole(hole.id, {
        status: "failed",
        pass: false,
        notes: [`基线里未找到该纪律行(marker="${hole.marker}"),坑无效——基线可能已改`],
      });
      return;
    }
    const seed: PromptVersion = {
      ...base,
      version_id: `optseed-${hole.id}`,
      parent_id: base.version_id,
      prompt_text: dig.text,
      status: "candidate",
      created_at: new Date().toISOString(),
    };

    // 2) 合成诊断(把挖的坑顶成最弱维度)+ 真优化器提案。
    const profile = this.synthProfile(hole);
    const input = buildOptimizerInput(seed, profile, hole.target, undefined, []);
    const proposal = await this.optimizer.propose(input, {
      basedOn: seed.version_id,
      optimizerModelId: opts.optimizerModelId,
    });
    if (!proposal) {
      this.patchHole(hole.id, { status: "failed", pass: false, notes: ["优化器未产出可用候选"] });
      return;
    }
    const child = proposal.child;

    // 3) L0 机械有效 + L1 瞄准命中。
    const validate = validatePrompt(child, seed, { lengthBudgetPct: 0.15 });
    const targetHit = (child.target_dimension ?? "") === hole.target;

    // 4) L2′ 覆盖判定:种子(坑深自检)+ 子代。
    this.patchHole(hole.id, {
      status: "judging",
      child_version_id: child.version_id,
      validate,
      target_hit: targetHit,
      hypothesis: child.hypothesis,
      edit_type: child.edit_type,
    });
    const seedCov = await this.judgeCoverage(seed.prompt_text, hole, opts.judgeModelId);
    const childCov = await this.judgeCoverage(child.prompt_text, hole, opts.judgeModelId);

    // 5) 汇总判定。
    const notes: string[] = [];
    if (!validate.ok) notes.push(`L0 校验未过:${validate.reasons.join("; ")}`);
    if (!targetHit) notes.push(`L1 瞄准未命中:target=${child.target_dimension ?? "(空)"} ≠ ${hole.target}`);
    if (!childCov.covered) notes.push("L2′ 子代未恢复该类具体处理(优化器没补上)");
    if (seedCov.covered) {
      notes.push("坑较浅:挖坑后种子仍被判已覆盖(通用规则兜底);子代恢复仍记 pass,但建议加深 ablation");
    } else if (childCov.covered) {
      notes.push("干净恢复:种子已无该具体处理,子代补回(优化器有效)");
    }

    const pass = validate.ok && targetHit && childCov.covered;
    this.patchHole(hole.id, {
      status: "done",
      seed_covered: seedCov.covered,
      coverage: childCov,
      pass,
      notes,
    });
  }

  /** 合成 champion 弱点画像:把挖的坑种成最弱探测维度(替代真跑算出的 profile)。 */
  private synthProfile(hole: DiggableHole): ChampionProfile {
    return {
      nScenarios: 0, // 零对局,信息性
      meanMargin: null,
      vetoRate: 0,
      probePassByType: { [hole.probe_type]: hole.plantedPassRate },
      weakDimensions: [
        {
          metric: hole.target,
          point: hole.plantedPassRate,
          reliability: "high",
          note: `${hole.probe_type} 通过率 ${hole.plantedPassRate.toFixed(2)}(最弱 = 挖的坑)`,
        },
      ],
    };
  }

  /** 概念级覆盖判定(LLM judge);失败回退关键词。 */
  private async judgeCoverage(
    text: string,
    hole: DiggableHole,
    judgeModelId?: string,
  ): Promise<OptCoverage> {
    const system =
      '你是《谁是AI》提示词审阅器。判断给定的 AI 玩家系统提示词里,是否包含一条【具体、可操作】的指令,' +
      '指导玩家以人设化方式回避某一类测试(而不仅是泛泛地说"不要展示能力")。只输出 JSON,不要多余内容。';
    const user = `【要找的纪律(概念)】\n${hole.reference}\n\n【待审提示词】\n${text}\n\n这段提示词里是否包含与上述纪律【同概念、且具体可操作】的指令?\n只输出:{"covered": true 或 false, "quote": "命中的原句,没有则空字符串"}`;
    try {
      const { mainConfig, connection } = this.ai.resolveCallConfig(judgeModelId);
      const modelConfig = { ...mainConfig, temperature: JUDGE_TEMPERATURE };
      const { content } = await this.ai.callModel(system, user, modelConfig, connection);
      const obj = parseJsonObject<{ covered?: boolean; quote?: string }>(content);
      if (obj && typeof obj.covered === "boolean") {
        return { covered: obj.covered, quote: obj.quote || undefined, method: "judge" };
      }
    } catch (err) {
      this.logger.warn(`覆盖 judge 调用失败,回退关键词: ${err instanceof Error ? err.message : err}`);
    }
    const kw = keywordCovered(text, hole.coverageKeywords);
    return { covered: kw.covered, quote: kw.quote, method: "keyword" };
  }

  // ===== 状态维护 =====

  private patchHole(holeId: string, patch: Partial<OptHoleResult>): void {
    if (!this.activeRun) return;
    const idx = this.activeRun.holes.findIndex((h) => h.hole_id === holeId);
    if (idx < 0) return;
    this.activeRun.holes[idx] = { ...this.activeRun.holes[idx], ...patch };
    this.emitStatus();
    this.events.emit("hole", this.activeRun.holes[idx]);
  }

  private settle(decision: "done" | "stopped", error?: string): void {
    if (this.activeRun) {
      this.activeRun.phase = "settled";
      this.activeRun.decision = decision;
      this.activeRun.error = error;
      this.activeRun.current_hole = undefined;
      this.activeRun.overall_pass =
        decision === "done" &&
        this.activeRun.holes.length > 0 &&
        this.activeRun.holes.every((h) => h.pass);
      this.activeRun.settled_at = new Date().toISOString();
    }
    this.stopRequested = false;
    this.emitStatus();
    this.events.emit("done", {
      run_id: this.activeRun?.run_id,
      decision,
      overall_pass: this.activeRun?.overall_pass,
      error,
    });
    this.logger.log(`优化器自检落定 ${this.activeRun?.run_id} decision=${decision}${error ? ` (${error})` : ""}`);
  }

  private emitStatus(): void {
    this.events.emit("status", this.activeRun);
  }
}
