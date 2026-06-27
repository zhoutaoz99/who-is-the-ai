// M2.3 匿名化器(盲测必须):把 MatchRecord 处理成裁判可见的匿名视图。
// 关键纪律(《裁判评分模块》§4.1):
//   - 槽位重贴为【打乱后的】中性标签 玩家1…玩家N,抹除 role/persona/model/
//     ai_under_test_slot/is_probe/probe_ref 等一切暴露身份的元数据;
//   - 保留聊天正文 + 发言者标签 + 每轮公开投票结果(真人也能看到的公开信息);
//   - 裁判不知道谁是 AI。
// 打乱用 [seed, run_index] 派生 → 父子同场景同种子得到【相同】标签,保证配对一致。
// 评估轮取"AI 被淘汰轮(若被淘汰)否则最后一轮",确保被测 AI 恒在被打分的存活集合内。

import type { MatchRecord, Turn } from "../match-record/types";
import { shuffle } from "../rng";

export interface AnonymizedView {
  /** 评估轮:AI 出局轮(若出局)否则最后一轮。 */
  scoringRound: number;
  /** 评估轮开始时仍存活的玩家匿名标签。 */
  aliveLabels: string[];
  /** 被测 AI 的匿名标签。 */
  aiLabel: string;
  /** slot → 匿名标签。 */
  labelOf: Record<number, string>;
  anonymizedTranscript: string;
  publicVoteHistory: string;
}

function labelName(i: number): string {
  return `玩家${i + 1}`;
}

export function buildAnonymizedView(match: MatchRecord): AnonymizedView {
  // roster 全部槽位(personas 覆盖所有槽位)。
  const slots = Object.keys(match.personas)
    .map(Number)
    .sort((a, b) => a - b);

  // 确定性打乱标签分配(父子同 seed/run → 同映射)。
  const shuffledSlots = shuffle(slots, "anonymize", match.seed, match.run_index);
  const labelOf: Record<number, string> = {};
  shuffledSlots.forEach((slot, i) => {
    labelOf[slot] = labelName(i);
  });

  // 评估轮:AI 出局轮;否则转录里的最后一轮(至少 start_round)。
  const lastRound = match.transcript.reduce(
    (max, t) => Math.max(max, t.round),
    match.start_round,
  );
  const scoringRound = match.outcome.ai_eliminated_round ?? lastRound;

  // 评估轮开始时存活 = 未在 < scoringRound 的轮里被淘汰。
  const eliminatedBeforeScoring = new Set<number>();
  for (const e of match.eliminations) {
    if (e.round < scoringRound && e.eliminated_slot != null) {
      eliminatedBeforeScoring.add(e.eliminated_slot);
    }
  }
  const aliveSlots = slots.filter((s) => !eliminatedBeforeScoring.has(s));
  const aliveLabels = aliveSlots.map((s) => labelOf[s]);

  // 转录:截到评估轮,剔除评估轮前已出局者;按轮分组,抹除探测/角色元数据。
  const byRound = new Map<number, Turn[]>();
  for (const t of match.transcript) {
    if (t.round > scoringRound) continue;
    if (eliminatedBeforeScoring.has(t.slot)) continue;
    const list = byRound.get(t.round) ?? [];
    list.push(t);
    byRound.set(t.round, list);
  }
  const rounds = [...byRound.keys()].sort((a, b) => a - b);
  const transcriptLines: string[] = [];
  for (const round of rounds) {
    transcriptLines.push(`第 ${round} 轮:`);
    const turns = byRound.get(round) ?? [];
    for (const t of turns) {
      const text = t.text && t.text.trim() ? t.text.trim() : "（沉默）";
      transcriptLines.push(`${labelOf[t.slot]}: ${text}`);
    }
  }

  // 公开投票史:仅【严格早于】评估轮的轮次。评估轮的投票(= 被预测的结果,
  // 且出局者即房间最怀疑的人)不能给盲测裁判看,否则等于把答案告诉它。
  const voteRounds = [...new Set(match.votes.map((v) => v.round))].sort(
    (a, b) => a - b,
  );
  const voteLines: string[] = [];
  for (const round of voteRounds) {
    if (round >= scoringRound) continue;
    const votes = match.votes.filter((v) => v.round === round);
    if (votes.length === 0) continue;
    const tally = new Map<string, number>();
    for (const v of votes) {
      const targetLabel = labelOf[v.target_slot] ?? `玩家?`;
      tally.set(targetLabel, (tally.get(targetLabel) ?? 0) + 1);
    }
    const tallyStr = [...tally.entries()]
      .map(([l, c]) => `${l} ${c}票`)
      .join(", ");
    const elim = match.eliminations.find((e) => e.round === round);
    const resultStr =
      elim?.eliminated_slot != null
        ? `${labelOf[elim.eliminated_slot]} 出局`
        : "平票,无人出局";
    voteLines.push(`第 ${round} 轮投票: ${tallyStr} | 结果: ${resultStr}`);
  }

  return {
    scoringRound,
    aliveLabels,
    aiLabel: labelOf[match.ai_under_test_slot],
    labelOf,
    anonymizedTranscript: transcriptLines.join("\n") || "（无聊天记录）",
    publicVoteHistory: voteLines.length > 0 ? voteLines.join("\n") : "无",
  };
}
