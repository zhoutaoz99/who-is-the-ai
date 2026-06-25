import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { registerExtraPersonas } from "../ai/ai.personas";
import { AiService } from "../ai/ai.service";
import { GameService } from "../game/game.service";
import type { SandboxPlayerSpec } from "../game/game.rules";
import { buildMatchRecord } from "./match-record/build";
import type { MatchRecord } from "./match-record/types";
import { SANDBOX_PERSONAS } from "./personas/detective-personas";
import { loadDefaultProbeBank, resolveProbe } from "./probe/probe-bank";
import { registerProbeCheckers } from "./probe/checkers";
import type { ResolvedProbeFire } from "./probe/types";
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
] as const;

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
 * 离线沙盒引擎(薄服务):按 Scenario 驱动一局 debugAutoAi 对局,复用产品运行时
 * (GameService)+ gateway 实时可视化。流程:prepare(建等待房)→ [前台配置页改参数]
 * → start(开局 + 后台落盘 MatchRecord)。
 */
@Injectable()
export class SandboxService implements OnModuleInit {
  private readonly logger = new Logger(SandboxService.name);
  private readonly outDir =
    process.env.SANDBOX_OUT_DIR ?? join(process.cwd(), "sandbox-out");

  constructor(
    private readonly gameService: GameService,
    private readonly aiService: AiService,
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
      seed: scenario.seed,
      runIndex: runConfig.run_index ?? 0,
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

  private async finalize(roomId: string): Promise<MatchRecord> {
    await this.waitForFinished(roomId);
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
    await mkdir(this.outDir, { recursive: true });
    const file = join(this.outDir, `${record.match_id}.json`);
    await writeFile(file, JSON.stringify(record, null, 2), "utf-8");
    this.logger.log(`MatchRecord 已写出: ${file}`);
    return record;
  }

  private async waitForFinished(roomId: string): Promise<void> {
    const deadline = Date.now() + MATCH_DEADLINE_MS;
    while (Date.now() < deadline) {
      await this.sleep(POLL_INTERVAL_MS);
      const res = await this.gameService.observeRoom({ roomId });
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
