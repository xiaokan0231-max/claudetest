import {
  createAppPool,
  createCollectionBatch,
  finishCollectionBatch,
  reapStaleRunningBatches,
  recordCollectionQuotaUsage,
  recordCollectionRun,
  withAdvisoryLock,
  withTransaction,
} from "./db.js";
import {
  chunk,
  hmacAuthorKey,
  normalizeUnsignedCount,
  parseIsoDuration,
  scrubPii,
  toMysqlDateTime,
  unique,
} from "./utils.js";
import {
  estimateCollectionQuotaBuckets,
  QUOTA_BUCKETS,
  YouTubeClient,
} from "./youtube.js";

function errorSummary(error) {
  return String(error?.message ?? error).slice(0, 4000);
}

async function apiStep({
  pool,
  batchId,
  queryId = null,
  runType,
  client,
  operation,
  countResult,
}) {
  const startedAt = new Date();
  const requestBefore = client.requestCount;
  const quotaBefore = client.quotaUsed;
  try {
    const result = await operation();
    await recordCollectionRun(pool, {
      batchId,
      queryId,
      runType,
      startedAt,
      status: "success",
      requestCount: client.requestCount - requestBefore,
      returnedCount: countResult(result),
      quotaUnits: client.quotaUsed - quotaBefore,
    });
    return result;
  } catch (error) {
    await recordCollectionRun(pool, {
      batchId,
      queryId,
      runType,
      startedAt,
      status: "failed",
      requestCount: client.requestCount - requestBefore,
      returnedCount: 0,
      quotaUnits: client.quotaUsed - quotaBefore,
      errorSummary: errorSummary(error),
    });
    throw error;
  }
}

async function loadActiveQueries(pool) {
  const [rows] = await pool.query(
    `SELECT id, name, query_text, topic, region_code, relevance_language,
            safe_search, max_results, lookback_days
     FROM tracked_queries
     WHERE enabled = TRUE
       AND archived_at IS NULL
     ORDER BY id`,
  );
  return rows;
}

async function loadActivePostIds(pool, activeWindowDays) {
  const [rows] = await pool.execute(
    `SELECT post_id
     FROM posts
     WHERE is_available = TRUE
       AND (
         published_at >= DATE_SUB(UTC_TIMESTAMP(6), INTERVAL ? DAY)
         OR first_seen_at >= DATE_SUB(UTC_TIMESTAMP(6), INTERVAL ? DAY)
       )
     ORDER BY post_id`,
    [activeWindowDays, activeWindowDays],
  );
  return rows.map((row) => row.post_id);
}

async function upsertCategories(connection, items, observedAt) {
  for (const item of items) {
    await connection.execute(
      `INSERT INTO youtube_categories
        (category_id, region_code, title, assignable, updated_at)
       VALUES (?, 'JP', ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        title = VALUES(title),
        assignable = VALUES(assignable),
        updated_at = VALUES(updated_at)`,
      [
        item.id,
        item.snippet?.title ?? item.id,
        item.snippet?.assignable ?? null,
        toMysqlDateTime(observedAt),
      ],
    );
  }
}

async function upsertChannel(
  connection,
  { channelId, title, observedAt, available = true },
) {
  await connection.execute(
    `INSERT INTO channels
      (channel_id, title, url, first_seen_at, last_seen_at, is_available)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      title = VALUES(title),
      last_seen_at = VALUES(last_seen_at),
      is_available = VALUES(is_available)`,
    [
      channelId,
      title || channelId,
      `https://www.youtube.com/channel/${channelId}`,
      toMysqlDateTime(observedAt),
      toMysqlDateTime(observedAt),
      available,
    ],
  );
}

