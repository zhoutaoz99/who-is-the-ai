// M2.7 诊断评分(八维量表 + 失败案例)+ M2.9 judge_eval_needed 探测裁定。
// 告知裁判哪个是 AI(像法医,与盲测相反),按《诊断评分》提示词产:
//   - rubric 八维(诊断信号,仅排序/看板,不进接受闸门);
//   - probe_verdicts:对 auto_check=null 的探测按 pass_if 文本裁定(M2.9);
//   - failure_cases:FOCUS_ROUND 内最拉高怀疑的 1–2 句(喂优化器)。
// 探测判定归属(《裁判》§5):auto_check!=null 的以引擎 auto_eval 为准,裁判只判 judge_eval_needed 的。

import { Injectable, Logger } from "@nestjs/common";
import { AiService } from "../../ai/ai.service";
import { loadPrompt, renderTemplate } from "../../ai/prompt-loader";
import { loadDefaultProbeBank } from "../probe/probe-bank";
import type { MatchRecord } from "../match-record/types";
import { parseJsonObject } from "../shared/json-parse";
import { buildLabeledTranscript } from "./anonymize";
import type { AnonymizedView } from "./anonymize";
import { RUBRIC_KEYS, type FailureCase, type ProbeVerdict } from "./types";

const JUDGE_TEMPERATURE = 0.2;
const MAX_RETRIES = 2;

export interface DiagnosticResult {
  rubric: Record<string, number>;
  probe_verdicts: ProbeVerdict[];
  failure_cases: FailureCase[];
  humanness_composite: number;
  /** 诊断侧 出戏=1 → 近否决(与引擎 veto OR;引擎判定为准时引擎优先)。 */
  vetoFromRubric: boolean;
  judgeModel: string;
  ok: boolean;
}

@Injectable()
export class RubricDiagnosticScorer {
  private readonly logger = new Logger(RubricDiagnosticScorer.name);

  constructor(private readonly ai: AiService) {}

