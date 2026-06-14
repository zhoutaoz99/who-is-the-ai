"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { useAuth } from "../lib/auth-client";
import { useGameClient } from "../lib/game-client";
import type {
  GenerationSummary,
  IterationGameResult,
  IterationRunStatus,
} from "../lib/game-types";

const API_URL =
  process.env.NEXT_PUBLIC_API_URL ||
  (typeof window !== "undefined"
    ? `${window.location.protocol}//${window.location.hostname}:3001`
    : "http://localhost:3001");

const ASSET_KEYS = [
  "ai-player/system-speech-strategy.txt",
  "ai-player/system-speech-expression.txt",
  "ai-player/system-vote.txt",
  "ai-player/user-speech-strategy-template.txt",
  "ai-player/user-speech-expression-template.txt",
  "ai-player/user-vote-template.txt",
  "ai-player/personas",
];

const TELL_LABELS: Record<string, string> = {
  round1PushVote: "首轮带节奏",
  singleCharWhenNamed: "被点名单字",
  sampleLineCopy: "照抄示例句",
  lockstepBlockVote: "AI 锁步同投",
  formulaicVoteReason: "投票理由同质",
  teammateMisfire: "误投队友",
  postProvocationSkip: "挑衅后消失",
  templatePhrase: "模板话术",
};

