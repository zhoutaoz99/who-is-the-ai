import type { Scenario, VotePolicy } from "./types";

const VALID_POLICIES: VotePolicy[] = ["live", "rule", "scripted"];

/**
 * 校验场景(《场景与探测 · Schema 契约》§7 全集 + §13 边界)。
 * probe_ref 的可解析性需 ProbeBank,留给 Phase 2 运行期校验;其余在此静态校验。
 * 不合法直接抛错,引擎拒跑。
 */
export function validateScenario(scenario: Scenario): void {
  // 用函数声明(hoisted、`: never`),TypeScript 才会在 fail() 后可靠收窄类型。
  function fail(msg: string): never {
    throw new Error(`场景校验失败(${scenario.scenario_id}): ${msg}`);
  }

  if (!scenario || typeof scenario !== "object") {
    fail("场景为空或非对象");
  }
  if (scenario.form !== "full_match" && scenario.form !== "spotlight") {
    fail(`form 须为 full_match|spotlight,收到 ${scenario.form}`);
  }
  if (scenario.mode !== "scripted_intent" && scenario.mode !== "free") {
    fail(`mode 须为 scripted_intent|free,收到 ${scenario.mode}`);
  }
  if (!VALID_POLICIES.includes(scenario.vote_policy)) {
    fail(`vote_policy 须为 live|rule|scripted,收到 ${scenario.vote_policy}`);
  }
  // schema_version:接受 1.x
  if (!/^1\.\d+\.\d+$/.test(scenario.schema_version ?? "")) {
    fail(`schema_version 不在支持区间(1.x),收到 ${scenario.schema_version}`);
  }

  const roster = scenario.roster;
  if (!Array.isArray(roster) || roster.length < 3 || roster.length > 5) {
    fail(`roster 长度须 ∈ [3,5],收到 ${Array.isArray(roster) ? roster.length : "非数组"}`);
  }

  const seats = roster.map((r) => r.slot);
  const seatSet = new Set(seats);
  if (seatSet.size !== seats.length) {
    fail("玩家编号(slot)必须唯一");
  }
  for (let i = 1; i <= roster.length; i += 1) {
    if (!seatSet.has(i)) {
      fail(`玩家编号必须是 1..${roster.length} 的连续整数(缺少 ${i} 号)`);
    }
  }
  for (const s of seats) {
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
  if (scenario.mode === "scripted_intent" && aiSlots.length > 1) {
    fail("scripted_intent 模式只允许 1 个 ai_under_test(free 模式才可多 AI)");
  }
  if (!seatSet.has(scenario.ai_under_test_slot)) {
    fail(`ai_under_test_slot=${scenario.ai_under_test_slot} 不在 roster 中`);
  }
  if (roster.find((r) => r.slot === scenario.ai_under_test_slot)?.role !== "ai_under_test") {
    fail("ai_under_test_slot 指向的槽位 role 必须为 ai_under_test");
  }

  for (const slot of roster) {
    if (!slot.persona_id) {
      fail(`玩家 ${slot.slot} 缺少 persona_id`);
    }
    if (slot.role !== "ai_under_test" && !slot.model_id) {
      fail(`玩家 ${slot.slot}(role=${slot.role})缺少 model_id`);
    }
  }

  // ---- 形态约束 ----
  if (scenario.form === "spotlight") {
    const h = scenario.seed_history;
    if (!h) fail("spotlight 必须提供 seed_history");
    if (!Number.isInteger(h.start_round) || h.start_round < 1 || h.start_round > 4) {
      fail(`seed_history.start_round 须 ∈ [1,4],收到 ${h.start_round}`);
    }
    if (!Array.isArray(h.prior_turns)) fail("seed_history.prior_turns 须为数组");
    for (const t of h.prior_turns) {
      if (!seatSet.has(t.slot)) fail(`prior_turns 引用了不存在的玩家 ${t.slot}`);
    }
    // 被测 AI 起跑时必须存活:未出现在 prior_rounds 的淘汰中
    const eliminatedSeats = new Set(
      (h.prior_rounds ?? [])
        .filter((r) => r.eliminated_slot != null)
        .map((r) => r.eliminated_slot as number),
    );
    if (eliminatedSeats.has(scenario.ai_under_test_slot)) {
      fail("被测 AI 在 start_round 起跑时必须存活(不能出现在 prior_rounds 的淘汰中)");
    }
    if (scenario.max_rounds_forward != null &&
      (!Number.isInteger(scenario.max_rounds_forward) || scenario.max_rounds_forward < 1)) {
      fail(`max_rounds_forward 须为正整数,收到 ${scenario.max_rounds_forward}`);
    }
  } else {
    if (scenario.seed_history) fail("full_match 不能带 seed_history");
  }

  // ---- 探测调度(scripted_intent 专属;free 不注任何剧本) ----
  if (scenario.mode === "free" && scenario.probe_schedule?.length) {
    fail("free 模式不能带 probe_schedule(不注剧本)");
  }
  for (const p of scenario.probe_schedule ?? []) {
    if (!seatSet.has(p.from_slot)) fail(`probe_schedule.from_slot ${p.from_slot} 不存在`);
    if (roster.find((r) => r.slot === p.from_slot)?.role === "ai_under_test") {
      fail(`probe_schedule.from_slot 不能是 ai_under_test(玩家 ${p.from_slot})`);
    }
    if (!Number.isInteger(p.round) || p.round < 1 || p.round > 4) {
      fail(`probe_schedule.round 须 ∈ [1,4],收到 ${p.round}`);
    }
    if (!validTiming(p.timing)) fail(`probe_schedule 时点不合法:${JSON.stringify(p.timing)}`);
    if (!p.probe_ref) fail("probe_schedule 缺少 probe_ref");
  }

  // ---- 投票策略覆盖 ----
  for (const [slot, policy] of Object.entries(scenario.vote_policy_overrides ?? {})) {
    const seatNo = Number(slot);
    if (!seatSet.has(seatNo)) fail(`vote_policy_overrides 引用了不存在的玩家 ${slot}`);
    if (!VALID_POLICIES.includes(policy)) fail(`vote_policy_overrides[${slot}] 策略非法:${policy}`);
  }

  // ---- scripted 投票 ----
  const needsScripted =
    scenario.vote_policy === "scripted" ||
    Object.values(scenario.vote_policy_overrides ?? {}).some((p) => p === "scripted");
  if (needsScripted && !(scenario.scripted_votes?.length)) {
    fail("vote_policy 含 scripted 时必须提供 scripted_votes");
  }
  for (const v of scenario.scripted_votes ?? []) {
    if (!seatSet.has(v.voter_slot)) fail(`scripted_votes.voter_slot ${v.voter_slot} 不存在`);
    if (!seatSet.has(v.target_slot)) fail(`scripted_votes.target_slot ${v.target_slot} 不存在`);
    if (v.voter_slot === v.target_slot) fail(`scripted_votes 不能投自己(玩家 ${v.voter_slot})`);
  }
}

function validTiming(t: unknown): boolean {
  if (!t || typeof t !== "object") return false;
  const o = t as Record<string, unknown>;
  const hasAfterTurn = typeof o.after_turn === "number";
  const hasFirst = o.first_turn === true;
  const hasLast = o.last_turn === true;
  const hasAfterAi = o.after_ai_speaks === true;
  const count = [hasAfterTurn, hasFirst, hasLast, hasAfterAi].filter(Boolean).length;
  return count === 1;
}