  /**
   * @param view 复用盲测同款打乱标签(保证标签一致);本遍【告知】AI 标签。
   * @param focusRound 失败定位轮(来自 M2.6 轨迹);null → "整局"。
   */
  async run(
    match: MatchRecord,
    view: AnonymizedView,
    focusRound: number | null,
    judgeModelId?: string,
  ): Promise<DiagnosticResult> {
    const probes = buildJudgeEvalProbes(match);
    const system = loadPrompt("sandbox/judge/rubric-diagnostic-system.txt");
    const user = renderTemplate("sandbox/judge/rubric-diagnostic-user.txt", {
      ai_player_label: view.aiLabel,
      room_context: roomContext(match),
      focus_round: focusRound != null ? `第 ${focusRound} 轮` : "整局",
      full_transcript: buildLabeledTranscript(match, view.labelOf),
      judge_eval_probes:
        probes.length > 0 ? JSON.stringify(probes, null, 2) : "无(本局没有待裁定探测)",
    });

    const { mainConfig, connection } = this.ai.resolveCallConfig(judgeModelId);
    const modelConfig = { ...mainConfig, temperature: JUDGE_TEMPERATURE };
    const validIds = new Set(probes.map((p) => p.probe_id));

    let parsed: ParsedDiagnostic | null = null;
    let lastError = "";
    for (let attempt = 0; attempt <= MAX_RETRIES && !parsed; attempt += 1) {
      try {
        const { content } = await this.ai.callModel(system, user, modelConfig, connection);
        parsed = parseDiagnostic(content, validIds);
        if (!parsed) lastError = "parse_failed";
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    if (!parsed) {
      this.logger.warn(`诊断评分失败 match=${match.match_id}: ${lastError}`);
      return {
        rubric: {},
        probe_verdicts: [],
        failure_cases: [],
        humanness_composite: 0,
        vetoFromRubric: false,
        judgeModel: modelConfig.model,
        ok: false,
      };
    }

    // 给裁判裁定补 type(从 probe 列表回填,便于按 probe_type 聚合)。
    const typeOf = new Map(probes.map((p) => [p.probe_id, p.type]));
    const verdicts: ProbeVerdict[] = parsed.probe_verdicts.map((v) => ({
      ...v,
      type: typeOf.get(v.probe_id) ?? "",
    }));

    return {
      rubric: parsed.rubric,
      probe_verdicts: verdicts,
      failure_cases: parsed.failure_cases,
      humanness_composite: humannessComposite(parsed.rubric),
      vetoFromRubric: (parsed.rubric["出戏"] ?? 0) >= 1,
      judgeModel: modelConfig.model,
      ok: true,
    };
  }
}

interface ParsedDiagnostic {
  rubric: Record<string, number>;
  probe_verdicts: Array<{ probe_id: string; result: "pass" | "fail"; reason: string }>;
  failure_cases: FailureCase[];
}

/** 解析诊断 JSON(纯函数,便于单测):校验 rubric 八维齐全、probe_id 合法、failure_cases 结构。 */
export function parseDiagnostic(
  raw: string,
  validProbeIds: Set<string>,
): ParsedDiagnostic | null {
  const obj = parseJsonObject<{
    rubric?: unknown;
    probe_verdicts?: unknown;
    failure_cases?: unknown;
  }>(raw);
  if (!obj || typeof obj.rubric !== "object" || obj.rubric == null) return null;

  // rubric:八维必须齐全且为数字。
  const rawRubric = obj.rubric as Record<string, unknown>;
  const rubric: Record<string, number> = {};
  for (const key of RUBRIC_KEYS) {
    const v = Number(rawRubric[key]);
    if (Number.isNaN(v)) return null;
    rubric[key] = v;
  }

  // probe_verdicts:丢弃陌生 probe_id;result 规整为 pass|fail。
  const verdicts: ParsedDiagnostic["probe_verdicts"] = [];
  if (Array.isArray(obj.probe_verdicts)) {
    for (const item of obj.probe_verdicts) {
      if (!item || typeof item !== "object") continue;
      const r = item as Record<string, unknown>;
      const id = typeof r.probe_id === "string" ? r.probe_id : "";
      if (!validProbeIds.has(id)) continue;
      const result = r.result === "fail" ? "fail" : "pass";
      verdicts.push({ probe_id: id, result, reason: typeof r.reason === "string" ? r.reason : "" });
    }
  }

  // failure_cases:允许空数组;逐条规整。
  const cases: FailureCase[] = [];
  if (Array.isArray(obj.failure_cases)) {
    for (const item of obj.failure_cases) {
      if (!item || typeof item !== "object") continue;
      const r = item as Record<string, unknown>;
      const utterance = typeof r.utterance === "string" ? r.utterance : "";
      if (!utterance) continue;
      cases.push({
        round: Number(r.round) || 0,
        utterance,
        tell: typeof r.tell === "string" ? r.tell : "",
        note: typeof r.note === "string" ? r.note : "",
        blind_suspicion_delta: Number(r.blind_suspicion_delta) || 0,
        probe_ref: typeof r.probe_ref === "string" ? r.probe_ref : undefined,
      });
    }
  }

  return { rubric, probe_verdicts: verdicts, failure_cases: cases };
}

/** 待裁定探测列表(M2.9):只取 judge_eval_needed=true 的,补 pass_if(probe bank)+ ai_response(转录)。 */
export function buildJudgeEvalProbes(match: MatchRecord): Array<{
  probe_id: string;
  type: string;
  delivered_text: string;
  ai_response: string;
  pass_if: string;
}> {
  const bank = loadDefaultProbeBank();
  const passIfOf = new Map(bank.probes.map((p) => [p.probe_id, p.pass_if] as const));
  const out: Array<{
    probe_id: string;
    type: string;
    delivered_text: string;
    ai_response: string;
    pass_if: string;
  }> = [];
  for (const pe of match.probe_events) {
    if (!pe.judge_eval_needed) continue; // 有 auto_eval 的不重判
    const resp =
      pe.ai_response_idx != null ? match.transcript[pe.ai_response_idx]?.text ?? "" : "";
    out.push({
      probe_id: pe.probe_ref,
      type: pe.type,
      delivered_text: pe.delivered_text,
      ai_response: resp,
      pass_if: passIfOf.get(pe.probe_ref) ?? "(未找到 pass_if)",
    });
  }
  return out;
}

/**
 * M2.9 把裁判 probe 裁定并入 probe_pass_by_type(纯函数)。
 * 遍历全部 probe_events 按 type 聚合:有 auto_eval 以引擎为准;否则取裁判裁定(按 probe_id 匹配);
 * 两者皆无则该事件不计入(undetermined)。返回新的 probe_pass_by_type(覆盖纯 auto 版本)。
 */
export function mergeProbePassByType(
  match: MatchRecord,
  verdicts: ProbeVerdict[],
): Record<string, number> {
  const verdictOf = new Map(verdicts.map((v) => [v.probe_id, v.result] as const));
  const byType = new Map<string, { pass: number; total: number }>();
  for (const pe of match.probe_events) {
    let result: "pass" | "fail" | null = null;
    if (pe.auto_eval) result = pe.auto_eval.result; // 引擎优先
    else if (verdictOf.has(pe.probe_ref)) result = verdictOf.get(pe.probe_ref)!;
    if (result == null) continue; // 未判定,不入(None≠0)
    const s = byType.get(pe.type) ?? { pass: 0, total: 0 };
    s.total += 1;
    if (result === "pass") s.pass += 1;
    byType.set(pe.type, s);
  }
  const out: Record<string, number> = {};
  for (const [type, s] of byType) out[type] = s.total > 0 ? s.pass / s.total : 0;
  return out;
}

/**
 * 人味分(humanness_composite,仅看板趋势,非决策)。把八维各折算成 1–5 的"像真人"贡献再取均。
 * 越低越好的维度反向、计数维度截断、存在感取"离 3 越近越好"、出戏=1 直接压到 1。
 */
export function humannessComposite(rubric: Record<string, number>): number {
  const clamp = (n: number) => Math.max(1, Math.min(5, n));
  const g = (k: string) => Number(rubric[k]) || 0;
  const parts = [
    6 - g("客服感"), // 1-5 越低越好 → 反向
    clamp(5 - g("结构化指纹")), // 次数,0 最佳
    clamp(5 - g("能力暴露") * 2), // 次数,重罚
    g("立场情绪"), // 越高越好
    g("博弈参与"), // 越高越好
    g("出戏") >= 1 ? 1 : 5, // 破角色直接压低
    g("语言质感"), // 越高越好
    clamp(5 - Math.abs(g("存在感") - 3) * 2), // 3 最佳
  ].map(clamp);
  const avg = parts.reduce((a, b) => a + b, 0) / parts.length;
  return Math.round(avg * 100) / 100;
}

function roomContext(match: MatchRecord): string {
  const n = Object.keys(match.personas).length;
  return `${n} 人局 · ${match.scenario_form}`;
}
