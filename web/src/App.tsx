import {
  useCallback,
  useEffect,
  Fragment,
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
  MessageSquareText,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  Sparkles,
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

type Page =
  | "overview"
  | "videos"
  | "popular"
  | "quota"
  | "comments"
  | "collections"
  | "reports"
  | "skillAnalyses"
  | "queries";
type Row = Record<string, any>;

const navItems: { id: Page; icon: typeof Home }[] = [
  { id: "overview", icon: Home },
  { id: "videos", icon: Video },
  { id: "popular", icon: Flame },
  { id: "quota", icon: Database },
  { id: "comments", icon: MessageSquareText },
  { id: "collections", icon: Clock3 },
  { id: "reports", icon: FileText },
  { id: "skillAnalyses", icon: Sparkles },
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

function QuotaBuckets({
  quota,
  locale,
  compact = false,
}: {
  quota: Row | null;
  locale: Locale;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  if (!quota || quota.status === "unavailable") {
    return (
      <EmptyState
        title={t("quota.unavailable")}
        body={quota?.message || t("quota.setupHint")}
        icon={<Database size={34} />}
      />
    );
  }
  if (!(quota.buckets ?? []).length) {
    return <EmptyState title={t("quota.noMetrics")} body={t("quota.noMetricsHint")} />;
  }
  return (
    <div className={`quota-buckets ${compact ? "quota-buckets-compact" : ""}`}>
      <div className="quota-freshness">
        <span className={`status-label quota-${quota.status}`}>
          <StatusDot status={quota.status === "available" ? "success" : "disabled"} />
          {t(`quota.${quota.status}`)}
        </span>
        <span>{t("quota.asOf")}: {formatJst(quota.asOf, locale)}</span>
      </div>
      {(quota.buckets ?? []).map((bucket: Row) => {
        const ratio = Math.min(100, Math.max(0, Number(bucket.usageRatio ?? 0) * 100));
        return (
          <div className="quota-bucket" key={bucket.id}>
            <div className="quota-bucket-head">
              <div>
                <strong>{bucket.limitName}</strong>
                <span>{bucket.quotaMetric}</span>
              </div>
              <b>{bucket.remaining == null ? "-" : formatCount(bucket.remaining, locale)} {t("quota.remaining")}</b>
            </div>
            <div className="quota-progress"><span style={{ width: `${ratio}%` }} /></div>
            <div className="quota-bucket-foot">
              <span>{t("quota.used")} {bucket.used == null ? "-" : formatCount(bucket.used, locale)}</span>
              <span>{t("quota.limit")} {formatCount(bucket.limit, locale)}</span>
            </div>
          </div>
        );
      })}
      {!compact && quota.consoleUrl ? (
        <a className="text-link" href={quota.consoleUrl} target="_blank" rel="noreferrer">
          {t("quota.openConsole")}<ExternalLink size={14} />
        </a>
      ) : null}
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
      const data = await api<Row>("/api/actions/collect-estimate?mode=balanced");
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
        body: kind === "analyze" ? { days: analyzeDays } : { mode: "balanced" },
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
    quota: QuotaPage,
    comments: CommentInsightsPage,
    collections: CollectionsPage,
    reports: ReportsPage,
    skillAnalyses: SkillAnalysesPage,
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
                <div><span>{t("action.standardEstimate")}</span><strong>{formatCount(estimate?.estimatedQuotaByBucket?.standard_units_per_day, locale)}</strong><small>/ {formatCount(estimate?.quotaBudget, locale)} {t("action.localBudget")}</small></div>
                <div><span>{t("action.searchEstimate")}</span><strong>{formatCount(estimate?.estimatedQuotaByBucket?.search_requests_per_day, locale)}</strong><small>/ {formatCount(estimate?.searchQuotaBudget, locale)} {t("action.localBudget")}</small></div>
                <div><span>{t("quotaOptimizer.keywordPlan")}</span><strong>{formatCount(estimate?.queryCount, locale)}</strong><small>{t("quotaOptimizer.enabledKeywords")}</small></div>
                <div><span>{t("quotaOptimizer.commentPlan")}</span><strong>{formatCount(estimate?.plannedCommentVideos, locale)}</strong><small>{formatCount(estimate?.plannedCommentPages, locale)} {t("quotaOptimizer.pagesEach")}</small></div>
                <p className="modal-plan-note">{t("action.localEstimateHint")}</p>
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

  if (!data) return <EmptyState title={t("common.loading")} icon={<LoaderCircle className="spin" size={34} />} />;
  const stats = data.stats ?? {};
  const batch = data.latestBatch ?? {};
  const kpis = [
    [Video, t("overview.sampleVideos"), stats.keyword_sample_videos, ""],
    [Tag, t("overview.queryCount"), stats.query_count, ""],
    [Flame, t("overview.popularCount"), stats.popular_video_count, "Top 50"],
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
        <Panel title={t("overview.opinion")} subtitle={t("overview.opinionSubtitle")} className="span-4">
          {!data.opinion?.overall ? (
            <EmptyState title={t("common.noData")} />
          ) : (
            <div className="opinion-summary">
              <strong>{formatCount(data.opinion.overall.comment_count, locale)}</strong>
              <span>{t("comments.analyzedComments")}</span>
              <div>
                <b>{t("opinion.positive")}: {formatCount(data.opinion.overall.positive_count, locale)}</b>
                <b>{t("opinion.neutral")}: {formatCount(data.opinion.overall.neutral_count, locale)}</b>
                <b>{t("opinion.negative")}: {formatCount(data.opinion.overall.negative_count, locale)}</b>
              </div>
              <p className="panel-note">{t("comments.privacyNote")}</p>
            </div>
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
  const detailGrowthOption = useMemo<EChartsOption>(() => {
    const rows = detail?.snapshots ?? [];
    return {
      grid: { left: 58, right: 18, top: 28, bottom: 44 },
      legend: { top: 0 },
      tooltip: { trigger: "axis" },
      xAxis: { type: "category", data: rows.map((row: Row) => formatJst(row.observed_at, locale, false)), axisLabel: { hideOverlap: true } },
      yAxis: { type: "value", splitLine: { lineStyle: { color: "#eef1f5" } } },
      series: [
        { type: "line", name: t("videos.latestViews"), smooth: true, data: rows.map((row: Row) => Number(row.views ?? 0)), lineStyle: { color: "#2563eb" }, itemStyle: { color: "#2563eb" } },
        { type: "line", name: t("videos.likes"), smooth: true, data: rows.map((row: Row) => Number(row.likes ?? 0)), lineStyle: { color: "#14a3a8" }, itemStyle: { color: "#14a3a8" } },
        { type: "line", name: t("videos.comments"), smooth: true, data: rows.map((row: Row) => Number(row.comments ?? 0)), lineStyle: { color: "#f59e0b" }, itemStyle: { color: "#f59e0b" } },
      ],
    };
  }, [detail, locale, t]);
  const peerMetrics = detail ? [
    [t("videos.latestViews"), detail.peerComparison?.views, (value: unknown) => formatCount(value, locale)],
    [t("videos.reactionRate"), detail.peerComparison?.reactionRate, (value: unknown) => formatPercent(value)],
    [t("videos.dailyGrowth"), detail.peerComparison?.growthPerDay, (value: unknown) => formatCount(value, locale)],
  ] : [];

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

      {detail ? (
        <div className="video-diagnostic-grid">
          <Panel title={t("videos.growthTimeline")} subtitle={Number(detail.snapshot_count) < 2 ? t("videos.needsMoreSnapshots") : undefined} className="span-6">
            {Number(detail.snapshot_count) < 2 ? <EmptyState title={t("videos.needsMoreSnapshots")} /> : <Chart option={detailGrowthOption} />}
          </Panel>
          <Panel title={t("videos.peerComparison")} subtitle={t("videos.peerSubtitle")} className="span-6">
            <div className="peer-metrics">
              {peerMetrics.map(([label, metric, formatter]: any[]) => (
                <div key={label}>
                  <span>{label}</span>
                  <strong>{formatter(metric?.value)}</strong>
                  <small>{metric?.rank ? t("videos.peerRank", { rank: metric.rank, total: metric.total, percentile: metric.percentile }) : t("common.noData")}</small>
                  <div className="mini-bar"><i style={{ width: `${Math.max(0, Math.min(100, Number(metric?.percentile ?? 0)))}%` }} /></div>
                </div>
              ))}
            </div>
          </Panel>
          <Panel title={t("videos.contentSignals")} subtitle={t("videos.contentSubtitle")} className="span-6">
            <div className="signal-block">
              <b>{t("videos.titleTerms")}</b>
              <div className="tag-list compact-tags">{(detail.contentSignals?.titleTerms ?? []).map((term: string) => <span key={term}>{term}</span>)}</div>
              <b>{t("videos.matchedQueries")}</b>
              <div className="tag-list compact-tags">{(detail.queries ?? []).map((query: Row) => <span key={query.id}>{query.query_text}</span>)}</div>
              <b>{t("videos.tags")}</b>
              <div className="tag-list compact-tags">{(detail.tags ?? []).slice(0, 18).map((item: Row) => <span key={item.tag}>{item.tag}</span>)}</div>
            </div>
          </Panel>
          <Panel title={t("videos.discoveryPath")} subtitle={t("videos.discoverySubtitle")} className="span-6">
            <div className="discovery-grid">
              <div><span>{t("videos.keywordSample")}</span><strong>{detail.contentSignals?.discoverySources?.keywordSample ? t("common.yes") : t("common.no")}</strong><small>{(detail.queries ?? []).map((query: Row) => query.topic).join(", ") || "N/A"}</small></div>
              <div><span>{t("videos.popularChart")}</span><strong>{detail.contentSignals?.discoverySources?.popularChart ? t("common.yes") : t("common.no")}</strong><small>{detail.popularSummary ? t("videos.popularRankSummary", { best: detail.popularSummary.best_rank, latest: detail.popularSummary.latest_rank, count: detail.popularSummary.appearance_count }) : t("videos.notOnPopular")}</small></div>
            </div>
            <div className="popular-history">
              {(detail.popularHistory ?? []).slice(0, 8).map((row: Row) => (
                <span key={`${row.batch_id}-${row.rank_position}`}>{formatJst(row.observed_at, locale, false)} · #{row.rank_position}</span>
              ))}
            </div>
          </Panel>
        </div>
      ) : null}

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

function QuotaPage({ refreshKey }: { refreshKey: number }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [quota, setQuota] = useState<Row | null>(null);
  const [plan, setPlan] = useState<Row | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [quotaData, planData] = await Promise.all([
      api<Row>("/api/system/quota"),
      api<Row>("/api/quota/plan"),
    ]);
    setQuota(quotaData);
    setPlan(planData);
  }, []);
  useEffect(() => { load(); }, [load, refreshKey]);

  const buckets = quota?.buckets ?? [];
  const dailyBuckets = buckets.filter((item: Row) => item.period === "day");
  const minuteBuckets = buckets.filter((item: Row) => item.period === "minute");
  const summary = quota?.summary ?? {};
  const dailyRatio = Number(summary.dailyUsageRatio ?? 0) * 100;

  if (!quota) return <EmptyState title={t("common.loading")} icon={<LoaderCircle className="spin" size={34} />} />;

  return (
    <div>
      <div className="page-heading quota-heading">
        <div>
          <h1>{t("quotaPage.title")}</h1>
          <p>{t("quotaPage.subtitle")}</p>
        </div>
        {quota.consoleUrl ? (
          <a className="secondary-button" href={quota.consoleUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={16} />{t("quota.openConsole")}
          </a>
        ) : null}
      </div>

      {quota.status === "unavailable" ? (
        <Panel title={t("quota.unavailable")}>
          <EmptyState title={quota.message || t("quota.unavailable")} body={t("quota.setupHint")} icon={<Database size={34} />} />
        </Panel>
      ) : (
        <>
          <div className="quota-summary-grid">
            <div className="quota-summary-card">
              <span>{t("quotaPage.dailyTotalLimit")}</span>
              <strong>{formatCount(summary.dailyLimit, locale)}</strong>
              <small>{t("quotaPage.dailyTotalHint")}</small>
            </div>
            <div className="quota-summary-card">
              <span>{t("quotaPage.dailyTotalUsed")}</span>
              <strong>{formatCount(summary.dailyUsed, locale)}</strong>
              <div className="quota-progress wide"><span style={{ width: `${Math.min(100, Math.max(0, dailyRatio))}%` }} /></div>
            </div>
            <div className="quota-summary-card">
              <span>{t("quotaPage.dailyTotalRemaining")}</span>
              <strong>{formatCount(summary.dailyRemaining, locale)}</strong>
              <small>{formatPercent(dailyRatio)} {t("quotaPage.usedPercent")}</small>
            </div>
            <div className="quota-summary-card">
              <span>{t("quotaPage.metricCount")}</span>
              <strong>{formatCount(summary.bucketCount, locale)}</strong>
              <small>{t(`quota.${quota.status}`)} · {t("quota.asOf")} {formatJst(quota.asOf, locale)}</small>
            </div>
          </div>

          {plan ? (
            <Panel title={t("quotaOptimizer.title")} subtitle={t("quotaOptimizer.subtitle")} className="quota-plan-panel">
              <div className="quota-plan-grid">
                <div>
                  <span>{t("quotaOptimizer.searchTarget")}</span>
                  <strong>{formatCount(plan.search?.target, locale)}</strong>
                  <small>{formatCount(plan.search?.used, locale)} / {formatCount(plan.search?.limit, locale)} {t("quota.used")}</small>
                </div>
                <div>
                  <span>{t("quotaOptimizer.standardTarget")}</span>
                  <strong>{formatCount(plan.standard?.target, locale)}</strong>
                  <small>{formatCount(plan.standard?.used, locale)} / {formatCount(plan.standard?.limit, locale)} {t("quota.used")}</small>
                </div>
                <div>
                  <span>{t("quotaOptimizer.safeAvailable")}</span>
                  <strong>{formatCount(plan.search?.safeAvailable, locale)}</strong>
                  <small>{t("quotaOptimizer.searchAvailableHint")}</small>
                </div>
                <div>
                  <span>{t("quotaOptimizer.approvalSlots")}</span>
                  <strong>{formatCount(plan.candidates?.recommendedApprovalCount, locale)}</strong>
                  <small>{formatCount(plan.candidates?.suggestedCount, locale)} {t("quotaOptimizer.suggestedCandidates")}</small>
                </div>
              </div>
              <div className="quota-plan-detail">
                <div><b>{t("quotaOptimizer.thisRun")}</b><span>{t("action.searchEstimate")}: {formatCount(plan.collection?.estimatedSearchRequests, locale)} · {t("action.standardEstimate")}: {formatCount(plan.collection?.estimatedStandardUnits, locale)}</span></div>
                <div><b>{t("quotaOptimizer.commentPlan")}</b><span>{formatCount(plan.collection?.recommendedCommentVideos, locale)} {t("comments.video")} × {formatCount(plan.collection?.recommendedCommentPages, locale)} {t("quotaOptimizer.pagesEach")}</span></div>
                <p>{plan.messages?.[locale] ?? t("quotaOptimizer.planUnavailable")}</p>
              </div>
            </Panel>
          ) : null}

          <Panel title={t("quotaPage.allMetrics")} subtitle={t("quotaPage.tableHint")}>
            <div className="quota-table-wrap">
              <table className="quota-table">
                <thead>
                  <tr>
                    <th>{t("quotaPage.name")}</th>
                    <th>{t("quotaPage.type")}</th>
                    <th>{t("quotaPage.dimension")}</th>
                    <th>{t("quota.limit")}</th>
                    <th>{t("quotaPage.usagePercent")}</th>
                    <th>{t("quota.used")}</th>
                    <th>{t("quota.remaining")}</th>
                    <th>{t("quotaPage.adjustable")}</th>
                  </tr>
                </thead>
                <tbody>
                  {buckets.map((bucket: Row) => {
                    const ratio = Number(bucket.usageRatio ?? 0) * 100;
                    const isOpen = expanded === bucket.id;
                    return (
                      <Fragment key={bucket.id}>
                        <tr className="quota-row" onClick={() => setExpanded(isOpen ? null : bucket.id)}>
                          <td>
                            <strong>{bucket.displayName}</strong>
                            <small>{bucket.quotaMetric}</small>
                          </td>
                          <td>{t("quotaPage.quotaType")}</td>
                          <td>{t(`quotaPage.${bucket.scope}`)} · {t(`quotaPage.${bucket.period}`)}</td>
                          <td>{formatCount(bucket.limit, locale)}</td>
                          <td>
                            <div className="quota-percent-cell">
                              <div className="quota-progress"><span style={{ width: `${Math.min(100, Math.max(0, ratio))}%` }} /></div>
                              <span>{bucket.usageRatio == null ? "-" : formatPercent(ratio)}</span>
                            </div>
                          </td>
                          <td>{bucket.used == null ? "-" : formatCount(bucket.used, locale)}</td>
                          <td>{bucket.remaining == null ? "-" : formatCount(bucket.remaining, locale)}</td>
                          <td>{bucket.adjustable ? t("common.yes") : t("common.no")}</td>
                        </tr>
                        {isOpen ? (
                          <tr className="quota-explanation-row">
                            <td colSpan={8}>
                              <div className="quota-explanation">
                                <strong>{t("quotaPage.whatItMeans")}</strong>
                                <p>{locale === "ja-JP" ? bucket.descriptionJa : bucket.description}</p>
                                <dl>
                                  <div><dt>{t("quotaPage.unit")}</dt><dd>{bucket.unit || "-"}</dd></div>
                                  <div><dt>{t("quotaPage.metric")}</dt><dd>{bucket.quotaMetric}</dd></div>
                                  <div><dt>{t("quotaPage.defaultLimit")}</dt><dd>{formatCount(bucket.defaultLimit, locale)}</dd></div>
                                </dl>
                              </div>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>

          <div className="dashboard-grid quota-sections">
            <Panel title={t("quotaPage.dailyMetrics")} className="span-6">
              {dailyBuckets.length ? <Chart option={rankedBarOption(dailyBuckets.map((item: Row) => ({ ...item, remainingLabel: item.remaining ?? 0 })), "displayName", "remainingLabel", locale, "#1498a3")} /> : <EmptyState title={t("common.noData")} />}
            </Panel>
            <Panel title={t("quotaPage.minuteMetrics")} className="span-6">
              {minuteBuckets.length ? <Chart option={rankedBarOption(minuteBuckets.map((item: Row) => ({ ...item, usedLabel: item.used ?? 0 })), "displayName", "usedLabel", locale, "#f79009")} /> : <EmptyState title={t("common.noData")} />}
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}

function rankedBarOption(
  rows: Row[],
  labelField: string,
  valueField: string,
  locale: Locale,
  color = "#1769e0",
): EChartsOption {
  const items = rows.slice(0, 12).reverse();
  return {
    grid: { left: 126, right: 52, top: 18, bottom: 34 },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    xAxis: { type: "value", splitLine: { lineStyle: { color: "#eef1f5" } } },
    yAxis: {
      type: "category",
      data: items.map((item) => item[labelField]),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { width: 116, overflow: "truncate", color: "#344054" },
    },
    series: [{
      type: "bar",
      data: items.map((item) => Number(item[valueField] ?? 0)),
      itemStyle: { color, borderRadius: [0, 3, 3, 0] },
      label: { show: true, position: "right", formatter: (params: any) => formatCount(params.value, locale) },
    }],
  };
}

function liftBarOption(rows: Row[]): EChartsOption {
  const items = rows.slice(0, 12).reverse();
  return {
    grid: { left: 150, right: 58, top: 18, bottom: 34 },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    xAxis: { type: "value", min: 1, axisLabel: { formatter: "{value}x" }, splitLine: { lineStyle: { color: "#eef1f5" } } },
    yAxis: {
      type: "category",
      data: items.map((item) => `${item.dimension_value} · ${item.term}`),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { width: 140, overflow: "truncate", color: "#344054" },
    },
    series: [{
      type: "bar",
      data: items.map((item) => Number(item.lift_score ?? 0)),
      itemStyle: { color: "#7f56d9", borderRadius: [0, 3, 3, 0] },
      label: { show: true, position: "right", formatter: (params: any) => `${Number(params.value).toFixed(2)}x` },
    }],
  };
}

function CommentInsightsPage({ refreshKey }: { refreshKey: number }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [data, setData] = useState<Row | null>(null);
  const [runId, setRunId] = useState("");
  const [topic, setTopic] = useState("");
  const [postId, setPostId] = useState("");
  const [sentiment, setSentiment] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (runId) params.set("analysis_run_id", runId);
    if (topic) params.set("topic", topic);
    if (postId) params.set("post_id", postId);
    if (sentiment) params.set("sentiment", sentiment);
    if (dateFrom) params.set("date_from", dateFrom);
    if (dateTo) params.set("date_to", dateTo);
    setData(await api<Row>(`/api/comment-insights?${params}`));
  }, [runId, topic, postId, sentiment, dateFrom, dateTo]);
  useEffect(() => { load(); }, [load, refreshKey]);

  const terms = data?.terms ?? [];
  const termRows = (type: string) => terms.filter((item: Row) => item.term_type === type);
  const sentimentTerms = data?.sentimentTerms ?? [];
  const positiveWords = sentimentTerms.filter((item: Row) => item.sentiment_label === "positive");
  const negativeWords = sentimentTerms.filter((item: Row) => item.sentiment_label === "negative");
  const topicFeatures = data?.topicFeatures ?? [];
  const metrics = data?.metrics ?? [];
  const overall = metrics.find((item: Row) => item.dimension_type === "overall");
  const topicMetrics = metrics.filter((item: Row) => item.dimension_type === "query_topic").slice(0, 10);
  const videoMetrics = metrics.filter((item: Row) => item.dimension_type === "post").slice(0, 10);
  const selected = data?.selectedMetric;

  const sentimentOption = useMemo<EChartsOption>(() => ({
    grid: { left: 84, right: 20, top: 34, bottom: 32 },
    legend: { top: 0 },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    xAxis: { type: "value", max: 100, axisLabel: { formatter: "{value}%" }, splitLine: { lineStyle: { color: "#eef1f5" } } },
    yAxis: {
      type: "category",
      data: topicMetrics.map((item: Row) => item.dimension_value).reverse(),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { width: 76, overflow: "truncate" },
    },
    series: [
      {
        name: t("opinion.positive"), type: "bar", stack: "sentiment", itemStyle: { color: "#1498a3" },
        data: topicMetrics.map((item: Row) => Number(item.comment_count) ? Number(item.positive_count) / Number(item.comment_count) * 100 : 0).reverse(),
      },
      {
        name: t("opinion.neutral"), type: "bar", stack: "sentiment", itemStyle: { color: "#98a2b3" },
        data: topicMetrics.map((item: Row) => Number(item.comment_count) ? Number(item.neutral_count) / Number(item.comment_count) * 100 : 0).reverse(),
      },
      {
        name: t("opinion.negative"), type: "bar", stack: "sentiment", itemStyle: { color: "#e66b5b" },
        data: topicMetrics.map((item: Row) => Number(item.comment_count) ? Number(item.negative_count) / Number(item.comment_count) * 100 : 0).reverse(),
      },
    ],
  }), [topicMetrics, t]);

  const dailyOption = useMemo<EChartsOption>(() => {
    const daily = data?.daily ?? [];
    const line = daily.length >= 8;
    return {
      grid: { left: 58, right: 20, top: 22, bottom: 42 },
      tooltip: { trigger: "axis" },
      xAxis: { type: "category", data: daily.map((item: Row) => item.comment_date), axisLabel: { color: "#667085" } },
      yAxis: { type: "value", splitLine: { lineStyle: { color: "#eef1f5" } } },
      series: [{
        type: line ? "line" : "bar",
        smooth: line,
        symbolSize: 6,
        data: daily.map((item: Row) => Number(item.comment_count)),
        itemStyle: { color: "#1769e0" },
        lineStyle: { color: "#1769e0", width: 2 },
      }],
    };
  }, [data]);

  if (!data) return <EmptyState title={t("common.loading")} icon={<LoaderCircle className="spin" size={34} />} />;
  const kpis = [
    [t("comments.analyzedComments"), selected?.comment_count ?? overall?.comment_count],
    [t("comments.distinctAuthors"), selected?.distinct_authors ?? overall?.distinct_authors],
    [t("comments.netSentiment"), formatPercent(selected?.net_sentiment_pct ?? overall?.net_sentiment_pct)],
    [t("opinion.positive"), selected?.positive_count ?? overall?.positive_count],
    [t("opinion.negative"), selected?.negative_count ?? overall?.negative_count],
  ];
  return (
    <div>
      <div className="page-heading"><div><h1>{t("comments.title")}</h1><p>{t("comments.subtitle")}</p></div></div>
      <div className="filter-bar">
        <label><span>{t("videos.run")}</span><select value={runId} onChange={(event) => setRunId(event.target.value)}><option value="">{t("common.all")}</option>{(data.filters?.runs ?? []).map((item: Row) => <option key={item.id} value={item.id}>#{item.id} · {formatJst(item.completed_at, locale)}</option>)}</select></label>
        <label><span>{t("videos.topic")}</span><select value={topic} onChange={(event) => { setTopic(event.target.value); setPostId(""); }}><option value="">{t("common.all")}</option>{(data.filters?.topics ?? []).map((item: Row) => <option key={item.topic}>{item.topic}</option>)}</select></label>
        <label><span>{t("comments.video")}</span><select value={postId} onChange={(event) => { setPostId(event.target.value); setTopic(""); }}><option value="">{t("common.all")}</option>{(data.filters?.videos ?? []).map((item: Row) => <option key={item.post_id} value={item.post_id}>{item.title}</option>)}</select></label>
        <label><span>{t("comments.sentiment")}</span><select value={sentiment} onChange={(event) => setSentiment(event.target.value)}><option value="all">{t("common.all")}</option><option value="positive">{t("opinion.positive")}</option><option value="neutral">{t("opinion.neutral")}</option><option value="negative">{t("opinion.negative")}</option></select></label>
        <label><span>{t("comments.dateFrom")}</span><input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} /></label>
        <label><span>{t("comments.dateTo")}</span><input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} /></label>
        <button className="secondary-button compact" onClick={() => { setRunId(""); setTopic(""); setPostId(""); setSentiment("all"); setDateFrom(""); setDateTo(""); }}><RotateCcw size={15} />{t("common.reset")}</button>
      </div>
      <div className="kpi-grid comment-kpis">
        {kpis.map(([label, value]) => <div className="kpi" key={String(label)}><div className="kpi-label"><MessageSquareText size={18} />{label}</div><strong>{typeof value === "string" && value.endsWith("%") ? value : formatCount(value, locale)}</strong></div>)}
      </div>
      <div className="dashboard-grid">
        <Panel title={t("comments.topicSentiment")} subtitle={t("comments.denominator")} className="span-6">
          {topicMetrics.length ? <Chart option={sentimentOption} /> : <EmptyState title={t("common.noData")} />}
        </Panel>
        <Panel title={t("comments.volumeTrend")} className="span-6">
          {(data.daily ?? []).length ? <Chart option={dailyOption} /> : <EmptyState title={t("common.noData")} />}
        </Panel>
        <Panel title={t("comments.hotWords")} className="span-4">
          {termRows("word").length ? <Chart option={rankedBarOption(termRows("word"), "term", "count", locale)} /> : <EmptyState title={t("common.noData")} />}
        </Panel>
        <Panel title={t("comments.hotPhrases")} className="span-4">
          {termRows("phrase").length ? <Chart option={rankedBarOption(termRows("phrase"), "term", "count", locale, "#1498a3")} /> : <EmptyState title={t("common.noData")} />}
        </Panel>
        <Panel title={t("comments.topicFeatures")} subtitle={t("comments.liftHint")} className="span-4">
          {topicFeatures.length ? <Chart option={liftBarOption(topicFeatures)} /> : <EmptyState title={t("common.noData")} />}
        </Panel>
        <Panel title={t("comments.positiveWords")} className="span-3">
          {positiveWords.length ? <Chart option={rankedBarOption(positiveWords, "term", "count", locale, "#1498a3")} /> : <EmptyState title={t("common.noData")} />}
        </Panel>
        <Panel title={t("comments.negativeWords")} className="span-3">
          {negativeWords.length ? <Chart option={rankedBarOption(negativeWords, "term", "count", locale, "#e66b5b")} /> : <EmptyState title={t("common.noData")} />}
        </Panel>
        <Panel title={t("comments.emojis")} className="span-3">
          {termRows("emoji").length ? <Chart option={rankedBarOption(termRows("emoji"), "term", "count", locale, "#f79009")} /> : <EmptyState title={t("common.noData")} />}
        </Panel>
        <Panel title={t("comments.hashtags")} className="span-3">
          {termRows("hashtag").length ? <Chart option={rankedBarOption(termRows("hashtag"), "term", "count", locale, "#7f56d9")} /> : <EmptyState title={t("common.noData")} />}
        </Panel>
        <Panel title={t("comments.videoRanking")} className="span-6">
          {videoMetrics.length ? <Chart option={rankedBarOption(videoMetrics.map((item: Row) => ({ ...item, label: data.filters?.videos?.find((video: Row) => video.post_id === item.dimension_value)?.title ?? item.dimension_value })), "label", "comment_count", locale, "#1498a3")} /> : <EmptyState title={t("common.noData")} />}
        </Panel>
        <Panel title={t("comments.quality")} className="span-12">
          <div className="quality-note"><CircleAlert size={18} /><p>{t("comments.privacyNote")}</p></div>
        </Panel>
      </div>
    </div>
  );
}

function skillChartOption(chart: Row, locale: Locale): EChartsOption {
  const fields = chart.fields ?? {};
  const rows = chart.rows ?? [];
  if (chart.type === "scatter") {
    return {
      grid: { left: 58, right: 22, top: 24, bottom: 44 },
      tooltip: { formatter: (params: any) => `${params.data[2] ?? ""}<br/>${params.data[0]} · ${params.data[1]}` },
      xAxis: { type: "value", splitLine: { lineStyle: { color: "#eef1f5" } } },
      yAxis: { type: "value", splitLine: { lineStyle: { color: "#eef1f5" } } },
      series: [{ type: "scatter", itemStyle: { color: "#1769e0" }, data: rows.map((row: Row) => [Number(row[fields.x]), Number(row[fields.y]), row[fields.label]]) }],
    };
  }
  if (chart.type === "line") {
    const seriesNames: string[] = fields.series
      ? Array.from(new Set<string>(rows.map((row: Row) => String(row[fields.series]))))
      : [String(chart.title)];
    const categories: string[] = Array.from(
      new Set<string>(rows.map((row: Row) => String(row[fields.x]))),
    );
    return {
      grid: { left: 58, right: 22, top: 24, bottom: 44 },
      tooltip: { trigger: "axis" },
      legend: { top: 0 },
      xAxis: { type: "category", data: categories },
      yAxis: { type: "value", splitLine: { lineStyle: { color: "#eef1f5" } } },
      series: seriesNames.map((name, index) => ({
        name,
        type: "line",
        data: rows.filter((row: Row) => !fields.series || String(row[fields.series]) === name).map((row: Row) => Number(row[fields.y])),
        color: ["#1769e0", "#1498a3", "#f79009", "#7f56d9"][index % 4],
      })),
    };
  }
  if (chart.type === "stackedBar") {
    const categories: string[] = Array.from(new Set<string>(rows.map((row: Row) => String(row[fields.x]))));
    const seriesNames: string[] = Array.from(new Set<string>(rows.map((row: Row) => String(row[fields.series]))));
    return {
      grid: { left: 110, right: 22, top: 34, bottom: 38 },
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
      legend: { top: 0 },
      xAxis: { type: "value", splitLine: { lineStyle: { color: "#eef1f5" } } },
      yAxis: { type: "category", data: categories },
      series: seriesNames.map((name, index) => ({
        name,
        type: "bar",
        stack: "total",
        data: categories.map((category) => Number(rows.find((row: Row) => String(row[fields.x]) === category && String(row[fields.series]) === name)?.[fields.y] ?? 0)),
        color: ["#1769e0", "#1498a3", "#f79009", "#98a2b3"][index % 4],
      })),
    };
  }
  return rankedBarOption(rows, fields.x || fields.label, fields.y || fields.value, locale);
}

function SkillAnalysesPage({ refreshKey }: { refreshKey: number }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [items, setItems] = useState<Row[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Row | null>(null);
  useEffect(() => {
    api<Row>("/api/skill-analyses").then((data) => {
      setItems(data.items);
      if (!selected && data.items[0]) setSelected(data.items[0].id);
    });
  }, [refreshKey, selected]);
  useEffect(() => {
    if (selected) api<Row>(`/api/skill-analyses/${selected}`).then(setDetail);
  }, [selected, refreshKey]);
  return (
    <div>
      <div className="page-heading"><div><h1>{t("skill.title")}</h1><p>{t("skill.subtitle")}</p></div></div>
      <div className="report-layout">
        <Panel title={t("skill.history")} className="report-history">
          <div className="run-list">{items.map((item) => <button key={item.id} className={selected === item.id ? "run-selected" : ""} onClick={() => setSelected(item.id)}><span><StatusDot status={item.status} />#{item.id} · {item.title}</span><small>{formatJst(item.completed_at || item.created_at, locale)}</small></button>)}</div>
        </Panel>
        <div className="skill-detail">
          {detail ? (
            <>
              <Panel title={detail.title} subtitle={detail.question}>
                <div className="skill-meta">
                  <span>{t("skill.sourceAnalysis")}: {detail.source_analysis_run_id ? `#${detail.source_analysis_run_id}` : "N/A"}</span>
                  <span>{t("skill.sourceBatch")}: {detail.source_batch_id ? `#${detail.source_batch_id}` : "N/A"}</span>
                  <span>{t("skill.window")}: {formatJst(detail.window_start, locale, false)} - {formatJst(detail.window_end, locale, false)}</span>
                </div>
                <article className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{detail.report_markdown}</ReactMarkdown></article>
              </Panel>
              {(detail.charts ?? []).map((chart: Row, index: number) => (
                <Panel key={`${chart.title}-${index}`} title={chart.title} subtitle={chart.subtitle}>
                  {chart.type === "table" ? (
                    <div className="table-wrap flat"><table><thead><tr>{Object.keys(chart.rows?.[0] ?? {}).map((key) => <th key={key}>{key}</th>)}</tr></thead><tbody>{(chart.rows ?? []).map((row: Row, rowIndex: number) => <tr key={rowIndex}>{Object.keys(chart.rows?.[0] ?? {}).map((key) => <td key={key}>{String(row[key] ?? "")}</td>)}</tr>)}</tbody></table></div>
                  ) : <Chart option={skillChartOption(chart, locale)} />}
                </Panel>
              ))}
            </>
          ) : <Panel title={t("skill.title")}><EmptyState title={t("common.noData")} body={t("skill.emptyHint")} /></Panel>}
        </div>
      </div>
    </div>
  );
}

const FREQ_OPTIONS = [
  { value: "once",       step: 24 },
  { value: "every_12h", step: 12 },
  { value: "every_6h",  step: 6  },
  { value: "every_4h",  step: 4  },
  { value: "every_2h",  step: 2  },
] as const;

function computeTriggerTimes(hour: number, minute: number, frequency: string): string[] {
  const step = FREQ_OPTIONS.find((o) => o.value === frequency)?.step ?? 24;
  const count = step >= 24 ? 1 : 24 / step;
  const times: string[] = [];
  for (let i = 0; i < count; i++) {
    const h = (hour + i * step) % 24;
    times.push(`${String(h).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
  }
  return times;
}

function CollectionsPage({ refreshKey }: { refreshKey: number }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [items, setItems] = useState<Row[]>([]);
  const [selected, setSelected] = useState<Row | null>(null);
  const [schedule, setSchedule] = useState<Row | null>(null);
  const [scheduleForm, setScheduleForm] = useState({
    hour: 7,
    minute: 0,
    frequency: "once",
    mode: "balanced",
    runAnalyze: true,
    analyzeDays: 30,
  });

  const load = useCallback(async () => {
    const [history, status] = await Promise.all([api<Row>("/api/collections"), api<Row>("/api/schedule")]);
    setItems(history.items);
    setSchedule(status);
  }, []);
  useEffect(() => { load(); }, [load, refreshKey]);
  useEffect(() => {
    if (schedule?.schedule) {
      setScheduleForm({
        hour: Number(schedule.schedule.hour ?? 7),
        minute: Number(schedule.schedule.minute ?? 0),
        frequency: schedule.schedule.frequency ?? "once",
        mode: schedule.schedule.mode === "standard" ? "standard" : "balanced",
        runAnalyze: Boolean(schedule.schedule.runAnalyze ?? true),
        analyzeDays: Number(schedule.schedule.analyzeDays ?? 30),
      });
    }
  }, [schedule]);

  const saveSchedule = async () => {
    await api<Row>("/api/schedule", { method: "POST", body: scheduleForm });
    await load();
  };
  const uninstallSchedule = async () => {
    await api<Row>("/api/schedule", { method: "DELETE", body: {} });
    await load();
  };
  const showDetail = async (id: string) => setSelected(await api<Row>(`/api/collections/${id}`));
  const triggerTimes = computeTriggerTimes(scheduleForm.hour, scheduleForm.minute, scheduleForm.frequency);
  const triggerTimesStr = triggerTimes.join("  ·  ");

  return (
    <div>
      <div className="page-heading"><div><h1>{t("collections.title")}</h1></div></div>
      <Panel
        title={t("collections.schedule")}
        subtitle={t("collections.scheduleBody")}
        action={
          <div className="panel-actions">
            {schedule?.installed ? (
              <button className="secondary-button" onClick={uninstallSchedule}><Trash2 size={16} />{t("collections.uninstall")}</button>
            ) : null}
            <button className="primary-button" onClick={saveSchedule}><CalendarClock size={16} />{schedule?.installed ? t("collections.updateSchedule") : t("collections.install")}</button>
          </div>
        }
      >
        <div className="schedule-config">
          <div className="schedule-status">
            <StatusDot status={schedule?.installed ? "success" : "disabled"} />
            <strong>{schedule?.installed ? t("collections.installed") : t("collections.notInstalled")}</strong>
            <span>{t("collections.triggerTimes", { times: triggerTimesStr })}</span>
          </div>
          <div className="schedule-form">
            <label>
              <span>{t("collections.scheduleTime")}</span>
              <div className="time-inputs">
                <input
                  type="number"
                  min={0}
                  max={23}
                  value={scheduleForm.hour}
                  onChange={(event) => setScheduleForm((current) => ({ ...current, hour: Number(event.target.value) }))}
                />
                <strong>:</strong>
                <input
                  type="number"
                  min={0}
                  max={59}
                  value={scheduleForm.minute}
                  onChange={(event) => setScheduleForm((current) => ({ ...current, minute: Number(event.target.value) }))}
                />
              </div>
            </label>
            <label>
              <span>{t("collections.frequency")}</span>
              <select value={scheduleForm.frequency} onChange={(event) => setScheduleForm((current) => ({ ...current, frequency: event.target.value }))}>
                <option value="once">{t("collections.freqOnce")}</option>
                <option value="every_12h">{t("collections.freqEvery12h")}</option>
                <option value="every_6h">{t("collections.freqEvery6h")}</option>
                <option value="every_4h">{t("collections.freqEvery4h")}</option>
                <option value="every_2h">{t("collections.freqEvery2h")}</option>
              </select>
            </label>
            <label>
              <span>{t("collections.collectMode")}</span>
              <select value={scheduleForm.mode} onChange={(event) => setScheduleForm((current) => ({ ...current, mode: event.target.value }))}>
                <option value="balanced">{t("collections.modeBalanced")}</option>
                <option value="standard">{t("collections.modeStandard")}</option>
              </select>
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={scheduleForm.runAnalyze}
                onChange={(event) => setScheduleForm((current) => ({ ...current, runAnalyze: event.target.checked }))}
              />
              <span>{t("collections.runAnalyze")}</span>
            </label>
            <label>
              <span>{t("collections.analyzeDays")}</span>
              <select
                value={scheduleForm.analyzeDays}
                disabled={!scheduleForm.runAnalyze}
                onChange={(event) => setScheduleForm((current) => ({ ...current, analyzeDays: Number(event.target.value) }))}
              >
                <option value={7}>7</option>
                <option value={30}>30</option>
                <option value={90}>90</option>
              </select>
            </label>
          </div>
          <p className="schedule-help">{t("collections.scheduleHelp")}</p>
        </div>
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
  const locale = useLocale();
  const [items, setItems] = useState<Row[]>([]);
  const [candidates, setCandidates] = useState<Row[]>([]);
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [form, setForm] = useState({ name: "", query_text: "", topic: "", max_results: 50, lookback_days: 7 });
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => api<Row>("/api/queries").then((data) => setItems(data.items)), []);
  const loadCandidates = useCallback(() => api<Row>("/api/keyword-candidates?status=suggested").then((data) => setCandidates(data.items)), []);
  useEffect(() => { load(); loadCandidates(); }, [load, loadCandidates, refreshKey]);

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
  const generateCandidates = async () => {
    setCandidateLoading(true);
    setError(null);
    try {
      await api<Row>("/api/keyword-candidates/suggest", { method: "POST", body: {} });
      await loadCandidates();
    } catch (err) {
      setError(localizedError(err, t));
    } finally {
      setCandidateLoading(false);
    }
  };
  const mutateCandidate = async (id: string, action: "approve" | "reject" | "archive") => {
    try {
      await api<Row>(`/api/keyword-candidates/${id}/${action}`, { method: "POST", body: {} });
      await Promise.all([load(), loadCandidates()]);
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
      <Panel
        title={t("keywordCandidates.title")}
        subtitle={t("keywordCandidates.subtitle")}
        action={(
          <button className="secondary-button" onClick={generateCandidates} disabled={candidateLoading}>
            {candidateLoading ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}
            {t("keywordCandidates.generate")}
          </button>
        )}
        className="candidate-panel"
      >
        {candidates.length === 0 ? (
          <EmptyState title={t("keywordCandidates.empty")} body={t("keywordCandidates.emptyHint")} icon={<Sparkles size={34} />} />
        ) : (
          <div className="candidate-grid">
            {candidates.slice(0, 12).map((candidate) => (
              <article className="candidate-card" key={candidate.id}>
                <div className="candidate-card-head">
                  <strong>{candidate.candidate_text}</strong>
                  <span>{Number(candidate.total_score ?? 0).toFixed(1)}</span>
                </div>
                <div className="candidate-meta">
                  <span>{candidate.topic}</span>
                  <span>{t(`keywordCandidates.source.${candidate.source_type}`, { defaultValue: candidate.source_type })}</span>
                </div>
                <p>{candidate.reason_text}</p>
                <dl>
                  <div><dt>{t("keywordCandidates.heat")}</dt><dd>{Number(candidate.heat_score ?? 0).toFixed(1)}</dd></div>
                  <div><dt>{t("keywordCandidates.comment")}</dt><dd>{Number(candidate.comment_score ?? 0).toFixed(1)}</dd></div>
                  <div><dt>{t("keywordCandidates.relevance")}</dt><dd>{Number(candidate.relevance_score ?? 0).toFixed(1)}</dd></div>
                </dl>
                <footer>
                  <small>{t("keywordCandidates.lastSeen")}: {formatJst(candidate.last_seen_at, locale)}</small>
                  <div className="row-actions">
                    <button className="icon-button" title={t("keywordCandidates.approve")} onClick={() => mutateCandidate(candidate.id, "approve")}><CheckCircle2 size={16} /></button>
                    <button className="icon-button" title={t("keywordCandidates.reject")} onClick={() => mutateCandidate(candidate.id, "reject")}><X size={16} /></button>
                    <button className="icon-button" title={t("common.archive")} onClick={() => mutateCandidate(candidate.id, "archive")}><Archive size={16} /></button>
                  </div>
                </footer>
              </article>
            ))}
          </div>
        )}
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
