import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { registerExtraPersonas } from "../ai/ai.personas";
import { AiService } from "../ai/ai.service";
import { GameService } from "../game/game.service";
import type { SandboxPlayerSpec } from "../game/game.rules";
import type { RoomSnapshot } from "../game/game.types";
import { buildMatchRecord } from "./match-record/build";
import type { MatchRecord } from "./match-record/types";
import { SANDBOX_PERSONAS } from "./personas/detective-personas";
import { loadDefaultProbeBank, resolveProbe } from "./probe/probe-bank";
import { registerProbeCheckers } from "./probe/checkers";
import type { ResolvedProbeFire } from "./probe/types";
import { SandboxRepository } from "./sandbox.repository";
import type { RunConfig, Scenario } from "./scenario/types";
import { validateScenario } from "./scenario/validate";

const POLL_INTERVAL_MS = 1_500;
const MATCH_DEADLINE_MS = 15 * 60_000;
const DEFAULT_DISCUSSION_SECONDS = 45;

/** 内置示例场景清单(打包进 dist,前台下拉选择 → 覆盖各增量)。 */
const EXAMPLE_SCENARIOS = [
  { id: "sc_example_0001", label: "整局 · live 投票", form: "full_match", file: "example-full-match.json" },
  { id: "sc_example_rule_0002", label: "整局 · rule 投票", form: "full_match", file: "example-full-match-rule.json" },
  { id: "sc_example_scripted_0003", label: "整局 · scripted 集火", form: "full_match", file: "example-full-match-scripted.json" },
  { id: "sc_example_probe_0004", label: "整局 · 探测注入", form: "full_match", file: "example-full-match-probe.json" },
  { id: "sc_example_spotlight_0005", label: "切片 · spotlight+探测", form: "spotlight", file: "example-spotlight.json" },
  // 基线场景库 baseline_v1 首批(见 docs《N.2.基线场景库》)。
  { id: "bsl_007", label: "基线 · HL-2 风格指纹(纯社交·阿条)", form: "full_match", file: "baseline/bsl_007.json" },
  { id: "bsl_008", label: "基线 · HL-2 风格指纹(3人·酸梅)", form: "full_match", file: "baseline/bsl_008.json" },
  { id: "bsl_023", label: "基线 · HL-5 人格一致(整局·探长)", form: "full_match", file: "baseline/bsl_023.json" },
  { id: "bsl_001", label: "基线 · HL-1 抗测试(算术·阿条)", form: "full_match", file: "baseline/bsl_001.json" },
  { id: "bsl_002", label: "基线 · HL-1 抗测试(表演·酸梅)", form: "full_match", file: "baseline/bsl_002.json" },
  { id: "bsl_003", label: "基线 · HL-1 抗测试(实时信息·布丁)", form: "full_match", file: "baseline/bsl_003.json" },
  // holdout 半 + 配套 optimize(给 holdout_gate 喂数据;同 probe_type 的 optimize/holdout 用不重叠轮换实例)。
  { id: "bsl_022", label: "基线 · HL-5 连环追问(optimize·布丁)", form: "full_match", file: "baseline/bsl_022.json" },
  { id: "bsl_006", label: "基线 · HL-1 抗测试(算术·holdout·酸梅)", form: "full_match", file: "baseline/bsl_006.json" },
  { id: "bsl_010", label: "基线 · HL-2 风格指纹(纯社交·holdout·探长)", form: "full_match", file: "baseline/bsl_010.json" },
  { id: "bsl_024", label: "基线 · HL-5 连环追问(holdout·阿条)", form: "full_match", file: "baseline/bsl_024.json" },
] as const;

/** 内置评测集清单(冻结的场景集合,驱动优化环;成员只引用 scenario_id,不复制场景)。 */
const EVAL_SETS = [
  { id: "baseline_smoke_v1", file: "baseline_smoke_v1.json" },
  { id: "baseline_holdout_v1", file: "baseline_holdout_v1.json" },
] as const;

/** 评测集清单文件(magnet:set_id/version + optimize/holdout 成员 id)。 */
interface EvalSetManifest {
  schema_version?: string;
  set_id: string;
  version: string;
  description?: string;
  optimize: string[];
  holdout: string[];
}

/** 解析后的评测集:成员 id 已还原为 Scenario,并算出绑定指标用的 eval_set_version。 */
export interface ResolvedEvalSet {
  set_id: string;
  version: string;
  /** 指标绑定标识(set_id@version):跨此值不可直接比。 */
  eval_set_version: string;
  description?: string;
  optimize: Scenario[];
  holdout: Scenario[];
}

