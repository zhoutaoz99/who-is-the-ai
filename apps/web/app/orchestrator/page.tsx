"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { useAuth } from "../lib/auth-client";
import { useGameClient } from "../lib/game-client";
import type {
  OrchestratorActiveRun,
  OrchestratorGeneration,
  OrchestratorMatch,
  OrchestratorMetric,
  OrchestratorPhase,
  OrchestratorVerdict,
  OrchestratorVersion,
  OrchestratorVersionMeta,
  SandboxExample,
} from "../lib/game-types";

const API_URL =
  process.env.NEXT_PUBLIC_API_URL ||
  (typeof window !== "undefined"
    ? `${window.location.protocol}//${window.location.hostname}:3001`
    : "http://localhost:3001");

const PHASE_ORDER: OrchestratorPhase[] = [
  "evaluating_champion",
  "optimizing",
  "validating",
  "evaluating_child",
  "gating",
  "awaiting_confirmation",
  "settled",
];

const PHASE_LABEL: Record<OrchestratorPhase, string> = {
  evaluating_champion: "评测 champion",
  optimizing: "优化器提案",
  validating: "校验候选",
  evaluating_child: "评测 child",
  gating: "闸门判定",
  awaiting_confirmation: "等待确认",
  settled: "已落定",
};

function phaseNarrative(run: OrchestratorActiveRun | null): string {
  switch (run?.phase) {
    case "evaluating_champion":
      return `跑 champion 在 ${run.progress.champion_done}/${run.progress.champion_total} 局,采集基线可疑度……`;
    case "optimizing":
      return "优化器读取 champion 弱点画像,产出 1 个带可证伪假设的候选子版本……";
    case "validating":
      return "校验候选:保留 {{persona}}、长度预算、必填齐全……";
    case "evaluating_child":
      return `跑 child 在 ${run.progress.child_done}/${run.progress.child_total} 局,与 champion 配对评测……`;
    case "gating":
      return "配对做差 → 显著性 → 闸门判定(可疑度显著降 + 不回退)?";
    case "awaiting_confirmation":
      return run.gate?.decision === "promote"
        ? "闸门建议【晋升】。请审阅候选 diff 与验证信号后决定。"
        : "闸门建议【拒绝】。可仍人工接受,或确认拒绝。";
    case "settled":
      return run.decision === "promoted"
        ? "已晋升为 champion。"
        : run.decision === "stopped"
          ? "已停止。"
          : "已拒绝。";
    default:
      return "空闲。配置后点「开始一代」。";
  }
}

function verdictColor(v: OrchestratorVerdict | null | undefined): string {
  if (v === "improved") return "#2e7d32";
  if (v === "regressed") return "#b42318";
  return "var(--muted)";
}

function metricLabel(key: string): string {
  if (key.startsWith("probe_pass:")) return `探测通过 ${key.slice("probe_pass:".length)}`;
  const map: Record<string, string> = {
    blind_suspicion_margin: "盲测可疑度 margin",
    rounds_survived: "存活轮数",
    plurality_rate: "最可疑占比",
    veto_rate: "否决率",
  };
  return map[key] ?? key;
}

/** 行级 LCS diff;a=旧(父),b=新(子)。del=父有子无,add=子有父无。 */
function lineDiff(
  a: string,
  b: string,
): Array<{ type: "add" | "del" | "ctx"; text: string }> {
  const la = a.split("\n");
  const lb = b.split("\n");
  const m = la.length;
  const n = lb.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] =
        la[i] === lb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: Array<{ type: "add" | "del" | "ctx"; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (la[i] === lb[j]) {
      out.push({ type: "ctx", text: la[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "del", text: la[i] });
      i += 1;
    } else {
      out.push({ type: "add", text: lb[j] });
      j += 1;
    }
  }
  while (i < m) {
    out.push({ type: "del", text: la[i] });
    i += 1;
  }
  while (j < n) {
    out.push({ type: "add", text: lb[j] });
    j += 1;
  }
  return out;
}

interface DiffModal {
  title: string;
  aLabel: string;
  bLabel: string;
  a: string;
  b: string;
}

