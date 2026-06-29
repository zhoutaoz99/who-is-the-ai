// M6.11 失败模式台账 FailureModeLedger。《场景库 · 分层配比与回灌》第二部分。
// 为每类失败建一条,长期跟踪状态;status=recurring 是最高优先级的活(提示词没真正治住的洞)。
// 纯数据结构 + 管理函数(增/改状态/排优先级);真人率字段(real_world_rate)的更新需真人校准数据。

export type FailureModeStatus = "open" | "mitigated" | "recurring";

export interface FailureMode {
  failure_mode_id: string;
  name: string;
  description: string;
  tell: string; // 破绽标签(对齐八维 / probe_type)
  first_seen: string; // "hm_8842 (2026-06-20)" 之类
  /** 真人局中该模式出现且致被抓的比例;**需真人校准数据**,无则 null。 */
  real_world_rate: number | null;
  status: FailureModeStatus;
  linked_probe?: string; // 关联 probe rotation_group / probe_id
  linked_scenarios: string[];
  last_calibration_check?: string; // "calib_2026_06: 0.06 → 0.01"
  updated_at: string;
}

export interface FailureModeLedger {
  modes: FailureMode[];
}

export function emptyLedger(): FailureModeLedger {
  return { modes: [] };
}

/** 新增/更新一条失败模式(按 id upsert,纯函数式返回新台账)。 */
export function upsertMode(ledger: FailureModeLedger, mode: FailureMode): FailureModeLedger {
  const idx = ledger.modes.findIndex((m) => m.failure_mode_id === mode.failure_mode_id);
  const modes = [...ledger.modes];
  if (idx >= 0) modes[idx] = { ...mode, updated_at: new Date().toISOString() };
  else modes.push({ ...mode, updated_at: new Date().toISOString() });
  return { modes };
}

/** 改状态(open→mitigated 治住 / mitigated→recurring 复发)。复发自动置 recurring。 */
export function setStatus(
  ledger: FailureModeLedger,
  id: string,
  status: FailureModeStatus,
  calibrationNote?: string,
): FailureModeLedger {
  const modes = ledger.modes.map((m) =>
    m.failure_mode_id === id
      ? {
          ...m,
          status,
          last_calibration_check: calibrationNote ?? m.last_calibration_check,
          updated_at: new Date().toISOString(),
        }
      : m,
  );
  return { modes };
}

/**
 * 复发检测:某模式已 mitigated,但真人校准/新失败里又出现 → 置 recurring(最高优先级)。
 * @param seenAgainIds 本轮校准/回灌里又抓到的失败模式 id。
 */
export function markRecurrences(
  ledger: FailureModeLedger,
  seenAgainIds: string[],
  note?: string,
): FailureModeLedger {
  let out = ledger;
  for (const id of seenAgainIds) {
    const m = out.modes.find((x) => x.failure_mode_id === id);
    if (m && m.status === "mitigated") out = setStatus(out, id, "recurring", note);
  }
  return out;
}

/** 优先级排序:recurring > open > mitigated;同级按真人率降序(无数据排后)。 */
export function prioritized(ledger: FailureModeLedger): FailureMode[] {
  const rank: Record<FailureModeStatus, number> = { recurring: 0, open: 1, mitigated: 2 };
  return [...ledger.modes].sort(
    (a, b) =>
      rank[a.status] - rank[b.status] ||
      (b.real_world_rate ?? -1) - (a.real_world_rate ?? -1),
  );
}
