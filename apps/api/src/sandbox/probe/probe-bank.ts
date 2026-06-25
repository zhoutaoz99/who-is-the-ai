// ProbeBank 解析:probe_ref(实例 id 或 rotation_group)+ 场景 split → 选一个兼容实例。
// 隔离不变量:optimize 场景不得解析到仅 holdout 的实例,反之亦然(留出集验泛化、不背答案)。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pickIndex } from "../rng";
import type { ProbeBank, ProbeInstance } from "./types";

let defaultBank: ProbeBank | null = null;

/** 读内置示例 probe 库(dist 下,经 nest assets 拷贝)。 */
export function loadDefaultProbeBank(): ProbeBank {
  if (defaultBank) return defaultBank;
  const file = join(__dirname, "example-probe-bank.json");
  defaultBank = JSON.parse(readFileSync(file, "utf-8")) as ProbeBank;
  return defaultBank;
}

/** split 兼容:both 始终兼容;否则须等于场景 split。 */
function compatible(instance: ProbeInstance, split: string): boolean {
  return instance.split_exposure === "both" || instance.split_exposure === split;
}

/**
 * 解析 probe_ref(实例 id 或 rotation_group)到一个与场景 split 兼容的实例。
 * 用 seedParts(含 seed/run_index/round/seq)确定性挑选,保证可复现。
 * 找不到兼容实例 → null(调用方记 skipped)。
 */
export function resolveProbe(
  bank: ProbeBank,
  probeRef: string,
  split: string,
  seedParts: Array<number | string>,
): ProbeInstance | null {
  const candidates = bank.probes.filter(
    (p) =>
      compatible(p, split) &&
      (p.probe_id === probeRef || p.rotation_group === probeRef),
  );
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  return candidates[pickIndex(candidates.length, ...seedParts)];
}
