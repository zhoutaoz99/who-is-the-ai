"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { useAuth } from "../lib/auth-client";
import { useGameClient } from "../lib/game-client";
import type {
  GenerationSummary,
  IterationGameResult,
  IterationPersonaMode,
  IterationPostRoundMode,
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

const EVAL_ASSET_KEYS = [
  "replay-score/system-replay-score.txt",
  "replay-score/user-replay-score-template.txt",
  "auto-optimize/system-prompt-optimizer.txt",
  "auto-optimize/user-prompt-optimizer-template.txt",
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
    retryAutoOptimize,
    stopIteration,
    refreshIteration,
  } = useGameClient();

  const [rounds, setRounds] = useState(4);
  const [gamesPerRound, setGamesPerRound] = useState(6);
  const [duration, setDuration] = useState(1);
  const [durationUnit, setDurationUnit] = useState<"min" | "sec">("min");
  const [sequentialSpeech, setSequentialSpeech] = useState(true);
  const [personaMode, setPersonaMode] = useState<IterationPersonaMode>("fixed_schedule");
  const [postRoundMode, setPostRoundMode] = useState<IterationPostRoundMode>("auto_optimize_wait_confirm");
  const [busy, setBusy] = useState(false);
  const [retryBusy, setRetryBusy] = useState(false);
  const [pageError, setPageError] = useState("");

  // 选中的轮次:默认跟随 currentRound;点击 stepper 可锁定查看历史轮。
  const [selectedRound, setSelectedRound] = useState<number | null>(null);
  useEffect(() => {
    if (iterationRun?.currentRound) setSelectedRound(iterationRun.currentRound);
  }, [iterationRun?.currentRound]);

  // 自动优化生成详情弹窗:记录要查看的轮次号。
  const [autoOptimizeDetailRound, setAutoOptimizeDetailRound] = useState<number | null>(null);

  // 预计用时 + 每名玩家发言次数:由后端按真实计时常量估算,参数变化时防抖拉取(保留上一次结果避免闪烁)。
  // 必须放在所有 early return 之前(遵守 Hooks 规则)。
  const [estimate, setEstimate] = useState<{
    seconds: number;
    speechesPerPlayer: number;
  } | null>(null);
  const discussionSecondsValue = durationUnit === "min" ? duration * 60 : duration;
  useEffect(() => {
    const status = iterationRun?.status;
    const isActiveRun =
      status === "running" ||
      status === "auto_optimizing" ||
      status === "awaiting_activation" ||
      status === "awaiting_confirmation";
    if (isActiveRun) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const url =
        `${API_URL}/debug/iterations/estimate` +
        `?rounds=${encodeURIComponent(rounds)}` +
        `&gamesPerRound=${encodeURIComponent(gamesPerRound)}` +
        `&discussionSeconds=${encodeURIComponent(discussionSecondsValue)}` +
        `&postRoundMode=${encodeURIComponent(postRoundMode)}` +
        `&sequentialSpeech=${encodeURIComponent(sequentialSpeech)}`;
      fetch(url, { signal: controller.signal })
        .then((r) => r.json())
        .then((json) => {
          if (
            json?.ok &&
            typeof json.seconds === "number" &&
            typeof json.speechesPerPlayer === "number"
          ) {
            setEstimate({
              seconds: json.seconds,
              speechesPerPlayer: json.speechesPerPlayer,
            });
          }
        })
        .catch(() => {
          /* abort 或网络错误:保留上一次结果 */
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    rounds,
    gamesPerRound,
    discussionSecondsValue,
    postRoundMode,
    sequentialSpeech,
    iterationRun?.status,
  ]);

  // 自动优化进行中时的实时「已耗时」计时器(基于 run.updatedAt,即进入 auto_optimizing 的时刻)。
  const [autoOptimizeElapsedMs, setAutoOptimizeElapsedMs] = useState(0);
  useEffect(() => {
    const autoOptimizing = iterationRun?.status === "auto_optimizing";
    if (!autoOptimizing || !iterationRun?.updatedAt) {
      setAutoOptimizeElapsedMs(0);
      return;
    }
    const startMs = new Date(iterationRun.updatedAt).getTime();
    const tick = () => setAutoOptimizeElapsedMs(Math.max(0, Date.now() - startMs));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [iterationRun?.status, iterationRun?.updatedAt]);

  // 版本管理
  const [generations, setGenerations] = useState<GenerationSummary[]>([]);
  const [activeGenId, setActiveGenId] = useState<string | null>(null);
  const [selectedGenId, setSelectedGenId] = useState<string | null>(null);
  const [manualOptimizeAsset, setManualOptimizeAsset] = useState(ASSET_KEYS[0]);
  const [loadedAssets, setLoadedAssets] = useState<Record<string, string>>({});
  const [draftAssets, setDraftAssets] = useState<Record<string, string>>({});
  const [manualOptimizeNote, setManualOptimizeNote] = useState("");
  const [manualOptimizeBusy, setManualOptimizeBusy] = useState(false);

  // 评估尺子版本管理
  const [evalGenerations, setEvalGenerations] = useState<GenerationSummary[]>([]);
  const [activeEvalGenId, setActiveEvalGenId] = useState<string | null>(null);
  const [selectedEvalGenId, setSelectedEvalGenId] = useState<string | null>(null);
  const [evalOptimizeAsset, setEvalOptimizeAsset] = useState(EVAL_ASSET_KEYS[0]);
  const [evalLoadedAssets, setEvalLoadedAssets] = useState<Record<string, string>>({});
  const [evalDraftAssets, setEvalDraftAssets] = useState<Record<string, string>>({});
  const [evalOptimizeNote, setEvalOptimizeNote] = useState("");
  const [evalOptimizeBusy, setEvalOptimizeBusy] = useState(false);

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

  const fetchEvalGenerations = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/debug/eval-prompts/generations`);
      const json = await res.json();
      if (json?.ok) {
        setEvalGenerations(json.generations ?? []);
        setActiveEvalGenId(json.active ?? null);
        setSelectedEvalGenId((cur) => cur ?? (json.active ?? null));
      }
    } catch {
      /* ignore */
    }
  }, []);

  const loadAsset = useCallback(async (genId: string | null) => {
    if (!genId) {
      setLoadedAssets({});
      setDraftAssets({});
      return;
    }
    setManualOptimizeBusy(true);
    try {
      const res = await fetch(`${API_URL}/debug/prompts/generations/${genId}`);
      const json = await res.json();
      const gen = json?.generation;
      if (gen) {
        const assets = Object.fromEntries(
          ASSET_KEYS.map((assetKey) => [
            assetKey,
            assetKey === "ai-player/personas"
              ? JSON.stringify(gen.personas ?? [], null, 2)
              : (gen.prompts?.[assetKey] ?? ""),
          ]),
        );
        setLoadedAssets(assets);
        setDraftAssets(assets);
      }
    } catch {
      /* ignore */
    } finally {
      setManualOptimizeBusy(false);
    }
  }, []);

  const loadEvalAsset = useCallback(async (genId: string | null) => {
    if (!genId) {
      setEvalLoadedAssets({});
      setEvalDraftAssets({});
      return;
    }
    setEvalOptimizeBusy(true);
    try {
      const res = await fetch(`${API_URL}/debug/eval-prompts/generations/${genId}`);
      const json = await res.json();
      const gen = json?.generation;
      if (gen) {
        const assets = Object.fromEntries(
          EVAL_ASSET_KEYS.map((assetKey) => [assetKey, gen.assets?.[assetKey] ?? ""]),
        );
        setEvalLoadedAssets(assets);
        setEvalDraftAssets(assets);
      }
    } catch {
      /* ignore */
    } finally {
      setEvalOptimizeBusy(false);
    }
  }, []);

  useEffect(() => {
    fetchGenerations();
    fetchEvalGenerations();
  }, [fetchGenerations, fetchEvalGenerations]);

  // 选中版本或切换 asset 时,加载该版本的对应提示词到右侧查看/调整。
  useEffect(() => {
    loadAsset(selectedGenId);
  }, [selectedGenId, loadAsset]);

  useEffect(() => {
    loadEvalAsset(selectedEvalGenId);
  }, [selectedEvalGenId, loadEvalAsset]);

  const handleSelectGen = (genId: string) => {
    if (
      genId !== selectedGenId &&
      manualOptimizeDirty &&
      !window.confirm("当前提示词版本有未保存修改，切换版本将丢失这些修改。继续吗？")
    ) {
      return;
    }
    setSelectedGenId(genId);
    setManualOptimizeNote("");
  };

  const handleSelectEvalGen = (genId: string) => {
    if (
      genId !== selectedEvalGenId &&
      evalOptimizeDirty &&
      !window.confirm("当前评估尺子有未保存修改，切换版本将丢失这些修改。继续吗？")
    ) {
      return;
    }
    setSelectedEvalGenId(genId);
    setEvalOptimizeNote("");
  };

  // 版本差异弹窗(父代 vs 选中代)
  const [diffOpen, setDiffOpen] = useState(false);
  const [diffAsset, setDiffAsset] = useState(ASSET_KEYS[0]);
  const [diffChangedKeys, setDiffChangedKeys] = useState<string[]>([]);
  const [diffKind, setDiffKind] = useState<"prompts" | "eval-prompts">("prompts");

  // 弹窗打开时锁定底层页面滚动
  useEffect(() => {
    if (!diffOpen) return;
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = original;
    };
  }, [diffOpen]);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffParent, setDiffParent] = useState<GenDetail | null>(null);
  const [diffSelected, setDiffSelected] = useState<GenDetail | null>(null);

  const selectedGen = generations.find((g) => g.id === selectedGenId) ?? null;
  const selectedEvalGen = evalGenerations.find((g) => g.id === selectedEvalGenId) ?? null;
  const hasParent = Boolean(selectedGen?.parentId);
  const evalHasParent = Boolean(selectedEvalGen?.parentId);
  const manualOptimizeDirtyKeys = ASSET_KEYS.filter(
    (key) => (draftAssets[key] ?? "") !== (loadedAssets[key] ?? ""),
  );
  const evalOptimizeDirtyKeys = EVAL_ASSET_KEYS.filter(
    (key) => (evalDraftAssets[key] ?? "") !== (evalLoadedAssets[key] ?? ""),
  );
  const manualOptimizeDirty = Boolean(selectedGenId) && manualOptimizeDirtyKeys.length > 0;
  const evalOptimizeDirty = Boolean(selectedEvalGenId) && evalOptimizeDirtyKeys.length > 0;
  const manualOptimizeContent = draftAssets[manualOptimizeAsset] ?? "";
  const evalOptimizeContent = evalDraftAssets[evalOptimizeAsset] ?? "";

  const openDiff = async (
    kind: "prompts" | "eval-prompts",
    selectedId: string,
    parentId: string,
    assetKeys: string[],
  ) => {
    setDiffKind(kind);
    setDiffOpen(true);
    setDiffLoading(true);
    try {
      const [pRes, sRes] = await Promise.all([
        fetch(`${API_URL}/debug/${kind}/generations/${parentId}`).then((r) => r.json()),
        fetch(`${API_URL}/debug/${kind}/generations/${selectedId}`).then((r) => r.json()),
      ]);
      const parent = pRes?.generation ?? null;
      const selected = sRes?.generation ?? null;
      setDiffParent(parent);
      setDiffSelected(selected);
      // 只保留父代与当前版本内容确实不同的 asset,差异下拉里隐藏无变化的 asset。
      const changed = assetKeys.filter(
        (k) => assetContent(parent, k) !== assetContent(selected, k),
      );
      setDiffChangedKeys(changed);
      setDiffAsset((cur) => {
        if (changed.length === 0) return cur;
        return changed.includes(cur) ? cur : changed[0];
      });
    } finally {
      setDiffLoading(false);
    }
  };

  const handleStart = async () => {
    setBusy(true);
    setPageError("");
    const seconds = durationUnit === "min" ? duration * 60 : duration;
    const res = await startIteration({
      rounds,
      gamesPerRound,
      discussionSeconds: seconds,
      sequentialSpeech,
      personaMode,
      autoOptimize: postRoundMode !== "manual",
      postRoundMode,
    });
    setBusy(false);
    if (!res.ok) setPageError(res.error ?? "启动失败");
  };

  const handleContinue = async () => {
    setBusy(true);
    const res = await continueIteration();
    setBusy(false);
    if (!res.ok) setPageError(res.error ?? "继续失败");
  };

  const handleRetryAutoOptimize = async () => {
    setRetryBusy(true);
    setPageError("");
    const res = await retryAutoOptimize();
    setRetryBusy(false);
    if (!res.ok) {
      setPageError(res.error ?? "自动优化重试失败");
    }
    // 不立即 fetchGenerations:自动优化已改为异步执行,
    // 完成后通过 socket iteration.status 事件推送结果;
    // 下方 useEffect 监听状态变化自动刷新版本列表。
  };

  // 自动优化完成后刷新版本列表(异步 auto-optimize 通过 socket 推送结果)。
  const prevStatusRef = useRef(iterationRun?.status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    const cur = iterationRun?.status;
    prevStatusRef.current = cur;
    if (prev === "auto_optimizing" && cur && cur !== "auto_optimizing") {
      fetchGenerations();
    }
  }, [iterationRun?.status, fetchGenerations]);

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

  const handleDelete = async (genId: string, isActive: boolean) => {
    const hint = isActive
      ? "\n该版本为当前激活版本,删除后将回退激活到其父代。"
      : "";
    if (!window.confirm(`确认删除版本 ${genId}?${hint}`)) return;
    setPageError("");
    try {
      const res = await fetch(`${API_URL}/debug/prompts/generation/${genId}`, {
        method: "DELETE",
      });
      const json = await res.json();
      if (!json?.ok) {
        setPageError(json?.error ?? "删除失败");
        return;
      }
      if (selectedGenId === genId) setSelectedGenId(null);
      await fetchGenerations();
    } catch {
      setPageError("删除失败");
    }
  };

  const handleCreateGeneration = async () => {
    if (!selectedGenId) return;
    if (!manualOptimizeDirtyKeys.length) {
      setPageError("当前提示词未修改,无需保存");
      return;
    }
    setManualOptimizeBusy(true);
    setPageError("");
    try {
      const changedAssets = Object.fromEntries(
        manualOptimizeDirtyKeys.map((key) => [key, draftAssets[key] ?? ""]),
      );
      const res = await fetch(`${API_URL}/debug/prompts/generation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fromGenId: selectedGenId,
          changedAssets,
          note: manualOptimizeNote || undefined,
        }),
      });
      const json = await res.json();
      if (!json?.ok) {
        setPageError(json?.error ?? "创建失败");
        return;
      }
      await fetchGenerations();
      if (json.generation?.id) setSelectedGenId(json.generation.id);
      setManualOptimizeNote("");
    } finally {
      setManualOptimizeBusy(false);
    }
  };

  const handleResetManualOptimize = () => {
    setDraftAssets(loadedAssets);
    setManualOptimizeNote("");
  };

  const handleActivateEvalGen = async (genId: string) => {
    await fetch(`${API_URL}/debug/eval-prompts/active`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ generationId: genId }),
    });
    await fetchEvalGenerations();
  };

  const handleDeleteEvalGen = async (genId: string, isActive: boolean) => {
    const hint = isActive
      ? "\n该版本为当前激活版本,删除后将回退激活到其父代。"
      : "";
    if (!window.confirm(`确认删除评估尺子版本 ${genId}?${hint}`)) return;
    setPageError("");
    try {
      const res = await fetch(`${API_URL}/debug/eval-prompts/generation/${genId}`, {
        method: "DELETE",
      });
      const json = await res.json();
      if (!json?.ok) {
        setPageError(json?.error ?? "删除失败");
        return;
      }
      if (selectedEvalGenId === genId) setSelectedEvalGenId(null);
      await fetchEvalGenerations();
    } catch {
      setPageError("删除失败");
    }
  };

  const handleCreateEvalGeneration = async () => {
    if (!selectedEvalGenId) return;
    if (!evalOptimizeDirtyKeys.length) {
      setPageError("当前提示词未修改,无需保存");
      return;
    }
    setEvalOptimizeBusy(true);
    setPageError("");
    try {
      const changedAssets = Object.fromEntries(
        evalOptimizeDirtyKeys.map((key) => [key, evalDraftAssets[key] ?? ""]),
      );
      const res = await fetch(`${API_URL}/debug/eval-prompts/generation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fromGenId: selectedEvalGenId,
          changedAssets,
          note: evalOptimizeNote || undefined,
        }),
      });
      const json = await res.json();
      if (!json?.ok) {
        setPageError(json?.error ?? "创建失败");
        return;
      }
      await fetchEvalGenerations();
      if (json.generation?.id) setSelectedEvalGenId(json.generation.id);
      setEvalOptimizeNote("");
    } finally {
      setEvalOptimizeBusy(false);
    }
  };

  const handleResetEvalOptimize = () => {
    setEvalDraftAssets(evalLoadedAssets);
    setEvalOptimizeNote("");
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
  const isAutoOptimizing = run?.status === "auto_optimizing";
  const isAwaitingConfirmation = run?.status === "awaiting_confirmation";
  const isAwaiting = run?.status === "awaiting_activation" || isAwaitingConfirmation;
  const isActive = isRunning || isAutoOptimizing || isAwaiting;
  const doneInRound = (run?.currentRoundGames ?? []).filter((g) =>
    g.status === "finished" || g.status === "failed" || Boolean(g.score) || Boolean(g.error),
  ).length;
  const totalInRound = run?.gamesPerRound ?? gamesPerRound;
  const progressPct = totalInRound > 0 ? Math.min(100, (doneInRound / totalInRound) * 100) : 0;
  const canRetryAutoOptimize =
    run?.status === "awaiting_activation" &&
    run.options?.autoOptimize === true &&
    run.lastAutoOptimize?.status === "failed";
  // 选中轮次的完整数据(已完成的轮);未完成则为 null。
  const selectedRoundData =
    run?.rounds.find((r) => r.round === selectedRound) ?? null;
  const isSelectedRoundCurrent = selectedRound === run?.currentRound;
  // 逐局列表跟随选中轮次:当前轮用实时流;历史轮用该轮已记录的局。
  const displayedRoundGames = isSelectedRoundCurrent
    ? (run?.currentRoundGames ?? [])
    : (selectedRoundData?.games ?? []);
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
            点击「开始迭代」用当前 active 代跑一批无头对局并打分;轮间在「AI 提示词版本」面板创建/激活新代后点「继续下一轮」。
          </p>

          {isActive ? (
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
              <div className="iter-param">
                <span className="muted-text">顺序发言</span>
                <strong>{run?.options?.sequentialSpeech === false ? "关闭" : "开启"}</strong>
              </div>
              <div className="iter-param">
                <span className="muted-text">人格策略</span>
                <strong>{personaModeLabel(run?.options?.personaMode ?? personaMode)}</strong>
              </div>
              <div className="iter-param">
                <span className="muted-text">轮后模式</span>
                <strong>{postRoundModeLabel(run?.options?.postRoundMode ?? postRoundMode)}</strong>
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
              <label
                className="iter-checkbox-label"
                title="勾选:玩家按固定顺序一个接一个发言(串行、无随机间隔,结果可复现);不勾选:各玩家独立随机发言"
              >
                顺序发言
                <input
                  type="checkbox"
                  checked={sequentialSpeech}
                  onChange={(e) => setSequentialSpeech(e.target.checked)}
                />
              </label>
              <label>
                人格策略
                <select
                  value={personaMode}
                  onChange={(e) => setPersonaMode(e.target.value as IterationPersonaMode)}
                >
                  <option value="fixed_schedule">固定赛程</option>
                  <option value="fixed_per_run">整次固定</option>
                  <option value="random_each_game">逐局随机</option>
                </select>
                <span className="iter-option-help">
                  {personaModeDescription(personaMode)}
                </span>
              </label>
              <label>
                轮后模式
                <select
                  value={postRoundMode}
                  onChange={(e) => setPostRoundMode(e.target.value as IterationPostRoundMode)}
                >
                  <option value="manual">手动优化</option>
                  <option value="auto_optimize_wait_confirm">自动优化后确认</option>
                  <option value="auto_optimize_activate_continue">自动优化并继续</option>
                </select>
              </label>
            </div>
          )}

          {!isActive && estimate != null && (
            <p className="muted-text iter-estimate">
              预计用时:<strong>{formatEstimate(estimate.seconds)}</strong>
              <span className="iter-estimate-note">
                · 每名玩家约 <strong>{estimate.speechesPerPlayer}</strong> 次发言/轮({sequentialSpeech ? "顺序" : "随机"}模式)
                (含打分{postRoundMode !== "manual" ? "与自动优化" : ""};仅供参考,实际受模型速度与对局结束轮数影响)
              </span>
            </p>
          )}

          <div className="iteration-actions">
            {!isActive && (
              <button
                className="primary-action"
                disabled={busy}
                onClick={handleStart}
              >
                {busy ? "启动中…" : "开始迭代"}
              </button>
            )}
            {(isRunning || isAutoOptimizing) && (
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
                  {busy ? "继续中…" : isAwaitingConfirmation ? "确认并继续" : "继续下一轮"}
                </button>
                <button className="secondary" onClick={handleStop} title="放弃本次迭代,释放占用以便重新开始">
                  停止本次
                </button>
              </>
            )}
            {canRetryAutoOptimize && (
              <button
                className="secondary"
                disabled={retryBusy}
                onClick={handleRetryAutoOptimize}
                title="重新执行自动优化,生成候选代"
              >
                {retryBusy ? "重试中…" : "重试自动优化"}
              </button>
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
              {run.pendingGenerationId && (
                <span>
                  待确认:<strong>{run.pendingGenerationId}</strong>
                </span>
              )}
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

          {/* 轮次 stepper(点击切换下方 scorecard / 自动优化记录关注的轮次) */}
          {run && (
            <div className="iter-stepper">
              {Array.from({ length: run.totalRounds }, (_, i) => i + 1).map((r) => {
                const completed = run.rounds.find((rr) => rr.round === r);
                const isCur = r === run.currentRound;
                const isSel = r === selectedRound;
                const state = completed
                  ? "done"
                  : isCur && isRunning
                    ? "active"
                    : isCur
                      ? "now"
                      : "pending";
                const notStarted = state === "pending";
                return (
                  <button
                    type="button"
                    key={r}
                    className={`iter-step ${state} ${isSel ? "selected" : ""}`}
                    disabled={notStarted}
                    onClick={() => setSelectedRound(r)}
                    title={notStarted ? `第 ${r} 轮(尚未开始)` : `查看第 ${r} 轮`}
                  >
                    <div className="iter-step-num">{completed ? "✓" : r}</div>
                    <div className="iter-step-meta">
                      {completed?.aggregate
                        ? `拟人 ${completed.aggregate.humanLikeScore.mean}`
                        : isCur && isRunning
                          ? `${doneInRound}/${totalInRound}局`
                          : ""}
                    </div>
                  </button>
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

          {/* 选中轮次的逐局结果 */}
          <div className="iteration-game-list">
            <p className="eyebrow">第 {selectedRound ?? "?"} 轮逐局</p>
            {displayedRoundGames.slice().reverse().map((g, i) => (
              <GameCard
                key={`${g.roomId || "pending"}-${g.gameIndex ?? i}`}
                g={g}
                onViewReplay={(id) => router.push(`/replay/${id}`)}
              />
            ))}
            {!displayedRoundGames.length && (
              <p className="muted-text">
                {isSelectedRoundCurrent ? "尚未开始或本轮无数据。" : "该轮暂无对局数据。"}
              </p>
            )}
          </div>

          {/* 选中轮次的 scorecard */}
          {run && selectedRound != null && (
            <div className="iteration-round-trend">
              <p className="eyebrow">第 {selectedRound} 轮 scorecard</p>
              {selectedRoundData ? (
                <RoundCard key={selectedRoundData.round} round={selectedRoundData} />
              ) : (
                <p className="muted-text">
                  {isSelectedRoundCurrent
                    ? "本轮尚未完成,暂无 scorecard。"
                    : "该轮尚未完成,暂无 scorecard。"}
                </p>
              )}
            </div>
          )}

          {/* 选中轮次的自动优化记录(独立区块,与 scorecard 分开) */}
          {run && selectedRound != null &&
            (run.options?.autoOptimize ||
              Boolean(selectedRoundData?.autoOptimize) ||
              (isSelectedRoundCurrent && isAutoOptimizing)) && (
            <div className="iteration-auto-optimize-list">
              <p className="eyebrow">第 {selectedRound} 轮 自动优化记录</p>
              {selectedRoundData?.autoOptimize ? (
                <AutoOptimizeCard
                  round={selectedRoundData}
                  runId={run.id}
                  onSelectGen={(id) => setSelectedGenId(id)}
                  onViewDetail={(roundNo) => setAutoOptimizeDetailRound(roundNo)}
                />
              ) : isSelectedRoundCurrent && isAutoOptimizing ? (
                <div className="stat-card iter-auto-optimize-card status-running">
                  <div className="iter-round-head">
                    <strong>第 {run.currentRound} 轮</strong>
                    <span className="room-tag">自动优化中…</span>
                    <span className="muted-text iter-auto-optimize-duration">
                      已耗时 {formatElapsed(autoOptimizeElapsedMs)}
                    </span>
                  </div>
                  <div className="muted-text">正在执行自动优化,生成候选代,请稍候。</div>
                </div>
              ) : (
                <p className="muted-text">该轮暂无自动优化记录。</p>
              )}
            </div>
          )}
        </section>
      </section>

      {/* 版本管理(全宽,左列表 / 右查看) */}
      <section className="panel lobby-card iteration-version-section">
          <div className="lobby-card-header">
            <div>
              <p className="eyebrow">AI Prompt Versions</p>
              <h2>AI 提示词版本</h2>
            </div>
            <button className="compact-button" onClick={fetchGenerations}>
              刷新
            </button>
          </div>
          <p className="muted-text">
            这里管理 AI 玩家实际运行的 7 个提示词 asset 与人格库。可在多个 asset 间分别修改,最后一次性保存成一个新版本;激活后只影响后续新开的对局。
          </p>

          <div className="iteration-version-layout">
            {/* 左:版本列表 */}
            <div className="iteration-version-list">
              {generations.length === 0 && (
                <p className="muted-text">暂无版本。</p>
              )}
              {generations.map((g) => {
                const childCount = generations.filter((x) => x.parentId === g.id).length;
                const isActiveGen = g.id === activeGenId;
                const deleteBlocked = childCount > 0 || (isActiveGen && !g.parentId);
                const deleteTitle = childCount > 0
                  ? "存在子版本,不允许删除"
                  : isActiveGen && !g.parentId
                    ? "激活版本无父代可回退,不允许删除"
                    : isActiveGen
                      ? "删除此激活版本(将回退到父代)"
                      : "删除此版本";
                return (
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
                    <button
                      className="compact-button"
                      disabled={deleteBlocked}
                      title={deleteTitle}
                      onClick={() => handleDelete(g.id, isActiveGen)}
                    >
                      删除
                    </button>
                  </div>
                </div>
                );
              })}
            </div>

            {/* 右:选中版本的提示词查看/调整 */}
            <div className="iteration-version-detail">
              <div className="iteration-version-detail-head">
                <div>
                  <p className="eyebrow">选中版本</p>
                  <h3>{selectedGenId ?? "请在左侧选择一个版本"}</h3>
                </div>
                <div className="iteration-version-detail-tools">
                  <select
                    value={manualOptimizeAsset}
                    onChange={(e) => {
                      setManualOptimizeAsset(e.target.value);
                      setManualOptimizeNote("");
                    }}
                    disabled={!selectedGenId}
                  >
                    {ASSET_KEYS.map((k) => (
                      <option key={k} value={k}>
                        {manualOptimizeDirtyKeys.includes(k) ? `* ${k}` : k}
                      </option>
                    ))}
                  </select>
                  <button
                    className="compact-button"
                    disabled={!hasParent}
                    title={hasParent ? "对比父代与当前版本" : "该版本无父代"}
                    onClick={() => {
                      if (!selectedGenId || !selectedGen?.parentId) return;
                      void openDiff("prompts", selectedGenId, selectedGen.parentId, ASSET_KEYS);
                    }}
                  >
                    与父代对比
                  </button>
                </div>
              </div>
              <div className="iteration-optimize-form">
                <div className="iteration-optimize-status">
                  <span
                    className={`iteration-optimize-badge ${manualOptimizeDirty ? "dirty" : "clean"}`}
                  >
                    {manualOptimizeDirty ? `已修改 ${manualOptimizeDirtyKeys.length} 项` : "未修改"}
                  </span>
                  <span className="muted-text">
                    {selectedGenId ? `当前提示词: ${manualOptimizeAsset}` : "请先在左侧选择一个版本"}
                  </span>
                </div>
                <textarea
                  className="iteration-optimize-textarea"
                  value={manualOptimizeContent}
                  rows={20}
                  onChange={(e) =>
                    setDraftAssets((cur) => ({ ...cur, [manualOptimizeAsset]: e.target.value }))
                  }
                  placeholder={selectedGenId ? "查看或调整该 asset;调整后可创建新版本" : "—"}
                />
                <input
                  type="text"
                  value={manualOptimizeNote}
                  onChange={(e) => setManualOptimizeNote(e.target.value)}
                  placeholder="保存说明(可选)"
                />
                <div className="iteration-optimize-actions">
                  <button
                    className="secondary"
                    disabled={manualOptimizeBusy || !selectedGenId || !manualOptimizeDirty}
                    onClick={handleResetManualOptimize}
                  >
                    还原全部修改
                  </button>
                  <button
                    className="primary-action"
                    disabled={manualOptimizeBusy || !selectedGenId || !manualOptimizeDirty}
                    onClick={handleCreateGeneration}
                  >
                    {manualOptimizeBusy ? "保存中…" : `保存 ${manualOptimizeDirtyKeys.length} 项修改为新版本`}
                  </button>
                </div>
                <p className="muted-text">
                  可以切换多个提示词分别修改,最后一次性保存为一个新版本。保存不会覆盖原版本,而是基于当前版本派生一个新版本。
                </p>
              </div>
            </div>
          </div>
        </section>

      <section className="panel lobby-card iteration-version-section">
        <div className="lobby-card-header">
          <div>
            <p className="eyebrow">Eval Rulers</p>
            <h2>评估尺子版本</h2>
          </div>
          <button className="compact-button" onClick={fetchEvalGenerations}>
            刷新
          </button>
        </div>
        <p className="muted-text">
          这里管理单局打分与自动优化器使用的评估提示词。可在多个评估 asset 间分别修改,最后一次性保存成一个新版本;激活后只影响后续新打分的对局和后续自动优化。
        </p>

        <div className="iteration-version-layout">
          <div className="iteration-version-list">
            {evalGenerations.length === 0 && (
              <p className="muted-text">暂无评估尺子版本。</p>
            )}
            {evalGenerations.map((g) => {
              const childCount = evalGenerations.filter((x) => x.parentId === g.id).length;
              const isActiveGen = g.id === activeEvalGenId;
              const deleteBlocked = childCount > 0 || (isActiveGen && !g.parentId);
              const deleteTitle = childCount > 0
                ? "存在子版本,不允许删除"
                : isActiveGen && !g.parentId
                  ? "激活版本无父代可回退,不允许删除"
                  : isActiveGen
                    ? "删除此激活版本(将回退到父代)"
                    : "删除此版本";
              return (
                <div
                  key={g.id}
                  className={`iteration-version-item ${g.id === selectedEvalGenId ? "selected" : ""} ${g.id === activeEvalGenId ? "active" : ""}`}
                  onClick={() => handleSelectEvalGen(g.id)}
                >
                  <div className="iteration-gen-head">
                    <strong>{g.id}</strong>
                    {isActiveGen && <span className="room-tag">ACTIVE</span>}
                  </div>
                  <div className="muted-text">← {g.parentId ?? "种子"}</div>
                  <div className="muted-text">手动版本 · 不参与自动优化</div>
                  {g.note && <div className="muted-text iteration-version-note">{g.note}</div>}
                  <div
                    className="iteration-gen-actions"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {!isActiveGen && (
                      <button
                        className="compact-button"
                        onClick={() => handleActivateEvalGen(g.id)}
                      >
                        激活
                      </button>
                    )}
                    <button
                      className="compact-button"
                      disabled={deleteBlocked}
                      title={deleteTitle}
                      onClick={() => handleDeleteEvalGen(g.id, isActiveGen)}
                    >
                      删除
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="iteration-version-detail">
            <div className="iteration-version-detail-head">
              <div>
                <p className="eyebrow">选中版本</p>
                <h3>{selectedEvalGenId ?? "请在左侧选择一个版本"}</h3>
              </div>
              <div className="iteration-version-detail-tools">
                <select
                  value={evalOptimizeAsset}
                  onChange={(e) => {
                    setEvalOptimizeAsset(e.target.value);
                    setEvalOptimizeNote("");
                  }}
                  disabled={!selectedEvalGenId}
                >
                  {EVAL_ASSET_KEYS.map((k) => (
                    <option key={k} value={k}>
                      {evalOptimizeDirtyKeys.includes(k) ? `* ${k}` : k}
                    </option>
                  ))}
                </select>
                <button
                  className="compact-button"
                  disabled={!evalHasParent}
                  title={evalHasParent ? "对比父代与当前版本" : "该版本无父代"}
                  onClick={() => {
                    if (!selectedEvalGenId || !selectedEvalGen?.parentId) return;
                    void openDiff(
                      "eval-prompts",
                      selectedEvalGenId,
                      selectedEvalGen.parentId,
                      EVAL_ASSET_KEYS,
                    );
                  }}
                >
                  与父代对比
                </button>
              </div>
            </div>
            <div className="iteration-optimize-form">
              <div className="iteration-optimize-status">
                <span className={`iteration-optimize-badge ${evalOptimizeDirty ? "dirty" : "clean"}`}>
                  {evalOptimizeDirty ? `已修改 ${evalOptimizeDirtyKeys.length} 项` : "未修改"}
                </span>
                <span className="muted-text">
                  {selectedEvalGenId ? `当前提示词: ${evalOptimizeAsset}` : "请先在左侧选择一个版本"}
                </span>
              </div>
              <textarea
                className="iteration-optimize-textarea"
                value={evalOptimizeContent}
                rows={20}
                onChange={(e) =>
                  setEvalDraftAssets((cur) => ({ ...cur, [evalOptimizeAsset]: e.target.value }))
                }
                placeholder={selectedEvalGenId ? "查看或调整该评估尺子;调整后可创建新版本" : "—"}
              />
              <input
                type="text"
                value={evalOptimizeNote}
                onChange={(e) => setEvalOptimizeNote(e.target.value)}
                placeholder="保存说明(可选)"
              />
              <div className="iteration-optimize-actions">
                <button
                  className="secondary"
                  disabled={evalOptimizeBusy || !selectedEvalGenId || !evalOptimizeDirty}
                  onClick={handleResetEvalOptimize}
                >
                  还原全部修改
                </button>
                <button
                  className="primary-action"
                  disabled={evalOptimizeBusy || !selectedEvalGenId || !evalOptimizeDirty}
                  onClick={handleCreateEvalGeneration}
                >
                  {evalOptimizeBusy ? "保存中…" : `保存 ${evalOptimizeDirtyKeys.length} 项修改为新版本`}
                </button>
              </div>
              <p className="muted-text">
                先在左侧选中版本,再切换多个提示词分别修改,最后一次性保存为一个新版本。
              </p>
            </div>
          </div>
        </div>
      </section>
      </main>

      {diffOpen && (
        <div className="iteration-modal-overlay" onClick={() => setDiffOpen(false)}>
          <div className="iteration-modal" onClick={(e) => e.stopPropagation()}>
            <div className="iteration-modal-head">
              <div>
                <p className="eyebrow">
                  {diffKind === "eval-prompts" ? "评估尺子差异(父代 → 当前)" : "版本差异(父代 → 当前)"}
                </p>
                <h3>
                  {diffParent?.generationId ??
                    (diffKind === "eval-prompts" ? selectedEvalGen?.parentId : selectedGen?.parentId) ??
                    "?"}
                  {" → "}
                  {diffSelected?.generationId ??
                    (diffKind === "eval-prompts" ? selectedEvalGenId : selectedGenId)}
                </h3>
              </div>
              <div className="iteration-modal-tools">
                <select
                  value={diffAsset}
                  onChange={(e) => setDiffAsset(e.target.value)}
                  disabled={diffChangedKeys.length === 0}
                >
                  {diffChangedKeys.length === 0 ? (
                    <option value="">无变化的 asset</option>
                  ) : (
                    diffChangedKeys.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))
                  )}
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
                  : !diffParent || !diffSelected
                    ? "无法加载版本"
                    : diffChangedKeys.length === 0
                      ? "该版本与父代无差异"
                      : `${diffAsset}: ${diffStats(assetContent(diffParent, diffAsset), assetContent(diffSelected, diffAsset))}`}
              </span>
            </div>
            <div className="iteration-modal-diff">
              {diffLoading ? (
                <p className="muted-text">加载中…</p>
              ) : !diffParent || !diffSelected ? (
                <p className="muted-text">无法加载版本详情。</p>
              ) : diffChangedKeys.length === 0 ? (
                <p className="muted-text">该版本与父代完全一致,无差异。</p>
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

      {autoOptimizeDetailRound != null && run && (() => {
        const detailRound = run.rounds.find((r) => r.round === autoOptimizeDetailRound);
        return (
          <AutoOptimizeDetailModal
            runId={run.id}
            roundNo={autoOptimizeDetailRound}
            response={detailRound?.autoOptimize?.response}
            aggregate={detailRound?.aggregate ?? null}
            onClose={() => setAutoOptimizeDetailRound(null)}
          />
        );
      })()}
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

function AutoOptimizeCard({
  round,
  runId,
  onSelectGen,
  onViewDetail,
}: {
  round: IterationRunStatus["rounds"][number];
  runId?: string;
  onSelectGen?: (genId: string) => void;
  onViewDetail?: (roundNo: number) => void;
}) {
  const optimizeResult = round.autoOptimize;
  if (!optimizeResult) return null;
  const statusText =
    optimizeResult.status === "created"
      ? "已生成"
      : optimizeResult.status === "failed"
        ? "失败"
        : "跳过";
  const statusClass = optimizeResult.status;
  return (
    <div className={`stat-card iter-auto-optimize-card status-${statusClass}`}>
      <div className="iter-round-head">
        <strong>第 {round.round} 轮</strong>
        <span className="room-tag">{statusText}</span>
        {typeof optimizeResult.durationMs === "number" && (
          <span className="muted-text iter-auto-optimize-duration">
            耗时 {formatElapsed(optimizeResult.durationMs)}
          </span>
        )}
      </div>
      <div className="muted-text">{autoOptimizeText(optimizeResult)}</div>
      {optimizeResult.status === "created" && optimizeResult.generationId && (
        <div className="iter-auto-optimize-gen">
          <span className="muted-text">生成代</span>
          {onSelectGen ? (
            <button
              className="compact-button"
              onClick={() => onSelectGen(optimizeResult.generationId!)}
              title="在 AI 提示词版本面板中选中该代"
            >
              {optimizeResult.generationId}
            </button>
          ) : (
            <strong>{optimizeResult.generationId}</strong>
          )}
          {optimizeResult.changedAssetKeys && optimizeResult.changedAssetKeys.length > 0 && (
            <span className="muted-text">改动:{optimizeResult.changedAssetKeys.join(", ")}</span>
          )}
        </div>
      )}
      {onViewDetail && runId && (
        <div className="iter-auto-optimize-actions">
          <button
            className="compact-button"
            onClick={() => onViewDetail(round.round)}
            title="查看发往大模型的完整生成输入"
          >
            生成详情
          </button>
        </div>
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
    case "auto_optimizing":
      return `第 ${run.currentRound} 轮已完成,正在执行自动优化,生成候选代,请稍候…`;
    case "awaiting_activation":
      return `第 ${run.currentRound} 轮已完成。请在「AI 提示词版本」面板创建/激活下一代,再点「继续下一轮」`;
    case "awaiting_confirmation":
      return `第 ${run.currentRound} 轮已完成。自动优化已生成 ${run.pendingGenerationId ?? "候选代"},确认后进入下一轮`;
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

function formatEstimate(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  if (s < 60) return `约 ${s} 秒`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (h > 0) return m > 0 ? `约 ${h} 小时 ${m} 分` : `约 ${h} 小时`;
  return `约 ${m} 分钟`;
}

/** 毫秒 → 「N 秒」/「N 分 M 秒」/「N 分」,用于自动优化耗时展示。 */
function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m} 分 ${rem} 秒` : `${m} 分`;
}

function personaModeLabel(mode: string): string {
  switch (mode) {
    case "random_each_game":
      return "逐局随机";
    case "fixed_per_run":
      return "整次固定";
    case "fixed_schedule":
      return "固定赛程";
    default:
      return mode;
  }
}

function personaModeDescription(mode: string): string {
  switch (mode) {
    case "fixed_schedule":
      return "开始本次 run 时生成一张 B 局人格组合表,后续每一轮复用同一张表;最适合比较不同 prompt generation,因为每代面对的人格分布一致。";
    case "fixed_per_run":
      return "整次 run 的所有对局都使用同一组 AI 人格;适合针对某一组稳定人格做小样本压测,但覆盖面比固定赛程低。";
    case "random_each_game":
      return "每局建房时重新随机 AI 人格;适合做泛化/烟测,但轮间随机性更大,不适合作为精确版本对比的默认策略。";
    default:
      return mode;
  }
}

function postRoundModeLabel(mode: string): string {
  switch (mode) {
    case "manual":
      return "手动优化";
    case "auto_optimize_wait_confirm":
      return "自动优化后确认";
    case "auto_optimize_activate_continue":
      return "自动优化并继续";
    default:
      return mode;
  }
}

function gameStatusLabel(status: IterationGameResult["status"]): string {
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
    default:
      return "已完成";
  }
}

function phaseLabel(phase: string | undefined): string {
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

function autoOptimizeText(
  optimizeResult: NonNullable<IterationRunStatus["rounds"][number]["autoOptimize"]>,
): string {
  if (optimizeResult.status === "created") {
    const keys = optimizeResult.changedAssetKeys?.length
      ? `(${optimizeResult.changedAssetKeys.join(", ")})`
      : "";
    return `已生成 ${optimizeResult.generationId ?? "-"} ${keys}${optimizeResult.note ? ` · ${optimizeResult.note}` : ""}`;
  }
  if (optimizeResult.status === "failed") return `失败:${optimizeResult.error ?? "未知错误"}`;
  return `跳过:${optimizeResult.error ?? "无变更"}`;
}

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
  const isDone = g.status === "finished" || Boolean(g.score);
  const canOpenReplay = Boolean(g.roomId) && (isDone || g.status === "failed");
  const canOpenScore = Boolean(g.score) && !g.error;

  return (
    <div className={`iter-game-card ${g.winner ?? ""} status-${g.status ?? "finished"}`}>
      <div className="iter-game-head">
        <span className="room-tag">
          {g.roomId || `第 ${(g.gameIndex ?? 0) + 1} 局`}
        </span>
        <span className="room-tag muted-tag">{gameStatusLabel(g.status)}</span>
        <span className={`iter-winner ${g.winner ?? ""}`}>
          {winnerLabel(g.winner)}
        </span>
      </div>
      {g.error ? (
        <span className="error-text">失败:{g.error}</span>
      ) : (
        <div className="iter-game-body">
          <div className="iter-game-meta">
            <span>{phaseLabel(g.phase)}</span>
            <span>游戏第 {g.currentGameRound ?? "-"} 轮</span>
            <span>AI {g.aiAlive ?? "-"}/{g.aiTotal ?? "-"}</span>
            <span>模拟真人 {g.simulatedHumanAlive ?? "-"}/{g.simulatedHumanTotal ?? "-"}</span>
          </div>
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
          <button
            className="compact-button"
            disabled={!canOpenReplay}
            onClick={() => canOpenReplay && onViewReplay(g.roomId)}
          >
            复盘 →
          </button>
          <button
            className="compact-button"
            disabled={!canOpenScore}
            onClick={() => canOpenScore && setModalOpen(true)}
          >
            打分详情
          </button>
        </div>
      )}
      {modalOpen && canOpenScore && (
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
  const [scorer, setScorer] = useState<string | null>(null);
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
      if (json?.ok) {
        setScoreRequest(json.request);
        setScorer(json.request?.system ?? null);
      }
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
                onClick={() => {
                  setTab("prompt");
                  void loadScoreRequest();
                }}
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
                    ? requestLoading
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

type AutoOptimizeRequestData = {
  system: string;
  user: string;
  config: {
    url: string;
    model: string;
    temperature: number;
    reasoningEffort: string;
    thinking: boolean;
  };
};

function AutoOptimizeDetailModal({
  runId,
  roundNo,
  response,
  aggregate,
  onClose,
}: {
  runId: string;
  roundNo: number;
  response?: string;
  aggregate: IterationRunStatus["rounds"][number]["aggregate"];
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"result" | "scorecard" | "user" | "system" | "request">("result");
  const [data, setData] = useState<AutoOptimizeRequestData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // 弹窗打开时锁定底层页面滚动,关闭时恢复。
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
    fetch(`${API_URL}/debug/iterations/auto-optimize-request/${runId}/${roundNo}`)
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        if (json?.ok) setData(json.request);
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
  }, [runId, roundNo]);

  return createPortal(
    <div className="iteration-modal-overlay" onClick={onClose}>
      <div
        className="iteration-modal iter-score-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="iteration-modal-head">
          <div>
            <p className="eyebrow">自动优化生成详情 · 第 {roundNo} 轮</p>
            <h3>发往大模型的完整输入</h3>
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
          ) : data ? (
            <>
              <div className="iter-metric-grid">
                <Metric label="模型" value={data.config.model} />
                <Metric label="Temperature" value={num(data.config.temperature)} />
                <Metric label="Reasoning Effort" value={data.config.reasoningEffort} />
                <Metric label="Thinking" value={data.config.thinking ? "开启" : "关闭"} />
              </div>

              <div className="iter-section">
                <div className="iter-tabs">
                  <button
                    className={`iter-tab ${tab === "result" ? "active" : ""}`}
                    onClick={() => setTab("result")}
                  >
                    生成结果
                  </button>
                  <button
                    className={`iter-tab ${tab === "scorecard" ? "active" : ""}`}
                    onClick={() => setTab("scorecard")}
                  >
                    本轮聚合 scorecard
                  </button>
                  <button
                    className={`iter-tab ${tab === "user" ? "active" : ""}`}
                    onClick={() => setTab("user")}
                  >
                    用户提示词
                  </button>
                  <button
                    className={`iter-tab ${tab === "system" ? "active" : ""}`}
                    onClick={() => setTab("system")}
                  >
                    系统提示词
                  </button>
                  <button
                    className={`iter-tab ${tab === "request" ? "active" : ""}`}
                    onClick={() => setTab("request")}
                  >
                    完整请求 JSON(发往大模型)
                  </button>
                </div>
                <pre className="iter-detail-pre">
                  {tab === "request"
                    ? JSON.stringify(
                        {
                          url: data.config.url,
                          model: data.config.model,
                          temperature: data.config.temperature,
                          messages: [
                            { role: "system", content: data.system },
                            { role: "user", content: data.user },
                          ],
                          reasoning_effort: data.config.reasoningEffort,
                          ...(data.config.thinking
                            ? { thinking: { type: "enabled" } }
                            : {}),
                        },
                        null,
                        2,
                      )
                    : tab === "system"
                      ? data.system
                      : tab === "user"
                        ? data.user
                        : tab === "scorecard"
                          ? aggregate
                            ? JSON.stringify(aggregate, null, 2)
                            : "(本轮无有效聚合 scorecard)"
                          : response?.trim()
                            ? response
                            : "(无生成结果:本轮自动优化未调用大模型或调用失败)"}
                </pre>
              </div>
            </>
          ) : null}
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
    case "auto_optimizing":
      return "自动优化中";
    case "awaiting_activation":
      return "等待激活下一代";
    case "awaiting_confirmation":
      return "等待确认候选代";
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
  assets?: Record<string, string>;
};

type DiffLine = { type: "eq" | "add" | "del"; text: string };

function assetContent(gen: GenDetail | null, key: string): string {
  if (!gen) return "";
  return key === "ai-player/personas"
    ? JSON.stringify(gen.personas ?? [], null, 2)
    : (gen.prompts?.[key] ?? gen.assets?.[key] ?? "");
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
