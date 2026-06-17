import { Body, Controller, Delete, Get, Param, Post } from "@nestjs/common";
import { DEBUG } from "../game/game.config";
import {
  EVAL_PROMPT_ASSET_KEYS,
  EvalPromptRegistry,
} from "./eval-prompt-registry";

/**
 * DEBUG 网关:评估尺子版本库管理。
 * 仅支持人工手动修改/派生/激活,不参与自动优化闭环。
 */
@Controller("debug/eval-prompts")
export class EvalPromptVersionController {
  constructor(private readonly registry: EvalPromptRegistry) {}

  private gate(): { ok: false; error: string } | null {
    return DEBUG ? null : { ok: false, error: "调试模式未开启" };
  }

  @Get("generations")
  async listGenerations() {
    if (this.gate()) return this.gate();
    const generations = await this.registry.listGenerations();
    return {
      ok: true,
      active: this.registry.getActiveGenerationId(),
      generations,
    };
  }

  @Get("generations/:id")
  async getGeneration(@Param("id") id: string) {
    if (this.gate()) return this.gate();
    const assets = await this.registry.getGenerationAssets(id);
    return { ok: true, generation: assets };
  }

  @Get("asset/:key/:version")
  async getAsset(
    @Param("key") key: string,
    @Param("version") version: string,
  ) {
    if (this.gate()) return this.gate();
    const content = await this.registry.readAssetContent(
      decodeURIComponent(key),
      Number(version),
    );
    if (content === null) return { ok: false, error: "未找到该 asset 版本" };
    return { ok: true, key, version: Number(version), content };
  }

  @Post("generation")
  async createGeneration(
    @Body()
    body: {
      fromGenId?: string;
      changedAssets: Record<string, string>;
      note?: string;
    },
  ) {
    if (this.gate()) return this.gate();
    try {
      const generation = await this.registry.createGeneration({
        fromGenId: body?.fromGenId,
        changedAssets: body?.changedAssets ?? {},
        note: body?.note,
      });
      return { ok: true, generation };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  @Post("active")
  async setActive(@Body() body: { generationId?: string }) {
    if (this.gate()) return this.gate();
    if (!body?.generationId) return { ok: false, error: "缺少 generationId" };
    try {
      await this.registry.setActive(body.generationId);
      return { ok: true, active: this.registry.getActiveGenerationId() };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  @Delete("generation/:id")
  async deleteGeneration(@Param("id") id: string) {
    if (this.gate()) return this.gate();
    try {
      await this.registry.deleteGeneration(id);
      return { ok: true, active: this.registry.getActiveGenerationId() };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  @Get("assets")
  getAssetKeys() {
    if (this.gate()) return this.gate();
    return { ok: true, keys: EVAL_PROMPT_ASSET_KEYS };
  }

  /**
   * 把 eval/prompts/ 本地文件内容同步进种子版本(仅种子版本,就地 UPDATE DB)。
   * 返回更新 / 未变化的 asset key。
   */
  @Post("generation/:id/sync-from-files")
  async syncFromFiles(@Param("id") id: string) {
    if (this.gate()) return this.gate();
    try {
      const { updated, unchanged } =
        await this.registry.syncFilesToGeneration(id);
      return { ok: true, generationId: id, updated, unchanged };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