/** 前台/发现用的评测集摘要。 */
export interface EvalSetSummary {
  set_id: string;
  version: string;
  eval_set_version: string;
  description?: string;
  optimize_count: number;
  holdout_count: number;
}

/** 前台配置页展示用的场景元信息(静态部分,不含实时模型/时长)。 */
export interface SandboxConfig {
  scenario_id: string;
  seed: number;
  mode: string;
  vote_policy: string;
  form: string;
  ai_under_test_slot: number;
  prompt_version_id: string;
  roster: Array<{
    slot: number;
    role: string;
    persona_id: string;
    temperature?: number;
  }>;
  vote_policy_overrides?: Record<number, string>;
  probe_schedule?: Array<{
    probe_ref: string;
    round: number;
    timing: unknown;
    from_slot: number;
  }>;
  seed_history?: {
    start_round: number;
    prior_turns_count: number;
    max_rounds_forward: number;
  } | null;
}

/**
 * 离线沙盒引擎(薄服务):按 Scenario 驱动一局沙盒对局,复用产品运行时
 * (GameService)+ gateway 实时可视化。流程:prepare(建等待房)→ [前台配置页改参数]
 * → start(开局 + 后台落库 MatchRecord)。
 */
@Injectable()
export class SandboxService implements OnModuleInit {
  private readonly logger = new Logger(SandboxService.name);

  constructor(
    private readonly gameService: GameService,
    private readonly aiService: AiService,
    private readonly repo: SandboxRepository,
  ) {}

  onModuleInit(): void {
    registerExtraPersonas(SANDBOX_PERSONAS);
    registerProbeCheckers();
  }

  /** 内置示例场景(前台"运行沙盒示例"按钮 / 不带 body 的 prepare 用)。 */
  loadDefaultScenario(): Scenario {
    const file = join(__dirname, "scenario", "example-full-match.json");
    return JSON.parse(readFileSync(file, "utf-8")) as Scenario;
  }

  /** 内置示例场景清单(前台下拉用)。 */
  getExampleList(): Array<{ id: string; label: string; form: string }> {
    return EXAMPLE_SCENARIOS.map(({ id, label, form }) => ({ id, label, form }));
  }

  /** 按 scenario_id 加载内置示例场景。 */
  loadExampleScenario(scenarioId: string): Scenario | null {
    const entry = EXAMPLE_SCENARIOS.find((e) => e.id === scenarioId);
    if (!entry) return null;
    const file = join(__dirname, "scenario", entry.file);
    return JSON.parse(readFileSync(file, "utf-8")) as Scenario;
  }

  /** 内置评测集清单(前台下拉/发现用)。 */
  getEvalSetList(): EvalSetSummary[] {
    const out: EvalSetSummary[] = [];
    for (const entry of EVAL_SETS) {
      const m = this.readEvalSetManifest(entry.file);
      if (!m) continue;
      out.push({
        set_id: m.set_id,
        version: m.version,
        eval_set_version: `${m.set_id}@${m.version}`,
        description: m.description,
        optimize_count: m.optimize?.length ?? 0,
        holdout_count: m.holdout?.length ?? 0,
      });
    }
    return out;
  }

  /**
   * 按 set_id 加载评测集,把成员 id 还原成 Scenario。
   * 任一成员不可解析即抛错(冻结集缺成员是真问题,不静默丢)。
   * @returns 解析后的集合;set_id 不存在 → null。
   */
  loadEvalSet(setId: string): ResolvedEvalSet | null {
    const entry = EVAL_SETS.find((e) => e.id === setId);
    if (!entry) return null;
    const m = this.readEvalSetManifest(entry.file);
    if (!m) throw new Error(`评测集清单读取失败:${entry.file}`);

    const resolve = (ids: string[], half: string): Scenario[] => {
      const scenarios: Scenario[] = [];
      const missing: string[] = [];
      for (const id of ids ?? []) {
        const s = this.loadExampleScenario(id);
        if (s) scenarios.push(s);
        else missing.push(id);
      }
      if (missing.length) {
        throw new Error(`评测集 ${m.set_id} 的 ${half} 成员无法解析:${missing.join(", ")}`);
      }
      return scenarios;
    };

    return {
      set_id: m.set_id,
      version: m.version,
      eval_set_version: `${m.set_id}@${m.version}`,
      description: m.description,
      optimize: resolve(m.optimize, "optimize"),
      holdout: resolve(m.holdout, "holdout"),
    };
  }

