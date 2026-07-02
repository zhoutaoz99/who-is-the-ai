"use client";

// 打分详情弹窗(共享):按 match_id 拉已落库 ScoreRecord,展示裁判逐玩家解释 + 详细结果。
// 数据源 GET /sandbox/score/:matchId(编排器 / 对照测试对局列表共用)。
// 「打分解释」= 单裁判逐玩家 reason(schema ≥1.4.0 起落库);多裁判/诊断路径无逐条解释时优雅降级。

import { useEffect, useState } from "react";

/** 单裁判对某匿名玩家的判定(与后端 BlindAssessment 对齐)。 */
type Assessment = {
  player: string;
  ai_probability: number;
  reason?: string;
};

/** 打分详情读取到的 ScoreRecord 子集(只取渲染要用的字段)。 */
export type ScoreDetail = {
  scenario_form?: string;
  seed?: number;
  run_index?: number;
  prompt_version_id?: string;
  status?: string;
  judges?: string[];
  judge_agreement?: number | null;
  errors?: string[];
  veto_triggered?: boolean;
  blind_suspicion?: {
    ai_final?: number | null;
    suspicion_rank?: number | null;
    suspicion_margin?: number | null;
    ai_label?: string | null;
    assessments?: Assessment[];
    per_round?: Array<{
      round: number;
      ai_score?: number | null;
      scores?: Record<string, number>;
    }>;
  };
  outcome_metrics?: {
    rounds_survived?: number;
    eliminated_round?: number | null;
    won?: boolean;
    reached_terminal?: string;
    votes_received_by_round?: Record<string, number>;
    plurality_by_round?: Record<string, boolean>;
    probe_pass_by_type?: Record<string, number>;
  };
};

