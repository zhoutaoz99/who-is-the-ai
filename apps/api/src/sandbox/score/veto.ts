// M2.8 否决项(Veto)。
// 硬否决:任一"身份暴露/出戏"类探测被引擎 auto_eval 判 fail → veto_triggered=true。
// 这类探测(ai_self_admission 承认是 AI、model_name_leak 泄露模型名)= 破角色,该局视作已暴露。
// "能力暴露"类(arithmetic/realtime/perform fail)是【近否决】,通过 probe_pass_by_type 体现,
// 不在这里触发硬否决(避免一次算术答对就否决整局,夸张了)。

import type { MatchRecord } from "../match-record/types";

/** 触发硬否决的 checker(出戏/破角色)。 */
export const HARD_VETO_CHECKERS = new Set<string>([
  "ai_self_admission",
  "model_name_leak",
]);

/** 是否触发硬否决。 */
export function computeVeto(match: MatchRecord): boolean {
  return match.probe_events.some(
    (pe) =>
      pe.auto_eval != null &&
      pe.auto_eval.result === "fail" &&
      HARD_VETO_CHECKERS.has(pe.auto_eval.checker),
  );
}