  private readEvalSetManifest(file: string): EvalSetManifest | null {
    try {
      const path = join(__dirname, "scenario", "sets", file);
      return JSON.parse(readFileSync(path, "utf-8")) as EvalSetManifest;
    } catch {
      return null;
    }
  }

  /** 把场景 probe_schedule 解析成不透明 fire 计划(probe_ref → 具体实例,带 split 隔离)。 */
  private resolveProbeSchedule(
    scenario: Scenario,
    runIndex: number,
  ): ResolvedProbeFire[] {
    const fires = scenario.probe_schedule ?? [];
    if (fires.length === 0) return [];
    const bank = loadDefaultProbeBank();
    const resolved: ResolvedProbeFire[] = [];
    for (let i = 0; i < fires.length; i += 1) {
      const fire = fires[i];
      const instance = resolveProbe(bank, fire.probe_ref, scenario.split, [
        scenario.seed,
        runIndex,
        fire.round,
        i,
      ]);
      if (!instance) {
        throw new Error(
          `探测解析失败:${fire.probe_ref} 在 split=${scenario.split} 下无可用实例(检查 split_exposure 隔离)`,
        );
      }
      resolved.push({
        probe_id: instance.probe_id,
        type: instance.type,
        round: fire.round,
        timing: fire.timing,
        from_seat: fire.from_slot,
        intent: instance.intent,
        templates: instance.templates,
        auto_check: instance.auto_check,
        split: scenario.split,
      });
    }
    return resolved;
  }

  /** 建一个等待中的沙盒房(不开局),返回 roomId 供前台配置页展示/修改。 */
  async prepare(
    scenario?: Scenario,
    runConfig: RunConfig = {},
  ): Promise<{ roomId: string }> {
    scenario ??= this.loadDefaultScenario();
    validateScenario(scenario);

    const specs: SandboxPlayerSpec[] = scenario.roster.map((slot) => ({
      slot: slot.slot,
      role: slot.role,
      personaId: slot.persona_id,
      modelId: slot.model_id,
    }));

    const probeSchedule = this.resolveProbeSchedule(scenario, runConfig.run_index ?? 0);

    const created = await this.gameService.createSandboxRoom({
      scenarioId: scenario.scenario_id,
      scenarioJson: scenario,
      specs,
      aiUnderTestModelId: runConfig.ai_under_test_model_id,
      discussionSeconds: runConfig.discussion_seconds ?? DEFAULT_DISCUSSION_SECONDS,
      votePolicy: scenario.vote_policy,
      voteOverrides: scenario.vote_policy_overrides,
      scriptedVotes: scenario.scripted_votes?.map((v) => ({
        round: v.round,
        voter_seat: v.voter_slot,
        target_seat: v.target_slot,
      })),
      seed: runConfig.seed_override ?? scenario.seed,
      runIndex: runConfig.run_index ?? 0,
      aiPromptVersionId: runConfig.ai_prompt_version_id,
      probeSchedule,
      form: scenario.form,
      startRound: scenario.seed_history?.start_round,
      maxRoundsForward: scenario.max_rounds_forward,
      seedHistory: scenario.seed_history
        ? {
            prior_turns: scenario.seed_history.prior_turns.map((t) => ({
              round: t.round,
              slot: t.slot,
              text: t.text,
            })),
            prior_rounds: scenario.seed_history.prior_rounds?.map((r) => ({
              round: r.round,
              eliminated_slot: r.eliminated_slot,
            })),
          }
        : undefined,
    });
    if (!created.ok || !created.room) {
      throw new Error(`建房失败: ${created.error ?? "?"}`);
    }
    this.logger.log(
      `沙盒房已创建(等待开始) room=${created.room.id} scenario=${scenario.scenario_id}`,
    );
    return { roomId: created.room.id };
  }

  /** 开局:驱动 GameService.startGame,并后台跑到终局落盘 MatchRecord。 */
  async start(roomId: string): Promise<{ roomId: string }> {
    const room = await this.gameService.getRoomInternal(roomId);
    if (!room) {
      throw new Error("房间不存在");
    }
    if (room.status !== "waiting") {
      throw new Error(`房间不在等待状态(当前 ${room.status})`);
    }

    const started = await this.gameService.startGame({
      roomId,
      playerId: room.ownerPlayerId,
    });
    if (!started.ok) {
      throw new Error(`开局失败: ${started.error ?? "?"}`);
    }
    this.logger.log(`沙盒对局已开始 room=${roomId}`);

    void this.finalize(roomId).catch((err) => {
      this.logger.warn(
        `MatchRecord 落盘失败 room=${roomId}: ${err instanceof Error ? err.message : err}`,
      );
    });

    return { roomId };
  }

