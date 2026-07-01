import { Controller, Get, Query } from "@nestjs/common";
import { LlmStatsService, type LlmStatsView } from "./llm-stats.service";

@Controller("llm")
export class LlmStatsController {
  constructor(private readonly llmStats: LlmStatsService) {}

  @Get("stats")
  async stats(
    @Query("days") days?: string,
    @Query("model") model?: string,
    @Query("source") source?: string,
  ): Promise<{ ok: true; stats: LlmStatsView }> {
    const parsedDays = Number(days);
    return {
      ok: true,
      stats: await this.llmStats.getStats({
        days: Number.isFinite(parsedDays) ? parsedDays : undefined,
        model,
        source,
      }),
    };
  }
}
