import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  Archive,
  BarChart3,
  CalendarClock,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  ClipboardList,
  Clock3,
  Copy,
  Database,
  ExternalLink,
  FileText,
  Flame,
  Home,
  Languages,
  LoaderCircle,
  Menu,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  Tag,
  Trash2,
  Video,
  X,
} from "lucide-react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { EChartsOption } from "echarts";
import { api, ApiError, setActionToken } from "./api";
import { Chart } from "./components/Chart";
import { VideoThumb } from "./components/VideoThumb";
import {
  categoryLabel,
  formatCount,
  formatJst,
  formatPercent,
  topics,
  type Locale,
} from "./format";

type Page = "overview" | "videos" | "popular" | "collections" | "reports" | "queries";
type Row = Record<string, any>;

const navItems: { id: Page; icon: typeof Home }[] = [
  { id: "overview", icon: Home },
  { id: "videos", icon: Video },
  { id: "popular", icon: Flame },
  { id: "collections", icon: Clock3 },
  { id: "reports", icon: FileText },
  { id: "queries", icon: Tag },
];

function localizedError(error: unknown, t: (key: string) => string): string {
  if (error instanceof ApiError) {
    const key = `errors.${error.code}`;
    const translated = t(key);
    return translated === key ? error.message : translated;
  }
  return t("errors.generic");
}

function useLocale(): Locale {
  const { i18n } = useTranslation();
  return i18n.language === "ja-JP" ? "ja-JP" : "zh-CN";
}