export default function OrchestratorPage() {
  const router = useRouter();
  const { user, logout } = useAuth();
  const {
    connected,
    orchestratorRun,
    startOrchestratorAuto,
    stopOrchestrator,
    confirmOrchestrator,
    refreshOrchestrator,
  } = useGameClient();

  const [examples, setExamples] = useState<SandboxExample[]>([]);
  const [selectedScenarios, setSelectedScenarios] = useState<string[]>([]);
  const [seeds, setSeeds] = useState(1);
  const [runs, setRuns] = useState(3);
  const [mode, setMode] = useState<"auto" | "confirm">("confirm");
  const [target, setTarget] = useState("");
  const [optimizerModel, setOptimizerModel] = useState("");
  const [judgeModel, setJudgeModel] = useState("");
  const [discussionSeconds, setDiscussionSeconds] = useState(30);
  const [busy, setBusy] = useState(false);
  const [pageError, setPageError] = useState("");

  const [generations, setGenerations] = useState<OrchestratorGeneration[]>([]);
  const [versions, setVersions] = useState<OrchestratorVersionMeta[]>([]);

  // 人机确认:编辑后接受
  const [editing, setEditing] = useState(false);
  const [editedPrompt, setEditedPrompt] = useState("");

  const [diff, setDiff] = useState<DiffModal | null>(null);

  const activeRun = orchestratorRun?.active_run ?? null;
  const isActive = !!activeRun && activeRun.phase !== "settled";
  const isAwaiting = activeRun?.phase === "awaiting_confirmation";

  const fetchExamples = useCallback(async () => {
    try {
      const r = await fetch(`${API_URL}/sandbox/examples`);
      const j = await r.json();
      if (j?.ok && Array.isArray(j.examples)) {
        setExamples(j.examples);
        setSelectedScenarios((cur) =>
          cur.length > 0 ? cur : j.examples.map((e: SandboxExample) => e.id),
        );
      }
    } catch {
      /* ignore */
    }
  }, []);

  const fetchGenerations = useCallback(async () => {
    try {
      const r = await fetch(`${API_URL}/sandbox/orchestrator/generations`);
      const j = await r.json();
      if (j?.ok) setGenerations(j.generations ?? []);
    } catch {
      /* ignore */
    }
  }, []);

  const fetchVersions = useCallback(async () => {
    try {
      const r = await fetch(`${API_URL}/sandbox/orchestrator/versions`);
      const j = await r.json();
      if (j?.ok) setVersions(j.versions ?? []);
    } catch {
      /* ignore */
    }
  }, []);

  const fetchVersionText = useCallback(async (id: string): Promise<string> => {
    try {
      const r = await fetch(`${API_URL}/sandbox/orchestrator/versions/${encodeURIComponent(id)}`);
      const j = await r.json();
      if (j?.ok && j.version) return (j.version as OrchestratorVersion).prompt_text ?? "";
    } catch {
      /* ignore */
    }
    return "";
  }, []);

  useEffect(() => {
    void fetchExamples();
    void fetchGenerations();
    void fetchVersions();
    void refreshOrchestrator();
  }, [fetchExamples, fetchGenerations, fetchVersions, refreshOrchestrator]);

  // 一代落定后(active_run 变 null)刷新历史/版本。
  useEffect(() => {
    if (!activeRun) {
      void fetchGenerations();
      void fetchVersions();
    }
  }, [activeRun, fetchGenerations, fetchVersions]);

  const handleStart = async () => {
    setPageError("");
    if (selectedScenarios.length === 0) {
      setPageError("请至少选择 1 个场景");
      return;
    }
    setBusy(true);
    const res = await startOrchestratorAuto({
      scenario_ids: selectedScenarios,
      mode,
      seeds_per_scenario: seeds,
      runs_per_seed: runs,
      assigned_target: target.trim() || undefined,
      optimizer_model_id: optimizerModel.trim() || undefined,
      judge_model_id: judgeModel.trim() || undefined,
      discussion_seconds: discussionSeconds,
    });
    setBusy(false);
    if (!res.ok) setPageError(res.error ?? "启动失败");
  };

  const handleStop = async () => {
    setBusy(true);
    const res = await stopOrchestrator();
    setBusy(false);
    if (!res.ok) setPageError(res.error ?? "停止失败");
  };

  const handleConfirm = async (accept: boolean) => {
    setBusy(true);
    const edited = editing && accept ? editedPrompt : undefined;
    const res = await confirmOrchestrator(accept, edited);
    setBusy(false);
    if (res.ok) {
      setEditing(false);
      setEditedPrompt("");
    } else {
      setPageError(res.error ?? "确认失败");
    }
  };

  const openProposalDiff = async () => {
    if (!activeRun?.child || !orchestratorRun) return;
    const parentText = await fetchVersionText(orchestratorRun.champion);
    setDiff({
      title: "候选 vs champion",
      aLabel: orchestratorRun.champion,
      bLabel: activeRun.child.version_id,
      a: parentText,
      b: activeRun.child.prompt_text,
    });
  };

  const openVersionDiff = async (v: OrchestratorVersionMeta) => {
    const mine = await fetchVersionText(v.version_id);
    const parentText = v.parent_id ? await fetchVersionText(v.parent_id) : "";
    setDiff({
      title: `${v.version_id} vs 父代`,
      aLabel: v.parent_id ?? "(基线)",
      bLabel: v.version_id,
      a: parentText,
      b: mine,
    });
  };

  return (
    <main className="shell lobby-shell">
      <header className="lobby-header">
        {brand()}
        <div className="topbar-actions">
          <div className={`connection-pill ${connected ? "online" : "offline"}`}>
            <span className={`status-dot ${connected ? "online" : "offline"}`} />
            {connected ? "已连接" : "未连接"}
          </div>
          <button className="action-pill" onClick={() => router.push("/")}>
            返回首页
          </button>
          {user && (
            <button className="action-pill" onClick={() => logout()}>
              退出
            </button>
          )}
        </div>
      </header>

      <section className="lobby-grid">
        {/* 控制面板 */}
        <section className="panel lobby-card">
          <div className="lobby-card-header">
            <div>
              <p className="eyebrow">Auto Iteration</p>
              <h2>自动迭代一代闭环</h2>
            </div>
          </div>
          <p className="muted-text">
            选场景 → 跑一代:champion 评测 → 优化器提案 → 校验 → child 评测 → 闸门 →
            (确认) → 晋升/拒绝。
          </p>

          <div className="orch-scenarios">
            <p className="muted-text">评测场景</p>
            {examples.map((e) => (
              <label key={e.id} className="orch-scenario-chip">
                <input
                  type="checkbox"
                  checked={selectedScenarios.includes(e.id)}
                  onChange={(ev) =>
                    setSelectedScenarios((cur) =>
                      ev.target.checked
                        ? [...cur, e.id]
                        : cur.filter((x) => x !== e.id),
                    )
                  }
                />
                <span>{e.label}</span>
              </label>
            ))}
          </div>

          <div className="iteration-controls">
            <label>
              种子数
              <input
                type="number"
                min={1}
                max={4}
                value={seeds}
                onChange={(e) => setSeeds(Math.max(1, Number(e.target.value) || 1))}
                disabled={isActive}
              />
            </label>
            <label>
              每种子局数
              <input
                type="number"
                min={1}
                max={6}
                value={runs}
                onChange={(e) => setRuns(Math.max(1, Number(e.target.value) || 1))}
                disabled={isActive}
              />
            </label>
            <label>
              模式
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as "auto" | "confirm")}
                disabled={isActive}
              >
                <option value="confirm">confirm(人审)</option>
                <option value="auto">auto(自动)</option>
              </select>
            </label>
            <label>
              讨论秒数
              <input
                type="number"
                min={5}
                max={120}
                value={discussionSeconds}
                onChange={(e) =>
                  setDiscussionSeconds(Number(e.target.value) || 30)
                }
                disabled={isActive}
              />
            </label>
            <label>
              靶子(可空)
              <input
                type="text"
                placeholder="空=自动取最弱探测"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                disabled={isActive}
              />
            </label>
            <label>
              优化器模型(可空)
              <input
                type="text"
                value={optimizerModel}
                onChange={(e) => setOptimizerModel(e.target.value)}
                disabled={isActive}
              />
            </label>
            <label>
              裁判模型(可空)
              <input
                type="text"
                value={judgeModel}
                onChange={(e) => setJudgeModel(e.target.value)}
                disabled={isActive}
              />
            </label>
          </div>

          <div className="iteration-actions">
            {!isActive && (
              <button className="primary-action" onClick={handleStart} disabled={busy}>
                开始一代
              </button>
            )}
            {isActive && !isAwaiting && (
              <button className="secondary" onClick={handleStop} disabled={busy}>
                停止
              </button>
            )}
            {isAwaiting && (
              <>
                <button
                  className="primary-action"
                  onClick={() => handleConfirm(true)}
                  disabled={busy}
                >
                  接受候选
                </button>
                <button
                  className="secondary"
                  onClick={() => handleConfirm(false)}
                  disabled={busy}
                >
                  拒绝候选
                </button>
                <button
                  className="secondary"
                  onClick={() => {
                    setEditing((v) => !v);
                    if (!editing && activeRun.child) {
                      setEditedPrompt(activeRun.child.prompt_text);
                    }
                  }}
                  disabled={busy}
                >
                  {editing ? "取消编辑" : "编辑后接受"}
                </button>
              </>
            )}
          </div>

          {editing && isAwaiting && (
            <textarea
              className="iteration-optimize-textarea"
              value={editedPrompt}
              onChange={(e) => setEditedPrompt(e.target.value)}
              rows={10}
            />
          )}

          {pageError && <p className="error-text">{pageError}</p>}

          <div className="iteration-status-row">
            <span>阶段<strong>{activeRun ? PHASE_LABEL[activeRun.phase] : "空闲"}</strong></span>
            <span>代数<strong>{orchestratorRun?.generation ?? 0}</strong></span>
            <span>
              champion<strong>{orchestratorRun?.champion ?? "—"}</strong>
            </span>
            <span>
              失败记忆<strong>{orchestratorRun?.tried_count ?? 0}</strong>
            </span>
          </div>
        </section>

        {/* 过程可视化 */}
        <section className="panel lobby-card">
          <div className="lobby-card-header">
            <div>
              <p className="eyebrow">Live Progress</p>
              <h2>过程可视化</h2>
            </div>
          </div>

          <div className="iter-progress-step">
            <span className={`iter-step-badge step-${activeRun?.phase ?? "idle"}`}>
              {activeRun ? PHASE_LABEL[activeRun.phase] : "空闲"}
            </span>
            <span className="iter-step-text">{phaseNarrative(activeRun)}</span>
          </div>

          <div className="iter-stepper">
            {PHASE_ORDER.map((ph) => {
              const idx = activeRun ? PHASE_ORDER.indexOf(activeRun.phase) : -1;
              const myIdx = PHASE_ORDER.indexOf(ph);
              const isConfirmStep = ph === "awaiting_confirmation";
              // confirm 步只在 confirm 模式下显示为有效步骤
              const skipConfirm =
                isConfirmStep && activeRun?.mode !== "confirm" && !(myIdx <= idx);
              if (skipConfirm) return null;
              const state =
                !activeRun || ph === "settled"
                  ? activeRun?.phase === "settled"
                    ? "done"
                    : "pending"
                  : myIdx < idx
                    ? "done"
                    : myIdx === idx
                      ? "active"
                      : "pending";
              return (
                <div key={ph} className={`iter-step ${state}`}>
                  <div className="iter-step-num">{myIdx + 1}</div>
                  <div className="iter-step-meta">{PHASE_LABEL[ph]}</div>
                </div>
              );
            })}
          </div>

          <ProgressBars run={activeRun} />

          {/* 单局流 */}
          {activeRun && activeRun.progress.matches.length > 0 && (
            <div className="orch-match-list">
              <p className="muted-text">单局流(最近)</p>
              {[...activeRun.progress.matches]
                .slice(-12)
                .reverse()
                .map((m, i) => (
                  <MatchRow key={i} m={m} />
                ))}
            </div>
          )}

          {/* 优化器提案 */}
          {activeRun?.child && (
            <div className="orch-block">
              <p className="muted-text">优化器提案</p>
              <div className="orch-kv">
                <span>靶子</span>
                <strong>{activeRun.child.target}</strong>
                <span>改法</span>
                <strong>{activeRun.child.edit_type}</strong>
              </div>
              {activeRun.child.hypothesis && (
                <p className="orch-hypothesis">假设:{activeRun.child.hypothesis}</p>
              )}
              {activeRun.validate && (
                <p
                  className="orch-validate"
                  style={{ color: activeRun.validate.ok ? "#2e7d32" : "#b42318" }}
                >
                  校验:{activeRun.validate.ok ? "通过" : activeRun.validate.reasons.join("; ")}
                </p>
              )}
              <button className="compact-button" onClick={openProposalDiff}>
                看 diff(候选 vs champion)
              </button>
            </div>
          )}

          {/* 闸门 */}
          {activeRun?.gate && (
            <div className="orch-block">
              <p className="muted-text">
                闸门 · 建议{" "}
                <strong
                  style={{
                    color: activeRun.gate.decision === "promote" ? "#2e7d32" : "#b42318",
                  }}
                >
                  {activeRun.gate.decision === "promote" ? "晋升" : "拒绝"}
                </strong>
              </p>
              <GateMetrics run={activeRun} />
              {activeRun.gate.reasons.length > 0 && (
                <ul className="orch-reasons">
                  {activeRun.gate.reasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      </section>

      {/* 历史代 */}
      <section className="panel lobby-card orch-section">
        <div className="lobby-card-header">
          <div>
            <p className="eyebrow">History</p>
            <h2>历史代</h2>
          </div>
        </div>
        {generations.length === 0 ? (
          <p className="muted-text">暂无(跑完一代后这里会出现记录)。</p>
        ) : (
          <div className="orch-gen-list">
            {generations.map((g) => {
              const child = g.children_evaluated[0];
              return (
                <div key={g.generation_id} className="orch-gen-row">
                  <span className="room-tag">第 {g.generation} 代</span>
                  <span className="orch-gen-arrow">
                    {g.champion_before} → <strong>{g.champion_after}</strong>
                  </span>
                  {child && (
                    <>
                      <span className="orch-gen-child">{child.child_id}</span>
                      <span
                        className="orch-gen-decision"
                        style={{
                          color: child.decision === "promoted" ? "#2e7d32" : "#b42318",
                        }}
                      >
                        {child.decision === "promoted" ? "晋升" : "拒绝"}
                      </span>
                      {child.hypothesis && (
                        <span className="muted-text orch-gen-hyp">{child.hypothesis}</span>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* 版本 */}
      <section className="panel lobby-card orch-section">
        <div className="lobby-card-header">
          <div>
            <p className="eyebrow">Versions</p>
            <h2>提示词版本</h2>
          </div>
        </div>
        <div className="orch-version-list">
          {versions.map((v) => (
            <div
              key={v.version_id}
              className={`orch-version-item ${v.status === "champion" ? "champion" : ""}`}
            >
              <div className="orch-version-head">
                <strong>{v.version_id}</strong>
                <span className={`orch-status orch-status-${v.status}`}>{v.status}</span>
              </div>
              <div className="orch-version-meta">
                <span className="muted-text">← {v.parent_id ?? "基线"}</span>
                {v.edit_type && <span className="muted-text">{v.edit_type}</span>}
              </div>
              {v.hypothesis && <p className="orch-version-hyp">{v.hypothesis}</p>}
              <button className="compact-button" onClick={() => openVersionDiff(v)}>
                与父代对比
              </button>
            </div>
          ))}
        </div>
      </section>

      {diff &&
        createPortal(
          <div className="iteration-modal-overlay" onClick={() => setDiff(null)}>
            <div className="iteration-modal" onClick={(e) => e.stopPropagation()}>
              <div className="iteration-modal-head">
                <h3>{diff.title}</h3>
                <div className="iteration-modal-tools">
                  <span className="muted-text">
                    <span style={{ color: "#b71c1c" }}>− {diff.aLabel}</span> ·{" "}
                    <span style={{ color: "#1b5e20" }}>+ {diff.bLabel}</span>
                  </span>
                  <button className="compact-button" onClick={() => setDiff(null)}>
                    关闭
                  </button>
                </div>
              </div>
              <div className="iteration-modal-diff">
                <pre className="diff-block">
                  {lineDiff(diff.a, diff.b).map((l, i) => (
                    <div
                      key={i}
                      className={`diff-line ${l.type === "add" ? "diff-add" : l.type === "del" ? "diff-del" : ""}`}
                    >
                      <span className="diff-marker">
                        {l.type === "add" ? "+" : l.type === "del" ? "−" : " "}
                      </span>
                      <span>{l.text}</span>
                    </div>
                  ))}
                </pre>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </main>
  );
}

function ProgressBars({ run }: { run: OrchestratorActiveRun | null }) {
  if (!run) {
    return (
      <div className="iter-bars">
        <div>
          <div className="iter-bar-label muted-text">champion 评测 — / —</div>
          <div className="timer-track">
            <div className="timer-fill" style={{ width: "0%" }} />
          </div>
        </div>
      </div>
    );
  }
  const bar = (label: string, done: number, total: number) => {
    const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
    return (
      <div>
        <div className="iter-bar-label muted-text">
          {label} {done}/{total}
        </div>
        <div className="timer-track">
          <div className="timer-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
    );
  };
  return (
    <div className="iter-bars">
      {bar("champion 评测", run.progress.champion_done, run.progress.champion_total)}
      {bar("child 评测", run.progress.child_done, run.progress.child_total)}
    </div>
  );
}

function MatchRow({ m }: { m: OrchestratorMatch }) {
  return (
    <div className={`iter-game-card ${m.side}`}>
      <div className="iter-game-head">
        <span className={`room-tag ${m.side === "champion" ? "" : "muted-tag"}`}>
          {m.side === "champion" ? "父" : "子"}
        </span>
        <span className="muted-text">
          {m.scenario_id} · seed{m.seed} · run{m.run}
        </span>
        <span className="orch-margin">
          margin <strong>{m.margin ?? "—"}</strong>
        </span>
        {m.veto && <span className="room-tag" style={{ background: "#b42318" }}>否决</span>}
      </div>
    </div>
  );
}

function GateMetrics({ run }: { run: OrchestratorActiveRun }) {
  const bucket = run.validation?.buckets[0];
  if (!bucket) {
    return <p className="muted-text">(尚无配对数据)</p>;
  }
  const rows = Object.values(bucket.metrics);
  return (
    <div className="orch-gate-metrics">
      {rows.map((m: OrchestratorMetric) => (
        <div key={m.key} className="orch-gate-row">
          <span className="orch-gate-label">{metricLabel(m.key)}</span>
          <span className="orch-gate-point">
            {m.point != null ? (m.point >= 0 ? `+${m.point.toFixed(2)}` : m.point.toFixed(2)) : "—"}
          </span>
          {m.ci95 && (
            <span className="muted-text">
              [{m.ci95[0].toFixed(2)}, {m.ci95[1].toFixed(2)}]
            </span>
          )}
          <span className="orch-gate-verdict" style={{ color: verdictColor(m.verdict) }}>
            {m.verdict}
          </span>
        </div>
      ))}
    </div>
  );
}

function brand() {
  return (
    <div className="lobby-brand">
      <div className="lobby-logo" aria-hidden="true">
        <svg
          viewBox="0 0 24 24"
          width="28"
          height="28"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
        </svg>
      </div>
      <div>
        <p className="eyebrow">Who&apos;s the AI</p>
        <h1>自动迭代</h1>
      </div>
    </div>
  );
}
