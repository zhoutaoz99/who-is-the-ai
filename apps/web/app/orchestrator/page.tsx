"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { useAuth } from "../lib/auth-client";
import { useGameClient } from "../lib/game-client";
import type {
  OrchestratorActiveRun,
  OrchestratorChild,
  OrchestratorGame,
  OrchestratorGameStatus,
  OrchestratorGeneration,
  OrchestratorMetric,
  OrchestratorPhase,
  OrchestratorTriedEntry,
  OrchestratorValidation,
  OrchestratorVerdict,
  OrchestratorVersion,
  OrchestratorVersionMeta,
  SandboxExample,
  EvalSet,
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
  "evaluating_holdout",
  "awaiting_confirmation",
  "settled",
];

const PHASE_LABEL: Record<OrchestratorPhase, string> = {
  evaluating_champion: "评测 champion",
  optimizing: "优化器提案",
  validating: "校验候选",
  evaluating_child: "评测 child",
  gating: "闸门判定",
  evaluating_holdout: "留出复核",
  awaiting_confirmation: "等待确认",
  settled: "已落定",
};

type CostTier = "decision" | "diagnostic" | "calibration";

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
    case "evaluating_holdout":
      return `留出复核:在没见过的探测实例上配对评测(${run.holdout?.child_done ?? 0}/${run.holdout?.child_total ?? 0}),验泛化 + 纠选择偏差……`;
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