function Panel({
  title,
  subtitle,
  action,
  children,
  className = "",
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      <header className="panel-header">
        <div>
          <h2>{title}</h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

function StatusDot({ status }: { status: string }) {
  return <span className={`status-dot status-${status}`} aria-hidden="true" />;
}

function EmptyState({
  title,
  body,
  icon = <BarChart3 size={36} />,
}: {
  title: string;
  body?: string;
  icon?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <strong>{title}</strong>
      {body ? <p>{body}</p> : null}
    </div>
  );
}

export function App() {
  const { t, i18n } = useTranslation();
  const locale = useLocale();
  const [page, setPage] = useState<Page>("overview");
  const [system, setSystem] = useState<Row | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [modal, setModal] = useState<"collect" | "analyze" | null>(null);
  const [estimate, setEstimate] = useState<Row | null>(null);
  const [analyzeDays, setAnalyzeDays] = useState(30);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const loadSystem = useCallback(async () => {
    const data = await api<Row>("/api/system/status");
    setActionToken(data.actionToken);
    setSystem(data);
  }, []);

  useEffect(() => {
    loadSystem().catch((err) => setError(localizedError(err, t)));
  }, [loadSystem, t]);

  useEffect(() => {
    if (!activeAction) return;
    const timer = window.setInterval(async () => {
      try {
        const action = await api<Row>(`/api/actions/${activeAction}`);
        if (action.status === "success" || action.status === "failed") {
          window.clearInterval(timer);
          setActiveAction(null);
          setNotice(action.status === "success" ? t("action.success") : action.error_summary);
          setRefreshKey((value) => value + 1);
          await loadSystem();
        }
      } catch (err) {
        setError(localizedError(err, t));
      }
    }, 1800);
    return () => window.clearInterval(timer);
  }, [activeAction, loadSystem, t]);

  const changeLanguage = (next: Locale) => {
    localStorage.setItem("sns-trend-lab-locale", next);
    i18n.changeLanguage(next);
  };

  const openCollect = async () => {
    setError(null);
    try {
      const data = await api<Row>("/api/actions/collect-estimate");
      setEstimate(data);
      setModal("collect");
    } catch (err) {
      setError(localizedError(err, t));
    }
  };

  const runAction = async (kind: "collect" | "analyze") => {
    setError(null);
    try {
      const data = await api<{ requestId: string }>(`/api/actions/${kind}`, {
        method: "POST",
        body: kind === "analyze" ? { days: analyzeDays } : {},
      });
      setActiveAction(data.requestId);
      setModal(null);
      setNotice(t("action.running"));
    } catch (err) {
      setError(localizedError(err, t));
    }
  };

  const PageComponent = {
    overview: OverviewPage,
    videos: VideosPage,
    popular: PopularPage,
    collections: CollectionsPage,
    reports: ReportsPage,
    queries: QueriesPage,
  }[page];

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? "sidebar-open" : ""}`}>
        <div className="brand">
          <BarChart3 size={24} />
          <span>SNS Trend Lab</span>
          <button className="icon-button mobile-only" onClick={() => setMobileNav(false)} aria-label={t("common.close")}>
            <X size={18} />
          </button>
        </div>
        <nav>
          {navItems.map(({ id, icon: Icon }) => (
            <button
              key={id}
              className={`nav-item ${page === id ? "nav-active" : ""}`}
              onClick={() => {
                setPage(id);
                setMobileNav(false);
              }}
            >
              <Icon size={19} />
              <span>{t(`nav.${id}`)}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <Settings2 size={18} />
          <span>{t("common.localSource")}</span>
        </div>
      </aside>

      <div className="main-column">
        <header className="topbar">
          <div className="topbar-left">
            <button className="icon-button mobile-only" onClick={() => setMobileNav(true)} aria-label="menu">
              <Menu size={20} />
            </button>
            <div className="freshness">
              <span>{t("overview.refreshed")}</span>
              <strong>{formatJst(system?.latestBatch?.observed_at, locale)}</strong>
              {system?.newDataPendingAnalysis ? <span className="attention-text">{t("common.newData")}</span> : null}
            </div>
          </div>
          <div className="topbar-actions">
            <div className="language-switch" aria-label="language">
              <Languages size={16} />
              <button className={locale === "zh-CN" ? "selected" : ""} onClick={() => changeLanguage("zh-CN")}>中文</button>
              <button className={locale === "ja-JP" ? "selected" : ""} onClick={() => changeLanguage("ja-JP")}>日本語</button>
            </div>
            <button className="primary-button" onClick={openCollect} disabled={Boolean(activeAction)}>
              {activeAction ? <LoaderCircle className="spin" size={17} /> : <Play size={17} />}
              {t("common.collect")}
            </button>
            <button className="secondary-button" onClick={() => setModal("analyze")} disabled={Boolean(activeAction)}>
              <BarChart3 size={17} />
              {t("common.analyze")}
            </button>
            <span className="source-status"><span className="source-dot" />{t("common.localSource")}</span>
          </div>
        </header>

        {(notice || error) ? (
          <div className={`global-message ${error ? "message-error" : "message-success"}`}>
            {error ? <CircleAlert size={17} /> : <CheckCircle2 size={17} />}
            <span>{error || notice}</span>
            <button className="icon-button" onClick={() => { setError(null); setNotice(null); }} aria-label={t("common.close")}>
              <X size={16} />
            </button>
          </div>
        ) : null}

        <main className="page-content">
          <PageComponent refreshKey={refreshKey} />
        </main>
      </div>

      {modal ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setModal(null)}>
          <div className="modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <h2>{modal === "collect" ? t("action.collectTitle") : t("action.analyzeTitle")}</h2>
                <p>{modal === "collect" ? t("action.collectBody") : t("action.analyzeBody")}</p>
              </div>
              <button className="icon-button" onClick={() => setModal(null)} aria-label={t("common.close")}><X size={18} /></button>
            </header>
            {modal === "collect" ? (
              <div className="modal-metrics">
                <div><span>{t("action.estimate")}</span><strong>{formatCount(estimate?.estimatedQuotaUnits, locale)}</strong></div>
                <div><span>{t("action.budget")}</span><strong>{formatCount(estimate?.quotaBudget, locale)}</strong></div>
              </div>
            ) : (
              <label className="field">
                <span>{t("action.days")}</span>
                <select value={analyzeDays} onChange={(event) => setAnalyzeDays(Number(event.target.value))}>
                  <option value={7}>7</option>
                  <option value={30}>30</option>
                  <option value={90}>90</option>
                </select>
              </label>
            )}
            <footer>
              <button className="secondary-button" onClick={() => setModal(null)}>{t("common.cancel")}</button>
              <button className="primary-button" onClick={() => runAction(modal)}><Play size={16} />{t("common.confirm")}</button>
            </footer>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function OverviewPage({ refreshKey }: { refreshKey: number }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [data, setData] = useState<Row | null>(null);

  useEffect(() => {
    api<Row>("/api/dashboard").then(setData);
  }, [refreshKey]);

  const queryOption = useMemo<EChartsOption>(() => ({
    grid: { left: 110, right: 56, top: 20, bottom: 42 },
    xAxis: { type: "value", axisLabel: { color: "#667085" }, splitLine: { lineStyle: { color: "#eef1f5" } } },
    yAxis: {
      type: "category",
      data: (data?.queryPerformance ?? []).map((item: Row) => item.name).reverse(),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: "#344054" },
    },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    series: [{
      type: "bar",
      data: (data?.queryPerformance ?? []).map((item: Row) => Number(item.sample_total_latest_views)).reverse(),
      itemStyle: { color: "#1769e0", borderRadius: [0, 3, 3, 0] },
      barWidth: 24,
      label: { show: true, position: "right", color: "#344054", formatter: (params: any) => formatCount(params.value, locale) },
    }],
  }), [data, locale]);

  const scatterOption = useMemo<EChartsOption>(() => ({
    grid: { left: 58, right: 24, top: 34, bottom: 48 },
    legend: { top: 0, right: 0, textStyle: { color: "#667085" } },
    xAxis: {
      type: "log",
      name: t("videos.latestViews"),
      nameLocation: "middle",
      nameGap: 32,
      axisLabel: { color: "#667085" },
      splitLine: { lineStyle: { color: "#eef1f5" } },
    },
    yAxis: {
      type: "log",
      name: t("videos.reactionRate"),
      axisLabel: { color: "#667085", formatter: "{value}%" },
      splitLine: { lineStyle: { color: "#eef1f5" } },
    },
    tooltip: {
      formatter: (params: any) => `${params.data[2]}<br/>${formatCount(params.data[0], locale)} · ${formatPercent(params.data[1])}`,
    },
    series: [
      {
        name: t("common.lowBase"),
        type: "scatter",
        symbolSize: 8,
        itemStyle: { color: "#f79009" },
        data: (data?.scatter ?? []).filter((item: Row) => item.low_base_reaction_rate).map((item: Row) => [Number(item.latest_views), Number(item.reaction_rate_pct), item.title]),
      },
      {
        name: t("common.active"),
        type: "scatter",
        symbolSize: 8,
        itemStyle: { color: "#1498a3" },
        data: (data?.scatter ?? []).filter((item: Row) => !item.low_base_reaction_rate).map((item: Row) => [Number(item.latest_views), Number(item.reaction_rate_pct), item.title]),
      },
    ],
  }), [data, locale, t]);

  const growthOption = useMemo<EChartsOption>(() => {
    const observationCount = Number(data?.stats?.observation_count ?? 0);
    if (observationCount >= 8) {
      const byPost = new Map<string, Row[]>();
      for (const item of data?.growthTrends ?? []) {
        if (!byPost.has(item.post_id)) byPost.set(item.post_id, []);
        byPost.get(item.post_id)!.push(item);
      }
      return {
        grid: { left: 58, right: 22, top: 24, bottom: 48 },
        tooltip: { trigger: "axis" },
        xAxis: { type: "time", axisLabel: { color: "#667085" }, splitLine: { show: false } },
        yAxis: { type: "value", axisLabel: { color: "#667085" }, splitLine: { lineStyle: { color: "#eef1f5" } } },
        series: [...byPost.values()].map((items, index) => ({
          name: items[0]?.title,
          type: "line",
          showSymbol: true,
          symbolSize: 5,
          data: items.map((item) => [item.observed_at, Number(item.views)]),
          lineStyle: { width: 2 },
          color: ["#1769e0", "#1498a3", "#f79009", "#7f56d9", "#667085"][index],
        })),
      };
    }
    return {
      grid: { left: 118, right: 48, top: 18, bottom: 42 },
      xAxis: { type: "value", axisLabel: { color: "#667085" }, splitLine: { lineStyle: { color: "#eef1f5" } } },
      yAxis: {
        type: "category",
        data: (data?.growthRankings ?? []).map((item: Row) => item.title).reverse(),
        axisLabel: { color: "#344054", width: 100, overflow: "truncate" },
        axisLine: { show: false },
        axisTick: { show: false },
      },
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
      series: [{
        type: "bar",
        data: (data?.growthRankings ?? []).map((item: Row) => Number(item.views_growth_per_day)).reverse(),
        itemStyle: { color: "#1498a3", borderRadius: [0, 3, 3, 0] },
        label: { show: true, position: "right", color: "#344054", formatter: (params: any) => formatCount(Math.round(params.value), locale) },
      }],
    };
  }, [data, locale]);

  const opinionOption = useMemo<EChartsOption>(() => {
    const topics = data?.opinion?.byTopic ?? [];
    return {
      grid: { left: 96, right: 18, top: 22, bottom: 30 },
      legend: { top: 0, textStyle: { color: "#667085" } },
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
      xAxis: { type: "value", axisLabel: { color: "#667085" }, splitLine: { lineStyle: { color: "#eef1f5" } } },
      yAxis: {
        type: "category",
        data: topics.map((item: Row) => item.dimension_value).reverse(),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: "#344054", width: 84, overflow: "truncate" },
      },
      series: [
        { name: t("opinion.positive"), type: "bar", stack: "s", itemStyle: { color: "#12b76a" }, data: topics.map((item: Row) => Number(item.positive_count)).reverse() },
        { name: t("opinion.neutral"), type: "bar", stack: "s", itemStyle: { color: "#98a2b3" }, data: topics.map((item: Row) => Number(item.neutral_count)).reverse() },
        { name: t("opinion.negative"), type: "bar", stack: "s", itemStyle: { color: "#f04438" }, data: topics.map((item: Row) => Number(item.negative_count)).reverse() },
      ],
    };
  }, [data, t]);

  if (!data) return <EmptyState title={t("common.loading")} icon={<LoaderCircle className="spin" size={34} />} />;
  const stats = data.stats ?? {};
  const batch = data.latestBatch ?? {};
  const kpis = [
    [Video, t("overview.sampleVideos"), stats.keyword_sample_videos, ""],
    [Tag, t("overview.queryCount"), stats.query_count, ""],
    [Flame, t("overview.popularCount"), stats.popular_video_count, "Top 50"],
    [Database, t("overview.quota"), batch.actual_quota_units, `/ ${formatCount(data.quotaBudget, locale)}`],
    [CalendarClock, t("overview.latestBatch"), batch.id ? `#${batch.id}` : "N/A", formatJst(batch.observed_at, locale)],
  ] as const;

  return (
    <div>
      <div className="kpi-grid">
        {kpis.map(([Icon, label, value, detail]) => (
          <div className="kpi" key={label}>
            <div className="kpi-label"><Icon size={18} />{label}</div>
            <strong>{typeof value === "string" && value.startsWith("#") ? value : formatCount(value, locale)}</strong>
            <span>{detail}</span>
          </div>
        ))}
      </div>

      <Panel title={t("overview.topVideos")} className="top-videos-panel">
        <div className="video-rail">
          {(data.topVideos ?? []).slice(0, 5).map((video: Row, index: number) => (
            <article className="video-rail-item" key={video.post_id}>
              <div className="rank-flag">{index + 1}</div>
              <VideoThumb postId={video.post_id} url={video.thumbnail_url} alt={video.title} />
              <div>
                <strong>{video.title}</strong>
                <span>{video.channel_title}</span>
                <span className="metric-line">{formatCount(video.latest_views, locale)}</span>
              </div>
            </article>
          ))}
        </div>
      </Panel>

      <div className="dashboard-grid">
        <Panel title={t("overview.queryPerformance")} subtitle={t("overview.querySubtitle")} className="span-5">
          <Chart option={queryOption} />
          <p className="panel-note">{t("overview.directional")}</p>
        </Panel>
        <Panel title={t("overview.scatter")} subtitle={t("overview.scatterSubtitle")} className="span-4">
          <Chart option={scatterOption} />
        </Panel>
        <Panel title={t("overview.popularTop")} className="span-3">
          <ol className="popular-compact">
            {(data.popular ?? []).map((item: Row) => (
              <li key={item.post_id}>
                <span className="rank-number">{item.rank_position}</span>
                <VideoThumb postId={item.post_id} url={item.thumbnail_url} alt={item.title} />
                <div><strong>{item.title}</strong><span>{item.channel_title}</span></div>
                <b>{formatCount(item.views, locale)}</b>
              </li>
            ))}
          </ol>
        </Panel>
        <Panel title={t("overview.recommendations")} className="span-4">
          <div className="recommendation-list">
            {(data.recommendations?.[locale] ?? []).map((item: string, index: number) => (
              <div key={item}><span>{index + 1}</span><p>{item}</p></div>
            ))}
          </div>
        </Panel>
        <Panel title={t("overview.growth")} className="span-4">
          {Number(stats.observation_count) < 2 ? (
            <EmptyState title={t("overview.needsSnapshots")} body={t("overview.needsSnapshotsBody")} />
          ) : (
            <Chart option={growthOption} />
          )}
        </Panel>
        <Panel title={t("overview.quotaUsage")} className="span-4">
          <div className="quota-summary">
            <div className="quota-ring"><strong>{formatCount(batch.actual_quota_units, locale)}</strong><span>/ {formatCount(data.quotaBudget, locale)}</span></div>
            <ul>
              {(data.quotaBreakdown ?? []).map((item: Row) => (
                <li key={item.run_type}><span>{item.run_type}</span><b>{item.quota_units}</b></li>
              ))}
            </ul>
          </div>
        </Panel>
        <Panel title={t("overview.opinion")} subtitle={t("overview.opinionSubtitle")} className="span-4">
          {(data.opinion?.byTopic?.length ?? 0) === 0 ? (
            <EmptyState title={t("common.noData")} />
          ) : (
            <Chart option={opinionOption} />
          )}
        </Panel>
      </div>
    </div>
  );
}

