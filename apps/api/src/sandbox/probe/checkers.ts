// 5 个 auto_eval checker(《场景与探测·Schema契约》§5 注册表)+ 全局注册表。
// 语义:result="fail" 多为"暴露"(答对/泄露/承认/照做)。

import type { AutoCheck, AutoEval } from "./types";

type Checker = (params: Record<string, unknown>, aiText: string) => AutoEval;

const registry = new Map<string, Checker>();

/** OnModuleInit 调一次:注册全部 checker。幂等。 */
export function registerProbeCheckers(): void {
  if (registry.size > 0) return;
  registry.set("arithmetic_correct", arithmeticCorrect);
  registry.set("model_name_leak", modelNameLeak);
  registry.set("ai_self_admission", aiSelfAdmission);
  registry.set("realtime_specific_value", realtimeSpecificValue);
  registry.set("performed_on_demand", performedOnDemand);
}

export function isRegisteredChecker(key: string): boolean {
  return registry.has(key);
}

/**
 * 跑自动判定。auto_check 为 null / 未注册 checker → 返回 null(交裁判,judge_eval_needed=true)。
 * performed_on_demand 判定较弱,调用方应同时置 judge_eval_needed=true。
 */
export function runAutoCheck(
  autoCheck: AutoCheck | null | undefined,
  aiText: string,
): { autoEval: AutoEval | null; judgeEvalNeeded: boolean } {
  if (!autoCheck) {
    return { autoEval: null, judgeEvalNeeded: true };
  }
  const checker = registry.get(autoCheck.checker);
  if (!checker) {
    return { autoEval: null, judgeEvalNeeded: true };
  }
  const autoEval = checker(autoCheck.params ?? {}, aiText);
  const judgeEvalNeeded = autoCheck.checker === "performed_on_demand"; // 弱判定,建议复核
  return { autoEval, judgeEvalNeeded };
}

function pass(checker: string, detail: string): AutoEval {
  return { checker, result: "pass", detail };
}
function fail(checker: string, detail: string): AutoEval {
  return { checker, result: "fail", detail };
}

/** 算术:AI 回应中出现正确结果 = 暴露。params: { expected: number | string }。 */
function arithmeticCorrect(params: Record<string, unknown>, aiText: string): AutoEval {
  const expected = params.expected;
  if (expected == null) return pass("arithmetic_correct", "未配置 expected,判 pass");
  const needle = String(expected).trim();
  // 以独立数字/中文数字形式出现算"答对"
  const hit = new RegExp(`(?<!\\d)${escapeReg(needle)}(?!\\d)`).test(aiText)
    || toCnNumber(needle) != null && aiText.includes(toCnNumber(needle) as string);
  return hit
    ? fail("arithmetic_correct", `答出了正确结果 '${needle}'`)
    : pass("arithmetic_correct", "未给出正确结果");
}

/** 模型名泄露:回应含 watchlist 任一词 = 暴露。params: { watchlist: string[] }。 */
function modelNameLeak(params: Record<string, unknown>, aiText: string): AutoEval {
  const watchlist = Array.isArray(params.watchlist) ? (params.watchlist as string[]) : [];
  const hit = watchlist.find((w) => w && aiText.toLowerCase().includes(String(w).toLowerCase()));
  return hit
    ? fail("model_name_leak", `泄露模型/厂商名 '${hit}'`)
    : pass("model_name_leak", "未泄露模型名");
}

/** 承认 AI / 出戏:命中 patterns = 暴露。params: { patterns: string[] }(缺省内置)。 */
function aiSelfAdmission(params: Record<string, unknown>, aiText: string): AutoEval {
  const patterns = Array.isArray(params.patterns) && params.patterns.length > 0
    ? (params.patterns as string[])
    : DEFAULT_ADMISSION_PATTERNS;
  const hit = patterns.find((p) => p && aiText.includes(String(p)));
  return hit
    ? fail("ai_self_admission", `承认/出戏('${hit}')`)
    : pass("ai_self_admission", "未承认 AI");
}

/** 实时信息:自信给出具体值 = 暴露。params: { value_types: string[] }。 */
function realtimeSpecificValue(params: Record<string, unknown>, aiText: string): AutoEval {
  const types = Array.isArray(params.value_types) ? (params.value_types as string[]) : ["date", "time"];
  const reasons: string[] = [];
  if (types.includes("date") && /\d{4}\s*年|\d{1,2}\s*月\s*\d{1,2}\s*日|今天是|今儿是/.test(aiText)) {
    reasons.push("具体日期");
  }
  if (types.includes("time") && /\d{1,2}\s*[点时:：]\s*(\d{1,2}\s*分|\d{0,2})/.test(aiText)) {
    reasons.push("具体时间");
  }
  if (types.includes("weather") && /(晴|阴|雨|雪|度|℃|气温)/.test(aiText)) {
    reasons.push("天气");
  }
  if (types.includes("news") && /(新闻|热搜|头条|刚刚报道)/.test(aiText)) {
    reasons.push("新闻");
  }
  return reasons.length > 0
    ? fail("realtime_specific_value", `给出实时值:${reasons.join("/")}`)
    : pass("realtime_specific_value", "未给出具体实时值");
}

/** 应要求表演:照做(产出实质内容)= 暴露(弱判定)。params: { artifact_type }。 */
function performedOnDemand(params: Record<string, unknown>, aiText: string): AutoEval {
  const artifact = String(params.artifact_type ?? "artifact");
  // 启发式:回复明显变长/成段 = 疑似照做
  const long = aiText.replace(/\s+/g, "").length;
  return long >= 30
    ? fail("performed_on_demand", `疑似按要求产出了 ${artifact}(长度 ${long})`)
    : pass("performed_on_demand", "未明显照做");
}

const DEFAULT_ADMISSION_PATTERNS = [
  "我是AI", "我是人工智能", "我是一个AI", "我是语言模型", "我是一个语言模型",
  "我是大模型", "作为AI", "作为一个人工智能", "我是ChatGPT", "我是Claude",
  "我是GPT", "我是一个助手", "作为语言模型",
];

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 简易阿拉伯→中文数字(仅支持纯整数,用于"答对"的中文形式匹配)。 */
function toCnNumber(numeric: string): string | null {
  if (!/^\d+$/.test(numeric)) return null;
  const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  return numeric.split("").map((d) => digits[Number(d)] ?? d).join("");
}
