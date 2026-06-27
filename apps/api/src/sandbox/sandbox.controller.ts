import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import type { SandboxConfig } from "./sandbox.service";
import { SandboxService } from "./sandbox.service";
import { ScoreService } from "./score/score.service";
import type { ScoreRecord } from "./score/types";
import type { RunConfig, Scenario } from "./scenario/types";

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
  ) {}

  @Get("examples")
  examples(): { ok: boolean; examples: Array<{ id: string; label: string; form: string }> } {
    return { ok: true, examples: this.sandbox.getExampleList() };
  }

  /** 读已落盘的 ScoreRecord(编排器打分详情回看用)。 */
  @Get("score/:matchId")
  storedScore(
    @Param("matchId") matchId: string,
  ): { ok: boolean; score?: ScoreRecord; error?: string } {
    const score = this.scoreService.loadStoredScore(matchId);
    return score ? { ok: true, score } : { ok: false, error: "未找到该局的打分记录" };
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
    @Body() body: { match_id?: string; judge_model_id?: string },
  ): Promise<{ ok: boolean; score?: ScoreRecord; error?: string }> {
    try {
      const matchId = (body?.match_id ?? "").trim();
      if (!matchId) {
        return { ok: false, error: "缺少 match_id" };
      }
      const score = await this.scoreService.scoreStoredMatch(matchId, {
        judgeModelId: body.judge_model_id,
      });
      return { ok: true, score };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