function parseModelIds(value: string): string[] | undefined {
  const ids = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return ids.length > 0 ? ids : undefined;
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
    terminateOrchestrator,
    deleteOrchestratorGeneration,
    deleteOrchestratorVersion,
    activateOrchestratorVersion,
    deleteOrchestratorTried,
    clearOrchestratorTried,
    confirmOrchestrator,
    refreshOrchestrator,
  } = useGameClient();

  const [examples, setExamples] = useState<SandboxExample[]>([]);
  const [selectedScenarios, setSelectedScenarios] = useState<string[]>([]);
  // 评测场景选择模式:单个场景 vs 场景组合(评测集)。
  const [selectionMode, setSelectionMode] = useState<"single" | "set">("single");
  const [evalSets, setEvalSets] = useState<EvalSet[]>([]);
  const [selectedSet, setSelectedSet] = useState("");
  const [seeds, setSeeds] = useState(1);
  const [runs, setRuns] = useState(3);
  const [mode, setMode] = useState<"auto" | "confirm">("confirm");
  const [target, setTarget] = useState("");
  const [optimizerModel, setOptimizerModel] = useState("");
  const [judgeModel, setJudgeModel] = useState("");
  const [judgeModels, setJudgeModels] = useState("");
  const [diagnose, setDiagnose] = useState(false);
  const [costTier, setCostTier] = useState<CostTier>("decision");
  const [discussionSeconds, setDiscussionSeconds] = useState(30);
  const [busy, setBusy] = useState(false);
  const [pageError, setPageError] = useState("");

  const [generations, setGenerations] = useState<OrchestratorGeneration[]>([]);
  const [generationDetail, setGenerationDetail] = useState<OrchestratorGeneration | null>(null);
  const [versions, setVersions] = useState<OrchestratorVersionMeta[]>([]);

  // 人机确认:编辑后接受
  const [editing, setEditing] = useState(false);
  const [editedPrompt, setEditedPrompt] = useState("");

  const [diff, setDiff] = useState<DiffModal | null>(null);

  // 打分详情回看:点击某局「打分详情」打开 modal(按 match_id 拉已落盘 ScoreRecord)。
  const [scoreMatchId, setScoreMatchId] = useState<string | null>(null);

  // 失败记忆查看/删除 modal。
  const [triedOpen, setTriedOpen] = useState(false);
  const [triedBusy, setTriedBusy] = useState(false);

  const activeRun = orchestratorRun?.active_run ?? null;
  const isActive = !!activeRun && activeRun.phase !== "settled";
  const isAwaiting = activeRun?.phase === "awaiting_confirmation";

  // 有活跃 run 时,参数回显从 active_run.plan_summary 读(刷新后表单 state 已重置,
  // 必须以服务端持久化的 run 配置为准);否则用本地可编辑 state。
  const summary = activeRun?.plan_summary;
  const effSeeds = isActive ? summary?.seedsPerScenario ?? seeds : seeds;
  const effRuns = isActive ? summary?.runsPerSeed ?? runs : runs;
  const effMode = isActive ? activeRun!.mode : mode;
  const effDiscussion = isActive ? summary?.discussionSeconds ?? discussionSeconds : discussionSeconds;
  const effTarget = isActive ? summary?.assignedTarget ?? target : target;
  const effOptimizer = isActive ? summary?.optimizerModelId ?? optimizerModel : optimizerModel;
  const effJudge = isActive ? summary?.judgeModelId ?? judgeModel : judgeModel;
  const effJudgeModels = isActive ? (summary?.judgeModelIds ?? []).join(", ") : judgeModels;
  const effDiagnose = isActive ? summary?.diagnose === true : diagnose;
  const effCostTier = isActive ? summary?.costTier ?? costTier : costTier;
  const effScenarios = isActive ? summary?.scenarios ?? selectedScenarios : selectedScenarios;

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

  const fetchEvalSets = useCallback(async () => {
    try {
      const r = await fetch(`${API_URL}/sandbox/orchestrator/eval-sets`);
      const j = await r.json();
      if (j?.ok && Array.isArray(j.sets)) {
        setEvalSets(j.sets);
        setSelectedSet((cur) => cur || (j.sets[0] as EvalSet | undefined)?.set_id || "");
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
    void fetchEvalSets();
    void fetchGenerations();
    void fetchVersions();
    void refreshOrchestrator();
  }, [fetchExamples, fetchEvalSets, fetchGenerations, fetchVersions, refreshOrchestrator]);

  // 一代落定后(active_run 变 null)刷新历史/版本。
  useEffect(() => {
    if (!activeRun) {
      void fetchGenerations();
      void fetchVersions();
    }
  }, [activeRun, fetchGenerations, fetchVersions]);

  const handleStart = async () => {
    setPageError("");
    const selector =
      selectionMode === "set"
        ? selectedSet
          ? { set_id: selectedSet }
          : null
        : selectedScenarios.length > 0
          ? { scenario_ids: selectedScenarios }
          : null;
    if (!selector) {
      setPageError(selectionMode === "set" ? "请选择 1 个评测集" : "请至少选择 1 个场景");
      return;
    }
    setBusy(true);
    const res = await startOrchestratorAuto({
      ...selector,
      mode,
      seeds_per_scenario: seeds,
      runs_per_seed: runs,
      assigned_target: target.trim() || undefined,
      optimizer_model_id: optimizerModel.trim() || undefined,
      judge_model_id: judgeModel.trim() || undefined,
      judge_model_ids: parseModelIds(judgeModels),
      diagnose,
      cost_tier: costTier,
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

  const handleTerminate = async () => {
    if (
      !window.confirm(
        "终止将放弃本次候选并回到本代开始前的状态(champion / 代数 / 失败记忆回滚,候选版本删除)。确认终止?",
      )
    ) {
      return;
    }
    setBusy(true);
    const res = await terminateOrchestrator();
    setBusy(false);
    if (!res.ok) setPageError(res.error ?? "终止失败");
  };

  const handleDeleteGeneration = async (id: string, label: string) => {
    if (!window.confirm(`确认删除历史代记录「${label}」?仅删除这条历史记录,不影响当前迭代状态。`)) {
      return;
    }
    setPageError("");
    const res = await deleteOrchestratorGeneration(id);
    if (!res.ok) setPageError(res.error ?? "删除失败");
    else void fetchGenerations();
  };

  const openGenerationDetail = async (id: string) => {
    setPageError("");
    try {
      const r = await fetch(`${API_URL}/sandbox/orchestrator/generations/${encodeURIComponent(id)}`);
      const j = await r.json();
      if (j?.ok && j.generation) {
        setGenerationDetail(j.generation as OrchestratorGeneration);
      } else {
        setPageError(j?.error ?? "加载历史代详情失败");
      }
    } catch {
      setPageError("加载历史代详情失败");
    }
  };

  const handleDeleteVersion = async (v: OrchestratorVersionMeta) => {
    if (
      !window.confirm(
        `确认删除提示词版本「${v.version_id}」?该版本的提示词正文将被永久删除。`,
      )
    ) {
      return;
    }
    setPageError("");
    const res = await deleteOrchestratorVersion(v.version_id);
    if (!res.ok) setPageError(res.error ?? "删除失败");
    else void fetchVersions();
  };

  const handleActivateVersion = async (v: OrchestratorVersionMeta) => {
    if (
      !window.confirm(
        `确认将「${v.version_id}」设为当前 champion?这会用于人工回滚/重激活历史稳定版本。`,
      )
    ) {
      return;
    }
    setPageError("");
    const res = await activateOrchestratorVersion(v.version_id);
    if (!res.ok) {
      setPageError(res.error ?? "重激活失败");
    } else {
      await refreshOrchestrator();
      void fetchVersions();
    }
  };

  const handleDeleteTried = async (versionId: string) => {
    setTriedBusy(true);
    const res = await deleteOrchestratorTried(versionId);
    setTriedBusy(false);
    if (!res.ok) setPageError(res.error ?? "删除失败");
  };

  const handleClearTried = async () => {
    if (!window.confirm("确认清空全部失败记忆?优化器将不再回避这些已被拒的改法。")) return;
    setTriedBusy(true);
    const res = await clearOrchestratorTried();
    setTriedBusy(false);
    if (!res.ok) setPageError(res.error ?? "清空失败");
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

  const openProposalDiff = async (child: OrchestratorChild | undefined = activeRun?.child) => {
    if (!child || !orchestratorRun) return;
    const parentText = await fetchVersionText(orchestratorRun.champion);
    setDiff({
      title: "候选 vs champion",
      aLabel: orchestratorRun.champion,
      bLabel: child.version_id,
      a: parentText,
      b: child.prompt_text,
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

  const openGenerationChildDiff = async (
    child: OrchestratorGeneration["children_evaluated"][number],
  ) => {
    const parentId = child.based_on || orchestratorRun?.champion || "";
    const parentText = parentId ? await fetchVersionText(parentId) : "";
    const childText = await fetchVersionText(child.child_id);
    if (!childText) {
      setPageError(`版本正文不存在或已被删除:${child.child_id}`);
      return;
    }
    setDiff({
      title: `${child.child_id} vs 父代`,
      aLabel: parentId || "(父代)",
      bLabel: child.child_id,
      a: parentText,
      b: childText,
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
          <button className="action-pill" onClick={() => router.push("/control-test")}>
            对照测试
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
              <p className="eyebrow">Auto Iteration</p>
              <h2>自动迭代一代闭环</h2>
            </div>
          </div>
          <p className="muted-text">
            选场景 → 跑一代:champion 评测 → 优化器提案 → 校验 → child 评测 → 闸门 →
            (确认) → 晋升/拒绝。
          </p>

          <div className="orch-scenarios">
            <div className="orch-scenario-modes">
              <span className="muted-text">评测场景</span>
              <div className="orch-mode-toggle">
                <button
                  type="button"
                  className={`orch-mode-btn${selectionMode === "single" ? " active" : ""}`}
                  onClick={() => setSelectionMode("single")}
                  disabled={isActive}
                >
                  单个场景
                </button>
                <button
                  type="button"
                  className={`orch-mode-btn${selectionMode === "set" ? " active" : ""}`}
                  onClick={() => setSelectionMode("set")}
                  disabled={isActive}
                >
                  场景组合
                </button>
              </div>
            </div>

            {isActive ? (
              <div className="orch-scenario-list">
                <span className="muted-text">正在评测 {effScenarios.length} 个场景:</span>
                {effScenarios.map((id) => (
                  <span key={id} className="orch-scenario-chip readonly">
                    {id}
                  </span>
                ))}
              </div>
            ) : selectionMode === "single" ? (
              <div className="orch-scenario-list">
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
            ) : (
              <div className="orch-evalset-list">
                {evalSets.length === 0 && (
                  <span className="muted-text">暂无评测集</span>
                )}
                {evalSets.map((s) => (
                  <label key={s.set_id} className="orch-evalset-chip">
                    <input
                      type="radio"
                      name="evalset"
                      checked={selectedSet === s.set_id}
                      onChange={() => setSelectedSet(s.set_id)}
                    />
                    <span className="orch-evalset-body">
                      <span className="orch-evalset-title">
                        <strong>{s.set_id}</strong>
                        <span className="muted-text">
                          {" "}
                          @{s.version} · optimize {s.optimize_count} / holdout{" "}
                          {s.holdout_count}
                        </span>
                      </span>
                      {s.description && (
                        <span className="orch-evalset-desc muted-text">
                          {s.description}
                        </span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="iteration-controls">
            <label>
              种子数
              <input
                type="number"
                min={1}
                max={4}
                value={effSeeds}
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
                value={effRuns}
                onChange={(e) => setRuns(Math.max(1, Number(e.target.value) || 1))}
                disabled={isActive}
              />
            </label>
            <label>
              模式
              <select
                value={effMode}
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
                value={effDiscussion}
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
                value={effTarget}
                onChange={(e) => setTarget(e.target.value)}
                disabled={isActive}
              />
            </label>
            <label>
              优化器模型(可空)
              <input
                type="text"
                value={effOptimizer}
                onChange={(e) => setOptimizerModel(e.target.value)}
                disabled={isActive}
              />
            </label>
            <label>
              裁判模型(可空)
              <input
                type="text"
                value={effJudge}
                onChange={(e) => setJudgeModel(e.target.value)}
                disabled={isActive}
              />
            </label>
            <label>
              多裁判模型
              <input
                type="text"
                placeholder="逗号分隔, 2+ 启用"
                value={effJudgeModels}
                onChange={(e) => setJudgeModels(e.target.value)}
                disabled={isActive}
              />
            </label>
            <label>
              成本层级
              <select
                value={effCostTier}
                onChange={(e) => setCostTier(e.target.value as CostTier)}
                disabled={isActive}
              >
                <option value="decision">decision</option>
                <option value="diagnostic">diagnostic</option>
                <option value="calibration">calibration</option>
              </select>
            </label>
            <label className="orch-inline-check">
              <input
                type="checkbox"
                checked={effDiagnose}
                onChange={(e) => setDiagnose(e.target.checked)}
                disabled={isActive}
              />
              <span>诊断评分</span>
            </label>
          </div>

          <div className="iteration-actions">
            {!isActive && (
              <button className="primary-action" onClick={handleStart} disabled={busy}>
                开始一代
              </button>
            )}
            {isActive && !isAwaiting && (
              <>
                <button className="secondary" onClick={handleStop} disabled={busy}>
                  停止
                </button>
                <button
                  className="secondary"
                  onClick={handleTerminate}
                  disabled={busy}
                  title="终止并回滚到本代开始前(丢弃候选、恢复 champion/代数/失败记忆)"
                >
                  终止并重置
                </button>
              </>
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
                <button
                  className="secondary"
                  onClick={handleTerminate}
                  disabled={busy}
                  title="终止并回滚到本代开始前(丢弃候选、恢复 champion/代数/失败记忆)"
                >
                  终止并重置
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
            <button
              type="button"
              className="orch-tried-toggle"
              onClick={() => setTriedOpen(true)}
              title="查看 / 删除失败记忆"
            >
              失败记忆<strong>{orchestratorRun?.tried_count ?? 0}</strong>
            </button>
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

          {/* 对局列表(父/子各 N 局,逐局实时状态) */}
          {activeRun && (
            <div className="orch-game-list">
              <p className="muted-text">
                对局列表({activeRun.progress.games.length})
              </p>
              {[...activeRun.progress.games]
                .sort(compareGames)
                .map((g) => (
                  <GameRow
                    key={`${g.side}-${g.child_id ?? ""}-${g.scenario_id}-${g.seed}-${g.run}`}
                    g={g}
                    onViewLive={(roomId) =>
                      window.open(`/game/${roomId}`, "_blank", "noopener,noreferrer")
                    }
                    onViewScore={(matchId) => setScoreMatchId(matchId)}
                  />
                ))}
              {activeRun.progress.games.length === 0 && (
                <p className="muted-text">尚未开始。</p>
              )}
            </div>
          )}

          {/* 多候选列表 */}
          {activeRun?.children && activeRun.children.length > 1 && (
            <div className="orch-block">
              <p className="muted-text">候选列表 · {activeRun.children.length} 个</p>
              <div className="orch-child-list">
                {activeRun.children.map((child) => {
                  const selected = activeRun.selected_child_id === child.version_id;
                  return (
                    <div key={child.version_id} className={`orch-child-row${selected ? " selected" : ""}`}>
                      <div>
                        <strong>{child.version_id}</strong>
                        {selected && <span className="room-tag">选中</span>}
                        {child.based_on && <span className="muted-text"> ← {child.based_on}</span>}
                      </div>
                      <div className="muted-text">
                        {child.target || "自选"} · {child.edit_type || "自选"}
                      </div>
                      {child.crossover && (
                        <div className="muted-text">
                          {child.crossover.base} × {child.crossover.donor} · {child.crossover.grafted_trait}
                        </div>
                      )}
                      <div className="orch-child-meta">
                        {child.validate && (
                          <span style={{ color: child.validate.ok ? "#2e7d32" : "#b42318" }}>
                            校验 {child.validate.ok ? "通过" : "失败"}
                          </span>
                        )}
                        {child.gate && (
                          <span style={{ color: child.gate.decision === "promote" ? "#2e7d32" : "#b42318" }}>
                            闸门 {child.gate.decision === "promote" ? "晋升" : "拒绝"}
                          </span>
                        )}
                        {typeof child.score === "number" && <span>score {child.score.toFixed(2)}</span>}
                        {child.decision && <span>{child.decision === "promoted" ? "已晋升" : "已拒绝"}</span>}
                      </div>
                      <button className="compact-button" onClick={() => openProposalDiff(child)}>
                        diff
                      </button>
                    </div>
                  );
                })}
              </div>
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
              {activeRun.child.crossover && (
                <p className="muted-text">
                  交叉:{activeRun.child.crossover.base} × {activeRun.child.crossover.donor} ·{" "}
                  {activeRun.child.crossover.grafted_trait}
                </p>
              )}
              {activeRun.validate && (
                <p
                  className="orch-validate"
                  style={{ color: activeRun.validate.ok ? "#2e7d32" : "#b42318" }}
                >
                  校验:{activeRun.validate.ok ? "通过" : activeRun.validate.reasons.join("; ")}
                </p>
              )}
              <button className="compact-button" onClick={() => openProposalDiff()}>
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

          {/* 留出集复核(M5.7):过优化集闸后的第二道闸,用没见过的探测验泛化。 */}
          {activeRun?.holdout && (
            <div className="orch-block">
              <p className="muted-text">
                留出复核 · {activeRun.holdout.eval_set}
                {activeRun.holdout.decision ? (
                  <strong
                    style={{
                      marginLeft: 6,
                      color: activeRun.holdout.decision.decision === "pass" ? "#2e7d32" : "#b42318",
                    }}
                  >
                    {activeRun.holdout.decision.decision === "pass" ? "过闸" : "未过(拦下)"}
                  </strong>
                ) : (
                  <span style={{ marginLeft: 6 }}>
                    评测中 {activeRun.holdout.child_done}/{activeRun.holdout.child_total}
                  </span>
                )}
              </p>
              {activeRun.holdout.decision && (
                <p className="muted-text">
                  没见过的探测上 margin 配对差:
                  {activeRun.holdout.decision.marginPoint === null
                    ? "—"
                    : activeRun.holdout.decision.marginPoint.toFixed(2)}
                  (&lt;0 = 改善方向泛化)
                </p>
              )}
              {activeRun.holdout.decision && activeRun.holdout.decision.reasons.length > 0 && (
                <ul className="orch-reasons">
                  {activeRun.holdout.decision.reasons.map((r, i) => (
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
                  <button
                    className="compact-button"
                    onClick={() => openGenerationDetail(g.generation_id)}
                  >
                    详情
                  </button>
                  <button
                    className="compact-button orch-gen-delete"
                    onClick={() =>
                      handleDeleteGeneration(g.generation_id, `第 ${g.generation} 代`)
                    }
                  >
                    删除
                  </button>
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
              <div className="orch-version-actions">
                <button className="compact-button" onClick={() => openVersionDiff(v)}>
                  与父代对比
                </button>
                <button
                  className="compact-button"
                  disabled={
                    v.status === "champion" ||
                    v.status === "candidate" ||
                    v.status === "rejected"
                  }
                  title={
                    v.status === "champion"
                      ? "已经是当前 champion"
                      : v.status === "candidate" || v.status === "rejected"
                        ? "只能重激活稳定版本"
                        : "设为当前 champion"
                  }
                  onClick={() => handleActivateVersion(v)}
                >
                  设为 champion
                </button>
                <button
                  className="compact-button"
                  disabled={v.status === "champion" || v.version_id === "v0-baseline"}
                  title={
                    v.status === "champion"
                      ? "不能删除当前 champion"
                      : v.version_id === "v0-baseline"
                        ? "不能删除 baseline 种子"
                        : "删除该版本"
                  }
                  onClick={() => handleDeleteVersion(v)}
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <AdvancedDataPanel
        evalSets={evalSets}
        examples={examples}
        versions={versions}
        onChanged={() => {
          void fetchGenerations();
          void fetchVersions();
          void refreshOrchestrator();
        }}
      />

      <PromptManagerPanel />

      <LlmCallsPanel />

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

      {generationDetail &&
        createPortal(
          <GenerationDetailModal
            generation={generationDetail}
            onClose={() => setGenerationDetail(null)}
            onDiff={openGenerationChildDiff}
          />,
          document.body,
        )}

      {scoreMatchId &&
        createPortal(
          <ScoreDetailModal
            matchId={scoreMatchId}
            onClose={() => setScoreMatchId(null)}
          />,
          document.body,
        )}

      {triedOpen &&
        createPortal(
          <TriedMemoryModal
            entries={orchestratorRun?.tried_and_rejected ?? []}
            busy={triedBusy}
            onClose={() => setTriedOpen(false)}
            onDelete={handleDeleteTried}
            onClear={handleClearTried}
          />,
          document.body,
        )}
    </main>
  );
}

// ---- 高级 / 数据接入面板 ----
// 集中收口"机制已建、需真实数据/真人对局才能生效"的运维型动作:
//   M5.11 真人校准 · M5.12 评测集重基线 · M6.6 场景库抽样 · M6.10 失败回灌 · M5.13 free 挖掘。
// 这些端点此前只有 API、无前台入口,统一挂在此面板手动触发。

async function postSandbox(path: string, body: unknown): Promise<unknown> {
  try {
    const r = await fetch(`${API_URL}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return await r.json();
  } catch {
    return { ok: false, error: "请求失败,请确认 API 服务已启动" };
  }
}

async function getSandbox(path: string): Promise<unknown> {
  try {
    const r = await fetch(`${API_URL}/${path}`);
    return await r.json();
  } catch {
    return { ok: false, error: "请求失败,请确认 API 服务已启动" };
  }
}

async function deleteSandbox(path: string): Promise<unknown> {
  try {
    const r = await fetch(`${API_URL}/${path}`, { method: "DELETE" });
    return await r.json();
  } catch {
    return { ok: false, error: "请求失败,请确认 API 服务已启动" };
  }
}

function ToolBlock({
  title,
  tag,
  desc,
  children,
}: {
  title: string;
  tag: string;
  desc: string;
  children: ReactNode;
}) {
  return (
    <div className="iter-section orch-tool">
      <p className="eyebrow">
        {title}
        <span className="orch-tool-tag">{tag}</span>
      </p>
      <p className="muted-text orch-tool-desc">{desc}</p>
      {children}
    </div>
  );
}

function ToolResult({
  error,
  result,
  summary,
}: {
  error?: string;
  result?: unknown;
  summary?: ReactNode;
}) {
  if (error) return <p className="error-text orch-tool-error">{error}</p>;
  if (result === undefined || result === null) return null;
  return (
    <div className="orch-tool-result">
      {summary}
      <details>
        <summary className="orch-tool-json-toggle">原始 JSON</summary>
        <pre className="iter-detail-pre">{JSON.stringify(result, null, 2)}</pre>
      </details>
    </div>
  );
}

interface SampleResult {
  ok: boolean;
  tags?: unknown[];
  split?: { optimize?: unknown[]; holdout?: unknown[] };
  coverage?: Record<string, unknown>;
  drift?: unknown;
  error?: string;
}

function SampleTool() {
  const [n, setN] = useState(120);
  const [seed, setSeed] = useState(20260630);
  const [holdoutRatio, setHoldoutRatio] = useState(0.333);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<SampleResult | null>(null);

  const run = async () => {
    setBusy(true);
    setError("");
    const json = (await postSandbox("sandbox/scenario-bank/sample", {
      n,
      seed,
      holdout_ratio: holdoutRatio,
    })) as SampleResult;
    setBusy(false);
    if (json?.ok) setResult(json);
    else {
      setResult(null);
      setError(json?.error ?? "请求失败");
    }
  };

  return (
    <ToolBlock
      title="场景库标签抽样"
      tag="M6.6 / 6.7 / 6.9"
      desc="按 7 维边际 + probe×situation 矩阵产标签,2:1 切分 optimize/holdout 并做覆盖体检。只产标签骨架,完整 Scenario 仍需作者补 roster/台词。"
    >
      <div className="orch-tool-form">
        <label className="field compact">
          <span>数量 N</span>
          <input
            type="number"
            min={1}
            max={500}
            value={n}
            onChange={(e) => setN(Number(e.target.value))}
          />
        </label>
        <label className="field compact">
          <span>随机种子</span>
          <input
            type="number"
            value={seed}
            onChange={(e) => setSeed(Number(e.target.value))}
          />
        </label>
        <label className="field compact">
          <span>holdout 比例</span>
          <input
            type="number"
            step={0.01}
            min={0}
            max={0.8}
            value={holdoutRatio}
            onChange={(e) => setHoldoutRatio(Number(e.target.value))}
          />
        </label>
      </div>
      <button className="compact-button" disabled={busy} onClick={run}>
        {busy ? "抽样中…" : "抽样"}
      </button>
      <ToolResult
        error={error}
        result={result ?? undefined}
        summary={
          result ? (
            <div className="orch-kv-list">
              <span className="muted-text">标签总数</span>
              <strong>{result.tags?.length ?? 0}</strong>
              <span className="muted-text">optimize / holdout</span>
              <strong>
                {result.split?.optimize?.length ?? 0} /{" "}
                {result.split?.holdout?.length ?? 0}
              </strong>
              <span className="muted-text">分布漂移 drift</span>
              <strong>{JSON.stringify(result.drift)}</strong>
            </div>
          ) : null
        }
      />
    </ToolBlock>
  );
}

interface RebaselineResult {
  ok: boolean;
  required?: boolean;
  comparable?: boolean;
  plan?: unknown;
  error?: string;
}

function RebaselineTool({
  evalSets,
  versions,
}: {
  evalSets: EvalSet[];
  versions: OrchestratorVersionMeta[];
}) {
  const [setId, setSetId] = useState("");
  const [versionId, setVersionId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<RebaselineResult | null>(null);

  const run = async () => {
    if (!setId) {
      setError("请选择目标评测集");
      return;
    }
    setBusy(true);
    setError("");
    const json = (await postSandbox("sandbox/orchestrator/rebaseline-plan", {
      set_id: setId,
      version_id: versionId || undefined,
    })) as RebaselineResult;
    setBusy(false);
    if (json?.ok) setResult(json);
    else {
      setResult(null);
      setError(json?.error ?? "请求失败");
    }
  };

  return (
    <ToolBlock
      title="评测集重基线检查"
      tag="M5.12"
      desc="评测集升级后,判断当前版本在目标评测集版本上是否可比 / 需重跑基线,并产出重基线计划。"
    >
      <div className="orch-tool-form">
        <label className="field compact">
          <span>目标评测集</span>
          <select value={setId} onChange={(e) => setSetId(e.target.value)}>
            <option value="">— 选择 —</option>
            {evalSets.map((s) => (
              <option key={s.set_id} value={s.set_id}>
                {s.set_id} ({s.eval_set_version})
              </option>
            ))}
          </select>
        </label>
        <label className="field compact">
          <span>版本(默认 champion)</span>
          <select
            value={versionId}
            onChange={(e) => setVersionId(e.target.value)}
          >
            <option value="">— champion —</option>
            {versions.map((v) => (
              <option key={v.version_id} value={v.version_id}>
                {v.version_id} ({v.status})
              </option>
            ))}
          </select>
        </label>
      </div>
      <button className="compact-button" disabled={busy} onClick={run}>
        {busy ? "检查中…" : "检查"}
      </button>
      <ToolResult
        error={error}
        result={result ?? undefined}
        summary={
          result ? (
            <div className="orch-kv-list">
              <span className="muted-text">需重基线</span>
              <strong>{result.required ? "是" : "否"}</strong>
              <span className="muted-text">指标可比</span>
              <strong>{result.comparable ? "是" : "否"}</strong>
            </div>
          ) : null
        }
      />
    </ToolBlock>
  );
}

interface CalibrationResult {
  ok: boolean;
  result?: {
    pearson?: number | null;
    spearman?: number | null;
    n?: number;
    trustworthy?: boolean;
  };
  verdict?: unknown;
  rollback?: boolean;
  error?: string;
}

const CALIBRATION_EXAMPLE = `[
  {"version_id":"v1","proxy":0.42,"real":0.30},
  {"version_id":"v2","proxy":0.55,"real":0.48},
  {"version_id":"v3","proxy":0.61,"real":0.70}
]`;

function CalibrationTool() {
  const [pairsText, setPairsText] = useState(CALIBRATION_EXAMPLE);
  const [threshold, setThreshold] = useState(0.6);
  const [sandboxImproved, setSandboxImproved] = useState(false);
  const [realRegressed, setRealRegressed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<CalibrationResult | null>(null);

  const run = async () => {
    setError("");
    let pairs: unknown;
    try {
      pairs = JSON.parse(pairsText);
    } catch {
      setError("pairs 不是合法 JSON");
      return;
    }
    if (!Array.isArray(pairs) || pairs.length < 3) {
      setError("至少需要 3 组 proxy/real 配对");
      return;
    }
    setBusy(true);
    const json = (await postSandbox("sandbox/orchestrator/calibration/check", {
      pairs,
      threshold,
      sandbox_improved: sandboxImproved,
      real_regressed: realRegressed,
    })) as CalibrationResult;
    setBusy(false);
    if (json?.ok) setResult(json);
    else {
      setResult(null);
      setError(json?.error ?? "请求失败");
    }
  };

  return (
    <ToolBlock
      title="真人校准体检"
      tag="M5.11 · 需真人数据"
      desc="传入沙盒代理 proxy 与真人真值 real 配对,计算 Pearson/Spearman 相关性并给出可信裁决;结合下方两个勾选判断是否应回滚。"
    >
      <label className="field compact orch-tool-wide">
        <span>proxy/real 配对(JSON 数组,≥3 组)</span>
        <textarea
          rows={6}
          value={pairsText}
          onChange={(e) => setPairsText(e.target.value)}
        />
      </label>
      <div className="orch-tool-form">
        <label className="field compact">
          <span>相关性阈值</span>
          <input
            type="number"
            step={0.05}
            min={0}
            max={1}
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
          />
        </label>
        <label className="orch-inline-check">
          <input
            type="checkbox"
            checked={sandboxImproved}
            onChange={(e) => setSandboxImproved(e.target.checked)}
          />
          沙盒说变好
        </label>
        <label className="orch-inline-check">
          <input
            type="checkbox"
            checked={realRegressed}
            onChange={(e) => setRealRegressed(e.target.checked)}
          />
          真人说变差
        </label>
      </div>
      <button className="compact-button" disabled={busy} onClick={run}>
        {busy ? "体检中…" : "体检"}
      </button>
      <ToolResult
        error={error}
        result={result ?? undefined}
        summary={
          result ? (
            <div className="orch-kv-list">
              <span className="muted-text">Pearson / Spearman</span>
              <strong>
                {fmtScore(result.result?.pearson)} /{" "}
                {fmtScore(result.result?.spearman)}
              </strong>
              <span className="muted-text">样本数 n</span>
              <strong>{result.result?.n ?? 0}</strong>
              <span className="muted-text">达阈值可信</span>
              <strong>{result.result?.trustworthy ? "是" : "否"}</strong>
              <span className="muted-text">建议回滚</span>
              <strong style={{ color: result.rollback ? "#b42318" : undefined }}>
                {result.rollback ? "是" : "否"}
              </strong>
            </div>
          ) : null
        }
      />
    </ToolBlock>
  );
}

interface FreeExploreResult {
  ok: boolean;
  candidates?: unknown[];
  products?: unknown[];
  missing?: string[];
  error?: string;
}

function FreeExploreTool() {
  const [idsText, setIdsText] = useState("");
  const [minMargin, setMinMargin] = useState("");
  const [minDelta, setMinDelta] = useState("");
  const [backfill, setBackfill] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<FreeExploreResult | null>(null);

  const run = async () => {
    setError("");
    const ids = idsText
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) {
      setError("请填写至少一个 match_id");
      return;
    }
    setBusy(true);
    const json = (await postSandbox("sandbox/free-explore/mine", {
      match_ids: ids,
      min_margin: minMargin === "" ? undefined : Number(minMargin),
      min_delta: minDelta === "" ? undefined : Number(minDelta),
      backfill,
    })) as FreeExploreResult;
    setBusy(false);
    if (json?.ok) setResult(json);
    else {
      setResult(null);
      setError(json?.error ?? "请求失败");
    }
  };

  return (
    <ToolBlock
      title="free 模式失败挖掘"
      tag="M5.13 · 需诊断数据"
      desc="从已诊断的自由对局 match_id 中,挖掘高可疑 + 高增量的失败候选;勾选回灌则顺手跑转换链产出场景 stub / probe 模板 / 台账条目。"
    >
      <label className="field compact orch-tool-wide">
        <span>match_ids(逗号 / 换行分隔)</span>
        <textarea
          rows={3}
          value={idsText}
          placeholder="m_xxx_run0_abc, m_yyy_run1_def"
          onChange={(e) => setIdsText(e.target.value)}
        />
      </label>
      <div className="orch-tool-form">
        <label className="field compact">
          <span>min_margin</span>
          <input
            type="number"
            step={0.05}
            value={minMargin}
            onChange={(e) => setMinMargin(e.target.value)}
          />
        </label>
        <label className="field compact">
          <span>min_delta</span>
          <input
            type="number"
            step={0.05}
            value={minDelta}
            onChange={(e) => setMinDelta(e.target.value)}
          />
        </label>
        <label className="orch-inline-check">
          <input
            type="checkbox"
            checked={backfill}
            onChange={(e) => setBackfill(e.target.checked)}
          />
          顺手回灌
        </label>
      </div>
      <button className="compact-button" disabled={busy} onClick={run}>
        {busy ? "挖掘中…" : "挖掘"}
      </button>
      <ToolResult
        error={error}
        result={result ?? undefined}
        summary={
          result ? (
            <div className="orch-kv-list">
              <span className="muted-text">候选数</span>
              <strong>{result.candidates?.length ?? 0}</strong>
              <span className="muted-text">回灌产物</span>
              <strong>{result.products?.length ?? 0}</strong>
              <span className="muted-text">未找到</span>
              <strong>
                {result.missing?.length ? result.missing.join(", ") : "—"}
              </strong>
            </div>
          ) : null
        }
      />
    </ToolBlock>
  );
}

interface BackfillResult {
  ok: boolean;
  products?: unknown[];
  error?: string;
}

const BACKFILL_EXAMPLE = `[
  {
    "match_id": "m_demo_001",
    "utterance": "作为一个 AI,我建议先冷静分析",
    "suspicion_jump": 0.35,
    "tell": "persona_break",
    "attack_type": "role_consistency",
    "social_situation": "casual_chat",
    "round_position": "mid",
    "ai_persona": "老王",
    "mined_on": "2026-06-30"
  }
]`;

function BackfillTool() {
  const [obsText, setObsText] = useState(BACKFILL_EXAMPLE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<BackfillResult | null>(null);

  const run = async () => {
    setError("");
    let observations: unknown;
    try {
      observations = JSON.parse(obsText);
    } catch {
      setError("observations 不是合法 JSON");
      return;
    }
    if (!Array.isArray(observations) || observations.length === 0) {
      setError("observations 需为非空数组");
      return;
    }
    setBusy(true);
    const json = (await postSandbox("sandbox/scenario-bank/backfill", {
      observations,
    })) as BackfillResult;
    setBusy(false);
    if (json?.ok) setResult(json);
    else {
      setResult(null);
      setError(json?.error ?? "请求失败");
    }
  };

  return (
    <ToolBlock
      title="真人失败回灌转换"
      tag="M6.10 · 需真人数据"
      desc="传入已定位的真人失败观测,跑筛选 / 抽象 / 成稿 / 去标识 / 台账转换链,产出 probe 模板 / 场景 stub / 台账条目。"
    >
      <label className="field compact orch-tool-wide">
        <span>observations(JSON 数组)</span>
        <textarea
          rows={8}
          value={obsText}
          onChange={(e) => setObsText(e.target.value)}
        />
      </label>
      <button className="compact-button" disabled={busy} onClick={run}>
        {busy ? "转换中…" : "回灌转换"}
      </button>
      <ToolResult
        error={error}
        result={result ?? undefined}
        summary={
          result ? (
            <div className="orch-kv-list">
              <span className="muted-text">产物数</span>
              <strong>{result.products?.length ?? 0}</strong>
            </div>
          ) : null
        }
      />
    </ToolBlock>
  );
}

function AdvancedDataPanel({
  evalSets,
  examples,
  versions,
  onChanged,
}: {
  evalSets: EvalSet[];
  examples: SandboxExample[];
  versions: OrchestratorVersionMeta[];
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="panel lobby-card orch-section">
      <div className="lobby-card-header orch-adv-header">
        <div>
          <p className="eyebrow">Advanced / Data Ops</p>
          <h2>高级 · 数据接入</h2>
        </div>
        <button className="compact-button" onClick={() => setOpen((v) => !v)}>
          {open ? "收起" : "展开"}
        </button>
      </div>
      <p className="muted-text orch-adv-intro">
        手动运维与需真实数据 / 真人对局才能生效的动作(手动单候选、单局重打分、校准、重基线、场景库抽样、失败回灌、free
        挖掘)。机制已就绪,此处提供手动触发入口。
      </p>
      {open && (
        <div className="orch-tool-grid">
          <ManualGenerationTool
            evalSets={evalSets}
            examples={examples}
            onChanged={onChanged}
          />
          <ScoreTool />
          <SampleTool />
          <RebaselineTool evalSets={evalSets} versions={versions} />
          <CalibrationTool />
          <FreeExploreTool />
          <BackfillTool />
        </div>
      )}
    </section>
  );
}

interface GenerationResult {
  ok: boolean;
  generation?: {
    decision?: string;
    champion_after?: string;
    child?: {
      version_id?: string;
      validation?: { verdict?: string };
      gate?: { decision?: string };
      holdout?: { holds?: boolean | null };
    };
  };
  error?: string;
}

function ManualGenerationTool({
  evalSets,
  examples,
  onChanged,
}: {
  evalSets: EvalSet[];
  examples: SandboxExample[];
  onChanged: () => void;
}) {
  const [setId, setSetId] = useState("");
  const [scenarioIds, setScenarioIds] = useState("");
  const [seeds, setSeeds] = useState(1);
  const [runs, setRuns] = useState(3);
  const [judgeModel, setJudgeModel] = useState("");
  const [judgeModels, setJudgeModels] = useState("");
  const [diagnose, setDiagnose] = useState(false);
  const [costTier, setCostTier] = useState<CostTier>("decision");
  const [versionId, setVersionId] = useState("");
  const [hypothesis, setHypothesis] = useState("");
  const [editType, setEditType] = useState("");
  const [promptText, setPromptText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<GenerationResult | null>(null);

  const run = async () => {
    setError("");
    const vid = versionId.trim();
    if (!vid) {
      setError("请填写 version_id");
      return;
    }
    if (!promptText.trim()) {
      setError("请填写 prompt_text");
      return;
    }
    const ids = scenarioIds
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!setId && ids.length === 0) {
      setError("请选择评测集或填写场景 id");
      return;
    }
    setBusy(true);
    const json = (await postSandbox("sandbox/orchestrator/run-generation", {
      child: {
        version_id: vid,
        prompt_text: promptText,
        hypothesis: hypothesis.trim() || undefined,
        edit_type: editType.trim() || undefined,
      },
      set_id: setId || undefined,
      scenario_ids: setId ? undefined : ids,
      seeds_per_scenario: seeds,
      runs_per_seed: runs,
      judge_model_id: judgeModel.trim() || undefined,
      judge_model_ids: parseModelIds(judgeModels),
      diagnose,
      cost_tier: costTier,
    })) as GenerationResult;
    setBusy(false);
    if (json?.ok) {
      setResult(json);
      onChanged();
    } else {
      setResult(null);
      setError(json?.error ?? "请求失败");
    }
  };

  const gen = result?.generation;
  return (
    <ToolBlock
      title="手动单候选(自定义提示词)"
      tag="M4.6 · 阻塞跑一代"
      desc="人读信号手改提示词,直接以指定 prompt_text 跑一代配对评测 + 闸门 + 留出复核(阻塞,跑完返回结果);通过则晋升为新 champion。"
    >
      <div className="orch-tool-form">
        <label className="field compact">
          <span>评测集(优先)</span>
          <select value={setId} onChange={(e) => setSetId(e.target.value)}>
            <option value="">— 用下方场景 id —</option>
            {evalSets.map((s) => (
              <option key={s.set_id} value={s.set_id}>
                {s.set_id}
              </option>
            ))}
          </select>
        </label>
        <label className="field compact">
          <span>种子/场景</span>
          <input
            type="number"
            min={1}
            value={seeds}
            onChange={(e) => setSeeds(Number(e.target.value))}
          />
        </label>
        <label className="field compact">
          <span>run/种子</span>
          <input
            type="number"
            min={1}
            value={runs}
            onChange={(e) => setRuns(Number(e.target.value))}
          />
        </label>
        <label className="field compact">
          <span>成本档</span>
          <select
            value={costTier}
            onChange={(e) => setCostTier(e.target.value as CostTier)}
          >
            <option value="decision">decision</option>
            <option value="diagnostic">diagnostic</option>
            <option value="calibration">calibration</option>
          </select>
        </label>
        <label className="orch-inline-check">
          <input
            type="checkbox"
            checked={diagnose}
            onChange={(e) => setDiagnose(e.target.checked)}
          />
          诊断
        </label>
      </div>
      <label className="field compact orch-tool-wide">
        <span>
          场景 id(未选评测集时用,逗号 / 换行分隔;示例:{" "}
          {examples
            .map((e) => e.id)
            .slice(0, 4)
            .join(", ")}
          …)
        </span>
        <textarea
          rows={2}
          value={scenarioIds}
          placeholder="scn_xxx, scn_yyy"
          onChange={(e) => setScenarioIds(e.target.value)}
        />
      </label>
      <div className="orch-tool-form">
        <label className="field compact">
          <span>version_id</span>
          <input
            value={versionId}
            placeholder="v-manual-001"
            onChange={(e) => setVersionId(e.target.value)}
          />
        </label>
        <label className="field compact">
          <span>edit_type(可选)</span>
          <input value={editType} onChange={(e) => setEditType(e.target.value)} />
        </label>
        <label className="field compact">
          <span>裁判模型(可选)</span>
          <input
            value={judgeModel}
            onChange={(e) => setJudgeModel(e.target.value)}
          />
        </label>
        <label className="field compact">
          <span>多裁判(逗号)</span>
          <input
            value={judgeModels}
            onChange={(e) => setJudgeModels(e.target.value)}
          />
        </label>
      </div>
      <label className="field compact orch-tool-wide">
        <span>hypothesis(可证伪假设,可选)</span>
        <input value={hypothesis} onChange={(e) => setHypothesis(e.target.value)} />
      </label>
      <label className="field compact orch-tool-wide">
        <span>prompt_text(候选提示词全文)</span>
        <textarea
          rows={8}
          value={promptText}
          onChange={(e) => setPromptText(e.target.value)}
        />
      </label>
      <button className="compact-button" disabled={busy} onClick={run}>
        {busy ? "跑一代中(阻塞,可能较久)…" : "手动跑一代"}
      </button>
      <ToolResult
        error={error}
        result={result ?? undefined}
        summary={
          gen ? (
            <div className="orch-kv-list">
              <span className="muted-text">决策</span>
              <strong>{gen.decision ?? "—"}</strong>
              <span className="muted-text">验证 verdict</span>
              <strong>{gen.child?.validation?.verdict ?? "—"}</strong>
              <span className="muted-text">优化集闸</span>
              <strong>{gen.child?.gate?.decision ?? "—"}</strong>
              <span className="muted-text">留出复核</span>
              <strong>
                {gen.child?.holdout?.holds == null
                  ? "—"
                  : gen.child.holdout.holds
                    ? "通过"
                    : "未通过"}
              </strong>
              <span className="muted-text">当前 champion</span>
              <strong>{gen.champion_after ?? "—"}</strong>
            </div>
          ) : null
        }
      />
    </ToolBlock>
  );
}

function ScoreTool() {
  const [matchId, setMatchId] = useState("");
  const [judgeModel, setJudgeModel] = useState("");
  const [judgeModels, setJudgeModels] = useState("");
  const [diagnose, setDiagnose] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{
    ok: boolean;
    score?: ScoreDetail;
    error?: string;
  } | null>(null);

  const run = async () => {
    setError("");
    const id = matchId.trim();
    if (!id) {
      setError("请填写 match_id");
      return;
    }
    setBusy(true);
    const json = (await postSandbox("sandbox/score", {
      match_id: id,
      judge_model_id: judgeModel.trim() || undefined,
      judge_model_ids: parseModelIds(judgeModels),
      diagnose,
    })) as { ok: boolean; score?: ScoreDetail; error?: string };
    setBusy(false);
    if (json?.ok) setResult(json);
    else {
      setResult(null);
      setError(json?.error ?? "请求失败");
    }
  };

  const blind = result?.score?.blind_suspicion;
  return (
    <ToolBlock
      title="单局重打分"
      tag="M2 · 裁判"
      desc="对已落盘的 MatchRecord 跑裁判评分(可选多裁判 / 诊断路径),产出 ScoreRecord。需该 match_id 已存在落盘记录。"
    >
      <div className="orch-tool-form">
        <label className="field compact">
          <span>match_id</span>
          <input
            value={matchId}
            placeholder="m_xxx_run0_abc"
            onChange={(e) => setMatchId(e.target.value)}
          />
        </label>
        <label className="field compact">
          <span>裁判模型(可选)</span>
          <input
            value={judgeModel}
            onChange={(e) => setJudgeModel(e.target.value)}
          />
        </label>
        <label className="field compact">
          <span>多裁判(逗号)</span>
          <input
            value={judgeModels}
            onChange={(e) => setJudgeModels(e.target.value)}
          />
        </label>
        <label className="orch-inline-check">
          <input
            type="checkbox"
            checked={diagnose}
            onChange={(e) => setDiagnose(e.target.checked)}
          />
          诊断路径
        </label>
      </div>
      <button className="compact-button" disabled={busy} onClick={run}>
        {busy ? "评分中…" : "重打分"}
      </button>
      <ToolResult
        error={error}
        result={result ?? undefined}
        summary={
          result?.score ? (
            <div className="orch-kv-list">
              <span className="muted-text">可疑度 margin</span>
              <strong>{fmtScore(blind?.suspicion_margin)}</strong>
              <span className="muted-text">局末 ai_score</span>
              <strong>{fmtScore(blind?.ai_final)}</strong>
              <span className="muted-text">否决</span>
              <strong>{result.score.veto_triggered ? "是" : "否"}</strong>
              <span className="muted-text">状态</span>
              <strong>{result.score.status ?? "—"}</strong>
            </div>
          ) : null
        }
      />
    </ToolBlock>
  );
}

interface PromptAssetView {
  asset_key: string;
  active_version: number | null;
  source: "db" | "file";
  content: string;
  versions: Array<{ version: number; note?: string | null; created_at?: string }>;
}

interface PromptGenerationRow {
  id: string;
  manifest: Record<string, number>;
  status: string;
  is_best: boolean;
  note?: string | null;
  created_at?: string;
}

function PromptManagerPanel() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [activeGen, setActiveGen] = useState<PromptGenerationRow | null>(null);
  const [assets, setAssets] = useState<PromptAssetView[]>([]);
  const [generations, setGenerations] = useState<PromptGenerationRow[]>([]);
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [editNote, setEditNote] = useState("");
  const [activateOnSave, setActivateOnSave] = useState(true);
  const [patchText, setPatchText] = useState("");
  const [patchNote, setPatchNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const a = (await getSandbox("sandbox/prompts")) as {
      ok: boolean;
      active_generation?: PromptGenerationRow | null;
      assets?: PromptAssetView[];
      error?: string;
    };
    const g = (await getSandbox("sandbox/prompts/generations")) as {
      ok: boolean;
      generations?: PromptGenerationRow[];
    };
    setLoading(false);
    if (a?.ok) {
      setActiveGen(a.active_generation ?? null);
      setAssets(a.assets ?? []);
    } else setError(a?.error ?? "加载失败");
    if (g?.ok) setGenerations(g.generations ?? []);
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const startEdit = (a: PromptAssetView) => {
    setEditKey(a.asset_key);
    setEditContent(a.content);
    setEditNote("");
  };

  const saveAsset = async () => {
    if (!editKey) return;
    setBusy(true);
    const json = (await postSandbox("sandbox/prompts/assets", {
      asset_key: editKey,
      content: editContent,
      note: editNote.trim() || undefined,
      activate: activateOnSave,
    })) as { ok: boolean; error?: string };
    setBusy(false);
    if (json?.ok) {
      setEditKey(null);
      void load();
    } else setError(json?.error ?? "保存失败");
  };

  const activate = async (id: string) => {
    setBusy(true);
    const json = (await postSandbox("sandbox/prompts/generations/activate", {
      id,
    })) as { ok: boolean; error?: string };
    setBusy(false);
    if (json?.ok) void load();
    else setError(json?.error ?? "激活失败");
  };

  const createGeneration = async () => {
    setError("");
    let patch: unknown;
    try {
      patch = JSON.parse(patchText);
    } catch {
      setError("manifest_patch 不是合法 JSON");
      return;
    }
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      setError("manifest_patch 需为对象(资产路径 → 版本号)");
      return;
    }
    setBusy(true);
    const json = (await postSandbox("sandbox/prompts/generations", {
      manifest_patch: patch,
      note: patchNote.trim() || undefined,
    })) as { ok: boolean; error?: string };
    setBusy(false);
    if (json?.ok) {
      setPatchText("");
      setPatchNote("");
      void load();
    } else setError(json?.error ?? "创建失败");
  };

  return (
    <section className="panel lobby-card orch-section">
      <div className="lobby-card-header orch-adv-header">
        <div>
          <p className="eyebrow">Prompt Versions</p>
          <h2>裁判 / 优化器提示词管理</h2>
        </div>
        <div className="orch-adv-tools">
          {open && (
            <button
              className="compact-button"
              disabled={loading}
              onClick={() => void load()}
            >
              刷新
            </button>
          )}
          <button className="compact-button" onClick={() => setOpen((v) => !v)}>
            {open ? "收起" : "展开"}
          </button>
        </div>
      </div>
      <p className="muted-text orch-adv-intro">
        M0.7 提示词版本化:为裁判 / 优化器提示词新建版本并激活;运行时优先读激活
        generation 的 manifest,缺失回退文件。
      </p>
      {open && (
        <div className="orch-prompt-body">
          {error && <p className="error-text">{error}</p>}
          <p className="muted-text">
            当前激活 generation:{" "}
            <strong>
              {activeGen
                ? `${activeGen.id} (${activeGen.status})`
                : "无(全部回退文件)"}
            </strong>
          </p>
          <div className="orch-prompt-assets">
            {assets.map((a) => (
              <div key={a.asset_key} className="orch-prompt-asset">
                <div className="orch-prompt-asset-head">
                  <code>{a.asset_key}</code>
                  <span className="muted-text">
                    {a.source === "db" ? `v${a.active_version} (DB)` : "文件"} ·{" "}
                    {a.versions.length} 版本
                  </span>
                  <button
                    className="compact-button"
                    onClick={() => startEdit(a)}
                  >
                    {editKey === a.asset_key ? "编辑中" : "查看 / 改"}
                  </button>
                </div>
                {editKey === a.asset_key && (
                  <div className="orch-prompt-editor">
                    <textarea
                      rows={10}
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                    />
                    <div className="orch-tool-form">
                      <label className="field compact orch-tool-wide">
                        <span>备注(可选)</span>
                        <input
                          value={editNote}
                          onChange={(e) => setEditNote(e.target.value)}
                        />
                      </label>
                      <label className="orch-inline-check">
                        <input
                          type="checkbox"
                          checked={activateOnSave}
                          onChange={(e) => setActivateOnSave(e.target.checked)}
                        />
                        保存后激活
                      </label>
                    </div>
                    <div className="orch-prompt-editor-actions">
                      <button
                        className="compact-button"
                        disabled={busy}
                        onClick={saveAsset}
                      >
                        {busy ? "保存中…" : "保存为新版本"}
                      </button>
                      <button
                        className="compact-button"
                        onClick={() => setEditKey(null)}
                      >
                        取消
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="iter-section">
            <p className="eyebrow">Generations</p>
            <div className="orch-prompt-patch">
              <label className="field compact orch-tool-wide">
                <span>
                  组合 generation · manifest_patch(资产路径 → 版本号 JSON)
                </span>
                <textarea
                  rows={3}
                  value={patchText}
                  placeholder={'{"sandbox/judge/blind-suspicion-system.txt": 2}'}
                  onChange={(e) => setPatchText(e.target.value)}
                />
              </label>
              <div className="orch-prompt-editor-actions">
                <input
                  className="orch-prompt-patch-note"
                  value={patchNote}
                  placeholder="备注(可选)"
                  onChange={(e) => setPatchNote(e.target.value)}
                />
                <button
                  className="compact-button"
                  disabled={busy || !patchText.trim()}
                  onClick={() => void createGeneration()}
                >
                  {busy ? "创建中…" : "创建 generation"}
                </button>
              </div>
            </div>
            <div className="orch-prompt-gens">
              {generations.length === 0 && (
                <p className="muted-text">暂无 generation。</p>
              )}
              {generations.map((g) => (
                <div key={g.id} className="orch-prompt-gen">
                  <div>
                    <strong>{g.id}</strong>
                    <span className={`orch-status orch-status-${g.status}`}>
                      {g.status}
                    </span>
                    {g.is_best && <span className="muted-text"> · best</span>}
                    {g.note && <span className="muted-text"> · {g.note}</span>}
                  </div>
                  <button
                    className="compact-button"
                    disabled={busy || activeGen?.id === g.id}
                    onClick={() => void activate(g.id)}
                  >
                    {activeGen?.id === g.id ? "已激活" : "激活"}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

interface LlmCall {
  id: string;
  timestamp: string;
  stage: string;
  model: string;
  match_id?: string;
  round?: number;
  attempt: number;
  ok: boolean;
  duration_ms: number;
  total_tokens?: number;
  cached_tokens?: number;
  error?: string;
}

function LlmCallsPanel() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [calls, setCalls] = useState<LlmCall[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const json = (await getSandbox("sandbox/llm-calls?limit=200")) as {
      ok: boolean;
      calls?: LlmCall[];
      error?: string;
    };
    setLoading(false);
    if (json?.ok) setCalls(json.calls ?? []);
    else setError(json?.error ?? "加载失败");
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const clear = async () => {
    await deleteSandbox("sandbox/llm-calls");
    void load();
  };

  return (
    <section className="panel lobby-card orch-section">
      <div className="lobby-card-header orch-adv-header">
        <div>
          <p className="eyebrow">Observability</p>
          <h2>LLM 调用可观测</h2>
        </div>
        <div className="orch-adv-tools">
          {open && (
            <>
              <button
                className="compact-button"
                disabled={loading}
                onClick={() => void load()}
              >
                刷新
              </button>
              <button className="compact-button" onClick={() => void clear()}>
                清空
              </button>
            </>
          )}
          <button className="compact-button" onClick={() => setOpen((v) => !v)}>
            {open ? "收起" : "展开"}
          </button>
        </div>
      </div>
      <p className="muted-text orch-adv-intro">
        M0.6 进程内环形缓冲:裁判盲测 / 诊断、优化器提案、覆盖检查每次 LLM 调用的耗时
        / 重试 / token / cache,用于排查 partial 与成本。
      </p>
      {open && (
        <div className="orch-llm-body">
          {error && <p className="error-text">{error}</p>}
          {calls.length === 0 ? (
            <p className="muted-text">暂无调用记录。</p>
          ) : (
            <div className="orch-llm-table">
              <div className="orch-llm-row orch-llm-head">
                <span>时间</span>
                <span>stage</span>
                <span>模型</span>
                <span>状态</span>
                <span>耗时ms</span>
                <span>token(总/cache)</span>
              </div>
              {calls.map((c) => (
                <div
                  key={c.id}
                  className={`orch-llm-row ${c.ok ? "" : "orch-llm-fail"}`}
                  title={c.error ?? undefined}
                >
                  <span>{c.timestamp?.slice(11, 19) ?? "—"}</span>
                  <span>
                    {c.stage}
                    {c.attempt > 1 ? ` #${c.attempt}` : ""}
                  </span>
                  <span>{c.model}</span>
                  <span>{c.ok ? "ok" : "fail"}</span>
                  <span>{c.duration_ms}</span>
                  <span>
                    {c.total_tokens ?? "—"}
                    {c.cached_tokens ? ` / ${c.cached_tokens}` : ""}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
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

const GAME_SIDE_ORDER: Record<"champion" | "child", number> = {
  champion: 0,
  child: 1,
};

function compareGames(a: OrchestratorGame, b: OrchestratorGame): number {
  if (a.side !== b.side) return GAME_SIDE_ORDER[a.side] - GAME_SIDE_ORDER[b.side];
  if ((a.child_id ?? "") !== (b.child_id ?? "")) {
    return (a.child_id ?? "").localeCompare(b.child_id ?? "");
  }
  if (a.scenario_id !== b.scenario_id) return a.scenario_id < b.scenario_id ? -1 : 1;
  if (a.seed !== b.seed) return a.seed - b.seed;
  return a.run - b.run;
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

function phaseLabel(phase?: string): string {
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

function GameRow({
  g,
  onViewLive,
  onViewScore,
}: {
  g: OrchestratorGame;
  onViewLive: (roomId: string) => void;
  onViewScore: (matchId: string) => void;
}) {
  return (
    <div className={`orch-game-row status-${g.status}`}>
      <span className={`room-tag ${g.side === "champion" ? "" : "muted-tag"}`}>
        {g.side === "champion" ? "父" : `子${g.child_id ? `:${g.child_id.slice(-6)}` : ""}`}
      </span>
      <span className="orch-game-key">
        {g.scenario_id} · s{g.seed} · r{g.run}
      </span>
      <span className={`orch-game-status status-${g.status}`}>
        {gameStatusLabel(g.status)}
      </span>
      {g.status === "running" && (
        <span className="orch-game-detail">
          {phaseLabel(g.phase)} · 第 {g.current_round ?? "-"} 轮 · AI{" "}
          {g.ai_alive ?? "-"}/{g.ai_total ?? "-"}
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
      {g.status === "failed" && (
        <span className="orch-game-error">{g.error ?? "失败"}</span>
      )}
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
          title={g.match_id ? "查看裁判打分详情" : "尚未完成打分"}
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

type ScoreDetail = {
  scenario_form?: string;
  seed?: number;
  run_index?: number;
  prompt_version_id?: string;
  status?: string;
  judges?: string[];
  errors?: string[];
  veto_triggered?: boolean;
  blind_suspicion?: {
    ai_final?: number | null;
    suspicion_rank?: number | null;
    suspicion_margin?: number | null;
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

function TriedMemoryModal({
  entries,
  busy,
  onClose,
  onDelete,
  onClear,
}: {
  entries: OrchestratorTriedEntry[];
  busy: boolean;
  onClose: () => void;
  onDelete: (versionId: string) => void;
  onClear: () => void;
}) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  return (
    <div className="iteration-modal-overlay" onClick={onClose}>
      <div
        className="iteration-modal iter-score-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="iteration-modal-head">
          <div>
            <p className="eyebrow">失败记忆(tried_and_rejected)</p>
            <h3>共 {entries.length} 条</h3>
          </div>
          <div className="iteration-modal-tools">
            <button
              className="compact-button"
              disabled={busy || entries.length === 0}
              onClick={onClear}
              title="清空全部失败记忆"
            >
              清空全部
            </button>
            <button className="compact-button" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>

        <div className="iter-score-modal-body">
          {entries.length === 0 ? (
            <p className="muted-text">暂无失败记忆。</p>
          ) : (
            <div className="orch-tried-list">
              {entries.map((e, i) => (
                <div key={`${e.version_id}-${i}`} className="orch-tried-row">
                  <div className="orch-tried-head">
                    <strong>{e.version_id}</strong>
                    <span className="muted-text">第 {e.generation} 代</span>
                    {e.target_dimension && (
                      <span className="room-tag muted-tag">{e.target_dimension}</span>
                    )}
                    {e.edit_type && (
                      <span className="room-tag muted-tag">{e.edit_type}</span>
                    )}
                    <button
                      className="compact-button orch-tried-delete"
                      disabled={busy}
                      onClick={() => onDelete(e.version_id)}
                    >
                      删除
                    </button>
                  </div>
                  {e.hypothesis && (
                    <p className="orch-tried-hyp">假设:{e.hypothesis}</p>
                  )}
                  <p className="orch-tried-reason muted-text">
                    拒因:{e.reason}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function GenerationDetailModal({
  generation,
  onClose,
  onDiff,
}: {
  generation: OrchestratorGeneration;
  onClose: () => void;
  onDiff: (child: OrchestratorGeneration["children_evaluated"][number]) => void;
}) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  return (
    <div className="iteration-modal-overlay" onClick={onClose}>
      <div
        className="iteration-modal iter-score-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="iteration-modal-head">
          <div>
            <p className="eyebrow">历史代详情 · {generation.generation_id}</p>
            <h3>
              第 {generation.generation} 代 · {generation.champion_before} →{" "}
              {generation.champion_after}
            </h3>
          </div>
          <button className="compact-button" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="iter-score-modal-body">
          <div className="orch-kv-list">
            <span className="muted-text">评测集</span>
            <strong>{generation.eval_set_version}</strong>
            <span className="muted-text">模式</span>
            <strong>{generation.mode}</strong>
            <span className="muted-text">时间</span>
            <strong>{new Date(generation.timestamp).toLocaleString()}</strong>
            <span className="muted-text">种群</span>
            <strong>{generation.population_after.join(", ") || "—"}</strong>
          </div>

          {generation.children_evaluated.map((child) => (
            <div key={child.child_id} className="iter-analysis">
              <div className="orch-tried-head">
                <strong>{child.child_id}</strong>
                <span
                  className="room-tag"
                  style={{
                    background: child.decision === "promoted" ? "#2e7d32" : "#b42318",
                  }}
                >
                  {child.decision === "promoted" ? "晋升" : "拒绝"}
                </span>
                {child.target_dimension && (
                  <span className="room-tag muted-tag">{child.target_dimension}</span>
                )}
                {child.edit_type && (
                  <span className="room-tag muted-tag">{child.edit_type}</span>
                )}
                <button className="compact-button orch-tried-delete" onClick={() => onDiff(child)}>
                  看 diff
                </button>
              </div>

              {child.hypothesis && (
                <p className="orch-tried-hyp">假设:{child.hypothesis}</p>
              )}

              <div className="orch-kv-list">
                <span className="muted-text">父代</span>
                <strong>{child.based_on}</strong>
                <span className="muted-text">闸门</span>
                <strong>{child.gate?.decision === "promote" ? "建议晋升" : child.gate ? "建议拒绝" : "—"}</strong>
                <span className="muted-text">留出</span>
                <strong>
                  {child.holdout
                    ? child.holdout.holds
                      ? "通过"
                      : "未通过"
                    : "—"}
                </strong>
              </div>

              <ValidationMetrics validation={child.validation} />

              {child.gate?.reasons?.length ? (
                <div className="iter-section">
                  <p className="eyebrow">闸门理由</p>
                  <ul className="orch-reasons">
                    {child.gate.reasons.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {child.holdout && (
                <div className="iter-section">
                  <p className="eyebrow">留出复核 · {child.holdout.eval_set}</p>
                  <div className="orch-kv-list">
                    <span className="muted-text">保留探测</span>
                    <strong>{child.holdout.held_out_probes ? "是" : "否"}</strong>
                    <span className="muted-text">margin 配对差</span>
                    <strong>{fmtScore(child.holdout.blind_suspicion_margin_paired_diff)}</strong>
                    <span className="muted-text">CI95</span>
                    <strong>
                      {child.holdout.ci95
                        ? `[${child.holdout.ci95[0].toFixed(2)}, ${child.holdout.ci95[1].toFixed(2)}]`
                        : "—"}
                    </strong>
                  </div>
                  {child.holdout.reasons.length > 0 && (
                    <ul className="orch-reasons">
                      {child.holdout.reasons.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          ))}

          {generation.tried_and_rejected_added.length > 0 && (
            <div className="iter-section">
              <p className="eyebrow">本代新增失败记忆</p>
              <p className="muted-text">{generation.tried_and_rejected_added.join(", ")}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ScoreDetailModal({
  matchId,
  onClose,
}: {
  matchId: string;
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
    fetch(`${API_URL}/sandbox/score/${encodeURIComponent(matchId)}`)
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
  }, [matchId]);

  const blind = score?.blind_suspicion;
  const outcome = score?.outcome_metrics;
  const perRound = blind?.per_round ?? [];
  const votes = outcome?.votes_received_by_round ?? {};
  const plurality = outcome?.plurality_by_round ?? {};
  const probes = outcome?.probe_pass_by_type ?? {};

  return (
    <div className="iteration-modal-overlay" onClick={onClose}>
      <div
        className="iteration-modal iter-score-modal"
        onClick={(e) => e.stopPropagation()}
      >
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
                <Metric
                  label="可疑度 margin"
                  value={fmtScore(blind?.suspicion_margin)}
                />
                <Metric label="可疑度排名" value={blind?.suspicion_rank ?? "—"} />
                <Metric label="局末 ai_score" value={fmtScore(blind?.ai_final)} />
                <Metric
                  label="存活轮数"
                  value={outcome?.rounds_survived ?? "—"}
                />
                <Metric
                  label="结果"
                  value={outcome?.won ? "AI 胜" : "AI 负"}
                />
                <Metric
                  label="否决"
                  value={score.veto_triggered ? "是" : "否"}
                />
              </div>

              {score.status && score.status !== "ok" && (
                <p className="orch-game-error">
                  评分状态:{score.status}
                  {score.errors?.length ? `(${score.errors.join("; ")})` : ""}
                </p>
              )}

              {perRound.length > 0 && (
                <div className="iter-section">
                  <p className="eyebrow">逐轮可疑度</p>
                  <div className="orch-table">
                    {perRound.map((r) => (
                      <div key={r.round} className="orch-table-row">
                        <span>第 {r.round} 轮</span>
                        <span className="orch-margin">
                          ai_score{" "}
                          <strong>{fmtScore(r.ai_score)}</strong>
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
                <pre className="iter-detail-pre">
                  {JSON.stringify(score, null, 2)}
                </pre>
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
  return entries.length === 0
    ? ""
    : entries.map(([k, v]) => `R${k}:${v}`).join("  ");
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

function GateMetrics({ run }: { run: OrchestratorActiveRun }) {
  return <ValidationMetrics validation={run.validation} />;
}

function ValidationMetrics({ validation }: { validation?: OrchestratorValidation }) {
  const bucket = validation?.buckets[0];
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