async function upsertChannelsAndSnapshots(
  connection,
  channelItems,
  videoItems,
  batchId,
  observedAt,
) {
  const fullChannels = new Map(channelItems.map((item) => [item.id, item]));
  const placeholders = new Map();
  for (const video of videoItems) {
    const channelId = video.snippet?.channelId;
    if (channelId) {
      placeholders.set(channelId, video.snippet?.channelTitle || channelId);
    }
  }

  for (const [channelId, title] of placeholders) {
    const full = fullChannels.get(channelId);
    await upsertChannel(connection, {
      channelId,
      title: full?.snippet?.title || title,
      observedAt,
    });
  }

  for (const channel of channelItems) {
    await upsertChannel(connection, {
      channelId: channel.id,
      title: channel.snippet?.title || channel.id,
      observedAt,
    });
    await connection.execute(
      `INSERT IGNORE INTO channel_metric_snapshots
        (channel_id, batch_id, observed_at, view_count, subscriber_count,
         hidden_subscriber_count, video_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        channel.id,
        batchId,
        toMysqlDateTime(observedAt),
        normalizeUnsignedCount(channel.statistics?.viewCount),
        normalizeUnsignedCount(channel.statistics?.subscriberCount),
        channel.statistics?.hiddenSubscriberCount ?? null,
        normalizeUnsignedCount(channel.statistics?.videoCount),
      ],
    );
  }
}

async function upsertPostsAndSnapshots(
  connection,
  videoItems,
  batchId,
  observedAt,
) {
  for (const video of videoItems) {
    const snippet = video.snippet ?? {};
    if (!video.id || !snippet.channelId || !snippet.publishedAt) {
      continue;
    }
    await connection.execute(
      `INSERT INTO posts
        (post_id, channel_id, title, published_at, url, thumbnail_url, duration_seconds,
         category_id, default_language, default_audio_language,
         live_broadcast_content, first_seen_at, last_seen_at, is_available,
         unavailable_since)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE, NULL)
       ON DUPLICATE KEY UPDATE
        channel_id = VALUES(channel_id),
        title = VALUES(title),
        published_at = VALUES(published_at),
        url = VALUES(url),
        thumbnail_url = VALUES(thumbnail_url),
        duration_seconds = VALUES(duration_seconds),
        category_id = VALUES(category_id),
        default_language = VALUES(default_language),
        default_audio_language = VALUES(default_audio_language),
        live_broadcast_content = VALUES(live_broadcast_content),
        last_seen_at = VALUES(last_seen_at),
        is_available = TRUE,
        unavailable_since = NULL`,
      [
        video.id,
        snippet.channelId,
        snippet.title || video.id,
        toMysqlDateTime(snippet.publishedAt),
        `https://www.youtube.com/watch?v=${video.id}`,
        selectThumbnailUrl(snippet.thumbnails),
        parseIsoDuration(video.contentDetails?.duration),
        snippet.categoryId ?? null,
        snippet.defaultLanguage ?? null,
        snippet.defaultAudioLanguage ?? null,
        snippet.liveBroadcastContent ?? null,
        toMysqlDateTime(observedAt),
        toMysqlDateTime(observedAt),
      ],
    );

    await connection.execute("DELETE FROM post_tags WHERE post_id = ?", [video.id]);
    for (const tag of unique(snippet.tags ?? [])) {
      await connection.execute(
        "INSERT IGNORE INTO post_tags (post_id, tag) VALUES (?, ?)",
        [video.id, String(tag).slice(0, 500)],
      );
    }

    const views = normalizeUnsignedCount(video.statistics?.viewCount);
    if (views !== null) {
      await connection.execute(
        `INSERT IGNORE INTO post_metric_snapshots
          (post_id, batch_id, observed_at, views, impressions, likes, comments,
           shares, saves, clicks)
         VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL)`,
        [
          video.id,
          batchId,
          toMysqlDateTime(observedAt),
          views,
          normalizeUnsignedCount(video.statistics?.likeCount),
          normalizeUnsignedCount(video.statistics?.commentCount),
        ],
      );
    }
  }
}