  /**
   * 跑完一局并返回 MatchRecord(编排器配对评测用;同步等到终局再返回)。
   * onProgress:轮询期间每次拿到房间快照时回调(对局内实时进度:phase/当前轮/AI 存活)。
   */
  async runMatch(
    scenario: Scenario,
    runConfig: RunConfig = {},
    onProgress?: (room: RoomSnapshot) => void,
  ): Promise<MatchRecord> {
    const { roomId } = await this.prepare(scenario, runConfig);
    const waitingRoom = await this.gameService.getRoomInternal(roomId);
    if (!waitingRoom) {
      throw new Error(`房间不存在 room=${roomId}`);
    }
    const started = await this.gameService.startGame({
      roomId,
      playerId: waitingRoom.ownerPlayerId,
    });
    if (!started.ok) {
      throw new Error(`开局失败: ${started.error ?? "?"}`);
    }
    return this.finalize(roomId, onProgress);
  }

  /** 取场景静态配置(前台配置页展示用)。 */
  async getConfig(roomId: string): Promise<SandboxConfig> {
    const room = await this.gameService.getRoomInternal(roomId);
    if (!room || !room.sandboxScenarioId) {
      throw new Error("不是沙盒房间或房间不存在");
    }
    const scenario = room.sandboxScenario as Scenario;
    return {
      scenario_id: scenario.scenario_id,
      seed: scenario.seed,
      mode: scenario.mode,
      vote_policy: scenario.vote_policy,
      form: scenario.form,
      ai_under_test_slot: scenario.ai_under_test_slot,
      prompt_version_id: scenario.prompt_version_id ?? "v0-baseline",
      roster: scenario.roster.map((r) => ({
        slot: r.slot,
        role: r.role,
        persona_id: r.persona_id,
        temperature: r.temperature,
      })),
      vote_policy_overrides: scenario.vote_policy_overrides ?? {},
      probe_schedule: (scenario.probe_schedule ?? []).map((p) => ({
        probe_ref: p.probe_ref,
        round: p.round,
        timing: p.timing,
        from_slot: p.from_slot,
      })),
      seed_history: scenario.seed_history
        ? {
            start_round: scenario.seed_history.start_round,
            prior_turns_count: scenario.seed_history.prior_turns.length,
            max_rounds_forward: scenario.max_rounds_forward ?? 2,
          }
        : null,
    };
  }

  private async finalize(
    roomId: string,
    onProgress?: (room: RoomSnapshot) => void,
  ): Promise<MatchRecord> {
    await this.waitForFinished(roomId, onProgress);
    const room = await this.gameService.getRoomInternal(roomId);
    if (!room) {
      throw new Error(`房间不存在 room=${roomId}`);
    }
    const scenario = room.sandboxScenario as Scenario | undefined;
    if (!scenario) {
      throw new Error(`缺少场景数据 room=${roomId}`);
    }
    const record = buildMatchRecord(room, scenario, {
      promptVersionId: scenario.prompt_version_id ?? "v0-baseline",
      runIndex: 0,
    });
    // LLM 失败留痕:有错误则置 degraded 并附 errors[]。
    const errors = this.aiService.consumeSandboxErrors(roomId);
    if (errors.length > 0) {
      record.status = "degraded";
      record.errors = errors.map((e) => ({
        round: e.round,
        phase: e.phase,
        slot: e.seat,
        kind: e.kind,
        detail: e.detail,
        retries: 0,
      }));
    }
    await this.repo.upsertMatchRecord(record);
    this.logger.log(`MatchRecord 已落库: ${record.match_id}`);
    return record;
  }

  /** 按 match_id 读已落库的 MatchRecord(scoreStoredMatch / 回看用)。 */
  async loadMatchRecord(matchId: string): Promise<MatchRecord | null> {
    return this.repo.loadMatchRecord(matchId);
  }

  private async waitForFinished(
    roomId: string,
    onProgress?: (room: RoomSnapshot) => void,
  ): Promise<void> {
    const deadline = Date.now() + MATCH_DEADLINE_MS;
    while (Date.now() < deadline) {
      await this.sleep(POLL_INTERVAL_MS);
      const res = await this.gameService.observeRoom({ roomId });
      if (res.room) onProgress?.(res.room);
      if (res.room?.status === "finished") {
        return;
      }
    }
    throw new Error(`对局未在时限内结束 room=${roomId}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
