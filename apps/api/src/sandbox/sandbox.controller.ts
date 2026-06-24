import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import type { SandboxConfig } from "./sandbox.service";
import { SandboxService } from "./sandbox.service";
import type { RunConfig, Scenario } from "./scenario/types";

/**
 * 离线沙盒 REST 接口:
 * - POST /sandbox/prepare  建等待房(可带 scenario,缺省用示例),返回 roomId
 * - GET  /sandbox/:roomId/config  取场景静态配置(前台配置页用)
 * - POST /sandbox/start     开局(后台跑到终局并落盘 MatchRecord)
 */
@Controller("sandbox")
export class SandboxController {
  constructor(private readonly sandbox: SandboxService) {}

  @Post("prepare")
  async prepare(
    @Body() body?: Partial<Scenario> & { run_config?: RunConfig },
  ): Promise<{ ok: boolean; roomId?: string; error?: string }> {
    try {
      const { run_config, ...rest } = body ?? {};
      const hasScenario = Array.isArray(rest.roster) && rest.roster.length > 0;
      const result = await this.sandbox.prepare(
        hasScenario ? (rest as Scenario) : undefined,
        run_config ?? {},
      );
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
}