async function upsertQueryResults(
  connection,
  queryResults,
  availablePostIds,
  batchId,
  observedAt,
) {
  for (const result of queryResults) {
    const query = result.query;
    await connection.execute(
      `INSERT IGNORE INTO query_observations
        (query_id, batch_id, observed_at, returned_sample_count,
         estimated_total_results, total_results_is_approximate)
       VALUES (?, ?, ?, ?, ?, TRUE)`,
      [
        query.id,
        batchId,
        toMysqlDateTime(observedAt),
        result.items.length,
        normalizeUnsignedCount(result.estimatedTotalResults),
      ],
    );

    for (const [index, item] of result.items.entries()) {
      const postId = item.id?.videoId;
      if (!postId || !availablePostIds.has(postId)) {
        continue;
      }
      await connection.execute(
        `INSERT INTO post_query_matches
          (post_id, query_id, first_matched_at, last_matched_at, first_rank,
           latest_rank, last_batch_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
          last_matched_at = VALUES(last_matched_at),
          latest_rank = VALUES(latest_rank),
          last_batch_id = VALUES(last_batch_id)`,
        [
          postId,
          query.id,
          toMysqlDateTime(observedAt),
          toMysqlDateTime(observedAt),
          index + 1,
          index + 1,
          batchId,
        ],
      );
    }
  }
}

async function upsertPopularResults(
  connection,
  popularItems,
  availablePostIds,
  batchId,
  observedAt,
) {
  for (const [index, item] of popularItems.entries()) {
    if (!item.id || !availablePostIds.has(item.id)) {
      continue;
    }
    await connection.execute(
      `INSERT IGNORE INTO popular_video_observations
        (batch_id, observed_at, region_code, category_id, post_id, rank_position)
       VALUES (?, ?, 'JP', NULL, ?, ?)`,
      [batchId, toMysqlDateTime(observedAt), item.id, index + 1],
    );
  }
}

async function markUnavailablePosts(connection, requestedIds, returnedIds, observedAt) {
  const missing = requestedIds.filter((id) => !returnedIds.has(id));
  for (const idChunk of chunk(missing, 100)) {
    if (idChunk.length === 0) {
      continue;
    }
    const placeholders = idChunk.map(() => "?").join(",");
    await connection.execute(
      `UPDATE posts
       SET is_available = FALSE,
           unavailable_since = COALESCE(unavailable_since, ?)
       WHERE post_id IN (${placeholders})`,
      [toMysqlDateTime(observedAt), ...idChunk],
    );
  }
  return missing.length;
}

export function selectThumbnailUrl(thumbnails) {
  for (const key of ["maxres", "standard", "high", "medium", "default"]) {
    if (thumbnails?.[key]?.url) {
      return String(thumbnails[key].url);
    }
  }
  return null;
}

function commentRequestBudget(config) {
  return config.commentFetch.enabled
    ? config.commentFetch.maxVideos * config.commentFetch.maxPages
    : 0;
}

export function collectionConfigForMode(config, mode = "standard") {
  if (mode === "standard") {
    return config;
  }
  if (mode !== "balanced") {
    throw new Error("--mode must be standard or balanced");
  }
  if (!config.commentFetch.enabled) {
    return config;
  }
  return {
    ...config,
    commentFetch: {
      ...config.commentFetch,
      maxVideos: Math.max(Number(config.commentFetch.maxVideos), 30),
      maxPages: Math.max(Number(config.commentFetch.maxPages), 2),
    },
  };
}

