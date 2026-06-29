// M4.9 算子战绩表 operator_scoreboard。《优化器模块》§2.6/§7。
// 按 (破绽类型, edit_type) 统计历史"该算子修该类破绽"的接受率,供 assign_targets 排序。
// win_rate 用 Beta(1,1) 平滑(= (accepted+1)/(proposed+2))避免小样本极端;样本太少退默认优先级
// 由 pickEditTypes 的稳定排序天然实现(无数据时 winRate 相等 → 保持 OPERATOR_MAP 默认顺序)。

export interface PairStat {
  proposed: number;
  accepted: number;
}

export interface OperatorScoreboard {
  /** key = `${targetType}|${editType}`。 */
  by_pair: Record<string, PairStat>;
}

export function emptyScoreboard(): OperatorScoreboard {
  return { by_pair: {} };
}

function key(type: string, editType: string): string {
  return `${type}|${editType}`;
}

/** Beta(1,1) 平滑接受率:(accepted+1)/(proposed+2);无样本 → 0.5(中性,排序靠默认优先级打破)。 */
export function winRate(board: OperatorScoreboard, type: string, editType: string): number {
  const s = board.by_pair[key(type, editType)];
  if (!s || s.proposed === 0) return 0.5;
  return (s.accepted + 1) / (s.proposed + 2);
}

/** 原始样本量(供"样本太少退默认"判断 / 展示)。 */
export function sampleCount(board: OperatorScoreboard, type: string, editType: string): number {
  return board.by_pair[key(type, editType)]?.proposed ?? 0;
}

/**
 * 每个候选评测结束后更新一格(纯函数,返回新表;不可变更新便于持久化/测试)。
 * @param accepted 该候选是否被接受(晋升)。
 */
export function updateScoreboard(
  board: OperatorScoreboard,
  type: string,
  editType: string,
  accepted: boolean,
): OperatorScoreboard {
  if (!type || !editType) return board; // 自由探索名额无类型/算子 → 不计入
  const k = key(type, editType);
  const prev = board.by_pair[k] ?? { proposed: 0, accepted: 0 };
  return {
    by_pair: {
      ...board.by_pair,
      [k]: { proposed: prev.proposed + 1, accepted: prev.accepted + (accepted ? 1 : 0) },
    },
  };
}
