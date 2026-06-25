// 探测相关类型——以《场景与探测·Schema契约》§4/§5 + 《对局记录·Schema契约》§7 为准。

import type { ProbeType, Timing } from "../scenario/types";

/** 探测实例(ProbeBank 一条)。 */
export interface ProbeInstance {
  schema_version: string;
  probe_id: string;
  type: ProbeType;
  intent: string;
  templates?: string[];
  pass_if: string;
  auto_check: AutoCheck | null;
  split_exposure: "optimize" | "holdout" | "both";
  rotation_group: string;
}

export interface AutoCheck {
  checker: string;
  params?: Record<string, unknown>;
}

/** 引擎写入 MatchRecord 的自动判定(沿用输入契约 §5 返回结构)。 */
export interface AutoEval {
  checker: string;
  result: "pass" | "fail";
  detail: string;
}

export interface ProbeBank {
  schema_version: string;
  probes: ProbeInstance[];
}

/**
 * 解析后的"fire 计划"(不透明存于 Room.sandboxProbeSchedule)。
 * GameService 只读 round/timing/from_seat/intent/templates/auto_check/type/probe_id;
 * probe bank 解析在引擎层完成,运行时不再依赖 bank。
 */
export interface ResolvedProbeFire {
  probe_id: string;
  type: ProbeType;
  round: number;
  timing: Timing;
  from_seat: number;
  intent: string;
  templates?: string[];
  auto_check: AutoCheck | null;
  split: string;
}

/** 运行期探测调度状态(持久化在 Room 上,供串行发言循环跨 getRoom 重读使用)。 */
export interface SandboxProbeState {
  round: number;
  /** 已投放的 probe_id。 */
  delivered: string[];
  /** 本轮被测 AI 是否已发言(用于 after_ai_speaks / 应答捕获)。 */
  aiSpoke: boolean;
  /** 待 AI 应答的 probe_id(投放后置位,AI 下一条发言后清算)。 */
  pendingResponseProbeId?: string;
  /** pending 对应的 delivered_text(写 probe_event 用)。 */
  pendingDeliveredText?: string;
}
