import { createAppPool } from "./db.js";
import {
  estimateCollectionQuotaBuckets,
  QUOTA_BUCKETS,
} from "./youtube.js";

const SEARCH_METRIC = "youtube.googleapis.com/search_list";
const STANDARD_METRIC = "youtube.googleapis.com/default";

function numberValue(value, fallback = 0) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function findDailyBucket(quota, metric) {
  return (quota?.buckets ?? []).find(
    (bucket) =>
      bucket.quotaMetric === metric &&
      bucket.period === "day" &&
      bucket.scope === "project",
  );
}

function target(limit, ratio) {
  return Math.max(0, Math.floor(numberValue(limit) * ratio));
}

export function buildQuotaRecommendation({
  searchLimit,
  searchUsed,
  standardLimit,
  standardUsed,
  estimatedByBucket,
  baseStandardUnits,
  enabledQueryCount,
  activePostCount,
  suggestedCandidateCount,
  approvedCandidateCount,
  commentFetch,
  quotaStatus = "local",
  source = "local_budget",
}) {
  const searchTarget = target(searchLimit, 0.75);
  const standardTarget = target(standardLimit, 0.7);
  const safeSearchAvailable = Math.max(0, searchTarget - numberValue(searchUsed));
  const safeStandardAvailable = Math.max(0, standardTarget - numberValue(standardUsed));
  const recommendedCommentPages = Math.max(2, Number(commentFetch?.maxPages ?? 1));
  const standardAfterBase = Math.max(0, safeStandardAvailable - baseStandardUnits);
  const recommendedCommentVideos = commentFetch?.enabled
    ? Math.max(
        Number(commentFetch.maxVideos ?? 0),
        Math.min(30, Math.floor(standardAfterBase / recommendedCommentPages)),
      )
    : 0;
  const safeApprovalSlots = Math.max(0, safeSearchAvailable - enabledQueryCount);
  const estimatedSearchRequests =
    estimatedByBucket[QUOTA_BUCKETS.search] ?? enabledQueryCount;
  const estimatedStandardUnits = estimatedByBucket[QUOTA_BUCKETS.standard] ?? 0;
  const shouldCollect =
    enabledQueryCount > 0 &&
    estimatedSearchRequests <= safeSearchAvailable &&
    estimatedStandardUnits <= safeStandardAvailable;

  return {
    strategy: "balanced",
    quotaStatus,
    source,
    targetSearchUsageRatio: 0.75,
    targetStandardUsageRatio: 0.7,
    search: {
      metric: SEARCH_METRIC,
      limit: searchLimit,
      used: searchUsed,
      target: searchTarget,
      safeAvailable: safeSearchAvailable,
      estimatedThisRun: estimatedSearchRequests,
    },
    standard: {
      metric: STANDARD_METRIC,
      limit: standardLimit,
      used: standardUsed,
      target: standardTarget,
      safeAvailable: safeStandardAvailable,
      baseUnitsWithoutComments: baseStandardUnits,
      estimatedThisRun: estimatedStandardUnits,
    },
    collection: {
      enabledQueryCount,
      activePostCount,
      estimatedQuotaByBucket: estimatedByBucket,
      estimatedStandardUnits,
      estimatedSearchRequests,
      recommendedCommentVideos,
      recommendedCommentPages,
      shouldCollect,
    },
    candidates: {
      suggestedCount: suggestedCandidateCount,
      approvedCount: approvedCandidateCount,
      safeApprovalSlots,
      recommendedApprovalCount: Math.min(suggestedCandidateCount, safeApprovalSlots),
    },
    messages: {
      "zh-CN": shouldCollect
        ? "当前免费额度仍很充足，建议使用 balanced 模式继续采集，并优先批准少量高分候选关键词。"
        : "当前不建议继续扩大采集；请检查 search 剩余额、启用关键词数或 Google Monitoring 延迟。",
      "ja-JP": shouldCollect
        ? "無料枠にはまだ余裕があります。balanced モードで収集し、高スコア候補を少数承認するのがおすすめです。"
        : "現時点では収集拡大をおすすめしません。search 残量、有効キーワード数、Monitoring の遅延を確認してください。",
    },
  };
}