async function upsertComments(connection, rows, batchId, observedAt) {
  let count = 0;
  for (const row of rows) {
    if (!row.commentId) {
      continue;
    }
    await connection.execute(
      `INSERT INTO comments
        (comment_id, post_id, author_key, parent_id, text_content, like_count,
         reply_count, published_at, first_seen_at, last_seen_at, batch_id,
         is_available)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE)
       ON DUPLICATE KEY UPDATE
        author_key = VALUES(author_key),
        text_content = VALUES(text_content),
        like_count = VALUES(like_count),
        reply_count = VALUES(reply_count),
        last_seen_at = VALUES(last_seen_at),
        batch_id = VALUES(batch_id),
        is_available = TRUE`,
      [
        row.commentId,
        row.postId,
        row.authorKey,
        row.parentId,
        row.text,
        row.likeCount,
        row.replyCount,
        row.publishedAt ? toMysqlDateTime(row.publishedAt) : null,
        toMysqlDateTime(observedAt),
        toMysqlDateTime(observedAt),
        batchId,
      ],
    );
    count += 1;
  }
  return count;
}

async function fetchVideoComments(client, config, postId) {
  const { salt, maxCommentsPerVideo, maxPages, order } = config.commentFetch;
  const rows = [];
  let pageToken;
  for (let page = 0; page < maxPages; page += 1) {
    const payload = await client.listCommentThreads(postId, { pageToken, order });
    for (const thread of payload.items ?? []) {
      const top = thread.snippet?.topLevelComment;
      const snippet = top?.snippet ?? {};
      rows.push({
        commentId: top?.id,
        postId,
        authorKey: hmacAuthorKey(salt, snippet.authorChannelId?.value),
        parentId: null,
        text: scrubPii(snippet.textOriginal ?? snippet.textDisplay ?? ""),
        likeCount: normalizeUnsignedCount(snippet.likeCount),
        replyCount: normalizeUnsignedCount(thread.snippet?.totalReplyCount),
        publishedAt: snippet.publishedAt ?? null,
      });
      if (rows.length >= maxCommentsPerVideo) {
        break;
      }
    }
    pageToken = payload.nextPageToken;
    if (!pageToken || rows.length >= maxCommentsPerVideo) {
      break;
    }
  }
  return rows.slice(0, maxCommentsPerVideo);
}

async function collectComments(pool, client, config, batchId, observedAt, postIds) {
  let totalStored = 0;
  for (const postId of postIds) {
    const startedAt = new Date();
    const requestBefore = client.requestCount;
    const quotaBefore = client.quotaUsed;
    try {
      const rows = await fetchVideoComments(client, config, postId);
      const stored = await withTransaction(pool, (connection) =>
        upsertComments(connection, rows, batchId, observedAt),
      );
      totalStored += stored;
      await recordCollectionRun(pool, {
        batchId,
        queryId: null,
        runType: "comment_fetch",
        startedAt,
        status: "success",
        requestCount: client.requestCount - requestBefore,
        returnedCount: stored,
        quotaUnits: client.quotaUsed - quotaBefore,
      });
    } catch (error) {
      const message = String(error?.message ?? error);
      const disabled =
        message.includes("commentsDisabled") || message.includes("(403)");
      await recordCollectionRun(pool, {
        batchId,
        queryId: null,
        runType: "comment_fetch",
        startedAt,
        status: disabled ? "skipped" : "failed",
        requestCount: client.requestCount - requestBefore,
        returnedCount: 0,
        quotaUnits: client.quotaUsed - quotaBefore,
        errorSummary: disabled ? "commentsDisabled" : errorSummary(error),
      });
      if (
        message.includes("SNS_QUOTA_BUDGET") ||
        message.includes("SNS_SEARCH_QUOTA_BUDGET")
      ) {
        throw error;
      }
    }
  }
  return totalStored;
}