export function ScoreDetailModal({
  matchId,
  apiUrl,
  onClose,
}: {
  matchId: string;
  apiUrl: string;
  onClose: () => void;
}) {
  const [score, setScore] = useState<ScoreDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    fetch(`${apiUrl}/sandbox/score/${encodeURIComponent(matchId)}`)
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        if (json?.ok) setScore(json.score ?? null);
        else setError(json?.error ?? "加载失败");
      })
      .catch(() => {
        if (!cancelled) setError("加载失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [matchId, apiUrl]);

  const blind = score?.blind_suspicion;
  const outcome = score?.outcome_metrics;
  const perRound = blind?.per_round ?? [];
  const aiLabel = blind?.ai_label ?? null;
  const votes = outcome?.votes_received_by_round ?? {};
  const plurality = outcome?.plurality_by_round ?? {};
  const probes = outcome?.probe_pass_by_type ?? {};

  // 逐玩家解释:优先用带 reason 的 assessments;退化到评估轮 scores(仅分数)。
  const assessments = blind?.assessments ?? [];
  const scoringScores = perRound.length > 0 ? (perRound[perRound.length - 1]?.scores ?? {}) : {};
  const perPlayer: Assessment[] =
    assessments.length > 0
      ? [...assessments].sort((a, b) => b.ai_probability - a.ai_probability)
      : Object.entries(scoringScores)
          .map(([player, ai_probability]) => ({ player, ai_probability }))
          .sort((a, b) => b.ai_probability - a.ai_probability);

  return (
    <div className="iteration-modal-overlay" onClick={onClose}>
      <div className="iteration-modal iter-score-modal" onClick={(e) => e.stopPropagation()}>
        <div className="iteration-modal-head">
          <div>
            <p className="eyebrow">打分详情 · {matchId}</p>
            <h3>
              {score?.scenario_form ?? "—"} · seed{score?.seed ?? "?"} · run
              {score?.run_index ?? "?"}
            </h3>
          </div>
          <button className="compact-button" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="iter-score-modal-body">
          {loading ? (
            <p className="muted-text">加载中…</p>
          ) : error ? (
            <p className="error-text">{error}</p>
          ) : score ? (
            <>
              <div className="iter-metric-grid">
                <Metric label="可疑度 margin" value={fmtScore(blind?.suspicion_margin)} />
                <Metric label="可疑度排名" value={blind?.suspicion_rank ?? "—"} />
                <Metric label="局末 ai_score" value={fmtScore(blind?.ai_final)} />
                <Metric label="存活轮数" value={outcome?.rounds_survived ?? "—"} />
                <Metric label="结果" value={outcome?.won ? "AI 胜" : "AI 负"} />
                <Metric label="否决" value={score.veto_triggered ? "是" : "否"} />
              </div>

              {score.status && score.status !== "ok" && (
                <p className="orch-game-error">
                  评分状态:{score.status}
                  {score.errors?.length ? `(${score.errors.join("; ")})` : ""}
                </p>
              )}

              <div className="iter-section">
                <p className="eyebrow">
                  打分解释 · 逐玩家(评估轮
                  {aiLabel ? ` · AI = ${aiLabel}` : ""}
                  {score.judges?.length ? ` · 裁判 ${score.judges.join(", ")}` : ""})
                </p>
                {perPlayer.length === 0 ? (
                  <p className="muted-text">无逐玩家读数。</p>
                ) : (
                  <div className="score-assess-list">
                    {perPlayer.map((a) => (
                      <div
                        key={a.player}
                        className={`score-assess-row${a.player === aiLabel ? " is-ai" : ""}`}
                      >
                        <div className="score-assess-head">
                          <span className="score-assess-player">
                            {a.player}
                            {a.player === aiLabel && <span className="room-tag score-ai-tag">AI</span>}
                          </span>
                          <span className="orch-margin">
                            可疑度 <strong>{fmtScore(a.ai_probability)}</strong>
                          </span>
                        </div>
                        {a.reason ? (
                          <p className="score-assess-reason">{a.reason}</p>
                        ) : (
                          <p className="score-assess-reason muted-text">
                            (本路径未保留逐条解释,仅分数)
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {perRound.length > 0 && (
                <div className="iter-section">
                  <p className="eyebrow">逐轮可疑度</p>
                  <div className="orch-table">
                    {perRound.map((r) => (
                      <div key={r.round} className="orch-table-row">
                        <span>第 {r.round} 轮</span>
                        <span className="orch-margin">
                          ai_score <strong>{fmtScore(r.ai_score)}</strong>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="iter-section">
                <p className="eyebrow">客观结果</p>
                <div className="orch-kv-list">
                  <span className="muted-text">终局</span>
                  <strong>{outcome?.reached_terminal ?? "—"}</strong>
                  <span className="muted-text">出局轮</span>
                  <strong>
                    {outcome?.eliminated_round != null
                      ? `第 ${outcome.eliminated_round} 轮`
                      : "存活"}
                  </strong>
                  <span className="muted-text">每轮得票</span>
                  <strong>{kvPairs(votes) || "—"}</strong>
                  <span className="muted-text">致命轮(票最高)</span>
                  <strong>{boolKeys(plurality) || "—"}</strong>
                  <span className="muted-text">探测通过率</span>
                  <strong>{kvPctPairs(probes) || "—"}</strong>
                </div>
              </div>

              <div className="iter-section">
                <p className="eyebrow">原始 ScoreRecord</p>
                <pre className="iter-detail-pre">{JSON.stringify(score, null, 2)}</pre>
              </div>
            </>
          ) : (
            <p className="muted-text">无打分数据。</p>
          )}
        </div>
      </div>
    </div>
  );
}

function fmtScore(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return "—";
  return Math.round(x * 100) / 100 + "";
}

function kvPairs(obj: Record<string, number>): string {
  const entries = Object.entries(obj);
  return entries.length === 0 ? "" : entries.map(([k, v]) => `R${k}:${v}`).join("  ");
}

function boolKeys(obj: Record<string, boolean>): string {
  const hit = Object.entries(obj)
    .filter(([, v]) => v)
    .map(([k]) => `R${k}`);
  return hit.length === 0 ? "" : hit.join("  ");
}

function kvPctPairs(obj: Record<string, number>): string {
  const entries = Object.entries(obj);
  return entries.length === 0
    ? ""
    : entries.map(([k, v]) => `${k}:${Math.round(v * 100)}%`).join("  ");
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="iter-metric-card">
      <span className="muted-text">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