function VideosPage({ refreshKey }: { refreshKey: number }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [data, setData] = useState<Row>({ items: [], total: 0, filters: {} });
  const [page, setPage] = useState(1);
  const [runId, setRunId] = useState("");
  const [topic, setTopic] = useState("");
  const [category, setCategory] = useState("");
  const [sort, setSort] = useState("latest_views");
  const [search, setSearch] = useState("");
  const [lowBase, setLowBase] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Row | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({
      page: String(page),
      page_size: "20",
      sort,
      direction: "desc",
    });
    if (runId) params.set("analysis_run_id", runId);
    if (topic) params.set("topic", topic);
    if (category) params.set("category_id", category);
    if (search) params.set("search", search);
    if (lowBase) params.set("low_base", "true");
    const result = await api<Row>(`/api/videos?${params}`);
    setData(result);
    if (!selected && result.items?.[0]) setSelected(result.items[0].post_id);
  }, [page, runId, topic, category, search, lowBase, sort, selected]);

  useEffect(() => { load(); }, [load, refreshKey]);
  useEffect(() => {
    if (!selected) return;
    const suffix = data.analysisRunId ? `?analysis_run_id=${data.analysisRunId}` : "";
    api<Row>(`/api/videos/${selected}${suffix}`).then(setDetail);
  }, [selected, data.analysisRunId, refreshKey]);

  const columns = useMemo<ColumnDef<Row>[]>(() => [
    {
      header: "#",
      cell: (info) => (page - 1) * 20 + info.row.index + 1,
      size: 44,
    },
    {
      header: t("videos.video"),
      accessorKey: "title",
      cell: (info) => {
        const item = info.row.original;
        return <div className="video-cell"><VideoThumb postId={item.post_id} url={item.thumbnail_url} alt={item.title} /><strong>{item.title}</strong></div>;
      },
    },
    { header: t("videos.channel"), accessorKey: "channel_title" },
    {
      header: t("videos.topicLabel"),
      accessorKey: "topics",
      cell: (info) => <span>{topics(info.getValue()).join(", ")}</span>,
    },
    {
      header: t("videos.latestViews"),
      accessorKey: "latest_views",
      cell: (info) => formatCount(info.getValue(), locale),
    },
    {
      header: t("videos.reactionRate"),
      accessorKey: "reaction_rate_pct",
      cell: (info) => <span className={info.row.original.low_base_reaction_rate ? "low-base-value" : ""}>{formatPercent(info.getValue())}</span>,
    },
    {
      header: t("videos.growth"),
      accessorKey: "views_growth_abs",
      cell: (info) => formatCount(info.getValue(), locale),
    },
    { header: t("videos.snapshots"), accessorKey: "snapshot_count" },
    {
      header: t("videos.published"),
      accessorKey: "published_at",
      cell: (info) => formatJst(info.getValue(), locale, false),
    },
  ], [locale, page, t]);

  const table = useReactTable({ data: data.items ?? [], columns, getCoreRowModel: getCoreRowModel() });
  const pageCount = Math.max(1, Math.ceil(Number(data.total) / 20));

  const scatterOption = useMemo<EChartsOption>(() => ({
    grid: { left: 64, right: 26, top: 38, bottom: 52 },
    xAxis: { type: "log", name: t("videos.latestViews"), nameLocation: "middle", nameGap: 34, splitLine: { lineStyle: { color: "#eef1f5" } } },
    yAxis: { type: "log", name: t("videos.reactionRate"), axisLabel: { formatter: "{value}%" }, splitLine: { lineStyle: { color: "#eef1f5" } } },
    tooltip: { formatter: (params: any) => `${params.data[2]}<br/>${formatCount(params.data[0], locale)} · ${formatPercent(params.data[1])}` },
    series: [{
      type: "scatter",
      symbolSize: (value: number[]) => value[3] ? 11 : 8,
      itemStyle: { color: (params: any) => params.data[3] ? "#f79009" : "#1498a3" },
      data: (data.scatter ?? []).map((item: Row) => [Number(item.latest_views), Number(item.reaction_rate_pct), item.title, item.low_base_reaction_rate]),
    }],
  }), [data.items, locale, t]);

  return (
    <div>
      <div className="page-heading"><div><h1>{t("videos.title")}</h1><p>{t("videos.total", { count: data.total })}</p></div></div>
      <div className="filter-bar">
        <label><span>{t("videos.run")}</span><select value={runId} onChange={(event) => { setRunId(event.target.value); setPage(1); }}><option value="">{t("common.all")}</option>{(data.filters?.runs ?? []).map((item: Row) => <option key={item.id} value={item.id}>#{item.id} · {formatJst(item.completed_at, locale)}</option>)}</select></label>
        <label><span>{t("videos.topic")}</span><select value={topic} onChange={(event) => { setTopic(event.target.value); setPage(1); }}><option value="">{t("common.all")}</option>{(data.filters?.topics ?? []).map((item: Row) => <option key={item.topic}>{item.topic}</option>)}</select></label>
        <label><span>{t("videos.category")}</span><select value={category} onChange={(event) => { setCategory(event.target.value); setPage(1); }}><option value="">{t("common.all")}</option>{(data.filters?.categories ?? []).map((item: Row) => <option key={item.category_id} value={item.category_id}>{categoryLabel(item.category_id, item.category_title, locale)}</option>)}</select></label>
        <label><span>{t("videos.sort")}</span><select value={sort} onChange={(event) => setSort(event.target.value)}><option value="latest_views">{t("videos.latestViews")}</option><option value="reaction_rate">{t("videos.reactionRate")}</option><option value="growth">{t("videos.growth")}</option><option value="published_at">{t("videos.published")}</option></select></label>
        <label className="search-field"><Search size={16} /><input value={search} placeholder={t("common.search")} onChange={(event) => { setSearch(event.target.value); setPage(1); }} /></label>
        <button className={`toggle-button ${lowBase ? "toggle-active" : ""}`} onClick={() => setLowBase((value) => !value)}>{t("common.lowBase")}</button>
        <button className="secondary-button compact" onClick={() => { setRunId(""); setTopic(""); setCategory(""); setSort("latest_views"); setSearch(""); setLowBase(false); setPage(1); }}><RotateCcw size={15} />{t("common.reset")}</button>
      </div>

      <div className="analysis-split">
        <Panel title={t("videos.chart")} className="analysis-chart">
          <Chart option={scatterOption} />
          <p className="warning-note"><CircleAlert size={15} />{t("videos.lowBaseHint")}</p>
        </Panel>
        <Panel title={t("videos.selected")} className="detail-panel">
          {detail ? (
            <div className="video-detail">
              <VideoThumb postId={detail.post_id} url={detail.thumbnail_url} alt={detail.title} className="detail-thumb" />
              <h3>{detail.title}</h3>
              <p>{detail.channel_title}</p>
              <div className="detail-metrics">
                <div><span>{t("videos.latestViews")}</span><strong>{formatCount(detail.latest_views, locale)}</strong></div>
                <div><span>{t("videos.likes")}</span><strong>{formatCount(detail.latest_likes, locale)}</strong></div>
                <div><span>{t("videos.comments")}</span><strong>{formatCount(detail.latest_comments, locale)}</strong></div>
                <div><span>{t("videos.reactionRate")}</span><strong>{formatPercent(detail.reaction_rate_pct)}</strong></div>
                <div><span>{t("videos.category")}</span><strong>{categoryLabel(detail.category_id, detail.category_title, locale)}</strong></div>
                <div><span>{t("videos.snapshots")}</span><strong>{detail.snapshot_count}</strong></div>
              </div>
              <div className="tag-list">{(detail.tags ?? []).slice(0, 12).map((item: Row) => <span key={item.tag}>{item.tag}</span>)}</div>
              <a className="text-link" href={detail.url} target="_blank" rel="noreferrer">{t("common.openYoutube")}<ExternalLink size={14} /></a>
            </div>
          ) : <EmptyState title={t("common.noData")} />}
        </Panel>
      </div>

      <div className="table-wrap">
        <table>
          <thead>{table.getHeaderGroups().map((group) => <tr key={group.id}>{group.headers.map((header) => <th key={header.id}>{flexRender(header.column.columnDef.header, header.getContext())}</th>)}</tr>)}</thead>
          <tbody>{table.getRowModel().rows.map((row) => <tr key={row.id} className={row.original.post_id === selected ? "selected-row" : ""} onClick={() => setSelected(row.original.post_id)}>{row.getVisibleCells().map((cell) => <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}</tr>)}</tbody>
        </table>
      </div>
      <div className="pagination"><button className="icon-button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={17} /></button><span>{page} / {pageCount}</span><button className="icon-button" disabled={page >= pageCount} onClick={() => setPage((value) => value + 1)}><ChevronRight size={17} /></button></div>
    </div>
  );
}

function PopularPage({ refreshKey }: { refreshKey: number }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [items, setItems] = useState<Row[]>([]);
  useEffect(() => { api<Row>("/api/popular").then((data) => setItems(data.items)); }, [refreshKey]);
  return (
    <div>
      <div className="page-heading"><div><h1>{t("popular.title")}</h1><p>{t("popular.subtitle")}</p></div></div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>{t("popular.rank")}</th><th>{t("popular.video")}</th><th>{t("popular.channel")}</th><th>{t("popular.views")}</th><th>{t("popular.appearances")}</th><th>{t("popular.rankChange")}</th></tr></thead>
          <tbody>{items.map((item) => <tr key={item.post_id}><td><strong className="rank-large">{item.rank_position}</strong></td><td><div className="video-cell"><VideoThumb postId={item.post_id} url={item.thumbnail_url} alt={item.title} /><strong>{item.title}</strong></div></td><td>{item.channel_title}</td><td>{formatCount(item.views, locale)}</td><td>{item.appearance_count}</td><td>{Number(item.rank_change) > 0 ? `+${item.rank_change}` : item.rank_change}</td></tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}

function CollectionsPage({ refreshKey }: { refreshKey: number }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [items, setItems] = useState<Row[]>([]);
  const [selected, setSelected] = useState<Row | null>(null);
  const [schedule, setSchedule] = useState<Row | null>(null);

  const load = useCallback(async () => {
    const [history, status] = await Promise.all([api<Row>("/api/collections"), api<Row>("/api/schedule")]);
    setItems(history.items);
    setSchedule(status);
  }, []);
  useEffect(() => { load(); }, [load, refreshKey]);

  const toggleSchedule = async () => {
    await api<Row>("/api/schedule", { method: schedule?.installed ? "DELETE" : "POST", body: {} });
    await load();
  };
  const showDetail = async (id: string) => setSelected(await api<Row>(`/api/collections/${id}`));

  return (
    <div>
      <div className="page-heading"><div><h1>{t("collections.title")}</h1></div></div>
      <Panel title={t("collections.schedule")} subtitle={t("collections.scheduleBody")} action={<button className={schedule?.installed ? "secondary-button" : "primary-button"} onClick={toggleSchedule}>{schedule?.installed ? <Trash2 size={16} /> : <CalendarClock size={16} />}{schedule?.installed ? t("collections.uninstall") : t("collections.install")}</button>}>
        <div className="schedule-status"><StatusDot status={schedule?.installed ? "success" : "disabled"} /><strong>{schedule?.installed ? t("collections.installed") : t("collections.notInstalled")}</strong></div>
      </Panel>
      <div className="table-wrap">
        <table>
          <thead><tr><th>{t("collections.batch")}</th><th>{t("collections.observedAt")}</th><th>{t("collections.trigger")}</th><th>{t("common.status")}</th><th>{t("collections.videos")}</th><th>{t("collections.channels")}</th><th>{t("collections.quota")}</th></tr></thead>
          <tbody>{items.map((item) => <tr key={item.id} onClick={() => showDetail(item.id)} className={selected?.id === item.id ? "selected-row" : ""}><td>#{item.id}</td><td>{formatJst(item.observed_at, locale)}</td><td>{item.trigger_type}</td><td><span className="status-label"><StatusDot status={item.status} />{item.status}</span></td><td>{item.video_count}</td><td>{item.channel_count}</td><td>{item.actual_quota_units}</td></tr>)}</tbody>
        </table>
      </div>
      {selected ? <Panel title={`${t("collections.details")} #${selected.id}`} className="detail-section"><div className="table-wrap flat"><table><thead><tr><th>{t("collections.runType")}</th><th>{t("common.status")}</th><th>{t("collections.requests")}</th><th>{t("collections.returned")}</th><th>{t("collections.quota")}</th><th>{t("collections.error")}</th></tr></thead><tbody>{selected.runs.map((run: Row) => <tr key={run.id}><td>{run.query_name || run.run_type}</td><td>{run.status}</td><td>{run.request_count}</td><td>{run.returned_count}</td><td>{run.quota_units}</td><td>{run.error_summary || ""}</td></tr>)}</tbody></table></div></Panel> : null}
    </div>
  );
}

function ReportsPage({ refreshKey }: { refreshKey: number }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [items, setItems] = useState<Row[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [report, setReport] = useState<Row | null>(null);
  useEffect(() => {
    api<Row>("/api/reports").then((data) => {
      setItems(data.items);
      if (!selected && data.items[0]) setSelected(data.items[0].id);
    });
  }, [refreshKey, selected]);
  useEffect(() => {
    if (selected) api<Row>(`/api/reports/${selected}?locale=${locale}`).then(setReport);
  }, [selected, locale, refreshKey]);

  return (
    <div>
      <div className="page-heading"><div><h1>{t("reports.title")}</h1></div></div>
      <div className="report-layout">
        <Panel title={t("reports.history")} className="report-history">
          <div className="run-list">{items.map((item) => <button key={item.id} className={selected === item.id ? "run-selected" : ""} onClick={() => setSelected(item.id)}><span><StatusDot status={item.status} />#{item.id} · {item.days}d</span><small>{formatJst(item.completed_at || item.started_at, locale)}</small></button>)}</div>
        </Panel>
        <Panel title={report ? `#${report.id} · ${t("reports.window")} ${report.days}d` : t("reports.title")} className="report-body">
          {report?.localeFallback ? <div className="fallback-notice"><CircleAlert size={16} />{t("reports.fallback")}</div> : null}
          {report ? <article className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{report.markdown}</ReactMarkdown></article> : <EmptyState title={t("common.noData")} />}
        </Panel>
      </div>
    </div>
  );
}

function QueriesPage({ refreshKey }: { refreshKey: number }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<Row[]>([]);
  const [form, setForm] = useState({ name: "", query_text: "", topic: "", max_results: 50, lookback_days: 7 });
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => api<Row>("/api/queries").then((data) => setItems(data.items)), []);
  useEffect(() => { load(); }, [load, refreshKey]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      await api<Row>("/api/queries", { method: "POST", body: form });
      setForm({ name: "", query_text: "", topic: "", max_results: 50, lookback_days: 7 });
      await load();
    } catch (err) {
      setError(localizedError(err, t));
    }
  };
  const mutate = async (path: string, method = "POST", body: Row = {}) => {
    try {
      await api<Row>(path, { method, body });
      await load();
    } catch (err) {
      setError(localizedError(err, t));
    }
  };

  return (
    <div>
      <div className="page-heading"><div><h1>{t("queries.title")}</h1><p>{t("queries.immutable")}</p></div></div>
      {error ? <div className="inline-error"><CircleAlert size={16} />{error}</div> : null}
      <Panel title={t("common.create")}>
        <form className="query-form" onSubmit={submit}>
          <label><span>{t("queries.name")}</span><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
          <label><span>{t("queries.queryText")}</span><input required value={form.query_text} onChange={(event) => setForm({ ...form, query_text: event.target.value })} /></label>
          <label><span>{t("queries.topic")}</span><input required value={form.topic} onChange={(event) => setForm({ ...form, topic: event.target.value })} /></label>
          <label><span>{t("queries.maxResults")}</span><input type="number" min={1} max={50} value={form.max_results} onChange={(event) => setForm({ ...form, max_results: Number(event.target.value) })} /></label>
          <label><span>{t("queries.lookback")}</span><input type="number" min={1} max={30} value={form.lookback_days} onChange={(event) => setForm({ ...form, lookback_days: Number(event.target.value) })} /></label>
          <button className="primary-button" type="submit"><Plus size={16} />{t("common.create")}</button>
        </form>
      </Panel>
      <div className="table-wrap">
        <table>
          <thead><tr><th>{t("queries.name")}</th><th>{t("queries.queryText")}</th><th>{t("queries.topic")}</th><th>{t("queries.maxResults")}</th><th>{t("queries.lookback")}</th><th>{t("queries.observations")}</th><th>{t("common.status")}</th><th>{t("common.actions")}</th></tr></thead>
          <tbody>{items.map((item) => <tr key={item.id}><td><strong>{item.name}</strong></td><td>{item.query_text}</td><td>{item.topic}</td><td><input className="cell-input" type="number" min={1} max={50} defaultValue={item.max_results} onBlur={(event) => { const value = Number(event.target.value); if (value !== Number(item.max_results)) mutate(`/api/queries/${item.id}`, "PATCH", { max_results: value }); }} /></td><td><input className="cell-input" type="number" min={1} max={30} defaultValue={item.lookback_days} onBlur={(event) => { const value = Number(event.target.value); if (value !== Number(item.lookback_days)) mutate(`/api/queries/${item.id}`, "PATCH", { lookback_days: value }); }} /></td><td>{item.observation_count}</td><td>{item.archived_at ? t("common.archived") : item.enabled ? t("common.active") : t("common.disabled")}</td><td><div className="row-actions">{item.archived_at ? <button className="icon-button" title={t("common.restore")} onClick={() => mutate(`/api/queries/${item.id}/restore`)}><RefreshCw size={16} /></button> : <><button className="icon-button" title={item.enabled ? t("common.disabled") : t("common.active")} onClick={() => mutate(`/api/queries/${item.id}`, "PATCH", { enabled: !item.enabled })}>{item.enabled ? <X size={16} /> : <CheckCircle2 size={16} />}</button><button className="icon-button" title={t("common.archive")} onClick={() => mutate(`/api/queries/${item.id}/archive`)}><Archive size={16} /></button></>}<button className="icon-button" title={t("common.copy")} onClick={() => mutate(`/api/queries/${item.id}/copy`, "POST", { name: `${item.name} copy ${Date.now().toString().slice(-4)}` })}><Copy size={16} /></button></div></td></tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}