export async function estimateCollection(config, { mode = "standard" } = {}) {
  const effectiveConfig = collectionConfigForMode(config, mode);
  const pool = createAppPool(config);
  try {
    const queries = await loadActiveQueries(pool);
    const activePostIds = await loadActivePostIds(
      pool,
      effectiveConfig.activeWindowDays,
    );
    const estimatedQuotaByBucket = estimateCollectionQuotaBuckets(
      queries,
      activePostIds.length,
      commentRequestBudget(effectiveConfig),
    );
    return {
      mode,
      queryCount: queries.length,
      activePostCount: activePostIds.length,
      estimatedQuotaUnits: estimatedQuotaByBucket[QUOTA_BUCKETS.standard],
      quotaBudget: effectiveConfig.quotaBudget,
      searchQuotaBudget: effectiveConfig.searchQuotaBudget,
      estimatedQuotaByBucket,
      plannedCommentVideos: effectiveConfig.commentFetch.enabled
        ? effectiveConfig.commentFetch.maxVideos
        : 0,
      plannedCommentPages: effectiveConfig.commentFetch.enabled
        ? effectiveConfig.commentFetch.maxPages
        : 0,
    };
  } finally {
    await pool.end();
  }
}

async function runCollection(
  config,
  pool,
  { triggerType = "manual", requestId = null, fetchImpl, mode = "standard" } = {},
) {
  const effectiveConfig = collectionConfigForMode(config, mode);
  let batchId;
  const observedAt = new Date();
  const client = new YouTubeClient({
    apiKey: effectiveConfig.youtubeApiKey,
    quotaBudget: effectiveConfig.quotaBudget,
    searchQuotaBudget: effectiveConfig.searchQuotaBudget,
    fetchImpl,
  });

  try {
    const queries = await loadActiveQueries(pool);
    const activePostIds = await loadActivePostIds(
      pool,
      effectiveConfig.activeWindowDays,
    );
    const estimatedQuotaByBucket = estimateCollectionQuotaBuckets(
      queries,
      activePostIds.length,
      commentRequestBudget(effectiveConfig),
    );
    const estimatedQuotaUnits = estimatedQuotaByBucket[QUOTA_BUCKETS.standard];
    if (estimatedQuotaUnits > effectiveConfig.quotaBudget) {
      throw new Error(
        `Estimated collection cost ${estimatedQuotaUnits} exceeds SNS_QUOTA_BUDGET=${effectiveConfig.quotaBudget}`,
      );
    }
    if (
      estimatedQuotaByBucket[QUOTA_BUCKETS.search] > effectiveConfig.searchQuotaBudget
    ) {
      throw new Error(
        `Estimated search cost ${estimatedQuotaByBucket[QUOTA_BUCKETS.search]} exceeds SNS_SEARCH_QUOTA_BUDGET=${effectiveConfig.searchQuotaBudget}`,
      );
    }

    // Held inside the collect advisory lock, so any 'running' batch is a zombie
    // from a crashed run; reap it before starting a fresh one.
    await reapStaleRunningBatches(pool);

    batchId = await createCollectionBatch(pool, {
      observedAt,
      triggerType,
      estimatedQuotaUnits,
      requestId,
    });

    const categoriesPayload = await apiStep({
      pool,
      batchId,
      runType: "category_refresh",
      client,
      operation: () => client.listCategories("JP"),
      countResult: (result) => result.items?.length ?? 0,
    });

    const queryResults = [];
    for (const query of queries) {
      const publishedAfter = new Date(
        observedAt.getTime() - Number(query.lookback_days) * 86400000,
      );
      const payload = await apiStep({
        pool,
        batchId,
        queryId: query.id,
        runType: "query_search",
        client,
        operation: () => client.searchVideos(query, publishedAfter),
        countResult: (result) => result.items?.length ?? 0,
      });
      queryResults.push({
        query,
        items: payload.items ?? [],
        estimatedTotalResults: payload.pageInfo?.totalResults ?? null,
      });
    }

    const popularPayload = await apiStep({
      pool,
      batchId,
      runType: "popular_chart",
      client,
      operation: () => client.listPopularVideos("JP"),
      countResult: (result) => result.items?.length ?? 0,
    });
    const popularItems = popularPayload.items ?? [];

    const discoveredIds = unique([
      ...queryResults.flatMap((result) =>
        result.items.map((item) => item.id?.videoId),
      ),
      ...popularItems.map((item) => item.id),
    ]);
    const requestedVideoIds = unique([...discoveredIds, ...activePostIds]);

    const videoItems = await apiStep({
      pool,
      batchId,
      runType: "video_refresh",
      client,
      operation: () => client.listVideos(requestedVideoIds),
      countResult: (result) => result.length,
    });
    const returnedPostIds = new Set(videoItems.map((item) => item.id));

    const channelIds = unique(
      videoItems.map((item) => item.snippet?.channelId),
    );
    const channelItems = await apiStep({
      pool,
      batchId,
      runType: "channel_refresh",
      client,
      operation: () => client.listChannels(channelIds),
      countResult: (result) => result.length,
    });

    const unavailableCount = await withTransaction(pool, async (connection) => {
      await upsertCategories(connection, categoriesPayload.items ?? [], observedAt);
      await upsertChannelsAndSnapshots(
        connection,
        channelItems,
        videoItems,
        batchId,
        observedAt,
      );
      await upsertPostsAndSnapshots(connection, videoItems, batchId, observedAt);
      await upsertQueryResults(
        connection,
        queryResults,
        returnedPostIds,
        batchId,
        observedAt,
      );
      await upsertPopularResults(
        connection,
        popularItems,
        returnedPostIds,
        batchId,
        observedAt,
      );
      return markUnavailablePosts(
        connection,
        activePostIds,
        returnedPostIds,
        observedAt,
      );
    });

    let commentCount = 0;
    if (effectiveConfig.commentFetch.enabled) {
      if (!effectiveConfig.commentFetch.salt) {
        throw new Error(
          "COMMENT_HMAC_SALT is required when SNS_COLLECT_COMMENTS=true",
        );
      }
      const [targetRows] = await pool.query(
        `SELECT t.post_id
         FROM (
           SELECT m.post_id FROM post_query_matches m WHERE m.last_batch_id = ?
           UNION
           SELECT o.post_id FROM popular_video_observations o WHERE o.batch_id = ?
         ) t
         JOIN v_latest_post_metrics v ON v.post_id = t.post_id
         ORDER BY v.views DESC
         LIMIT ${Number(effectiveConfig.commentFetch.maxVideos)}`,
        [batchId, batchId],
      );
      commentCount = await collectComments(
        pool,
        client,
        effectiveConfig,
        batchId,
        observedAt,
        targetRows.map((row) => row.post_id),
      );
    }

    await recordCollectionQuotaUsage(
      pool,
      batchId,
      estimatedQuotaByBucket,
      client.quotaUsedByBucket,
    );
    await finishCollectionBatch(pool, batchId, {
      status: "success",
      actualQuotaUnits: client.quotaUsed,
    });

    return {
      batchId,
      observedAt,
      mode,
      queryCount: queries.length,
      discoveredVideoCount: discoveredIds.length,
      refreshedVideoCount: videoItems.length,
      channelCount: channelItems.length,
      popularVideoCount: popularItems.length,
      commentCount,
      unavailableCount,
      estimatedQuotaUnits,
      actualQuotaUnits: client.quotaUsed,
      estimatedQuotaByBucket,
      actualQuotaByBucket: client.quotaUsedByBucket,
    };
  } catch (error) {
    if (batchId) {
      await recordCollectionQuotaUsage(
        pool,
        batchId,
        {},
        client.quotaUsedByBucket,
      );
      await finishCollectionBatch(pool, batchId, {
        status: "failed",
        actualQuotaUnits: client.quotaUsed,
        errorSummary: errorSummary(error),
      });
    }
    throw error;
  }
}

export async function collect(
  config,
  { triggerType = "manual", requestId = null, fetchImpl, mode = "standard" } = {},
) {
  const pool = createAppPool(config);
  try {
    return await withAdvisoryLock(pool, "sns_trend_lab_collect", () =>
      runCollection(config, pool, { triggerType, requestId, fetchImpl, mode }),
    );
  } finally {
    await pool.end();
  }
}
