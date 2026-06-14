import { Controller, Get, Param } from "@nestjs/common";
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

  /** 返回冻结打分尺子(打分的 system prompt),供前端展示打分输入。 */
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
}
