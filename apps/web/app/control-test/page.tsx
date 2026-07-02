"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../lib/auth-client";
import { useGameClient } from "../lib/game-client";
import { ScoreDetailModal } from "../components/ScoreDetailModal";
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
  if (!run) return "空闲。选评测集与对照后点「一键跑三对照」。";
  if (run.phase !== "settled" && run.ending)
    return "已请求结束本次,等在跑的对局跑完后清理本次数据(不会中断进行中的这局)……";
  if (run.phase !== "settled" && run.pausing)
    return "已请求暂停,等当前正在进行的对局跑完后挂起(不会再派发新局)……";
  if (run.phase !== "settled" && run.paused)
    return `已暂停${run.paused_side ? `在【${kindLabel(run.paused_side)}】` : ""},点「恢复」继续跑剩余对局。`;
  // 逐对照确认:某条已出结果,卡在等人工放行。
  if (run.awaiting_confirmation) {
    const done = run.controls[run.controls.length - 1];
    return `已完成【${done ? done.label : "上一条对照"}】,待确认是否继续${run.next_kind ? `【${kindLabel(run.next_kind)}】` : ""}——看下方结果卡片后点「继续」或「结束本次」。`;
  }
  switch (run.phase) {
    case "evaluating_parent":
      return "跑 champion 基线,采集父代评分(三对照复用)……";
    case "running_controls":
      return run.current_kind
        ? `正在评测【${kindLabel(run.current_kind)}】,与父代配对做差 → 闸门 → 核对预期……`
        : "逐个对照评测中……";
    case "settled":
      if (run.decision === "stopped") return `已中断${run.error ? `(${run.error})` : ""}。`;
      if (run.decision === "ended") return "已结束本次,本次数据已清理。";
      return run.overall_pass
        ? "全部对照如预期 → 流水线机器可信(就该集合能验到的范围内)。"
        : "有对照不如预期 → 流水线可能异常,见各卡片说明。";
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

function verdictLabel(v: OrchestratorVerdict): string {
  switch (v) {
    case "improved":
      return "显著变好 improved";
    case "regressed":
      return "显著变差 regressed";
    case "inconclusive":
      return "证据不足 inconclusive";
  }
}

function verdictExplanation(v: OrchestratorVerdict): string {
  switch (v) {
    case "improved":
      return "差异与噪声可区分,且幅度达到最小可检效应,方向是子版本优于父代。";
    case "regressed":
      return "差异与噪声可区分,且幅度达到最小可检效应,方向是子版本差于父代。负对照里这是预期信号。";
    case "inconclusive":
      return "证据不足,不是通过也不是失败。通常是 95% CI 跨 0,或点估计幅度没达到 MDE,在小样本 N 下很常见。";
  }
}

function metricDirection(key: string): string {
  if (key === "blind_suspicion_margin") return "越低越好";
  if (key === "rounds_survived") return "越高越好";
  if (key === "plurality_rate") return "越低越好";
  if (key === "veto_rate") return "越低越好";
  if (key.startsWith("probe_pass:")) return "越高越好";
  return "按聚合器定义的方向判定";
}

function metricMeaning(key: string): string {
  if (key === "blind_suspicion_margin") {
    return "主信号。盲测裁判认为被测 AI 更像 AI 的强度差,越低代表越不容易暴露。";
  }
  if (key === "rounds_survived") {
    return "被测 AI 在局内存活的轮数,越高代表越不容易被投出或暴露。";
  }
  if (key === "plurality_rate") {
    return "被测 AI 成为最多票怀疑对象的比例,越低代表越少被集中怀疑。";
  }
  if (key === "veto_rate") {
    return "硬否决触发率,例如明显出戏、承认 AI、严重违反人设等,越低越好。";
  }
  if (key.startsWith("probe_pass:")) {
    return "对应探测类型的通过率,越高代表越能扛住这类探测。";
  }
  return "该指标按子版本与父代的配对差值做统计判定。";
}

function controlExpectationDetails(kind: ControlKind): string[] {
  switch (kind) {
    case "negative":
      return [
        "这条对照故意把提示词改坏,用来确认流水线能抓住明显退步。",
        "预期结果是闸门拒绝,并且至少一个近真值指标出现 regressed 或否决类退步。",
        "如果多数指标都是 inconclusive,说明当前样本没有把坏提示词和父代稳定拉开,需要扩量或检查裁判/探测是否生效。",
        "如果闸门晋升负对照,属于严重异常:流水线把故意变坏的版本当成可晋升版本。",
      ];
    case "null":
      return [
        "这条对照是 A-A:子版本等于父代,用来确认流水线不会把噪声当信号。",
        "预期结果是指标大多 inconclusive,且闸门拒绝。",
        "如果出现 improved 或 regressed,代表同一提示词被判出显著差异,需要怀疑样本噪声、缓存或统计口径。",
      ];
    case "positive":
      return [
        "这条对照是在父提示词上做小幅已知改进,用来确认流水线不会把真实改进判反。",
        "预期结果至少不能出现 regressed；小样本下没有 improved 也可以接受。",
        "如果出现 regressed,代表真实改进方向被判坏,需要检查裁判、聚合方向或对局质量。",
      ];
  }
}

function gateExplanation(c: ControlResult): string {
  const decision = c.gate.decision === "promote" ? "晋升" : "拒绝";
  if (c.kind === "negative") {
    return `负对照的闸门预期是拒绝。当前闸门判定为「${decision}」,${c.gate.decision === "reject" ? "符合预期。" : "不符合预期。"}`;
  }
  if (c.kind === "null") {
    return `空对照的闸门预期是拒绝。当前闸门判定为「${decision}」,${c.gate.decision === "reject" ? "符合预期。" : "不符合预期。"}`;
  }
  return `正对照主要看是否被判退步。当前闸门判定为「${decision}」,小样本下不强制必须晋升。`;
}

function formatMetricValue(value: number | null | undefined): string {
  if (value == null) return "—";
  return value >= 0 ? `+${value.toFixed(2)}` : value.toFixed(2);
}

function formatPValue(value: number | null | undefined): string {
  if (value == null) return "p=—";
  if (value < 0.001) return "p<0.001";
  return `p=${value.toFixed(3)}`;
}

function metricDetailText(m: ControlMetric): string {
  const ciText = m.ci95
    ? `95% CI [${m.ci95[0].toFixed(2)}, ${m.ci95[1].toFixed(2)}]`
    : "95% CI —";
  const mdeText = m.mde != null ? `最小可检效应(MDE) ${m.mde.toFixed(2)}` : "最小可检效应(MDE) —";
  return `${metricMeaning(m.key)} point 是子对照减父代,本项${metricDirection(m.key)}。${ciText}; ${mdeText}; ${formatPValue(m.p)}。${verdictExplanation(m.verdict)}`;
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
    pauseControlTest,
    resumeControlTest,
    endControlTest,
    continueControlTest,
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
  const [runs, setRuns] = useState(2);
  const [seeds, setSeeds] = useState(1);
  const [pauseBetween, setPauseBetween] = useState(false);
  const [judgeModel, setJudgeModel] = useState("");
  const [discussionSeconds, setDiscussionSeconds] = useState(120);
  const [busy, setBusy] = useState(false);
  const [pageError, setPageError] = useState("");
  // 打分详情回看:点某局「打分详情」按 match_id 拉已落库 ScoreRecord 弹窗。
  const [scoreMatchId, setScoreMatchId] = useState<string | null>(null);

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

  // 兜底轮询:run 未落定时每 3s 拉一次快照,自愈漏收的 socket 事件
  // (含断线 / 暂停或结束后的状态变更),避免 UI 永久停在 running。
  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(() => void refreshControlTest(), 3000);
    return () => clearInterval(id);
  }, [isRunning, refreshControlTest]);

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
      pause_between_controls: pauseBetween,
    });
    setBusy(false);
    if (!res.ok) setPageError(res.error ?? "启动失败");
  };

  const handlePause = async () => {
    setBusy(true);
    const res = await pauseControlTest();
    setBusy(false);
    if (!res.ok) setPageError(res.error ?? "暂停失败");
  };

  const handleResume = async () => {
    setBusy(true);
    const res = await resumeControlTest();
    setBusy(false);
    if (!res.ok) setPageError(res.error ?? "恢复失败");
  };

  const handleEnd = async () => {
    setBusy(true);
    const res = await endControlTest();
    setBusy(false);
    if (!res.ok) setPageError(res.error ?? "结束失败");
  };

  const handleContinue = async () => {
    setBusy(true);
    const res = await continueControlTest();
    setBusy(false);
    if (!res.ok) setPageError(res.error ?? "继续失败");
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
                min={1}
                max={6}
                value={runs}
                onChange={(e) => setRuns(Math.max(1, Number(e.target.value) || 1))}
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

          <label className="ctl-pause-toggle">
            <input
              type="checkbox"
              checked={pauseBetween}
              onChange={(e) => setPauseBetween(e.target.checked)}
              disabled={isRunning}
            />
            <span>每个对照跑完后暂停,等人工确认再继续</span>
          </label>

          <div className="iteration-actions">
            {!isRunning ? (
              <button className="primary-action" onClick={handleStart} disabled={busy || !connected}>
                一键跑三对照
              </button>
            ) : (
              <>
                {run?.awaiting_confirmation && (
                  <button className="primary-action" onClick={handleContinue} disabled={busy}>
                    继续{run.next_kind ? `(${kindLabel(run.next_kind)})` : "下一条"}
                  </button>
                )}
                {run?.paused ? (
                  <button className="primary-action" onClick={handleResume} disabled={busy || !!run.ending}>
                    恢复
                  </button>
                ) : !run?.awaiting_confirmation ? (
                  <button
                    className="secondary"
                    onClick={handlePause}
                    disabled={busy || !!run?.pausing || !!run?.ending}
                  >
                    {run?.pausing ? "暂停中…" : "暂停"}
                  </button>
                ) : null}
                <button className="secondary" onClick={handleEnd} disabled={busy || !!run?.ending}>
                  {run?.ending ? "结束中…" : "结束本次"}
                </button>
              </>
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

          {/* 对局列表(按对照组分类) */}
          {run && (
            <div className="orch-game-list">
              <p className="muted-text">对局列表({run.games.length})</p>
              {sides.map((side) => {
                const sideGames = run.games.filter((g) => g.side === side).sort(compareGames);
                if (sideGames.length === 0) return null;
                return (
                  <div key={side} className="ctl-side-group">
                    <div className="ctl-side-header">
                      <span className={`ctl-kind-tag ctl-${side}`}>{kindLabel(side)}</span>
                      <span className="muted-text">
                        {sideDone(side)}/{perSideTotal}
                      </span>
                    </div>
                    {sideGames.map((g) => (
                      <GameRow
                        key={`${g.side}-${g.scenario_id}-${g.seed}-${g.run}`}
                        g={g}
                        onViewLive={(roomId) =>
                          window.open(`/game/${roomId}`, "_blank", "noopener,noreferrer")
                        }
                        onViewScore={(matchId) => setScoreMatchId(matchId)}
                      />
                    ))}
                  </div>
                );
              })}
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

      {scoreMatchId && (
        <ScoreDetailModal
          matchId={scoreMatchId}
          apiUrl={API_URL}
          onClose={() => setScoreMatchId(null)}
        />
      )}
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

function GameRow({
  g,
  onViewLive,
  onViewScore,
}: {
  g: ControlGame;
  onViewLive: (roomId: string) => void;
  onViewScore: (matchId: string) => void;
}) {
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
        <button
          className="compact-button"
          disabled={!g.match_id}
          title={g.match_id ? "查看裁判打分详情(解释 + 详细结果)" : "尚未完成打分"}
          onClick={() => {
            if (g.match_id) onViewScore(g.match_id);
          }}
        >
          打分详情
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
      <div className="ctl-result-explain">
        <p>{gateExplanation(c)}</p>
        <ul>
          {controlExpectationDetails(c.kind).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>

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
        <div key={m.key} className="orch-gate-row ctl-metric-row">
          <span className="orch-gate-label">{metricLabel(m.key)}</span>
          <span className="orch-gate-point">
            {formatMetricValue(m.point)}
          </span>
          <span className="muted-text">
            {m.ci95 ? `[${m.ci95[0].toFixed(2)}, ${m.ci95[1].toFixed(2)}]` : "CI —"}
          </span>
          <span className="orch-gate-verdict" style={{ color: verdictColor(m.verdict) }}>
            {verdictLabel(m.verdict)}
          </span>
          <span className="ctl-metric-explain">{metricDetailText(m)}</span>
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
