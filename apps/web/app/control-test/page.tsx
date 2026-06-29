"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../lib/auth-client";
import { useGameClient } from "../lib/game-client";
import type {
  ControlBucket,
  ControlGame,
  ControlKind,
  ControlMetric,
  ControlPreview,
  ControlResult,
  ControlTestPhase,
  ControlTestRun,
  EvalSet,
  OptHolePreview,
  OptHoleResult,
  OptHoleStatus,
  OrchestratorGameStatus,
  OrchestratorVerdict,
} from "../lib/game-types";

const API_URL =
  process.env.NEXT_PUBLIC_API_URL ||
  (typeof window !== "undefined"
    ? `${window.location.protocol}//${window.location.hostname}:3001`
    : "http://localhost:3001");

const ALL_KINDS: ControlKind[] = ["null", "negative", "positive"];

const PHASE_ORDER: ControlTestPhase[] = ["evaluating_parent", "running_controls", "settled"];
const PHASE_LABEL: Record<ControlTestPhase, string> = {
  evaluating_parent: "评测父代(champion)",
  running_controls: "逐对照评测",
  settled: "已落定",
};

function kindLabel(kind: string): string {
  switch (kind) {
    case "parent":
      return "父(champion)";
    case "null":
      return "空对照 A-A";
    case "negative":
      return "负对照 sabotage";
    case "positive":
      return "正对照 known-good";
    default:
      return kind;
  }
}

