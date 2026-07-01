"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

const API_URL =
  process.env.NEXT_PUBLIC_API_URL ||
  (typeof window !== "undefined"
    ? `${window.location.protocol}//${window.location.hostname}:3001`
    : "http://localhost:3001");

type RangeValue = "1" | "7" | "30" | "all";

interface LlmStatsBucket {
  totalCalls: number;
  successCalls: number;
  failedCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  totalInputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  cacheHitRate: number;
  avgDurationMs: number;
}

interface LlmModelStatsBucket extends LlmStatsBucket {
  modelName: string;
  providerFormat: string;
}

interface LlmSourceStatsBucket extends LlmStatsBucket {
  source: string;
}

interface LlmStatsView {
  generatedAt: string;
  window: {
    days: number | null;
    since: string | null;
    until: string;
  };
  overview: LlmStatsBucket;
  byModel: LlmModelStatsBucket[];
  bySource: LlmSourceStatsBucket[];
}

export default function LlmStatsPage() {
  const router = useRouter();
  const [range, setRange] = useState<RangeValue>("7");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [stats, setStats] = useState<LlmStatsView | null>(null);

  const loadStats = useCallback(async (rangeValue: RangeValue) => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (rangeValue !== "all") {
        params.set("days", rangeValue);
      }
      const res = await fetch(`${API_URL}/llm/stats${params.size ? `?${params.toString()}` : ""}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok || !data?.ok || !data?.stats) {
        throw new Error(data?.error || "拉取统计数据失败");
      }
      setStats(data.stats as LlmStatsView);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStats(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStats(range);
  }, [loadStats, range]);

  useEffect(() => {
    const timer = setInterval(() => void loadStats(range), 20000);
    return () => clearInterval(timer);
  }, [loadStats, range]);

  const sourceRows = useMemo(() => stats?.bySource ?? [], [stats]);
  const modelRows = useMemo(() => stats?.byModel ?? [], [stats]);
  const overview = stats?.overview;

  return (
    <main className="shell llm-stats-shell">
      <section className="topbar">
        <div>
          <p className="eyebrow">LLM Observability</p>
          <h1>大模型调用统计</h1>
          <p className="muted-text">覆盖真人对局、离线沙盒对局和优化链路的统一统计看板。</p>
        </div>
        <div className="topbar-actions">
          <div className="llm-stats-range">
            {([
              { value: "1", label: "近 1 天" },
              { value: "7", label: "近 7 天" },
              { value: "30", label: "近 30 天" },
              { value: "all", label: "全部" },
            ] as const).map((item) => (
              <button
                key={item.value}
                className={`llm-range-btn${range === item.value ? " active" : ""}`}
                type="button"
                onClick={() => setRange(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <button className="secondary" type="button" onClick={() => void loadStats(range)}>
            刷新
          </button>
          <button className="secondary" type="button" onClick={() => router.push("/")}>
            返回大厅
          </button>
        </div>
      </section>

      {error && <p className="error">{error}</p>}

      <section className="llm-stats-hero panel">
        <div>
          <p className="eyebrow">Window</p>
          <h2>{formatWindow(stats?.window)}</h2>
        </div>
        <div className="llm-stats-meta">
          <span>更新时间</span>
          <strong>{stats ? formatDateTime(stats.generatedAt) : "--"}</strong>
        </div>
      </section>

      <section className="llm-stats-grid">
        <MetricCard
          title="调用次数"
          value={loading && !overview ? "..." : formatNumber(overview?.totalCalls)}
          detail={overview ? `成功 ${formatNumber(overview.successCalls)} / 失败 ${formatNumber(overview.failedCalls)}` : "统计所有真实模型请求"}
          tone="teal"
        />
        <MetricCard
          title="输入 Token"
          value={loading && !overview ? "..." : formatNumber(overview?.promptTokens)}
          detail={overview ? `总输入口径 ${formatNumber(overview.totalInputTokens)}` : "提示词输入 token"}
          tone="sand"
        />
        <MetricCard
          title="输出 Token"
          value={loading && !overview ? "..." : formatNumber(overview?.completionTokens)}
          detail="模型返回 token"
          tone="ink"
        />
        <MetricCard
          title="总 Token"
          value={loading && !overview ? "..." : formatNumber(overview?.totalTokens)}
          detail="输入 + 输出"
          tone="olive"
        />
        <MetricCard
          title="缓存命中 Token"
          value={loading && !overview ? "..." : formatNumber(overview?.cachedTokens)}
          detail={overview ? `缓存写入 ${formatNumber(overview.cacheWriteTokens)}` : "命中缓存输入 token"}
          tone="rose"
        />
        <MetricCard
          title="缓存命中率"
          value={loading && !overview ? "..." : formatPercent(overview?.cacheHitRate)}
          detail={overview ? `平均耗时 ${formatNumber(overview.avgDurationMs)} ms` : "cached / total input"}
          tone="blue"
        />
      </section>

      <section className="llm-stats-layout">
        <section className="panel llm-stats-panel">
          <div className="llm-stats-panel-head">
            <div>
              <p className="eyebrow">By Source</p>
              <h2>按来源查看</h2>
            </div>
            <span className="llm-stats-caption">真人对局 AI 玩家、离线沙盒、优化器、裁判等统一拆分</span>
          </div>
          <StatsTable
            rows={sourceRows}
            emptyText={loading ? "加载中…" : "暂无来源统计"}
            renderName={(row) => sourceLabel(row.source)}
          />
        </section>

        <section className="panel llm-stats-panel">
          <div className="llm-stats-panel-head">
            <div>
              <p className="eyebrow">By Model</p>
              <h2>按模型查看</h2>
            </div>
            <span className="llm-stats-caption">不同模型的调用量、成本与缓存收益</span>
          </div>
          <StatsTable
            rows={modelRows}
            emptyText={loading ? "加载中…" : "暂无模型统计"}
            renderName={(row) => `${row.modelName} · ${row.providerFormat}`}
          />
        </section>
      </section>
    </main>
  );
}

function MetricCard(props: {
  title: string;
  value: string;
  detail: string;
  tone: "teal" | "sand" | "ink" | "olive" | "rose" | "blue";
}) {
  return (
    <article className={`llm-metric-card ${props.tone}`}>
      <span>{props.title}</span>
      <strong>{props.value}</strong>
      <small>{props.detail}</small>
    </article>
  );
}

function StatsTable<T extends LlmSourceStatsBucket | LlmModelStatsBucket>(props: {
  rows: T[];
  emptyText: string;
  renderName: (row: T) => string;
}) {
  if (props.rows.length === 0) {
    return <div className="llm-empty">{props.emptyText}</div>;
  }

  return (
    <div className="llm-table">
      <div className="llm-table-head llm-table-row">
        <span>名称</span>
        <span>调用</span>
        <span>输入</span>
        <span>输出</span>
        <span>总量</span>
        <span>缓存命中</span>
        <span>命中率</span>
      </div>
      {props.rows.map((row) => (
        <div key={props.renderName(row)} className="llm-table-row">
          <strong className="llm-name">{props.renderName(row)}</strong>
          <span className="llm-cell" data-label="调用">
            {formatNumber(row.totalCalls)}
          </span>
          <span className="llm-cell" data-label="输入">
            {formatNumber(row.promptTokens)}
          </span>
          <span className="llm-cell" data-label="输出">
            {formatNumber(row.completionTokens)}
          </span>
          <span className="llm-cell" data-label="总量">
            {formatNumber(row.totalTokens)}
          </span>
          <span className="llm-cell" data-label="缓存命中">
            {formatNumber(row.cachedTokens)}
          </span>
          <span className="llm-cell" data-label="命中率">
            {formatPercent(row.cacheHitRate)}
          </span>
        </div>
      ))}
    </div>
  );
}

function formatNumber(value?: number): string {
  return new Intl.NumberFormat("zh-CN").format(value ?? 0);
}

function formatPercent(value?: number): string {
  return `${((value ?? 0) * 100).toFixed(1)}%`;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function formatWindow(window?: LlmStatsView["window"]): string {
  if (!window) {
    return "加载中…";
  }
  if (window.days == null) {
    return "全量累计";
  }
  return `最近 ${window.days} 天`;
}

function sourceLabel(source: string): string {
  const map: Record<string, string> = {
    ai_player: "AI 玩家",
    optimizer: "优化器",
    judge: "裁判打分",
    optimizer_check: "优化器自检",
    replay_debug: "调试调用",
    unknown: "未标注",
  };
  return map[source] ?? source;
}
