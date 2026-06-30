// 真人校准服务(《真人校准 · 方案设计》§6/§9)。编排器调度下的周期性闸:
//   回灌真人局 → 按版本配对(代理 vs 真人)→ Spearman 相关性体检 → 落 CalibrationRun
//   → 据裁决写 state.calibration 冻结态(供 OrchestratorService 晋升时读)。
// 解耦:本服务只做"代理 ↔ 真值"的体检与冻结态写入,不碰晋升/裁判/侦探内部逻辑。

import { Injectable, Logger } from "@nestjs/common";
import type { MatchRecord } from "../match-record/types";
import { SandboxRepository } from "../sandbox.repository";
import {
  calibrationVerdict,
  correlationProxyVsReal,
  type CalibrationAction,
} from "./calibration";
import {
  buildCalibrationPairs,
  medianMatchesPerVersion,
  proxyMarginFromValidatedMetrics,
  summarizeHumanByVersion,
  type CalibrationRun,
} from "./calibration-backfill";
import { PromptVersionStore } from "./prompt-version";
import { OrchestratorStateStore } from "./state";

export interface RunCalibrationOptions {
  generation?: number;
  versions?: string[];
  threshold?: number;
  dataSource?: CalibrationRun["data_source"];
  minHumanMatchesPerVersion?: number;
}

@Injectable()
export class CalibrationService {
  private readonly logger = new Logger(CalibrationService.name);

  constructor(
    private readonly repo: SandboxRepository,
    private readonly promptStore: PromptVersionStore,
    private readonly stateStore: OrchestratorStateStore,
  ) {}

  /** 回灌真人局(data_source A 的采集入口);幂等按 match_id。 */
  async ingestHumanMatches(records: MatchRecord[]): Promise<{ ingested: number }> {
    let ingested = 0;
    for (const rec of records) {
      if (!rec?.match_id || !rec?.prompt_version_id) continue;
      await this.repo.insertHumanMatch(rec);
      ingested += 1;
    }
    return { ingested };
  }

  /** 跑一次校准批次:配对 → 相关性 → 落盘 → 更新冻结态。spec §3/§4/§6。 */
  async runCalibration(opts: RunCalibrationOptions = {}): Promise<CalibrationRun> {
    const state = this.stateStore.load();
    const generation = opts.generation ?? state?.generation ?? 0;
    const threshold = opts.threshold;

    const matches = await this.repo.listHumanMatches(opts.versions);
    const humanByVersion = summarizeHumanByVersion(matches);

    const proxyByVersion = new Map<string, number | null>();
    for (const version of humanByVersion.keys()) {
      const v = this.promptStore.load(version);
      proxyByVersion.set(version, proxyMarginFromValidatedMetrics(v?.validated_metrics));
    }

    const { pairs } = buildCalibrationPairs(humanByVersion, proxyByVersion, {
      minHumanMatchesPerVersion: opts.minHumanMatchesPerVersion,
    });
    const result = correlationProxyVsReal(pairs, { threshold });
    const { action, reason } = calibrationVerdict(result);
    const frozen = this.nextFrozen(action);

    const run: CalibrationRun = {
      calibration_id: `calib_${generation}_${Date.now().toString(36)}`,
      generation,
      data_source: opts.dataSource ?? "A_live",
      versions_included: pairs.map((p) => p.version),
      n_versions: result.n_versions,
      human_matches_per_version_median: medianMatchesPerVersion(humanByVersion),
      pairs,
      correlation_proxy_vs_real: result.correlation_proxy_vs_real,
      correlation_ci95: result.correlation_ci95,
      correlation_aux_voteshare: result.correlation_aux_voteshare,
      threshold: result.threshold,
      verdict: result.verdict,
      residual_flags: result.residual_flags,
      diagnosis: null,
      actions_taken: [],
      promotions_frozen: frozen,
      confounder_controls: [],
      holdout_recheck: null,
      timestamp: new Date().toISOString(),
    };

    await this.repo.insertCalibrationRun(run);

    // 写冻结态:OrchestratorService 晋升时读 state.calibration.frozen(spec §6)。
    if (state) {
      state.calibration = {
        calibration_id: run.calibration_id,
        verdict: result.verdict,
        action,
        frozen,
        generation,
        reason,
        updatedAt: run.timestamp,
      };
      this.stateStore.save(state);
      await this.stateStore.flush();
    }

    this.logger.log(
      `校准 ${run.calibration_id}: verdict=${result.verdict} action=${action} frozen=${frozen} (n=${result.n_versions})`,
    );
    return run;
  }

  getCalibrationState(): NonNullable<ReturnType<OrchestratorStateStore["load"]>>["calibration"] | null {
    return this.stateStore.load()?.calibration ?? null;
  }

  async listRuns(limit = 50): Promise<CalibrationRun[]> {
    return this.repo.listCalibrationRuns(limit);
  }

  /** healthy→解冻;drifting/broken→冻结;low_confidence(hold)→维持现状。spec §6/§105。 */
  private nextFrozen(action: CalibrationAction): boolean {
    const prev = this.stateStore.load()?.calibration?.frozen ?? false;
    if (action === "freeze_and_fix") return true;
    if (action === "continue") return false;
    return prev; // hold
  }
}
