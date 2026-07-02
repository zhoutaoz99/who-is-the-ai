// 对照测试 REST 接口(单独的测试模块)。
// - GET  /sandbox/control-test/controls   预览三条对照(不跑)
// - GET  /sandbox/control-test/state       当前/最近一次 run 快照(首屏 / 重连兜底)
// - POST /sandbox/control-test/run         一键 kickoff:后台跑负/正/空三对照,立即返回 run_id(进度走 socket)
// - POST /sandbox/control-test/stop        停止当前 run
// - POST /sandbox/control-test/continue    逐对照确认模式下放行下一条对照

import { Body, Controller, Get, Post } from "@nestjs/common";
import { ALL_CONTROL_KINDS, CONTROL_SPECS, type ControlKind } from "./control-prompts";
import { ControlTestService } from "./control-test.service";
import type { ControlTestRun } from "./control-test.types";
import { OptimizerCheckService } from "./optimizer-check.service";
import type { OptimizerCheckRun } from "./optimizer-check.types";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

@Controller("sandbox/control-test")
export class ControlTestController {
  constructor(
    private readonly controlTest: ControlTestService,
    private readonly optimizerCheck: OptimizerCheckService,
  ) {}

  /** 预览三条对照的用意与期望(前台展示/确认用,不跑对局)。 */
  @Get("controls")
  controls(): {
    ok: boolean;
    controls: Array<{ kind: ControlKind; label: string; expectation: string }>;
  } {
    return {
      ok: true,
      controls: ALL_CONTROL_KINDS.map((k) => ({
        kind: k,
        label: CONTROL_SPECS[k].label,
        expectation: CONTROL_SPECS[k].expectation,
      })),
    };
  }

  /** 当前/最近一次 run 快照(首屏与断线重连兜底)。 */
  @Get("state")
  state(): { ok: boolean; run: ControlTestRun | null } {
    return { ok: true, run: this.controlTest.getActiveRun() };
  }

  /**
   * 一键 kickoff 三对照(child-vs-parent)。body 全部可选:
   * - set_id           默认 baseline_smoke_v1
   * - kinds            默认 ["null","negative","positive"]
   * - seeds_per_scenario / runs_per_seed / judge_model_id / discussion_seconds  评测参数
   * 非阻塞:立即返回 run_id,逐局/逐对照进度走 socket controltest.*。
   */
  @Post("run")
  run(
    @Body()
    body?: {
      set_id?: string;
      kinds?: ControlKind[];
      seeds_per_scenario?: number;
      runs_per_seed?: number;
      judge_model_id?: string;
      discussion_seconds?: number;
      pause_between_controls?: boolean;
    },
  ): { ok: boolean; run_id?: string; error?: string } {
    try {
      const { run_id } = this.controlTest.startRun({
        setId: body?.set_id,
        kinds: body?.kinds,
        seedsPerScenario: body?.seeds_per_scenario,
        runsPerSeed: body?.runs_per_seed,
        judgeModelId: body?.judge_model_id,
        discussionSeconds: body?.discussion_seconds,
        pauseBetweenControls: body?.pause_between_controls,
      });
      return { ok: true, run_id };
    } catch (err) {
      return { ok: false, error: msg(err) };
    }
  }

  @Post("stop")
  stop(): { ok: boolean } {
    this.controlTest.stop();
    return { ok: true };
  }

  /** 逐对照确认模式:放行下一条对照。 */
  @Post("continue")
  continue(): { ok: boolean } {
    this.controlTest.continue();
    return { ok: true };
  }

  // ===== 优化器自检(零对局:挖坑 → 真优化器 → 子代是否恢复)=====

  /** 可挖的坑清单(前台选择用)。 */
  @Get("optimizer/holes")
  optimizerHoles(): {
    ok: boolean;
    holes: Array<{ id: string; target: string; probe_type: string; reference: string }>;
  } {
    return { ok: true, holes: this.optimizerCheck.listHoles() };
  }

  /** 当前/最近一次优化器自检快照(首屏与重连兜底)。 */
  @Get("optimizer/state")
  optimizerState(): { ok: boolean; run: OptimizerCheckRun | null } {
    return { ok: true, run: this.optimizerCheck.getActiveRun() };
  }

  /**
   * 一键 kickoff 优化器自检。body 可选:
   * - hole_ids           默认全部可挖的坑
   * - optimizer_model_id / judge_model_id
   * 非阻塞:立即返回 run_id,逐坑进度走 socket optcheck.*。
   */
  @Post("optimizer/run")
  optimizerRun(
    @Body() body?: { hole_ids?: string[]; optimizer_model_id?: string; judge_model_id?: string },
  ): { ok: boolean; run_id?: string; error?: string } {
    try {
      const { run_id } = this.optimizerCheck.startRun({
        holeIds: body?.hole_ids,
        optimizerModelId: body?.optimizer_model_id,
        judgeModelId: body?.judge_model_id,
      });
      return { ok: true, run_id };
    } catch (err) {
      return { ok: false, error: msg(err) };
    }
  }

  @Post("optimizer/stop")
  optimizerStop(): { ok: boolean } {
    this.optimizerCheck.stop();
    return { ok: true };
  }
}
