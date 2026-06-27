// M4.3 单候选调用 propose_one:渲染优化器提示词 → callModel(中温度)→ 解析 {child} → PromptVersion。
// 一次调用只产 1 个候选;K 个候选靠外层 K 次调用 + 不同靶子(Phase 3,M4.7)。
// 依据《优化器模块·方案设计》§9/§3。

import { Injectable, Logger } from "@nestjs/common";
import { AiService } from "../../ai/ai.service";
import { loadPrompt, renderTemplate } from "../../ai/prompt-loader";
import { parseJsonObject } from "../shared/json-parse";
import type { PromptVersion } from "../orchestrator/prompt-version";
import type { OptimizerInput } from "./input";

/** 优化器采样温度:单候选内求质量,跨调用靠靶子求多样(§13)。 */
const OPTIMIZER_TEMPERATURE = 0.8;
const MAX_RETRIES = 2;

const EDIT_TYPES = [
  "add_negative_constraint",
  "add_fewshot",
  "remove_tell_inducer",
  "reword_persona",
  "strengthen_or_reorder",
  "generalize_to_reflex",
  "consolidate",
] as const;

interface ChildOutput {
  child?: {
    child_id?: string;
    based_on?: string;
    target?: string;
    edit_type?: string;
    placement?: string;
    hypothesis?: string;
    prompt_text?: string;
    diff_summary?: string;
  };
}

export interface Proposal {
  child: PromptVersion;
}

@Injectable()
export class OptimizerService {
  private readonly logger = new Logger(OptimizerService.name);

  constructor(private readonly ai: AiService) {}

  /** 产 1 个候选子版本;解析/调用失败返回 null。 */
  async propose(
    input: OptimizerInput,
    opts: { basedOn: string; optimizerModelId?: string },
  ): Promise<Proposal | null> {
    const system = loadPrompt("sandbox/optimizer/system-prompt-optimizer.txt");
    const user = renderTemplate("sandbox/optimizer/user-prompt-optimizer-template.txt", {
      assigned_target: input.assigned_target || "(由你判断当前最该修的破绽)",
      assigned_edit_type: input.assigned_edit_type || "(自选)",
      persona_scope: input.persona_scope,
      current_prompt: input.current_version.prompt_text,
      locked_sections: input.locked_sections.join("\n"),
      weak_dimensions: JSON.stringify(input.weak_dimensions, null, 2),
      failure_clusters:
        input.failure_clusters.length > 0
          ? JSON.stringify(input.failure_clusters, null, 2)
          : "(暂无)",
      tried_and_rejected:
        input.tried_and_rejected.length > 0
          ? JSON.stringify(input.tried_and_rejected, null, 2)
          : "(暂无)",
      length_budget: input.length_budget,
    });

    const { mainConfig, connection } = this.ai.resolveCallConfig(opts.optimizerModelId);
    const modelConfig = { ...mainConfig, temperature: OPTIMIZER_TEMPERATURE };

    let parsed: ChildOutput | null = null;
    let lastError = "";
    for (let attempt = 0; attempt <= MAX_RETRIES && !parsed; attempt += 1) {
      try {
        const { content } = await this.ai.callModel(system, user, modelConfig, connection);
        parsed = parseChild(content);
        if (!parsed) lastError = "parse_failed";
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    if (!parsed?.child || !parsed.child.prompt_text) {
      this.logger.warn(`优化器未产出可用候选(basedOn=${opts.basedOn}): ${lastError}`);
      return null;
    }
    const c = parsed.child;
    const editType = EDIT_TYPES.includes(c.edit_type as (typeof EDIT_TYPES)[number])
      ? c.edit_type!
      : "strengthen_or_reorder";

    const child: PromptVersion = {
      version_id: `${opts.basedOn}--${editType}--${shortId()}`,
      parent_id: opts.basedOn,
      prompt_text: c.prompt_text!,
      persona_scope: "shared",
      status: "candidate",
      hypothesis: c.hypothesis,
      target_dimension: c.target || input.assigned_target,
      edit_type: editType,
      created_at: new Date().toISOString(),
    };
    return { child };
  }
}

function parseChild(raw: string): ChildOutput | null {
  const obj = parseJsonObject<{ child?: unknown }>(raw);
  if (!obj || !obj.child || typeof obj.child !== "object") return null;
  return { child: obj.child as ChildOutput["child"] };
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 8);
}
