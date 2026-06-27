// M5.8 GenerationEval 记录:每代一条,接受/拒绝依据。对齐《编排器 §11》。

import type { GateDecision } from "./gate";
import type { ValidationReport } from "../aggregate/validation";

export interface ChildEval {
  child_id: string;
  based_on: string;
  hypothesis?: string;
  target_dimension?: string;
  edit_type?: string;
  validation: ValidationReport;
  gate: GateDecision;
  /** 实际落定结果(promoted/rejected;confirm 模式下人可能覆盖 gate 建议)。 */
  decision: "promoted" | "rejected";
}

export interface GenerationEval {
  generation_id: string; // gen_<generation>_<child_id>,同时是落盘文件名
  generation: number;
  eval_set_version: string;
  mode: string; // MVP: scripted_intent
  champion_before: string;
  children_evaluated: ChildEval[];
  champion_after: string;
  population_after: string[];
  tried_and_rejected_added: string[];
  timestamp: string;
}