export async function buildQuotaPlan(config, { googleQuota = null } = {}) {
  const pool = createAppPool(config);
  try {
    const [queryRows] = await pool.query(
      `SELECT id, max_results
       FROM tracked_queries
       WHERE enabled = TRUE AND archived_at IS NULL
       ORDER BY id`,
    );
    const [activePostRows] = await pool.execute(
      `SELECT COUNT(*) AS count
       FROM posts
       WHERE is_available = TRUE
         AND (
           published_at >= DATE_SUB(UTC_TIMESTAMP(6), INTERVAL ? DAY)
           OR first_seen_at >= DATE_SUB(UTC_TIMESTAMP(6), INTERVAL ? DAY)
         )`,
      [config.activeWindowDays, config.activeWindowDays],
    );
    const [candidateRows] = await pool.query(
      `SELECT
         SUM(status = 'suggested') AS suggested_count,
         SUM(status = 'approved') AS approved_count
       FROM keyword_candidates`,
    );
    const [usageRows] = await pool.query(
      `SELECT q.quota_bucket, COALESCE(SUM(q.actual_units), 0) AS actual_units
       FROM collection_quota_usage q
       JOIN collection_batches b ON b.id = q.batch_id
       WHERE b.observed_at >= UTC_DATE()
       GROUP BY q.quota_bucket`,
    );
    const localUsage = new Map(
      usageRows.map((row) => [row.quota_bucket, Number(row.actual_units)]),
    );
    const activePostCount = Number(activePostRows[0]?.count ?? 0);
    const plannedCommentVideos = config.commentFetch.enabled
      ? Math.max(Number(config.commentFetch.maxVideos), 30)
      : 0;
    const plannedCommentPages = config.commentFetch.enabled
      ? Math.max(Number(config.commentFetch.maxPages), 2)
      : 0;
    const effectiveCommentFetch = {
      ...config.commentFetch,
      maxVideos: plannedCommentVideos,
      maxPages: plannedCommentPages,
    };
    const commentRequests = plannedCommentVideos * plannedCommentPages;
    const estimatedByBucket = estimateCollectionQuotaBuckets(
      queryRows,
      activePostCount,
      commentRequests,
    );
    const baseByBucket = estimateCollectionQuotaBuckets(queryRows, activePostCount, 0);
    const searchBucket = findDailyBucket(googleQuota, SEARCH_METRIC);
    const standardBucket = findDailyBucket(googleQuota, STANDARD_METRIC);
    const hasGoogle = Boolean(searchBucket || standardBucket);

    return buildQuotaRecommendation({
      searchLimit: searchBucket?.limit ?? config.searchQuotaBudget,
      searchUsed:
        searchBucket?.used ??
        localUsage.get(QUOTA_BUCKETS.search) ??
        0,
      standardLimit: standardBucket?.limit ?? config.quotaBudget,
      standardUsed:
        standardBucket?.used ??
        localUsage.get(QUOTA_BUCKETS.standard) ??
        0,
      estimatedByBucket,
      baseStandardUnits: baseByBucket[QUOTA_BUCKETS.standard],
      enabledQueryCount: queryRows.length,
      activePostCount,
      suggestedCandidateCount: Number(candidateRows[0]?.suggested_count ?? 0),
      approvedCandidateCount: Number(candidateRows[0]?.approved_count ?? 0),
      commentFetch: effectiveCommentFetch,
      quotaStatus: googleQuota?.status ?? "local",
      source: hasGoogle ? "google_cloud_monitoring" : "local_budget",
    });
  } finally {
    await pool.end();
  }
}