function phaseNarrative(run: ControlTestRun | null): string {
  switch (run?.phase) {
    case "evaluating_parent":
      return "跑 champion 基线,采集父代评分(三对照复用)……";
    case "running_controls":
      return run.current_kind
        ? `正在评测【${kindLabel(run.current_kind)}】,与父代配对做差 → 闸门 → 核对预期……`
        : "逐个对照评测中……";
    case "settled":
      return run.decision === "stopped"
        ? `已停止${run.error ? `(${run.error})` : ""}。`
        : run.overall_pass
          ? "全部对照如预期 → 流水线机器可信(就该集合能验到的范围内)。"
          : "有对照不如预期 → 流水线可能异常,见各卡片说明。";
    default:
      return "空闲。选评测集与对照后点「一键跑三对照」。";
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

function gameStatusLabel(status: OrchestratorGameStatus): string {
  switch (status) {
    case "pending":
      return "待开始";
    case "running":
      return "进行中";
    case "scoring":
      return "打分中";
    case "finished":
      return "已完成";
    case "failed":
      return "失败";
  }
}

function gamePhaseLabel(phase?: string): string {
  switch (phase) {
    case "waiting":
      return "等待开局";
    case "discussion":
      return "讨论中";
    case "voting":
      return "投票中";
    case "resolving":
      return "结算中";
    case "game_over":
      return "已结束";
    default:
      return "待开始";
  }
}

export default function ControlTestPage() {
  const router = useRouter();
  const { user, logout } = useAuth();
  const {
    connected,
    controlTestRun,
    startControlTest,
    stopControlTest,
    refreshControlTest,
    optimizerCheckRun,
    startOptimizerCheck,
    stopOptimizerCheck,
    refreshOptimizerCheck,
  } = useGameClient();

  const [evalSets, setEvalSets] = useState<EvalSet[]>([]);
  const [selectedSet, setSelectedSet] = useState("");
  const [previews, setPreviews] = useState<ControlPreview[]>([]);
  const [kinds, setKinds] = useState<ControlKind[]>(ALL_KINDS);
  const [runs, setRuns] = useState(3);
  const [seeds, setSeeds] = useState(1);
  const [judgeModel, setJudgeModel] = useState("");
  const [discussionSeconds, setDiscussionSeconds] = useState(30);
  const [busy, setBusy] = useState(false);
  const [pageError, setPageError] = useState("");

  // 优化器自检
  const [holes, setHoles] = useState<OptHolePreview[]>([]);
  const [selectedHoles, setSelectedHoles] = useState<string[]>([]);
  const [optModel, setOptModel] = useState("");
  const [optBusy, setOptBusy] = useState(false);

  const run = controlTestRun;
  const isRunning = !!run && run.phase !== "settled";
  const optRun = optimizerCheckRun;
  const optIsRunning = !!optRun && optRun.phase !== "settled";

  const fetchEvalSets = useCallback(async () => {
    try {
      const r = await fetch(`${API_URL}/sandbox/orchestrator/eval-sets`);
      const j = await r.json();
      if (j?.ok && Array.isArray(j.sets)) {
        setEvalSets(j.sets);
        setSelectedSet(
          (cur) =>
            cur ||
            (j.sets as EvalSet[]).find((s) => s.set_id === "baseline_smoke_v1")?.set_id ||
            (j.sets[0] as EvalSet | undefined)?.set_id ||
            "",
        );
      }
    } catch {
      /* ignore */
    }
  }, []);

  const fetchPreviews = useCallback(async () => {
    try {
      const r = await fetch(`${API_URL}/sandbox/control-test/controls`);
      const j = await r.json();
      if (j?.ok && Array.isArray(j.controls)) setPreviews(j.controls);
    } catch {
      /* ignore */
    }
  }, []);

  const fetchHoles = useCallback(async () => {
    try {
      const r = await fetch(`${API_URL}/sandbox/control-test/optimizer/holes`);
      const j = await r.json();
      if (j?.ok && Array.isArray(j.holes)) {
        setHoles(j.holes);
        setSelectedHoles((cur) => (cur.length ? cur : (j.holes as OptHolePreview[]).map((h) => h.id)));
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void fetchEvalSets();
    void fetchPreviews();
    void fetchHoles();
    void refreshControlTest();
    void refreshOptimizerCheck();
  }, [fetchEvalSets, fetchPreviews, fetchHoles, refreshControlTest, refreshOptimizerCheck]);

  const handleStart = async () => {
    setPageError("");
    if (!selectedSet) {
      setPageError("请选择 1 个评测集");
      return;
    }
    if (kinds.length === 0) {
      setPageError("请至少选择 1 个对照");
      return;
    }
    setBusy(true);
    const res = await startControlTest({
      set_id: selectedSet,
      kinds,
      seeds_per_scenario: seeds,
      runs_per_seed: runs,
      judge_model_id: judgeModel.trim() || undefined,
      discussion_seconds: discussionSeconds,
    });
    setBusy(false);
    if (!res.ok) setPageError(res.error ?? "启动失败");
  };

  const handleStop = async () => {
    setBusy(true);
    const res = await stopControlTest();
    setBusy(false);
    if (!res.ok) setPageError(res.error ?? "停止失败");
  };

  const toggleKind = (k: ControlKind) =>
    setKinds((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]));

  const toggleHole = (id: string) =>
    setSelectedHoles((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const handleOptStart = async () => {
    setPageError("");
    if (selectedHoles.length === 0) {
      setPageError("请至少选择 1 个要挖的坑");
      return;
    }
    setOptBusy(true);
    const res = await startOptimizerCheck({
      hole_ids: selectedHoles,
      optimizer_model_id: optModel.trim() || undefined,
      judge_model_id: judgeModel.trim() || undefined,
    });
    setOptBusy(false);
    if (!res.ok) setPageError(res.error ?? "启动失败");
  };

  const handleOptStop = async () => {
    setOptBusy(true);
    await stopOptimizerCheck();
    setOptBusy(false);
  };

  // 进度:父 + 各对照各一条进度条(从 games 折算)。
  const sides = useMemo<string[]>(
    () => ["parent", ...(run?.kinds ?? kinds)],
    [run?.kinds, kinds],
  );
  const perSideTotal = run
    ? run.plan.scenarios.length * run.plan.seedsPerScenario * run.plan.runsPerSeed
    : 0;
  const sideDone = (side: string) =>
    (run?.games ?? []).filter(
      (g) => g.side === side && (g.status === "finished" || g.status === "failed"),
    ).length;

  return (
    <main className="shell lobby-shell">
      <header className="lobby-header">
        {brand()}
        <div className="topbar-actions">
          <div className={`connection-pill ${connected ? "online" : "offline"}`}>
            <span className={`status-dot ${connected ? "online" : "offline"}`} />
            {connected ? "已连接" : "未连接"}
          </div>
          <button className="action-pill" onClick={() => router.push("/orchestrator")}>
            自动迭代
          </button>
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
              <p className="eyebrow">Pipeline Control Test</p>
              <h2>对照测试 · 验流水线机器</h2>
            </div>
          </div>
          <p className="muted-text">
            在冻结评测集上,把负/正/空三条对照当 child,与当前 champion(父)做配对评测,核对流水线
            是否如预期反应(噪声不被当信号、能抓烂、对真实改进方向敏感)。
            <strong>验的是机器对不对,不是 AI 好不好。</strong>
          </p>

          {/* 评测集 */}
          <div className="orch-evalset-list">
            {evalSets.length === 0 && <span className="muted-text">暂无评测集</span>}
            {evalSets.map((s) => (
              <label key={s.set_id} className="orch-evalset-chip">
                <input
                  type="radio"
                  name="ctl-evalset"
                  checked={selectedSet === s.set_id}
                  onChange={() => setSelectedSet(s.set_id)}
                  disabled={isRunning}
                />
                <span className="orch-evalset-body">
                  <span className="orch-evalset-title">
                    <strong>{s.set_id}</strong>
                    <span className="muted-text">
                      {" "}
                      @{s.version} · optimize {s.optimize_count} / holdout {s.holdout_count}
                    </span>
                  </span>
                  {s.description && (
                    <span className="orch-evalset-desc muted-text">{s.description}</span>
                  )}
                </span>
              </label>
            ))}
          </div>

          {/* 对照选择 */}
          <div className="ctl-kinds">
            <span className="muted-text">选对照</span>
            {(previews.length ? previews : ALL_KINDS.map((k) => ({ kind: k, label: kindLabel(k), expectation: "" }))).map(
              (p) => (
                <label key={p.kind} className={`ctl-kind-chip ctl-${p.kind}`} title={p.expectation}>
                  <input
                    type="checkbox"
                    checked={kinds.includes(p.kind)}
                    onChange={() => toggleKind(p.kind)}
                    disabled={isRunning}
                  />
                  <span>{p.label}</span>
                </label>
              ),
            )}
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
                disabled={isRunning}
              />
            </label>
            <label>
              每种子局数
              <input
                type="number"
                min={2}
                max={6}
                value={runs}
                onChange={(e) => setRuns(Math.max(2, Number(e.target.value) || 2))}
                disabled={isRunning}
              />
            </label>
            <label>
              讨论秒数
              <input
                type="number"
                min={5}
                max={120}
                value={discussionSeconds}
                onChange={(e) => setDiscussionSeconds(Number(e.target.value) || 30)}
                disabled={isRunning}
              />
            </label>
            <label>
              裁判模型(可空)
              <input
                type="text"
                value={judgeModel}
                onChange={(e) => setJudgeModel(e.target.value)}
                disabled={isRunning}
              />
            </label>
          </div>

          <div className="iteration-actions">
            {!isRunning ? (
              <button className="primary-action" onClick={handleStart} disabled={busy || !connected}>
                一键跑三对照
              </button>
            ) : (
              <button className="secondary" onClick={handleStop} disabled={busy}>
                停止
              </button>
            )}
          </div>

          {pageError && <p className="error-text">{pageError}</p>}

          <div className="iteration-status-row">
            <span>
              阶段<strong>{run ? PHASE_LABEL[run.phase] : "空闲"}</strong>
            </span>
            <span>
              评测集<strong>{run?.set_id ?? (selectedSet || "—")}</strong>
            </span>
            <span>
              父代<strong>{run?.parent_version_id ?? "—"}</strong>
            </span>
            {run?.phase === "settled" && run.decision === "done" && (
              <span>
                总体
                <strong style={{ color: run.overall_pass ? "#2e7d32" : "#b42318" }}>
                  {run.overall_pass ? "通过" : "异常"}
                </strong>
              </span>
            )}
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
            <span className={`iter-step-badge step-${run?.phase ?? "idle"}`}>
              {run ? PHASE_LABEL[run.phase] : "空闲"}
            </span>
            <span className="iter-step-text">{phaseNarrative(run)}</span>
          </div>

          <div className="iter-stepper">
            {PHASE_ORDER.map((ph, i) => {
              const idx = run ? PHASE_ORDER.indexOf(run.phase) : -1;
              const state = !run ? "pending" : i < idx ? "done" : i === idx ? "active" : "pending";
              return (
                <div key={ph} className={`iter-step ${state}`}>
                  <div className="iter-step-num">{i + 1}</div>
                  <div className="iter-step-meta">{PHASE_LABEL[ph]}</div>
                </div>
              );
            })}
          </div>

          {/* 各 side 进度条 */}
          {run && (
            <div className="iter-bars">
              {sides.map((side) => {
                const done = sideDone(side);
                const pct = perSideTotal > 0 ? Math.min(100, (done / perSideTotal) * 100) : 0;
                return (
                  <div key={side}>
                    <div className="iter-bar-label muted-text">
                      {kindLabel(side)} {done}/{perSideTotal}
                    </div>
                    <div className="timer-track">
                      <div className="timer-fill" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* 对局列表 */}
          {run && (
            <div className="orch-game-list">
              <p className="muted-text">对局列表({run.games.length})</p>
              {[...run.games].sort(compareGames).map((g) => (
                <GameRow
                  key={`${g.side}-${g.scenario_id}-${g.seed}-${g.run}`}
                  g={g}
                  onViewLive={(roomId) =>
                    window.open(`/game/${roomId}`, "_blank", "noopener,noreferrer")
                  }
                />
              ))}
              {run.games.length === 0 && <p className="muted-text">尚未开始。</p>}
            </div>
          )}

          {/* 对照结果卡片 */}
          {run && run.controls.length > 0 && (
            <div className="ctl-results">
              {[...run.controls]
                .sort((a, b) => ALL_KINDS.indexOf(a.kind) - ALL_KINDS.indexOf(b.kind))
                .map((c) => (
                  <ControlResultCard key={c.kind} c={c} />
                ))}
            </div>
          )}

          {/* 提醒 */}
          {run?.caveats && run.caveats.length > 0 && (
            <div className="ctl-caveats">
              <p className="muted-text">注意</p>
              <ul className="orch-reasons">
                {run.caveats.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </section>

      {/* 优化器自检(零对局) */}
      <section className="panel lobby-card orch-section">
        <div className="lobby-card-header">
          <div>
            <p className="eyebrow">Optimizer Self-check · zero-match</p>
            <h2>优化器自检 · 挖坑 → 填坑(不跑对局)</h2>
          </div>
          {optRun && (
            <span className={`iter-step-badge step-${optRun.phase}`}>
              {optRun.phase === "settled" ? "已落定" : "运行中"}
            </span>
          )}
        </div>
        <p className="muted-text">
          在基线提示词上删掉一条抗测试纪律(挖坑),把它当最弱靶喂给<strong>真优化器</strong>,看产出的子代
          是否恢复了该类具体处理。只用 1 次优化器调用 + 覆盖判定,<strong>0 对局</strong>。验的是"优化器产出对的编辑";
          "好编辑能否被 credit"由上方正对照负责。
        </p>

        <div className="ctl-kinds">
          <span className="muted-text">选要挖的坑</span>
          {holes.map((h) => (
            <label key={h.id} className="ctl-kind-chip" title={h.reference}>
              <input
                type="checkbox"
                checked={selectedHoles.includes(h.id)}
                onChange={() => toggleHole(h.id)}
                disabled={optIsRunning}
              />
              <span>{h.probe_type}</span>
            </label>
          ))}
        </div>

        <div className="iteration-controls">
          <label>
            优化器模型(可空)
            <input
              type="text"
              value={optModel}
              onChange={(e) => setOptModel(e.target.value)}
              disabled={optIsRunning}
            />
          </label>
          <label>
            裁判模型(可空)
            <input
              type="text"
              value={judgeModel}
              onChange={(e) => setJudgeModel(e.target.value)}
              disabled={optIsRunning}
            />
          </label>
        </div>

        <div className="iteration-actions">
          {!optIsRunning ? (
            <button className="primary-action" onClick={handleOptStart} disabled={optBusy || !connected}>
              跑优化器自检
            </button>
          ) : (
            <button className="secondary" onClick={handleOptStop} disabled={optBusy}>
              停止
            </button>
          )}
          {optRun?.phase === "settled" && optRun.decision === "done" && (
            <span className="iteration-status-row" style={{ marginLeft: "auto" }}>
              <span>
                总体
                <strong style={{ color: optRun.overall_pass ? "#2e7d32" : "#b42318" }}>
                  {optRun.overall_pass ? "通过" : "异常"}
                </strong>
              </span>
            </span>
          )}
        </div>

        {optRun && (
          <div className="ctl-results">
            {optRun.holes.map((h) => (
              <HoleCard key={h.hole_id} h={h} />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function optStatusLabel(s: OptHoleStatus): string {
  switch (s) {
    case "pending":
      return "待开始";
    case "proposing":
      return "优化器提案中";
    case "judging":
      return "覆盖判定中";
    case "done":
      return "已完成";
    case "failed":
      return "失败";
  }
}

function HoleCard({ h }: { h: OptHoleResult }) {
  const done = h.status === "done";
  return (
    <div className={`ctl-result-card ${done ? (h.pass ? "pass" : "fail") : ""}`}>
      <div className="ctl-result-head">
        <span className="ctl-kind-tag">{h.probe_type}</span>
        <span className="muted-text">{h.target}</span>
        {done ? (
          <span className={`ctl-pass-badge ${h.pass ? "pass" : "fail"}`}>
            {h.pass ? "优化器有效 ✓" : "异常 ✗"}
          </span>
        ) : (
          <span className="ctl-pass-badge">{optStatusLabel(h.status)}</span>
        )}
      </div>

      {(h.validate || h.target_hit != null || h.coverage) && (
        <div className="opt-checks">
          <span className={`opt-chk ${h.validate ? (h.validate.ok ? "ok" : "bad") : ""}`}>
            L0 校验 {h.validate ? (h.validate.ok ? "✓" : "✗") : "—"}
          </span>
          <span className={`opt-chk ${h.target_hit != null ? (h.target_hit ? "ok" : "bad") : ""}`}>
            L1 瞄准 {h.target_hit != null ? (h.target_hit ? "✓" : "✗") : "—"}
          </span>
          <span className={`opt-chk ${h.coverage ? (h.coverage.covered ? "ok" : "bad") : ""}`}>
            L2′ 覆盖 {h.coverage ? (h.coverage.covered ? "✓" : "✗") : "—"}
            {h.coverage ? `(${h.coverage.method})` : ""}
          </span>
          {h.seed_covered != null && (
            <span className="opt-chk muted-text">坑深 {h.seed_covered ? "浅(种子已覆盖)" : "干净"}</span>
          )}
        </div>
      )}

      {h.hypothesis && <p className="ctl-expectation muted-text">假设:{h.hypothesis}</p>}
      {h.coverage?.quote && (
        <p className="ctl-expectation muted-text">命中:「{h.coverage.quote}」</p>
      )}
      {h.error && <p className="orch-game-error">{h.error}</p>}
      {h.notes.length > 0 && (
        <ul className="orch-reasons ctl-notes">
          {h.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

const SIDE_ORDER: Record<string, number> = { parent: 0, null: 1, negative: 2, positive: 3 };

function compareGames(a: ControlGame, b: ControlGame): number {
  if (a.side !== b.side) return (SIDE_ORDER[a.side] ?? 9) - (SIDE_ORDER[b.side] ?? 9);
  if (a.scenario_id !== b.scenario_id) return a.scenario_id < b.scenario_id ? -1 : 1;
  if (a.seed !== b.seed) return a.seed - b.seed;
  return a.run - b.run;
}

function GameRow({ g, onViewLive }: { g: ControlGame; onViewLive: (roomId: string) => void }) {
  return (
    <div className={`orch-game-row status-${g.status}`}>
      <span className={`room-tag ${g.side === "parent" ? "" : "muted-tag"}`}>{kindLabel(g.side)}</span>
      <span className="orch-game-key">
        {g.scenario_id} · s{g.seed} · r{g.run}
      </span>
      <span className={`orch-game-status status-${g.status}`}>{gameStatusLabel(g.status)}</span>
      {g.status === "running" && (
        <span className="orch-game-detail">
          {gamePhaseLabel(g.phase)} · 第 {g.current_round ?? "-"} 轮 · AI {g.ai_alive ?? "-"}/
          {g.ai_total ?? "-"}
        </span>
      )}
      {g.status === "scoring" && <span className="orch-game-detail muted-text">裁判评分中…</span>}
      {g.status === "finished" && (
        <>
          <span className="orch-margin">
            margin <strong>{g.margin ?? "—"}</strong>
          </span>
          {g.veto && (
            <span className="room-tag" style={{ background: "#b42318" }}>
              否决
            </span>
          )}
        </>
      )}
      {g.status === "failed" && <span className="orch-game-error">{g.error ?? "失败"}</span>}
      <span className="orch-game-actions">
        <button
          className="compact-button"
          disabled={!g.room_id}
          title={g.room_id ? "查看这局对局记录(实时 / 回看)" : "对局尚未开始"}
          onClick={() => {
            if (g.room_id) onViewLive(g.room_id);
          }}
        >
          对局记录
        </button>
      </span>
    </div>
  );
}

function ControlResultCard({ c }: { c: ControlResult }) {
  return (
    <div className={`ctl-result-card ${c.pass ? "pass" : "fail"}`}>
      <div className="ctl-result-head">
        <span className={`ctl-kind-tag ctl-${c.kind}`}>{c.label}</span>
        <span className={`ctl-pass-badge ${c.pass ? "pass" : "fail"}`}>
          {c.pass ? "如预期 ✓" : "异常 ✗"}
        </span>
        <span className="ctl-gate muted-text">
          闸门{" "}
          <strong style={{ color: c.gate.decision === "promote" ? "#2e7d32" : "#b42318" }}>
            {c.gate.decision === "promote" ? "晋升" : "拒绝"}
          </strong>
        </span>
      </div>
      <p className="ctl-expectation muted-text">{c.expectation}</p>

      {c.buckets.map((b) => (
        <BucketMetrics key={b.form} b={b} />
      ))}

      {c.notes.length > 0 && (
        <ul className="orch-reasons ctl-notes">
          {c.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BucketMetrics({ b }: { b: ControlBucket }) {
  const rows: ControlMetric[] = [
    b.margin,
    b.rounds_survived,
    b.plurality_rate,
    b.veto_rate,
    ...b.probe_pass,
  ].filter((m): m is ControlMetric => m != null);
  if (rows.length === 0) return <p className="muted-text">(尚无配对数据)</p>;
  return (
    <div className="orch-gate-metrics">
      <div className="muted-text ctl-bucket-form">
        {b.form} · N={b.nScenarios}
      </div>
      {rows.map((m) => (
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
        <h1>对照测试</h1>
      </div>
    </div>
  );
}
