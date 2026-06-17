import { Body, Controller, Delete, Get, Param, Post } from "@nestjs/common";
import { DEBUG } from "../game/game.config";
import {
  ALL_ASSET_KEYS,
  PromptRegistry,
} from "./prompt-registry";

/**
 * DEBUG 网关:AI 提示词版本库管理。
 * 列出 / 派生 / 激活(回滚)/ 打分 —— 供 eval 闭环脚本与人工迭代使用。
 * 仅在 DEBUG=true 时可用,与 replay-debug 同样的门控方式。
 */
@Controller("debug/prompts")
export class PromptVersionController {
  constructor(private readonly registry: PromptRegistry) {}

  private gate(): { ok: false; error: string } | null {
    return DEBUG ? null : { ok: false, error: "调试模式未开启" };
  }

  /** 列出全部代(父子关系 + 状态 + 分数)。 */
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

  /** 取某一代的全部 asset 正文 + 解析后的人格库。 */
  @Get("generations/:id")
  async getGeneration(@Param("id") id: string) {
    if (this.gate()) return this.gate();
    const assets = await this.registry.getGenerationAssets(id);
    return { ok: true, generation: assets };
  }

  /** 取某 asset 某版本的原始正文。 */
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

  /**
   * 从来源代派生新代:把 changedAssets 里的每个 asset 写一个新版本,
   * 其余继承。changedAssets: { "<asset_key>": "<正文, personas 为 JSON 字符串>" }
   */
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

  /** 激活(或回滚到)指定代。 */
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

  /** 标记某代为历史最佳(回滚目标)。 */
  @Post("best")
  async markBest(@Body() body: { generationId?: string }) {
    if (this.gate()) return this.gate();
    if (!body?.generationId) return { ok: false, error: "缺少 generationId" };
    try {
      await this.registry.markBest(body.generationId);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 删除某代:存在子代则拒绝;若删除的是 active 代,先回退到其父代。
   */
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

  /** 回写某代的评估分数。 */
  @Post("score")
  async writeScore(
    @Body() body: { generationId?: string; score?: unknown },
  ) {
    if (this.gate()) return this.gate();
    if (!body?.generationId) return { ok: false, error: "缺少 generationId" };
    await this.registry.writeScore(body.generationId, body.score ?? null);
    return { ok: true };
  }

  /** 列出受版本管理的 asset key(便于工具枚举)。 */
  @Get("assets")
  getAssetKeys() {
    if (this.gate()) return this.gate();
    return { ok: true, keys: ALL_ASSET_KEYS };
  }

  /**
   * 把 src/ai/prompts/ 本地源文件内容同步进种子版本(仅种子版本,就地 UPDATE DB)。
   * personas 无对应文件,会出现在 skipped 里。
   */
  @Post("generation/:id/sync-from-files")
  async syncFromFiles(@Param("id") id: string) {
    if (this.gate()) return this.gate();
    try {
      const { updated, unchanged, skipped } =
        await this.registry.syncFilesToGeneration(id);
      return { ok: true, generationId: id, updated, unchanged, skipped };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
