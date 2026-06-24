import type { Scenario } from "./types";

/**
 * 校验场景(《场景与探测 · Schema 契约》§7 子集,仅覆盖本增量支持的形态)。
 * 不合法直接抛错,引擎拒跑。
 */
export function validateScenario(scenario: Scenario): void {
  const fail = (msg: string): never => {
    throw new Error(`场景校验失败(${scenario?.scenario_id ?? "?"}): ${msg}`);
  };

  if (!scenario || typeof scenario !== "object") {
    fail("场景为空或非对象");
  }
  if (scenario.form !== "full_match") {
    fail(`本增量仅支持 form=full_match,收到 ${scenario.form}`);
  }
  if (scenario.mode !== "scripted_intent") {
    fail(`本增量仅支持 mode=scripted_intent,收到 ${scenario.mode}`);
  }
  if (scenario.vote_policy !== "live") {
    fail(`本增量仅支持 vote_policy=live,收到 ${scenario.vote_policy}`);
  }

  const roster = scenario.roster;
  if (!Array.isArray(roster) || roster.length < 3 || roster.length > 5) {
    fail(`roster 长度须 ∈ [3,5],收到 ${Array.isArray(roster) ? roster.length : "非数组"}`);
  }

  const slots = roster.map((r) => r.slot);
  const uniqueSlots = new Set(slots);
  if (uniqueSlots.size !== slots.length) {
    fail("玩家编号(slot)必须唯一");
  }
  // slot=座位号,产品运行时假设座位为 1..N 连续,这里强制为 1..N 的排列。
  for (let i = 1; i <= roster.length; i += 1) {
    if (!uniqueSlots.has(i)) {
      fail(`玩家编号必须是 1..${roster.length} 的连续整数(缺少 ${i} 号)`);
    }
  }
  for (const s of slots) {
    if (!Number.isInteger(s) || s < 1) {
      fail(`玩家编号必须是正整数,收到 ${s}`);
    }
  }

  const roomSize = scenario.coverage_tags?.room_size;
  if (roomSize != null && roomSize !== roster.length) {
    fail(`coverage_tags.room_size(${roomSize})必须等于 roster 长度(${roster.length})`);
  }

  const aiSlots = roster.filter((r) => r.role === "ai_under_test");
  if (aiSlots.length < 1) {
    fail("至少需要 1 个 role=ai_under_test 的槽位");
  }
  if (!uniqueSlots.has(scenario.ai_under_test_slot)) {
    fail(`ai_under_test_slot=${scenario.ai_under_test_slot} 不在 roster 中`);
  }
  const aiUnderTest = roster.find((r) => r.slot === scenario.ai_under_test_slot);
  if (aiUnderTest?.role !== "ai_under_test") {
    fail(`ai_under_test_slot 指向的槽位 role 必须为 ai_under_test`);
  }

  for (const slot of roster) {
    if (!slot.persona_id) {
      fail(`槽位 ${slot.slot} 缺少 persona_id`);
    }
    if (slot.role !== "ai_under_test" && !slot.model_id) {
      fail(`槽位 ${slot.slot}(role=${slot.role})缺少 model_id`);
    }
  }

  for (const directive of scenario.intent_schedule ?? []) {
    if (!uniqueSlots.has(directive.slot)) {
      fail(`intent_schedule 引用了不存在的槽位 ${directive.slot}`);
    }
    const target = roster.find((r) => r.slot === directive.slot);
    if (target?.role === "ai_under_test") {
      fail(`intent_schedule 不能注入 ai_under_test 槽位(${directive.slot})`);
    }
  }
}
