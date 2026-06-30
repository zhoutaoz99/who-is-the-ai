import { Body, Controller, Delete, Get, Param, Post, Query } from "@nestjs/common";
import type { SandboxConfig } from "./sandbox.service";
import { SandboxService } from "./sandbox.service";
import { ScoreService } from "./score/score.service";
import type { ScoreRecord } from "./score/types";
import type { RunConfig, Scenario } from "./scenario/types";
import { mineFailureCandidates } from "./orchestrator/free-explore";
import { computeCoverage } from "./scenario-bank/coverage";
import { runBackfill, type HumanFailureObservation } from "./scenario-bank/replay-backfill";
import { sampleScenarioTags } from "./scenario-bank/sampler";
import { distributionDrift, splitOptimizeHoldout } from "./scenario-bank/split";
import {
  clearSandboxLlmCalls,
  listSandboxLlmCalls,
  type SandboxLlmCallRecord,
} from "./shared/observability";
import { SandboxPromptService } from "./shared/prompt-versions";

/**
 * 离线沙盒 REST 接口:
 * - GET  /sandbox/examples        内置示例场景清单
 * - POST /sandbox/prepare         建等待房(可带 scenario_id 或完整 scenario,缺省用默认示例)
 * - GET  /sandbox/:roomId/config  取场景静态配置(前台配置页用)
 * - POST /sandbox/start           开局(后台跑到终局并落盘 MatchRecord)
 * - POST /sandbox/score           对已落盘的 MatchRecord 跑裁判评分,产出 ScoreRecord
 * - GET  /sandbox/score/:matchId  读已落盘的 ScoreRecord(打分详情回看)
 */
@Controller("sandbox")
export class SandboxController {
  constructor(
    private readonly sandbox: SandboxService,
    private readonly scoreService: ScoreService,
    private readonly promptService: SandboxPromptService,
  ) {}

  @Get("examples")
  examples(): { ok: boolean; examples: Array<{ id: string; label: string; form: string }> } {
    return { ok: true, examples: this.sandbox.getExampleList() };
  }

  /** 最近沙盒 LLM 调用观测记录(进程内环形缓冲,用于排查 partial/重试/usage)。 */
  @Get("llm-calls")
  llmCalls(
    @Query("limit") limit?: string,
  ): { ok: boolean; calls: SandboxLlmCallRecord[] } {
    return { ok: true, calls: listSandboxLlmCalls(Number(limit) || 200) };
  }

  @Delete("llm-calls")
  clearLlmCalls(): { ok: boolean } {
    clearSandboxLlmCalls();
    return { ok: true };
  }

  /** judge/optimizer prompt 版本化视图(M0.7):active generation 命中 DB,否则回退文件。 */
  @Get("prompts")
  async prompts(): Promise<{ ok: boolean; active_generation: unknown; assets: unknown[] }> {
    const view = await this.promptService.listAssets();
    return { ok: true, active_generation: view.active_generation, assets: view.assets };
  }

  @Get("prompts/generations")
  async promptGenerations(): Promise<{ ok: boolean; generations: unknown[] }> {
    return { ok: true, generations: await this.promptService.listGenerations() };
  }