export default function IterationPage() {
  const router = useRouter();
  const { user, logout } = useAuth();
  const {
    debug,
    connected,
    iterationRun,
    startIteration,
    continueIteration,
    stopIteration,
    refreshIteration,
  } = useGameClient();

  const [rounds, setRounds] = useState(4);
  const [gamesPerRound, setGamesPerRound] = useState(6);
  const [duration, setDuration] = useState(1);
  const [durationUnit, setDurationUnit] = useState<"min" | "sec">("min");
  const [busy, setBusy] = useState(false);
  const [pageError, setPageError] = useState("");

  // 版本管理
  const [generations, setGenerations] = useState<GenerationSummary[]>([]);
  const [activeGenId, setActiveGenId] = useState<string | null>(null);
  const [selectedGenId, setSelectedGenId] = useState<string | null>(null);
  const [editorAsset, setEditorAsset] = useState(ASSET_KEYS[0]);
  const [editorContent, setEditorContent] = useState("");
  const [editorNote, setEditorNote] = useState("");
  const [editorBusy, setEditorBusy] = useState(false);

  const fetchGenerations = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/debug/prompts/generations`);
      const json = await res.json();
      if (json?.ok) {
        setGenerations(json.generations ?? []);
        setActiveGenId(json.active ?? null);
        setSelectedGenId((cur) => cur ?? (json.active ?? null));
      }
    } catch {
      /* ignore */
    }
  }, []);

  const loadAsset = useCallback(async (genId: string | null, key: string) => {
    if (!genId) {
      setEditorContent("");
      return;
    }
    setEditorBusy(true);
    try {
      const res = await fetch(`${API_URL}/debug/prompts/generations/${genId}`);
      const json = await res.json();
      const gen = json?.generation;
      if (gen) {
        setEditorContent(
          key === "ai-player/personas"
            ? JSON.stringify(gen.personas, null, 2)
            : (gen.prompts[key] ?? ""),
        );
      }
    } catch {
      /* ignore */
    } finally {
      setEditorBusy(false);
    }
  }, []);

  useEffect(() => {
    fetchGenerations();
  }, [fetchGenerations]);

  // 选中版本或切换 asset 时,加载该版本的对应提示词到右侧查看/编辑。
  useEffect(() => {
    loadAsset(selectedGenId, editorAsset);
  }, [selectedGenId, editorAsset, loadAsset]);

  const handleSelectGen = (genId: string) => {
    setSelectedGenId(genId);
    setEditorNote("");
  };

  // 版本差异弹窗(父代 vs 选中代)
  const [diffOpen, setDiffOpen] = useState(false);
  const [diffAsset, setDiffAsset] = useState(ASSET_KEYS[0]);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffParent, setDiffParent] = useState<GenDetail | null>(null);
  const [diffSelected, setDiffSelected] = useState<GenDetail | null>(null);

  const selectedGen = generations.find((g) => g.id === selectedGenId) ?? null;
  const hasParent = Boolean(selectedGen?.parentId);

  const openDiff = async () => {
    if (!selectedGenId || !selectedGen?.parentId) return;
    setDiffAsset(editorAsset);
    setDiffOpen(true);
    setDiffLoading(true);
    try {
      const [pRes, sRes] = await Promise.all([
        fetch(`${API_URL}/debug/prompts/generations/${selectedGen.parentId}`).then((r) => r.json()),
        fetch(`${API_URL}/debug/prompts/generations/${selectedGenId}`).then((r) => r.json()),
      ]);
      setDiffParent(pRes?.generation ?? null);
      setDiffSelected(sRes?.generation ?? null);
    } finally {
      setDiffLoading(false);
    }
  };

  const handleStart = async () => {
    setBusy(true);
    setPageError("");
    const seconds = durationUnit === "min" ? duration * 60 : duration;
    const res = await startIteration({ rounds, gamesPerRound, discussionSeconds: seconds });
    setBusy(false);
    if (!res.ok) setPageError(res.error ?? "启动失败");
  };

  const handleContinue = async () => {
    setBusy(true);
    const res = await continueIteration();
    setBusy(false);
    if (!res.ok) setPageError(res.error ?? "继续失败");
  };

  const handleStop = async () => {
    await stopIteration();
    await refreshIteration();
    fetchGenerations();
  };

  const handleActivate = async (genId: string) => {
    await fetch(`${API_URL}/debug/prompts/active`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ generationId: genId }),
    });
    await fetchGenerations();
  };

  const handleMarkBest = async (genId: string) => {
    await fetch(`${API_URL}/debug/prompts/best`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ generationId: genId }),
    });
    await fetchGenerations();
  };

  const handleCreateGeneration = async () => {
    if (!selectedGenId) return;
    setEditorBusy(true);
    setPageError("");
    try {
      const res = await fetch(`${API_URL}/debug/prompts/generation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fromGenId: selectedGenId,
          changedAssets: { [editorAsset]: editorContent },
          note: editorNote || undefined,
        }),
      });
      const json = await res.json();
      if (!json?.ok) {
        setPageError(json?.error ?? "创建失败");
        return;
      }
      await fetchGenerations();
      if (json.generation?.id) setSelectedGenId(json.generation.id);
      setEditorNote("");
    } finally {
      setEditorBusy(false);
    }
  };

  if (!debug) {
    return (
      <main className="shell lobby-shell">
        <header className="lobby-header">{brand()}</header>
        <section className="panel lobby-card">
          <p className="muted-text">调试模式未开启,无法使用自动迭代入口。</p>
          <button className="secondary" onClick={() => router.push("/")}>
            返回首页
          </button>
        </section>
      </main>
    );
  }

  const run = iterationRun;
  const isRunning = run?.status === "running";
  const isAwaiting = run?.status === "awaiting_activation";
  const doneInRound = run?.currentRoundGames?.length ?? 0;
  const totalInRound = run?.gamesPerRound ?? gamesPerRound;
  const progressPct = totalInRound > 0 ? Math.min(100, (doneInRound / totalInRound) * 100) : 0;

  return (
    <>
    <main className="shell lobby-shell">
      <header className="lobby-header">
        {brand()}
        <div className="topbar-actions">
          <div className={`connection-pill ${connected ? "online" : "offline"}`}>
            <span className={`status-dot ${connected ? "online" : "offline"}`} />
            {connected ? "已连接" : "未连接"}
          </div>
          <button
            className="action-pill"
            onClick={() => router.push("/")}
          >
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
        {/* 控制区 */}
        <section className="panel lobby-card">
          <div className="lobby-card-header">
            <div>
              <p className="eyebrow">Auto Iteration</p>
              <h2>自动对局评估自迭代</h2>
            </div>
          </div>
          <p className="muted-text">
            点击「开始迭代」用当前 active 代跑一批无头对局并打分;轮间在右侧版本面板创建/激活新代后点「继续下一轮」。
          </p>

          {isRunning || isAwaiting ? (
            <div className="iteration-controls iteration-controls-readonly">
              <div className="iter-param">
                <span className="muted-text">每轮局数 B</span>
                <strong>{run?.gamesPerRound ?? gamesPerRound}</strong>
              </div>
              <div className="iter-param">
                <span className="muted-text">轮数 K</span>
                <strong>{run?.totalRounds ?? rounds}</strong>
              </div>
              <div className="iter-param">
                <span className="muted-text">讨论时长</span>
                <strong>{fmtDuration(run?.discussionSeconds ?? duration * (durationUnit === "min" ? 60 : 1))}</strong>
              </div>
            </div>
          ) : (
            <div className="iteration-controls">
              <label>
                每轮局数 B
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={gamesPerRound}
                  onChange={(e) => setGamesPerRound(Number(e.target.value))}
                />
              </label>
              <label>
                轮数 K
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={rounds}
                  onChange={(e) => setRounds(Number(e.target.value))}
                />
              </label>
              <label>
                讨论时长
                <div className="iter-duration-input">
                  <input
                    type="number"
                    min={durationUnit === "min" ? 1 : 10}
                    max={durationUnit === "min" ? 10 : 600}
                    value={duration}
                    onChange={(e) => setDuration(Number(e.target.value))}
                  />
                  <select
                    value={durationUnit}
                    onChange={(e) => setDurationUnit(e.target.value as "min" | "sec")}
                  >
                    <option value="min">分</option>
                    <option value="sec">秒</option>
                  </select>
                </div>
              </label>
            </div>
          )}

          <div className="iteration-actions">
            {!isRunning && !isAwaiting && (
              <button
                className="primary-action"
                disabled={busy}
                onClick={handleStart}
              >
                {busy ? "启动中…" : "开始迭代"}
              </button>
            )}
            {isRunning && (
              <button className="secondary" onClick={handleStop}>
                停止
              </button>
            )}
            {isAwaiting && (
              <>
                <button
                  className="primary-action"
                  disabled={busy}
                  onClick={handleContinue}
                >
                  {busy ? "继续中…" : "继续下一轮"}
                </button>
                <button className="secondary" onClick={handleStop} title="放弃本次迭代,释放占用以便重新开始">
                  停止本次
                </button>
              </>
            )}
          </div>

          {pageError && <p className="error-text">{pageError}</p>}

          {run && (
            <div className="iteration-status-row">
              <span>
                状态:<strong>{statusLabel(run.status)}</strong>
              </span>
              <span>
                第 <strong>{run.currentRound}</strong>/{run.totalRounds} 轮
              </span>
              <span>
                active 代:<strong>{run.activeGenerationId ?? "-"}</strong>
              </span>
            </div>
          )}
        </section>

        {/* 实时进度 */}
        <section className="panel lobby-card">
          <div className="lobby-card-header">
            <div>
              <p className="eyebrow">Live Progress</p>
              <h2>实时进度</h2>
            </div>
          </div>

          {/* 当前步骤说明 */}
          {run && (
            <div className="iter-progress-step">
              <span className={`iter-step-badge step-${run.status}`}>
                {statusLabel(run.status)}
              </span>
              <span className="iter-step-text">
                {currentStepText(run, doneInRound, totalInRound)}
              </span>
            </div>
          )}

          {/* 轮次 stepper */}
          {run && (
            <div className="iter-stepper">
              {Array.from({ length: run.totalRounds }, (_, i) => i + 1).map((r) => {
                const completed = run.rounds.find((rr) => rr.round === r);
                const isCur = r === run.currentRound;
                const state = completed
                  ? "done"
                  : isCur && isRunning
                    ? "active"
                    : isCur
                      ? "now"
                      : "pending";
                return (
                  <div key={r} className={`iter-step ${state}`}>
                    <div className="iter-step-num">{completed ? "✓" : r}</div>
                    <div className="iter-step-meta">
                      {completed?.aggregate
                        ? `拟人 ${completed.aggregate.humanLikeScore.mean}`
                        : isCur && isRunning
                          ? `${doneInRound}/${totalInRound}局`
                          : ""}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* 双进度条:整体 + 本轮 */}
          {run && (
            <div className="iter-bars">
              <ProgressBar
                label={`整体进度 ${run.rounds.length}/${run.totalRounds} 轮`}
                value={run.rounds.length}
                max={run.totalRounds}
              />
              {isRunning && (
                <ProgressBar
                  label={`本轮对局 ${doneInRound}/${totalInRound}`}
                  value={doneInRound}
                  max={totalInRound}
                />
              )}
            </div>
          )}

          {/* 本轮逐局结果 */}
          <div className="iteration-game-list">
            <p className="eyebrow">本轮逐局</p>
            {(run?.currentRoundGames ?? []).slice().reverse().map((g, i) => (
              <GameCard
                key={`${g.roomId}-${i}`}
                g={g}
                onViewReplay={(id) => router.push(`/replay/${id}`)}
              />
            ))}
            {!run?.currentRoundGames?.length && (
              <p className="muted-text">尚未开始或本轮无数据。</p>
            )}
          </div>

          {/* 各轮分数趋势 */}
          {(run?.rounds ?? []).length > 0 && (
            <div className="iteration-round-trend">
              <p className="eyebrow">各轮 scorecard</p>
              {run!.rounds.map((r) => (
                <RoundCard key={r.round} round={r} />
              ))}
            </div>
          )}
        </section>
      </section>

      {/* 版本管理(全宽,左列表 / 右查看) */}
      <section className="panel lobby-card iteration-version-section">
          <div className="lobby-card-header">
            <div>
              <p className="eyebrow">Prompt Versions</p>
              <h2>版本谱系与激活</h2>
            </div>
            <button className="compact-button" onClick={fetchGenerations}>
              刷新
            </button>
          </div>

          <div className="iteration-version-layout">
            {/* 左:版本列表 */}
            <div className="iteration-version-list">
              {generations.length === 0 && (
                <p className="muted-text">暂无版本。</p>
              )}
              {generations.map((g) => (
                <div
                  key={g.id}
                  className={`iteration-version-item ${g.id === selectedGenId ? "selected" : ""} ${g.id === activeGenId ? "active" : ""}`}
                  onClick={() => handleSelectGen(g.id)}
                >
                  <div className="iteration-gen-head">
                    <strong>{g.id}</strong>
                    {g.id === activeGenId && <span className="room-tag">ACTIVE</span>}
                    {g.isBest && <span className="room-tag">BEST</span>}
                  </div>
                  <div className="muted-text">← {g.parentId ?? "种子"}</div>
                  <div className="muted-text">{genScoreText(g)}</div>
                  {g.note && <div className="muted-text iteration-version-note">{g.note}</div>}
                  <div
                    className="iteration-gen-actions"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {g.id !== activeGenId && (
                      <button
                        className="compact-button"
                        onClick={() => handleActivate(g.id)}
                      >
                        激活
                      </button>
                    )}
                    <button
                      className="compact-button"
                      onClick={() => handleMarkBest(g.id)}
                    >
                      标记最佳
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* 右:选中版本的提示词查看/编辑 */}
            <div className="iteration-version-detail">
              <div className="iteration-version-detail-head">
                <div>
                  <p className="eyebrow">选中版本</p>
                  <h3>{selectedGenId ?? "请在左侧选择一个版本"}</h3>
                </div>
                <div className="iteration-version-detail-tools">
                  <select
                    value={editorAsset}
                    onChange={(e) => setEditorAsset(e.target.value)}
                    disabled={!selectedGenId}
                  >
                    {ASSET_KEYS.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                  <button
                    className="compact-button"
                    disabled={!hasParent}
                    title={hasParent ? "对比父代与当前版本" : "该版本无父代"}
                    onClick={openDiff}
                  >
                    与父代对比
                  </button>
                </div>
              </div>
              <textarea
                className="iteration-editor-textarea"
                value={editorContent}
                rows={20}
                onChange={(e) => setEditorContent(e.target.value)}
                placeholder={selectedGenId ? "查看或编辑该 asset;编辑后可创建新版本" : "—"}
              />
              <input
                type="text"
                value={editorNote}
                onChange={(e) => setEditorNote(e.target.value)}
                placeholder="改动说明(可选)"
              />
              <button
                className="primary-action"
                disabled={editorBusy || !selectedGenId}
                onClick={handleCreateGeneration}
              >
                {editorBusy ? "创建中…" : `从 ${selectedGenId ?? ""} 创建新代`}
              </button>
              <p className="muted-text">
                编辑上方内容后创建新代(继承此版本,仅改动当前 asset);创建后需在左侧对应行点「激活」生效。
              </p>
            </div>
          </div>
        </section>
      </main>

      {diffOpen && (
        <div className="iteration-modal-overlay" onClick={() => setDiffOpen(false)}>
          <div className="iteration-modal" onClick={(e) => e.stopPropagation()}>
            <div className="iteration-modal-head">
              <div>
                <p className="eyebrow">版本差异(父代 → 当前)</p>
                <h3>
                  {diffParent?.generationId ?? selectedGen?.parentId ?? "?"}
                  {" → "}
                  {diffSelected?.generationId ?? selectedGenId}
                </h3>
              </div>
              <div className="iteration-modal-tools">
                <select value={diffAsset} onChange={(e) => setDiffAsset(e.target.value)}>
                  {ASSET_KEYS.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
                <button className="compact-button" onClick={() => setDiffOpen(false)}>
                  关闭
                </button>
              </div>
            </div>
            <div className="iteration-modal-legend">
              <span className="diff-line diff-add">+ 新增</span>
              <span className="diff-line diff-del">- 删除</span>
              <span className="muted-text">
                {diffLoading
                  ? "加载中…"
                  : diffParent && diffSelected
                    ? `${diffAsset}: ${diffStats(assetContent(diffParent, diffAsset), assetContent(diffSelected, diffAsset))}`
                    : "无法加载版本"}
              </span>
            </div>
            <div className="iteration-modal-diff">
              {diffLoading ? (
                <p className="muted-text">加载中…</p>
              ) : !diffParent || !diffSelected ? (
                <p className="muted-text">无法加载版本详情。</p>
              ) : (
                renderDiff(
                  lineDiff(
                    assetContent(diffParent, diffAsset),
                    assetContent(diffSelected, diffAsset),
                  ),
                )
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function RoundCard({ round }: { round: IterationRunStatus["rounds"][number] }) {
  const a = round.aggregate;
  if (!a) {
    return (
      <div className="stat-card">
        <div>
          第 {round.round} 轮 · 代 {round.generationId ?? "-"} · {round.games.length} 局
        </div>
        <div className="muted-text">无有效分数</div>
      </div>
    );
  }
  const tellsSorted = Object.entries(a.tells)
    .filter(([, v]) => v > 0)
    .sort((x, y) => y[1] - x[1]);
  return (
    <div className="stat-card iter-round-card">
      <div className="iter-round-head">
        <strong>
          第 {round.round} 轮 · 代 {round.generationId ?? "-"}
        </strong>
        <span className="muted-text">
          {a.n} 局 · AI 胜率 {pct(a.aiWinRate)}
        </span>
      </div>
      <div className="stat-card-row">
        <span>拟人 {a.humanLikeScore.mean} ± {a.humanLikeScore.se}</span>
        <span>自然度 {a.naturalnessAiVsHuman.mean}</span>
        <span>威胁定位 {a.voteThreatTargeting.mean}</span>
      </div>

      {/* tells 迷你条形图 */}
      <div className="iter-tells">
        {tellsSorted.length === 0 ? (
          <span className="muted-text">无 tell 命中 🎉</span>
        ) : (
          tellsSorted.map(([k, v]) => {
            const rate = a.tellGameRates[k] ?? 0;
            return (
              <div key={k} className="iter-tell-row">
                <span className="iter-tell-label">{TELL_LABELS[k] ?? k}</span>
                <div className="iter-tell-bar">
                  <div className="iter-tell-fill" style={{ width: `${Math.round(rate * 100)}%` }} />
                </div>
                <span className="iter-tell-count">{v}</span>
              </div>
            );
          })
        )}
      </div>

      {a.topIssues[0] && (
        <div className="muted-text">主要问题:{a.topIssues[0].issue}</div>
      )}
    </div>
  );
}

function ProgressBar({ label, value, max }: { label: string; value: number; max: number }) {
  const pctv = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="iter-bar">
      <div className="iter-bar-label">{label}</div>
      <div className="timer-track">
        <div className="timer-fill" style={{ width: `${pctv}%`, transition: "width 0.5s linear" }} />
      </div>
    </div>
  );
}

function currentStepText(
  run: IterationRunStatus,
  doneInRound: number,
  totalInRound: number,
): string {
  switch (run.status) {
    case "running":
      return `第 ${run.currentRound}/${run.totalRounds} 轮进行中:已跑 ${doneInRound}/${totalInRound} 局,跑完自动逐局打分并聚合成 scorecard`;
    case "awaiting_activation":
      return `第 ${run.currentRound} 轮已完成。请在「版本谱系」创建/激活下一代,再点「继续下一轮」`;
    case "completed":
      return `全部 ${run.totalRounds} 轮已完成`;
    case "stopped":
      return `已停止(共完成 ${run.rounds.length} 轮)`;
    case "failed":
      return `失败:${run.error ?? "未知错误"}`;
    default:
      return "";
  }
}

function winnerLabel(w: string | null): string {
  return w === "ai" ? "AI 胜" : w === "human" ? "真人胜" : "—";
}

function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s > 0 && s % 60 === 0) return `${s / 60} 分钟`;
  return `${s} 秒`;
}

// 冻结打分尺子(system prompt)全局缓存,首次打开详情弹窗时拉取一次。
let scorerPromptCache: string | null = null;

const TELL_DESCRIPTIONS: Record<string, string> = {
  round1PushVote: "第一轮怂恿投票/带节奏(投就完了/直接投/催投票)",
  singleCharWhenNamed: "被点名只回单字(在/额/嗯)",
  sampleLineCopy: "照抄人格示例句或换字拼接",
  lockstepBlockVote: "两名 AI 投票目标完全一致的轮次",
  formulaicVoteReason: "投票理由同质化(太积极/追着问)",
  teammateMisfire: "投给己方另一名 AI",
  postProvocationSkip: "抛挑衅/被点名后连续 skip 消失",
  templatePhrase: "模板话术(先看看/先听听/观察一下/带节奏/有点可疑)",
};

function GameCard({
  g,
  onViewReplay,
}: {
  g: IterationGameResult;
  onViewReplay: (roomId: string) => void;
}) {
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <div className={`iter-game-card ${g.winner ?? ""}`}>
      <div className="iter-game-head">
        <span className="room-tag">{g.roomId}</span>
        <span className={`iter-winner ${g.winner ?? ""}`}>
          {winnerLabel(g.winner)}
        </span>
      </div>
      {g.error ? (
        <span className="error-text">失败:{g.error}</span>
      ) : (
        <div className="iter-game-body">
          <div className="iter-game-score">
            <span className="muted-text">拟人度</span>
            <strong>{g.humanLikeScore ?? "-"}</strong>
          </div>
          <div className="iter-score-bar">
            <div
              className="iter-score-fill"
              style={{ width: `${g.humanLikeScore ?? 0}%` }}
            />
          </div>
          <button className="compact-button" onClick={() => onViewReplay(g.roomId)}>
            复盘 →
          </button>
          <button className="compact-button" onClick={() => setModalOpen(true)}>
            打分详情
          </button>
        </div>
      )}
      {modalOpen && !g.error && (
        <ScoreDetailModal g={g} onClose={() => setModalOpen(false)} />
      )}
    </div>
  );
}

type ScoreData = Record<string, any>;

function ScoreDetailModal({
  g,
  onClose,
}: {
  g: IterationGameResult;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"score" | "replay" | "prompt" | "request">("score");
  const [replay, setReplay] = useState<Record<string, any> | null>(null);
  const [replayLoading, setReplayLoading] = useState(false);
  const [scorer, setScorer] = useState<string | null>(scorerPromptCache);
  const [scorerLoading, setScorerLoading] = useState(false);
  const [personas, setPersonas] = useState<Array<Record<string, any>> | null>(null);
  const [personasOpen, setPersonasOpen] = useState(false);
  const [scoreRequest, setScoreRequest] = useState<{
    system: string;
    user: string;
    config: { url: string; model: string; temperature: number; reasoningEffort: string; thinking: boolean };
  } | null>(null);
  const [requestLoading, setRequestLoading] = useState(false);

  // 弹窗打开时锁定底层页面滚动,关闭时恢复。
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    if (!scorerPromptCache) {
      setScorerLoading(true);
      fetch(`${API_URL}/debug/iterations/scorer-prompt`)
        .then((r) => r.json())
        .then((json) => {
          if (json?.ok) {
            scorerPromptCache = json.prompt;
            setScorer(json.prompt);
          }
        })
        .catch(() => {})
        .finally(() => setScorerLoading(false));
    }
    setReplayLoading(true);
    fetch(`${API_URL}/replay/${g.roomId}/export?includeUserPrompt=false`)
      .then((r) => r.json())
      .then((json) => {
        if (json?.ok) setReplay(json.data);
      })
      .catch(() => {})
      .finally(() => setReplayLoading(false));
    // 拉取该局所用代的完整人格定义,用于展示本局 AI 人格。
    if (g.generationId) {
      fetch(`${API_URL}/debug/prompts/generations/${g.generationId}`)
        .then((r) => r.json())
        .then((json) => {
          if (json?.ok) setPersonas(json.generation?.personas ?? []);
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const s: ScoreData | null = (g.score as ScoreData) ?? null;
  // 本局 AI 的人格 id:优先用 replay 的玩家表,回退到打分结果的 aiPersonas/perAi。
  const replayAiIds: string[] = (replay?.players ?? [])
    .filter((p: Record<string, any>) => p.revealedType === "ai" && p.aiPersonaId)
    .map((p: Record<string, any>) => p.aiPersonaId);
  const fallbackIds: string[] = Array.isArray(s?.aiPersonas)
    ? s.aiPersonas
    : Array.isArray(s?.perAi)
      ? s.perAi.map((p: Record<string, any>) => p.personaId).filter(Boolean)
      : [];
  const aiPersonaIds: string[] = replayAiIds.length ? replayAiIds : fallbackIds;
  const gamePersonas: Array<Record<string, any>> = (personas ?? []).filter((p) =>
    aiPersonaIds.includes(p.id),
  );
  const tells: Record<string, number> = s?.tells ?? {};
  const totalTells = Object.values(tells).reduce((a, b) => a + (Number(b) || 0), 0);
  const tellsSorted = Object.entries(tells).sort((x, y) => (Number(y[1]) || 0) - (Number(x[1]) || 0));
  const perAi: Array<Record<string, any>> = Array.isArray(s?.perAi) ? s.perAi : [];
  const topIssues: string[] = Array.isArray(s?.topIssues) ? s.topIssues : [];

  // 懒加载:首次切到「完整请求」tab 时,从后端取该局打分的真实请求(system+user+config)。
  const loadScoreRequest = async () => {
    if (scoreRequest || requestLoading) return;
    setRequestLoading(true);
    try {
      const res = await fetch(`${API_URL}/debug/iterations/score-request/${g.roomId}`);
      const json = await res.json();
      if (json?.ok) setScoreRequest(json.request);
    } catch {
      /* ignore */
    } finally {
      setRequestLoading(false);
    }
  };

  return createPortal(
    <div className="iteration-modal-overlay" onClick={onClose}>
      <div
        className="iteration-modal iter-score-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="iteration-modal-head">
          <div>
            <p className="eyebrow">打分详情 · {g.roomId}</p>
            <h3>
              {winnerLabel(g.winner)} · 代 {g.generationId ?? "-"} · 拟人{" "}
              {g.humanLikeScore ?? "-"}
            </h3>
          </div>
          <button className="compact-button" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="iter-score-modal-body">
          {/* 指标卡 */}
          <div className="iter-metric-grid">
            <Metric label="拟人度 (0-100)" value={num(s?.humanLikeScore)} />
            <Metric label="自然度 (1-5)" value={num(s?.naturalnessAiVsHuman)} />
            <Metric label="威胁定位 (1-5)" value={num(s?.voteThreatTargeting)} />
            <Metric label="AI 胜" value={s?.aiWin ? "是" : "否"} />
            <Metric label="存活 AI" value={num(s?.aiSurvivors)} />
            <Metric label="进行轮数" value={num(s?.roundsPlayed)} />
          </div>

          {/* AI 存活 */}
          {perAi.length > 0 && (
            <div className="iter-section">
              <p className="eyebrow">AI 存活情况</p>
              <div className="iter-perai">
                {perAi.map((p, i) => (
                  <span key={p.personaId ?? i} className="room-tag">
                    {p.personaId ?? "?"}
                    {p.eliminatedRound ? ` · 第${p.eliminatedRound}轮出局` : " · 存活"}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* 本局 AI 人格定义(可折叠) */}
          <div className="iter-section">
            <button
              type="button"
              className="iter-collapse-head"
              onClick={() => setPersonasOpen((v) => !v)}
            >
              <span>{personasOpen ? "▾" : "▸"}</span>
              <span>
                本局 AI 人格定义{gamePersonas.length ? `(${gamePersonas.length})` : ""}
              </span>
            </button>
            {personasOpen && (gamePersonas.length === 0 ? (
              <p className="muted-text">
                {personas === null ? "加载中…" : "未获取到本局 AI 人格定义。"}
              </p>
            ) : (
              <div className="iter-personas">
                {gamePersonas.map((p) => (
                  <div key={p.id} className="iter-persona-card">
                    <div className="iter-persona-head">
                      <strong>{p.name ?? p.id}</strong>
                      <span className="muted-text">{p.id}</span>
                    </div>
                    {p.speechStyle && (
                      <div className="iter-persona-field">
                        <span className="muted-text">说话风格</span>
                        <span>{p.speechStyle}</span>
                      </div>
                    )}
                    {p.sentenceStyle && (
                      <div className="iter-persona-field">
                        <span className="muted-text">句式</span>
                        <span>{p.sentenceStyle}</span>
                      </div>
                    )}
                    {p.responseBias && (
                      <div className="iter-persona-field">
                        <span className="muted-text">接话倾向</span>
                        <span>{p.responseBias}</span>
                      </div>
                    )}
                    {p.typingHabit && (
                      <div className="iter-persona-field">
                        <span className="muted-text">打字习惯</span>
                        <span>{p.typingHabit}</span>
                      </div>
                    )}
                    {Array.isArray(p.toneRules) && p.toneRules.length > 0 && (
                      <div className="iter-persona-field">
                        <span className="muted-text">语气规则</span>
                        <span>{p.toneRules.join(" / ")}</span>
                      </div>
                    )}
                    {Array.isArray(p.avoidPhrases) && p.avoidPhrases.length > 0 && (
                      <div className="iter-persona-field">
                        <span className="muted-text">禁用话术</span>
                        <span className="iter-avoid">{p.avoidPhrases.join("、")}</span>
                      </div>
                    )}
                    {Array.isArray(p.sampleLines) && p.sampleLines.length > 0 && (
                      <div className="iter-persona-field">
                        <span className="muted-text">口吻示例</span>
                        <span className="iter-samples">{p.sampleLines.join(" | ")}</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>

          {/* tells */}
          <div className="iter-section">
            <p className="eyebrow">
              tell 命中(共 {totalTells} 次{totalTells === 0 ? " 🎉" : ""})
            </p>
            <div className="iter-tells-modal">
              {tellsSorted.map(([k, v]) => {
                const count = Number(v) || 0;
                return (
                  <div
                    key={k}
                    className={`iter-tell-modal-row ${count > 0 ? "hit" : ""}`}
                  >
                    <div className="iter-tell-modal-head">
                      <strong>{TELL_LABELS[k] ?? k}</strong>
                      <span className="iter-tell-count">{count}</span>
                    </div>
                    <div className="muted-text">{TELL_DESCRIPTIONS[k] ?? ""}</div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 主要问题 */}
          {topIssues.length > 0 && (
            <div className="iter-section">
              <p className="eyebrow">主要问题</p>
              <ul className="iter-issues">
                {topIssues.map((issue, i) => (
                  <li key={i}>{issue}</li>
                ))}
              </ul>
            </div>
          )}

          {/* 原始 I/O 选项卡 */}
          <div className="iter-section">
            <div className="iter-tabs">
              <button
                className={`iter-tab ${tab === "score" ? "active" : ""}`}
                onClick={() => setTab("score")}
              >
                打分结果 JSON
              </button>
              <button
                className={`iter-tab ${tab === "replay" ? "active" : ""}`}
                onClick={() => setTab("replay")}
              >
                Replay JSON(用户输入)
              </button>
              <button
                className={`iter-tab ${tab === "prompt" ? "active" : ""}`}
                onClick={() => setTab("prompt")}
              >
                打分提示词(系统)
              </button>
              <button
                className={`iter-tab ${tab === "request" ? "active" : ""}`}
                onClick={() => {
                  setTab("request");
                  void loadScoreRequest();
                }}
              >
                完整请求 JSON(发往大模型)
              </button>
            </div>
            <pre className="iter-detail-pre">
              {tab === "score"
                ? g.score
                  ? JSON.stringify(g.score, null, 2)
                  : "(无分数)"
                : tab === "replay"
                  ? replayLoading
                    ? "加载中…"
                    : replay
                      ? JSON.stringify(replay, null, 2)
                      : "(空)"
                  : tab === "prompt"
                    ? scorerLoading
                      ? "加载中…"
                      : scorer ?? "(空)"
                    : requestLoading
                      ? "加载中…"
                      : scoreRequest
                        ? JSON.stringify(
                            {
                              url: scoreRequest.config.url,
                              model: scoreRequest.config.model,
                              temperature: scoreRequest.config.temperature,
                              messages: [
                                { role: "system", content: scoreRequest.system },
                                { role: "user", content: scoreRequest.user },
                              ],
                              reasoning_effort: scoreRequest.config.reasoningEffort,
                              ...(scoreRequest.config.thinking
                                ? { thinking: { type: "enabled" } }
                                : {}),
                            },
                            null,
                            2,
                          )
                        : "(点此加载)"}
            </pre>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="iter-metric-card">
      <span className="muted-text">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function num(x: unknown): string {
  const n = Number(x);
  return Number.isFinite(n) ? String(n) : "-";
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
        <p className="eyebrow">Who's the AI</p>
        <h1>自动迭代</h1>
      </div>
    </div>
  );
}

function statusLabel(s: string): string {
  switch (s) {
    case "running":
      return "进行中";
    case "awaiting_activation":
      return "等待激活下一代";
    case "completed":
      return "已完成";
    case "stopped":
      return "已停止";
    case "failed":
      return "失败";
    default:
      return s;
  }
}

function genScoreText(g: GenerationSummary): string {
  const score = g.score as { humanLikeScore?: { mean?: number }; aiWinRate?: number } | null;
  if (!score) return "无分数";
  const hl = score.humanLikeScore?.mean;
  return `拟人 ${hl ?? "-"} · AI 胜率 ${score.aiWinRate != null ? pct(score.aiWinRate) : "-"}`;
}

function pct(x: number): string {
  return `${Math.round((x ?? 0) * 1000) / 10}%`;
}

// ===== 版本差异(diff)辅助 =====

type GenDetail = {
  generationId?: string;
  prompts?: Record<string, string>;
  personas?: unknown[];
};

type DiffLine = { type: "eq" | "add" | "del"; text: string };

function assetContent(gen: GenDetail | null, key: string): string {
  if (!gen) return "";
  return key === "ai-player/personas"
    ? JSON.stringify(gen.personas ?? [], null, 2)
    : (gen.prompts?.[key] ?? "");
}

/** 基于行的 LCS diff,返回 eq/add/del 行序列。 */
function lineDiff(aText: string, bText: string): DiffLine[] {
  const a = aText.split("\n");
  const b = bText.split("\n");
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "eq", text: a[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "del", text: a[i] });
      i += 1;
    } else {
      out.push({ type: "add", text: b[j] });
      j += 1;
    }
  }
  while (i < n) {
    out.push({ type: "del", text: a[i] });
    i += 1;
  }
  while (j < m) {
    out.push({ type: "add", text: b[j] });
    j += 1;
  }
  return out;
}

function diffStats(aText: string, bText: string): string {
  const lines = lineDiff(aText, bText);
  const add = lines.filter((l) => l.type === "add").length;
  const del = lines.filter((l) => l.type === "del").length;
  return `+${add} / -${del} 行变化`;
}

function renderDiff(lines: DiffLine[]) {
  if (lines.every((l) => l.type === "eq")) {
    return <p className="muted-text">该 asset 与父代完全一致,无差异。</p>;
  }
  return (
    <pre className="diff-block">
      {lines.map((l, idx) => (
        <div key={idx} className={`diff-line diff-${l.type}`}>
          <span className="diff-marker">{l.type === "add" ? "+" : l.type === "del" ? "-" : " "}</span>
          <span className="diff-text">{l.text || " "}</span>
        </div>
      ))}
    </pre>
  );
}
