import { Controller, Get, Param, Query } from "@nestjs/common";
import { DEBUG } from "../game/game.config";
import { IterationService } from "./iteration.service";

/**
 * 迭代 run 的 HTTP 兜底接口(首屏加载 / 断线重连)。
 * 实时进度走 socket iteration.* 事件;这里只给当前/最近 run 的快照。
 */
@Controller("debug/iterations")
export class IterationController {
  constructor(private readonly iterationService: IterationService) {}

  @Get()
  async getStatus() {
    if (!DEBUG) return { ok: false, error: "调试模式未开启" };
    return this.iterationService.getStatus();
  }

  /** 估算一次迭代的预计用时(秒),供前端参数面板随参数变化动态提示。 */
  @Get("estimate")
  async estimate(
    @Query("rounds") rounds?: string,
    @Query("gamesPerRound") gamesPerRound?: string,
    @Query("discussionSeconds") discussionSeconds?: string,
    @Query("postRoundMode") postRoundMode?: string,
    @Query("sequentialSpeech") sequentialSpeech?: string,
  ) {
    if (!DEBUG) return { ok: false, error: "调试模式未开启" };
    return this.iterationService.estimateIteration({
      rounds: Number(rounds),
      gamesPerRound: Number(gamesPerRound),
      discussionSeconds: Number(discussionSeconds),
      postRoundMode,
      sequentialSpeech: sequentialSpeech === "true",
    });
  }

  /** 返回当前激活的打分尺子(system prompt),供前端展示打分输入。 */
  @Get("scorer-prompt")
  async getScorerPrompt() {
    if (!DEBUG) return { ok: false, error: "调试模式未开启" };
    try {
      return { ok: true, prompt: this.iterationService.getScorerPrompt() };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** 返回打分模型调用配置(不含 apiKey),供前端拼装完整请求 JSON。 */
  @Get("score-model")
  async getScoreModel() {
    if (!DEBUG) return { ok: false, error: "调试模式未开启" };
    try {
      return { ok: true, config: this.iterationService.getScoreModelConfig() };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** 重建某局打分的完整请求(system + user + config),如实展示发往大模型的输入。 */
  @Get("score-request/:roomId")
  async getScoreRequest(@Param("roomId") roomId: string) {
    if (!DEBUG) return { ok: false, error: "调试模式未开启" };
    try {
      return await this.iterationService.getScoreRequest(roomId);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** 重建某轮自动优化的完整请求(优化器 system + user + config),如实展示生成过程输入。 */
  @Get("auto-optimize-request/:runId/:roundNo")
  async getAutoOptimizeRequest(
    @Param("runId") runId: string,
    @Param("roundNo") roundNo: string,
  ) {
    if (!DEBUG) return { ok: false, error: "调试模式未开启" };
    const round = Number(roundNo);
    if (!Number.isFinite(round)) return { ok: false, error: "无效的轮次" };
    try {
      return await this.iterationService.getAutoOptimizeRequest(runId, round);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
