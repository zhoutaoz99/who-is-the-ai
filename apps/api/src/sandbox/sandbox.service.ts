import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { registerExtraPersonas } from "../ai/ai.personas";
import { GameService } from "../game/game.service";
import type { SandboxPlayerSpec } from "../game/game.rules";
import { buildMatchRecord } from "./match-record/build";
import type { MatchRecord } from "./match-record/types";
import { SANDBOX_PERSONAS } from "./personas/detective-personas";
import type { RunConfig, Scenario } from "./scenario/types";
import { validateScenario } from "./scenario/validate";

const POLL_INTERVAL_MS = 1_500;
const MATCH_DEADLINE_MS = 15 * 60_000;
const DEFAULT_DISCUSSION_SECONDS = 45;

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
    base_intent?: string;
  }>;
  intent_schedule: Array<{ round: number; slot: number; intent: string }>;
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

  constructor(private readonly gameService: GameService) {}

  onModuleInit(): void {
    registerExtraPersonas(SANDBOX_PERSONAS);
  }

  /** 内置示例场景(前台"运行沙盒示例"按钮 / 不带 body 的 prepare 用)。 */
  loadDefaultScenario(): Scenario {
    const file = join(__dirname, "scenario", "example-full-match.json");
    return JSON.parse(readFileSync(file, "utf-8")) as Scenario;
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
      baseIntent: slot.base_intent,
    }));

    const created = await this.gameService.createSandboxRoom({
      scenarioId: scenario.scenario_id,
      scenarioJson: scenario,
      specs,
      aiUnderTestModelId: runConfig.ai_under_test_model_id,
      intentSchedule: scenario.intent_schedule,
      discussionSeconds: runConfig.discussion_seconds ?? DEFAULT_DISCUSSION_SECONDS,
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
        base_intent: r.base_intent,
      })),
      intent_schedule: scenario.intent_schedule ?? [],
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