  @Post("prompts/assets")
  async createPromptAsset(
    @Body() body?: { asset_key?: string; content?: string; note?: string; activate?: boolean },
  ): Promise<{ ok: boolean; asset?: unknown; generation?: unknown; error?: string }> {
    try {
      const assetKey = (body?.asset_key ?? "").trim();
      const content = body?.content ?? "";
      if (!assetKey || !content.trim()) return { ok: false, error: "缺少 asset_key 或 content" };
      const result = await this.promptService.createAssetVersion(assetKey, content, {
        note: body?.note,
        activate: body?.activate === true,
      });
      return { ok: true, asset: result.asset, generation: result.generation };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  @Post("prompts/generations")
  async createPromptGeneration(
    @Body() body?: { manifest_patch?: Record<string, number>; note?: string },
  ): Promise<{ ok: boolean; generation?: unknown; error?: string }> {
    try {
      const patch = body?.manifest_patch;
      if (!patch || typeof patch !== "object") return { ok: false, error: "缺少 manifest_patch" };
      const generation = await this.promptService.createGenerationWithPatch(patch, body?.note);
      return { ok: true, generation };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  @Post("prompts/generations/activate")
  async activatePromptGeneration(
    @Body() body?: { id?: string },
  ): Promise<{ ok: boolean; generation?: unknown; error?: string }> {
    try {
      const id = (body?.id ?? "").trim();
      if (!id) return { ok: false, error: "缺少 id" };
      const generation = await this.promptService.activateGeneration(id);
      return { ok: true, generation };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * 场景库标签抽样(M6.6/M6.7/M6.9):产出标签、2:1 切分和覆盖体检。
   * 注意:这里只产 ScenarioTags,完整 Scenario 仍需作者补 roster/seed_history/台词。
   */
  @Post("scenario-bank/sample")
  sampleScenarioBank(
    @Body() body?: { n?: number; seed?: number; holdout_ratio?: number },
  ): { ok: boolean; tags: unknown[]; split: unknown; coverage: unknown; drift: unknown } {
    const n = Math.max(1, Math.min(500, Math.floor(Number(body?.n) || 120)));
    const seed = Math.floor(Number(body?.seed) || 20260630);
    const holdoutRatio = Number.isFinite(Number(body?.holdout_ratio))
      ? Math.max(0, Math.min(0.8, Number(body?.holdout_ratio)))
      : 1 / 3;
    const tags = sampleScenarioTags(n, seed);
    const split = splitOptimizeHoldout(tags, holdoutRatio, seed);
    return {
      ok: true,
      tags,
      split,
      coverage: computeCoverage(tags),
      drift: {
        probe_type: distributionDrift(split, (t) => t.probe_type),
        social_situation: distributionDrift(split, (t) => t.social_situation),
      },
    };
  }

  /**
   * 真人失败回灌转换(M6.10):调用方传已采集/定位的真人失败观测,返回 probe/stub/ledger 产物。
   */
  @Post("scenario-bank/backfill")
  backfillScenarioBank(
    @Body() body?: { observations?: HumanFailureObservation[] },
  ): { ok: boolean; products?: unknown[]; error?: string } {
    const observations = Array.isArray(body?.observations) ? body.observations : [];
    if (observations.length === 0) return { ok: false, error: "缺少 observations" };
    return { ok: true, products: runBackfill(observations) };
  }

  /** 读已落库的 ScoreRecord(编排器打分详情回看用)。 */
  @Get("score/:matchId")
  async storedScore(
    @Param("matchId") matchId: string,
  ): Promise<{ ok: boolean; score?: ScoreRecord; error?: string }> {
    const score = await this.scoreService.loadStoredScore(matchId);
    return score ? { ok: true, score } : { ok: false, error: "未找到该局的打分记录" };
  }

  /**
   * free 模式旁路探索(M5.13)的挖掘入口:
   * 调用方传一批已诊断 ScoreRecord 的 match_id,从 failure_cases 里挖高可疑候选。
   * backfill=true 时顺手跑 M6.10 转换链,产出场景 stub / probe 模板 / 台账条目。
   */
  @Post("free-explore/mine")
  async mineFreeExplore(
    @Body()
    body: {
      match_ids?: string[];
      min_margin?: number;
      min_delta?: number;
      backfill?: boolean;
    },
  ): Promise<{ ok: boolean; candidates?: unknown[]; products?: unknown[]; missing?: string[]; error?: string }> {
    const ids = Array.isArray(body?.match_ids) ? body.match_ids.map((id) => String(id).trim()).filter(Boolean) : [];
    if (ids.length === 0) return { ok: false, error: "缺少 match_ids" };
    const scores: ScoreRecord[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      const score = await this.scoreService.loadStoredScore(id);
      if (score) scores.push(score);
      else missing.push(id);
    }
    const candidates = mineFailureCandidates(scores, {
      minMargin: body?.min_margin,
      minDelta: body?.min_delta,
    });
    return {
      ok: true,
      candidates,
      products: body?.backfill === true ? runBackfill(candidates) : undefined,
      missing,
    };
  }

  @Post("prepare")
  async prepare(
    @Body()
    body?: Partial<Scenario> & { run_config?: RunConfig; scenario_id?: string },
  ): Promise<{ ok: boolean; roomId?: string; error?: string }> {
    try {
      const { run_config, scenario_id, ...rest } = body ?? {};
      let scenario: Scenario | undefined;
      if (Array.isArray(rest.roster) && rest.roster.length > 0) {
        scenario = rest as Scenario;
      } else if (scenario_id) {
        scenario = this.sandbox.loadExampleScenario(scenario_id) ?? undefined;
      }
      const result = await this.sandbox.prepare(scenario, run_config ?? {});
      return { ok: true, roomId: result.roomId };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  @Get(":roomId/config")
  async config(
    @Param("roomId") roomId: string,
  ): Promise<{ ok: boolean; config?: SandboxConfig; error?: string }> {
    try {
      const config = await this.sandbox.getConfig(roomId);
      return { ok: true, config };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  @Post("start")
  async start(
    @Body() body: { roomId?: string },
  ): Promise<{ ok: boolean; roomId?: string; error?: string }> {
    try {
      const roomId = (body?.roomId ?? "").trim();
      if (!roomId) {
        return { ok: false, error: "缺少 roomId" };
      }
      const result = await this.sandbox.start(roomId);
      return { ok: true, roomId: result.roomId };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  @Post("score")
  async score(
    @Body()
    body: {
      match_id?: string;
      judge_model_id?: string;
      judge_model_ids?: string[] | string;
      diagnose?: boolean;
    },
  ): Promise<{ ok: boolean; score?: ScoreRecord; error?: string }> {
    try {
      const matchId = (body?.match_id ?? "").trim();
      if (!matchId) {
        return { ok: false, error: "缺少 match_id" };
      }
      const score = await this.scoreService.scoreStoredMatch(matchId, {
        judgeModelId: body.judge_model_id,
        judgeModelIds: parseModelIds(body.judge_model_ids),
        diagnose: body.diagnose === true,
      });
      return { ok: true, score };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

function parseModelIds(value: string[] | string | undefined): string[] | undefined {
  if (Array.isArray(value)) {
    const ids = value.map((v) => String(v).trim()).filter(Boolean);
    return ids.length > 0 ? ids : undefined;
  }
  if (typeof value !== "string") return undefined;
  const ids = value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  return ids.length > 0 ? ids : undefined;
}
