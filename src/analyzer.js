import { createAppPool, withAdvisoryLock, withTransaction } from "./db.js";
import {
  bigIntOrNull,
  decimalRatio,
  decimalToScaledInteger,
  escapeMarkdown,
  formatCount,
  formatJst,
  formatPercent,
  mysqlDateToDate,
  scaledIntegerToDecimal,
  signedDifference,
  sumBigInts,
  toMysqlDateTime,
} from "./utils.js";
import { scoreSentiment } from "./sentiment.js";
import {
  buildBigrams,
  extractEmojis,
  extractHashtags,
  tokenize,
} from "./text.js";

function groupBy(items, keyFn) {
  const output = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!output.has(key)) {
      output.set(key, []);
    }
    output.get(key).push(item);
  }
  return output;
}

function compareBigIntDesc(left, right, field) {
  const leftValue = bigIntOrNull(left[field]) ?? -1n;
  const rightValue = bigIntOrNull(right[field]) ?? -1n;
  return leftValue === rightValue ? 0 : leftValue > rightValue ? -1 : 1;
}

function compareDecimalDesc(left, right, field) {
  const leftValue = decimalToScaledInteger(left[field]) ?? -1n;
  const rightValue = decimalToScaledInteger(right[field]) ?? -1n;
  return leftValue === rightValue ? 0 : leftValue > rightValue ? -1 : 1;
}

export function normalizeDimensionValue(value) {
  return String(value ?? "").normalize("NFKC").trim().slice(0, 500);
}

export function buildDimensionKey(type, value) {
  const normalizedType = String(type ?? "")
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US");
  const normalizedValue = normalizeDimensionValue(value).toLocaleLowerCase("ja-JP");
  return `${normalizedType}\u0000${normalizedValue}`;
}

export function buildPostMetrics(snapshotRows) {
  const grouped = groupBy(snapshotRows, (row) => row.post_id);
  const metrics = [];
  for (const [postId, rows] of grouped) {
    rows.sort(
      (left, right) =>
        mysqlDateToDate(left.observed_at) - mysqlDateToDate(right.observed_at) ||
        Number(left.id) - Number(right.id),
    );
    const earliest = rows[0];
    const latest = rows.at(-1);
    const growth =
      rows.length > 1 ? signedDifference(latest.views, earliest.views) : null;
    const elapsedMs =
      mysqlDateToDate(latest.observed_at) - mysqlDateToDate(earliest.observed_at);
    const latestLikes = bigIntOrNull(latest.likes);
    const latestComments = bigIntOrNull(latest.comments);
    const reactions =
      latestLikes !== null && latestComments !== null
        ? latestLikes + latestComments
        : null;
    const growthPerDay =
      growth !== null && elapsedMs > 0
        ? decimalRatio(growth, BigInt(elapsedMs), {
            multiplier: 86400000n,
          })
        : null;

    metrics.push({
      postId,
      title: latest.title,
      channelId: latest.channel_id,
      channelTitle: latest.channel_title,
      publishedAt: latest.published_at,
      url: latest.url,
      thumbnailUrl: latest.thumbnail_url,
      categoryId: latest.category_id,
      categoryTitle: latest.category_title,
      earliestObservedAt: earliest.observed_at,
      latestObservedAt: latest.observed_at,
      snapshotCount: rows.length,
      earliestViews: earliest.views,
      latestViews: latest.views,
      viewsGrowthAbs: growth?.toString() ?? null,
      viewsGrowthPct:
        growth !== null
          ? decimalRatio(growth, earliest.views, { multiplier: 100n })
          : null,
      viewsGrowthPerDay: growthPerDay,
      latestLikes: latest.likes,
      latestComments: latest.comments,
      latestReactions: reactions?.toString() ?? null,
      reactionRatePct:
        reactions !== null
          ? decimalRatio(reactions, latest.views, { multiplier: 100n })
          : null,
      lowBaseReactionRate: bigIntOrNull(latest.views) < 100n,
    });
  }
  return metrics;
}

export function buildTopicMetrics(postMetrics, dimensionsByPost) {
  const groups = new Map();
  for (const metric of postMetrics) {
    const dimensions = dimensionsByPost.get(metric.postId) ?? [];
    for (const dimension of dimensions) {
      const dimensionType = String(dimension.type ?? "").trim();
      const dimensionValue = normalizeDimensionValue(dimension.value);
      if (!dimensionType || !dimensionValue) {
        continue;
      }
      const key = buildDimensionKey(dimensionType, dimensionValue);
      if (!groups.has(key)) {
        groups.set(key, {
          type: dimensionType,
          value: dimensionValue,
          itemsByPost: new Map(),
        });
      }
      groups.get(key).itemsByPost.set(metric.postId, metric);
    }
  }

  const output = [];
  for (const group of groups.values()) {
    const items = [...group.itemsByPost.values()];
    const totalViews = sumBigInts(items.map((item) => item.latestViews)) ?? 0n;
    const reactionValues = items.map((item) => item.latestReactions);
    const totalReactions = reactionValues.every((value) => value !== null)
      ? sumBigInts(reactionValues)
      : null;
    const growthItems = items.filter(
      (item) => item.viewsGrowthAbs !== null,
    );
    const totalGrowth = sumBigInts(
      growthItems.map((item) => item.viewsGrowthAbs),
    );
    const growthPerDayScaled = growthItems
      .map((item) => decimalToScaledInteger(item.viewsGrowthPerDay))
      .filter((value) => value !== null);
    const averageGrowthPerDay =
      growthPerDayScaled.length > 0
        ? scaledIntegerToDecimal(
            growthPerDayScaled.reduce((sum, value) => sum + value, 0n) /
              BigInt(growthPerDayScaled.length),
          )
        : null;

    output.push({
      dimensionType: group.type,
      dimensionValue: group.value,
      postCount: items.length,
      totalViews: totalViews.toString(),
      totalReactions: totalReactions?.toString() ?? null,
      weightedReactionRatePct:
        totalReactions !== null
          ? decimalRatio(totalReactions, totalViews, { multiplier: 100n })
          : null,
      postsWithGrowthData: growthItems.length,
      postsWithPositiveGrowth: growthItems.filter(
        (item) => bigIntOrNull(item.viewsGrowthAbs) > 0n,
      ).length,
      totalViewsGrowthAbs: totalGrowth?.toString() ?? null,
      averageViewsGrowthPerDay: averageGrowthPerDay,
    });
  }
  return output;
}

export function buildQueryMetrics(queryRows, matchesByQuery, metricsByPost) {
  const grouped = groupBy(queryRows, (row) => row.query_id);
  const output = [];
  for (const [queryId, rows] of grouped) {
    const observations = rows
      .filter((row) => row.observed_at !== null)
      .sort(
        (left, right) =>
          mysqlDateToDate(left.observed_at) - mysqlDateToDate(right.observed_at),
      );
    const earliest = observations[0] ?? null;
    const latest = observations.at(-1) ?? null;
    const matchedPostIds = matchesByQuery.get(String(queryId)) ?? [];
    const matchedMetrics = matchedPostIds
      .map((postId) => metricsByPost.get(postId))
      .filter(Boolean);
    const sampleTotalLatestViews =
      sumBigInts(matchedMetrics.map((item) => item.latestViews)) ?? 0n;
    const sampleGrowthValues = matchedMetrics
      .map((item) => item.viewsGrowthAbs)
      .filter((value) => value !== null);
    const sampleGrowth =
      sampleGrowthValues.length > 0 ? sumBigInts(sampleGrowthValues) : null;
    const estimateGrowth =
      observations.length > 1
        ? signedDifference(
            latest.estimated_total_results,
            earliest.estimated_total_results,
          )
        : null;

    output.push({
      queryId: String(queryId),
      name: rows[0].name,
      queryText: rows[0].query_text,
      topic: rows[0].topic,
      earliestObservedAt: earliest?.observed_at ?? null,
      latestObservedAt: latest?.observed_at ?? null,
      snapshotCount: observations.length,
      earliestEstimatedTotalResults: earliest?.estimated_total_results ?? null,
      latestEstimatedTotalResults: latest?.estimated_total_results ?? null,
      estimatedTotalResultsGrowthAbs: estimateGrowth?.toString() ?? null,
      estimatedTotalResultsGrowthPct:
        estimateGrowth !== null
          ? decimalRatio(estimateGrowth, earliest.estimated_total_results, {
              multiplier: 100n,
            })
          : null,
      matchedPostCount: matchedMetrics.length,
      sampleTotalLatestViews: sampleTotalLatestViews.toString(),
      sampleTotalViewsGrowthAbs: sampleGrowth?.toString() ?? null,
    });
  }
  return output;
}

export function buildPopularMetrics(rows) {
  const grouped = groupBy(rows, (row) => row.post_id);
  const output = [];
  for (const [postId, items] of grouped) {
    items.sort(
      (left, right) =>
        mysqlDateToDate(left.observed_at) - mysqlDateToDate(right.observed_at),
    );
    output.push({
      postId,
      appearanceCount: items.length,
      bestRank: Math.min(...items.map((item) => Number(item.rank_position))),
      latestRank: Number(items.at(-1).rank_position),
      firstObservedAt: items[0].observed_at,
      latestObservedAt: items.at(-1).observed_at,
    });
  }
  return output;
}

function markdownPostRows(items) {
  return items
    .map(
      (item) =>
        `| [${escapeMarkdown(item.title)}](${item.url}) | ${escapeMarkdown(
          item.channelTitle,
        )} | ${formatCount(item.latestViews)} | ${formatCount(
          item.viewsGrowthAbs,
        )} | ${formatPercent(item.reactionRatePct)} |`,
    )
    .join("\n");
}

function bullets(items) {
  return items.map((item) => `- ${item}`).join("\n");
}

export function emptyCommentSummary() {
  return {
    overall: {
      commentCount: 0,
      distinctAuthors: 0,
      positive: 0,
      neutral: 0,
      negative: 0,
      netSentimentPct: null,
    },
    byTopic: [],
  };
}

// Aggregate heuristic sentiment over comment rows ({ author_key, text_content,
// topics }) into an overall summary plus per-keyword-topic breakdown.
export function buildCommentMetrics(commentRows) {
  if (!commentRows || commentRows.length === 0) {
    return emptyCommentSummary();
  }
  const netSentiment = (positive, negative, total) =>
    total > 0 ? ((positive - negative) / total) * 100 : null;
  const overallAuthors = new Set();
  const overall = { commentCount: 0, positive: 0, neutral: 0, negative: 0 };
  const topicMap = new Map();
  for (const row of commentRows) {
    const { label } = scoreSentiment(row.text_content);
    overall.commentCount += 1;
    overall[label] += 1;
    if (row.author_key) {
      overallAuthors.add(row.author_key);
    }
    const topics = String(row.topics ?? "")
      .split("||")
      .map((topic) => topic.trim())
      .filter(Boolean);
    for (const topic of topics) {
      if (!topicMap.has(topic)) {
        topicMap.set(topic, {
          topic,
          authors: new Set(),
          commentCount: 0,
          positive: 0,
          neutral: 0,
          negative: 0,
        });
      }
      const bucket = topicMap.get(topic);
      bucket.commentCount += 1;
      bucket[label] += 1;
      if (row.author_key) {
        bucket.authors.add(row.author_key);
      }
    }
  }
  const byTopic = [...topicMap.values()]
    .map((bucket) => ({
      topic: bucket.topic,
      commentCount: bucket.commentCount,
      distinctAuthors: bucket.authors.size,
      positive: bucket.positive,
      neutral: bucket.neutral,
      negative: bucket.negative,
      netSentimentPct: netSentiment(bucket.positive, bucket.negative, bucket.commentCount),
    }))
    .sort((left, right) => right.commentCount - left.commentCount);
  return {
    overall: {
      commentCount: overall.commentCount,
      distinctAuthors: overallAuthors.size,
      positive: overall.positive,
      neutral: overall.neutral,
      negative: overall.negative,
      netSentimentPct: netSentiment(overall.positive, overall.negative, overall.commentCount),
    },
    byTopic,
  };
}

function commentDimensions(row) {
  const dimensions = [{ type: "overall", value: "ALL" }];
  const topics = String(row.topics ?? "")
    .split("||")
    .map((topic) => normalizeDimensionValue(topic))
    .filter(Boolean);
  for (const topic of topics) {
    dimensions.push({ type: "query_topic", value: topic });
  }
  if (row.post_id) {
    dimensions.push({
      type: "post",
      value: String(row.post_id),
      label: row.post_title || row.post_id,
    });
  }
  return dimensions;
}

function metricBucket(map, type, value, date = null) {
  const key = `${date ?? ""}\u0000${buildDimensionKey(type, value)}`;
  if (!map.has(key)) {
    map.set(key, {
      dimensionType: type,
      dimensionValue: value,
      commentDate: date,
      authors: new Set(),
      commentCount: 0,
      positive: 0,
      neutral: 0,
      negative: 0,
    });
  }
  return map.get(key);
}

function finalizeCommentMetric(bucket) {
  return {
    dimensionType: bucket.dimensionType,
    dimensionValue: bucket.dimensionValue,
    commentDate: bucket.commentDate,
    commentCount: bucket.commentCount,
    distinctAuthors: bucket.authors.size,
    positive: bucket.positive,
    neutral: bucket.neutral,
    negative: bucket.negative,
    netSentimentPct:
      bucket.commentCount > 0
        ? ((bucket.positive - bucket.negative) / bucket.commentCount) * 100
        : null,
  };
}

function bumpTerm(termBuckets, dimension, sentiment, type, term) {
  if (!term) return;
  const key = `${buildDimensionKey(dimension.type, dimension.value)}\u0000${sentiment}\u0000${type}`;
  if (!termBuckets.has(key)) {
    termBuckets.set(key, {
      dimensionType: dimension.type,
      dimensionValue: dimension.value,
      sentimentLabel: sentiment,
      termType: type,
      counts: new Map(),
      total: 0,
    });
  }
  const bucket = termBuckets.get(key);
  bucket.counts.set(term, (bucket.counts.get(term) ?? 0) + 1);
  bucket.total += 1;
}

function topTermRows(termBuckets, limitByType = {}) {
  const overallShares = new Map();
  for (const bucket of termBuckets.values()) {
    if (
      bucket.dimensionType !== "overall" ||
      bucket.dimensionValue !== "ALL" ||
      bucket.sentimentLabel !== "all"
    ) {
      continue;
    }
    for (const [term, count] of bucket.counts) {
      overallShares.set(
        `${bucket.termType}\u0000${term}`,
        bucket.total > 0 ? count / bucket.total : 0,
      );
    }
  }
  const rows = [];
  for (const bucket of termBuckets.values()) {
    const limit =
      limitByType[bucket.termType] ??
      (bucket.termType === "word" ? 40 : bucket.termType === "phrase" ? 30 : 15);
    const ranked = [...bucket.counts.entries()]
      .sort(
        (left, right) =>
          right[1] - left[1] || left[0].localeCompare(right[0], "ja"),
      )
      .slice(0, limit);
    for (const [term, count] of ranked) {
      const share = bucket.total > 0 ? count / bucket.total : 0;
      const overallShare = overallShares.get(`${bucket.termType}\u0000${term}`) ?? 0;
      rows.push({
        dimensionType: bucket.dimensionType,
        dimensionValue: bucket.dimensionValue,
        sentimentLabel: bucket.sentimentLabel,
        termType: bucket.termType,
        term,
        count,
        sharePct: share * 100,
        liftScore:
          bucket.dimensionType !== "overall" && overallShare > 0
            ? share / overallShare
            : null,
      });
    }
  }
  return rows;
}

// Build materialized comment insights without external NLP services.
export function buildCommentInsights(commentRows) {
  const metricBuckets = new Map();
  const dailyBuckets = new Map();
  const termBuckets = new Map();
  for (const row of commentRows ?? []) {
    const sentiment = scoreSentiment(row.text_content).label;
    const dimensions = commentDimensions(row);
    const date = row.published_at ? String(row.published_at).slice(0, 10) : null;
    const tokens = tokenize(row.text_content);
    const phrases = buildBigrams(tokens);
    const emojis = extractEmojis(row.text_content);
    const hashtags = extractHashtags(row.text_content);
    for (const dimension of dimensions) {
      const metric = metricBucket(metricBuckets, dimension.type, dimension.value);
      metric.commentCount += 1;
      metric[sentiment] += 1;
      if (row.author_key) metric.authors.add(row.author_key);
      if (date) {
        const daily = metricBucket(
          dailyBuckets,
          dimension.type,
          dimension.value,
          date,
        );
        daily.commentCount += 1;
        daily[sentiment] += 1;
        if (row.author_key) daily.authors.add(row.author_key);
      }
      for (const label of ["all", sentiment]) {
        for (const token of tokens) bumpTerm(termBuckets, dimension, label, "word", token);
        for (const phrase of phrases) bumpTerm(termBuckets, dimension, label, "phrase", phrase);
        for (const emoji of emojis) bumpTerm(termBuckets, dimension, label, "emoji", emoji);
        for (const hashtag of hashtags) bumpTerm(termBuckets, dimension, label, "hashtag", hashtag);
      }
    }
  }
  const metrics = [...metricBuckets.values()]
    .map(finalizeCommentMetric)
    .sort((left, right) => right.commentCount - left.commentCount);
  const dailyMetrics = [...dailyBuckets.values()]
    .map(finalizeCommentMetric)
    .sort(
      (left, right) =>
        String(left.commentDate).localeCompare(String(right.commentDate)) ||
        right.commentCount - left.commentCount,
    );
  return {
    metrics,
    dailyMetrics,
    terms: topTermRows(termBuckets),
    summary: {
      overall:
        metrics.find(
          (item) =>
            item.dimensionType === "overall" && item.dimensionValue === "ALL",
        ) ?? emptyCommentSummary().overall,
      byTopic: metrics
        .filter((item) => item.dimensionType === "query_topic")
        .map((item) => ({ topic: item.dimensionValue, ...item })),
    },
  };
}

function opinionLines(opinion, locale) {
  const ja = locale === "ja-JP" || locale === "ja";
  const overall = opinion?.overall;
  if (!overall || overall.commentCount === 0) {
    return ja
      ? "- 分析期間内に対象コメントがありませんでした。"
      : "- 分析期间内没有可用的评论。";
  }
  const head = ja
    ? `- コメント ${overall.commentCount} 件（作者 ${overall.distinctAuthors} 名）。ポジティブ ${overall.positive} / 中立 ${overall.neutral} / ネガティブ ${overall.negative}、ネット感情 ${formatPercent(overall.netSentimentPct)}。`
    : `- 评论 ${overall.commentCount} 条（作者 ${overall.distinctAuthors} 名）。正面 ${overall.positive} / 中立 ${overall.neutral} / 负面 ${overall.negative}，净情感 ${formatPercent(overall.netSentimentPct)}。`;
  const topics = (opinion.byTopic ?? []).slice(0, 5).map((topic) =>
    ja
      ? `- 「${escapeMarkdown(topic.topic)}」: ${topic.commentCount} 件、ネット感情 ${formatPercent(topic.netSentimentPct)}。`
      : `- 「${escapeMarkdown(topic.topic)}」：${topic.commentCount} 条，净情感 ${formatPercent(topic.netSentimentPct)}。`,
  );
  const caveat = ja
    ? "- 感情は辞書ベースの推定値で、コメントは偏ったサンプルです。事実ではなく傾向として扱ってください。"
    : "- 情感为词典法估算值，评论是有偏样本；请当作倾向而非事实。";
  return [head, ...topics, caveat].join("\n");
}

export function buildReportModel({
  analysisRunId,
  windowStart,
  windowEnd,
  postMetrics,
  topicMetrics,
  queryMetrics,
  popularMetrics,
  missingReactionCount,
  commentSummary = emptyCommentSummary(),
  keywordSuggestions = [],
}) {
  const topViews = [...postMetrics]
    .sort((left, right) => compareBigIntDesc(left, right, "latestViews"))
    .slice(0, 5);
  const topGrowth = postMetrics
    .filter((item) => item.viewsGrowthAbs !== null)
    .sort((left, right) => compareBigIntDesc(left, right, "viewsGrowthAbs"))
    .slice(0, 5);
  const topTopics = [...topicMetrics]
    .filter((item) => item.dimensionType === "query_topic")
    .sort((left, right) => compareBigIntDesc(left, right, "totalViews"))
    .slice(0, 5);
  const topQueries = [...queryMetrics]
    .sort((left, right) =>
      compareBigIntDesc(left, right, "latestEstimatedTotalResults"),
    )
    .slice(0, 5);
  const topPopular = [...popularMetrics]
    .sort(
      (left, right) =>
        left.bestRank - right.bestRank ||
        right.appearanceCount - left.appearanceCount,
    )
    .slice(0, 5);
  const topReaction = postMetrics
    .filter((item) => item.reactionRatePct !== null)
    .sort((left, right) => compareDecimalDesc(left, right, "reactionRatePct"))[0];
  const hasVideoData = postMetrics.length > 0;
  const factsZh = [];
  const factsJa = [];
  if (topGrowth[0]) {
    factsZh.push(
      `「${topGrowth[0].title}」在分析期间的浏览增长最高，增加了 ${formatCount(topGrowth[0].viewsGrowthAbs)} 次。`,
    );
    factsJa.push(
      `「${topGrowth[0].title}」は分析期間内の閲覧増加が最大で、${formatCount(topGrowth[0].viewsGrowthAbs)} 回増加しました。`,
    );
  }
  if (topTopics[0]) {
    factsZh.push(
      `关键词主题「${topTopics[0].dimensionValue}」的样本视频最新浏览数合计为 ${formatCount(topTopics[0].totalViews)} 次。`,
    );
    factsJa.push(
      `キーワードテーマ「${topTopics[0].dimensionValue}」のサンプル動画の最新閲覧数合計は ${formatCount(topTopics[0].totalViews)} 回でした。`,
    );
  }
  if (topReaction) {
    const lowBaseZh = topReaction.lowBaseReactionRate
      ? " 但该结果基于不足 100 次浏览的低基数，需要谨慎解读。"
      : "";
    const lowBaseJa = topReaction.lowBaseReactionRate
      ? " ただし、閲覧数が 100 回未満の低い基数に基づくため、慎重な解釈が必要です。"
      : "";
    factsZh.push(
      `反应率最高的视频是「${topReaction.title}」，反应率为 ${formatPercent(topReaction.reactionRatePct)}。${lowBaseZh}`,
    );
    factsJa.push(
      `反応率が最も高い動画は「${topReaction.title}」で、${formatPercent(topReaction.reactionRatePct)} でした。${lowBaseJa}`,
    );
  }
  if (factsZh.length === 0) {
    factsZh.push("分析期间没有可比较的视频指标。");
    factsJa.push("分析期間内に比較可能な動画指標がありませんでした。");
  }

  const hypothesesZh = topGrowth[0]
    ? [
        "高增长视频所属的关键词主题、标题表达、视频时长或频道规模可能与表现有关，但相关性不能证明因果关系。",
        "在热门榜中持续出现的视频可能获得了更强的推荐分发，但公开 API 数据不足以确认具体流量来源。",
      ]
    : hasVideoData
      ? ["当前只有单次视频指标快照，尚不能提出基于增长表现的驱动假设。"]
      : ["当前没有可用于提出表现驱动假设的视频快照。"];
  const hypothesesJa = topGrowth[0]
    ? [
        "高成長動画のキーワードテーマ、タイトル表現、動画時間、チャンネル規模が成果に関係する可能性がありますが、相関は因果関係を証明しません。",
        "急上昇ランキングに継続して登場する動画は推薦配信が強い可能性がありますが、公開 API だけでは流入元を確認できません。",
      ]
    : hasVideoData
      ? ["現在は動画指標のスナップショットが 1 回のみのため、成長要因に関する仮説はまだ提示できません。"]
      : ["成果要因の仮説に使える動画スナップショットがありません。"];

  const validationNeedsZh = [
    "需要 YouTube Analytics 或频道所有者数据验证观看时长、完播率、流量来源和订阅转化。",
    "需要在相似发布时间、视频形式和观察窗口下测试标题或主题，才能更可靠地判断增长驱动因素。",
    "需要更多连续快照确认短期增长是否可持续。",
  ];
  const validationNeedsJa = [
    "視聴時間、完視聴率、流入元、登録転換を確認するには YouTube Analytics またはチャンネル所有者データが必要です。",
    "成長要因をより確実に判断するには、公開時刻、動画形式、観測期間を揃えてタイトルやテーマを検証する必要があります。",
    "短期的な成長が持続するかを確認するには、連続したスナップショットが必要です。",
  ];
  const keywordRecommendationZh = keywordSuggestions.slice(0, 5).map((item) =>
    `候选关键词「${item.candidate_text}」得分 ${Number(item.total_score).toFixed(1)}，建议进入人工批准队列；理由：${item.reason_text}`,
  );
  const keywordRecommendationJa = keywordSuggestions.slice(0, 5).map((item) =>
    `候補キーワード「${item.candidate_text}」はスコア ${Number(item.total_score).toFixed(1)} です。承認候補として確認してください。理由：${item.reason_text}`,
  );
  const recommendationsZh = [
    ...(topGrowth[0]
    ? [
        "围绕最高浏览主题制作 2 条新视频，并用相同 7 天窗口比较每日增长。",
        "复用最高增长视频的标题结构，只改变一个变量进行验证。",
        "持续每日采集，比较热门榜出现次数与浏览增长。",
      ]
    : hasVideoData
      ? [
          "在后续日期再次采集，建立可比较的增长基线。",
          "将最高浏览主题作为观察候选，而不是立即下结论。",
          "持续观察热门榜出现次数与后续增长。",
        ]
      : ["先运行真实数据采集，并在后续日期再次采集以建立连续快照。"]),
    ...keywordRecommendationZh,
  ];
  const recommendationsJa = [
    ...(topGrowth[0]
    ? [
        "最新閲覧数が最大のテーマを軸に新しい動画を 2 本制作し、同じ 7 日間で日次成長を比較します。",
        "最も成長した動画のタイトル構造を再利用し、変更する変数を 1 つに絞って検証します。",
        "毎日の収集を継続し、急上昇ランキングの登場回数と閲覧増加を比較します。",
      ]
    : hasVideoData
      ? [
          "後日もう一度収集し、比較可能な成長ベースラインを作ります。",
          "最新閲覧数が最大のテーマは観察候補として扱い、すぐに結論づけません。",
          "急上昇ランキングの登場回数とその後の成長を継続して観察します。",
        ]
      : ["実データを収集し、後日もう一度収集して連続スナップショットを作ります。"]),
    ...keywordRecommendationJa,
  ];
  const limitationsZh = [
    `${missingReactionCount} 条视频缺少点赞数或评论数，因此无法计算完整反应数和反应率。`,
    "YouTube 不公开分享数，反应数仅定义为点赞数加评论数。",
    "关键词结果总数是近似值，只能作为方向性信号，不是精确搜索量。",
    "不同视频的发布时间和曝光机会不同，比较时应优先使用每日增长和相似观察窗口。",
    "自 2025 年 3 月 31 日起，YouTube Shorts 的 viewCount 包含播放开始或重播次数，口径与此前不同。",
    "本报告中的相关性不证明因果关系。",
  ];
  const limitationsJa = [
    `${missingReactionCount} 本の動画で高評価数またはコメント数が欠けているため、完全な反応数と反応率を計算できません。`,
    "YouTube は共有数を公開していないため、反応数は高評価数とコメント数の合計として定義しています。",
    "キーワード結果総数は近似値であり、方向性のシグナルに限られ、正確な検索量ではありません。",
    "動画ごとに公開時刻と露出機会が異なるため、比較では日次成長と近い観測期間を優先する必要があります。",
    "2025 年 3 月 31 日以降、YouTube Shorts の viewCount は再生開始またはリプレイを含み、以前と定義が異なります。",
    "本レポートの相関は因果関係を証明しません。",
  ];

  return {
    analysisRunId,
    windowStart,
    windowEnd,
    postMetrics,
    topicMetrics,
    queryMetrics,
    popularMetrics,
    missingReactionCount,
    opinion: commentSummary,
    topViews,
    topGrowth,
    topTopics,
    topQueries,
    topPopular,
    keywordSuggestions,
    postById: new Map(postMetrics.map((item) => [item.postId, item])),
    summaryJson: {
      "zh-CN": {
        facts: factsZh,
        hypotheses: hypothesesZh,
        validationNeeds: validationNeedsZh,
        recommendations: recommendationsZh,
        limitations: limitationsZh,
      },
      "ja-JP": {
        facts: factsJa,
        hypotheses: hypothesesJa,
        validationNeeds: validationNeedsJa,
        recommendations: recommendationsJa,
        limitations: limitationsJa,
      },
    },
  };
}

function topicRows(items) {
  return (
    items
      .map(
        (item) =>
          `| ${escapeMarkdown(item.dimensionValue)} | ${item.postCount} | ${formatCount(
            item.totalViews,
          )} | ${formatCount(item.totalViewsGrowthAbs)} | ${formatPercent(
            item.weightedReactionRatePct,
          )} |`,
      )
      .join("\n") || "| N/A | | | | |"
  );
}

function queryRows(items) {
  return (
    items
      .map(
        (item) =>
          `| ${escapeMarkdown(item.name)} | ${formatCount(
            item.latestEstimatedTotalResults,
          )} | ${formatCount(item.estimatedTotalResultsGrowthAbs)} | ${
            item.matchedPostCount
          } | ${formatCount(item.sampleTotalLatestViews)} |`,
      )
      .join("\n") || "| N/A | | | | |"
  );
}

function popularRows(model) {
  return (
    model.topPopular
      .map((item) => {
        const post = model.postById.get(item.postId);
        return `| ${item.bestRank} | ${escapeMarkdown(
          post?.title ?? item.postId,
        )} | ${item.appearanceCount} | ${item.latestRank} |`;
      })
      .join("\n") || "| N/A | | | |"
  );
}

function keywordSuggestionRows(items) {
  return (
    (items ?? [])
      .slice(0, 8)
      .map(
        (item) =>
          `| ${escapeMarkdown(item.candidate_text)} | ${escapeMarkdown(item.topic)} | ${Number(
            item.total_score,
          ).toFixed(1)} | ${escapeMarkdown(item.reason_text)} |`,
      )
      .join("\n") || "| N/A | | | |"
  );
}

export function renderReport(input, locale = "zh-CN") {
  const model = input.summaryJson ? input : buildReportModel(input);
  const summary = model.summaryJson[locale] ?? model.summaryJson["zh-CN"];
  if (locale === "ja-JP" || locale === "ja") {
    return `# YouTube SNS トレンド分析レポート

分析実行 ID：\`${model.analysisRunId}\`

## 実行サマリー

- データソース：YouTube Data API v3 の日本向けキーワード検索、日本の \`mostPopular\`、公開動画指標スナップショット。
- 分析期間：${formatJst(model.windowStart)} から ${formatJst(model.windowEnd)}（JST）。
- 分析動画数：${model.postMetrics.length}、キーワード数：${model.queryMetrics.length}、急上昇ランキング登場動画数：${model.popularMetrics.length}。
- 公開されている閲覧数、高評価数、コメント数を使用します。YouTube は共有数、保存数、クリック数、視聴時間を公開していません。

## 高パフォーマンス動画

| 動画 | チャンネル | 最新閲覧数 | 閲覧増加 | 反応率 |
| --- | --- | ---: | ---: | ---: |
${markdownPostRows(model.topViews) || "| データなし | | | | |"}

## 成長が目立つ動画

| 動画 | チャンネル | 最新閲覧数 | 閲覧増加 | 反応率 |
| --- | --- | ---: | ---: | ---: |
${markdownPostRows(model.topGrowth) || "| 比較可能なスナップショットなし | | | | |"}

## キーワードテーマ

| テーマ | 動画数 | 最新閲覧数合計 | 閲覧増加合計 | 加重反応率 |
| --- | ---: | ---: | ---: | ---: |
${topicRows(model.topTopics)}

## キーワード近似結果数

\`estimated_total_results\` は YouTube 検索 API が返す近似結果数です。方向性のシグナルに限られ、正確な検索量ではありません。

| キーワード | 最新近似結果数 | 変化 | 一致サンプル動画数 | サンプル最新閲覧数合計 |
| --- | ---: | ---: | ---: | ---: |
${queryRows(model.topQueries)}

## 日本の急上昇ランキング

| 最高順位 | 動画 | 登場回数 | 最新順位 |
| ---: | --- | ---: | ---: |
${popularRows(model)}

## データで確認できる事実

${bullets(summary.facts)}

## 合理的な推測

${bullets(summary.hypotheses)}

## 追加検証が必要な点

${bullets(summary.validationNeeds)}

## 企画・改善提案

${bullets(summary.recommendations)}

## キーワード拡張候補

未承認の候補だけを表示します。承認するまでは search.list クォータを消費しません。

| 候補 | テーマ | スコア | 根拠 |
| --- | --- | ---: | --- |
${keywordSuggestionRows(model.keywordSuggestions)}

## コメント世論（試験的）

${opinionLines(model.opinion, "ja-JP")}

## データ品質と制約

${bullets(summary.limitations)}
`;
  }

  return `# YouTube SNS 趋势分析报告

分析运行 ID：\`${model.analysisRunId}\`

## 执行摘要

- 数据来源：YouTube Data API v3 的日本关键词搜索、日本 \`mostPopular\` 热门榜及公开视频指标快照。
- 分析期间：${formatJst(model.windowStart)} 至 ${formatJst(model.windowEnd)}（JST）。
- 分析视频数：${model.postMetrics.length}；关键词数：${model.queryMetrics.length}；热门榜出现视频数：${model.popularMetrics.length}。
- 本报告使用公开浏览数、点赞数和评论数。YouTube 不公开分享数、收藏数、点击数或观看时长。

## 高表现视频

| 视频 | 频道 | 最新浏览数 | 浏览增长 | 反应率 |
| --- | --- | ---: | ---: | ---: |
${markdownPostRows(model.topViews) || "| 暂无数据 | | | | |"}

## 增长明显的视频

| 视频 | 频道 | 最新浏览数 | 浏览增长 | 反应率 |
| --- | --- | ---: | ---: | ---: |
${markdownPostRows(model.topGrowth) || "| 暂无可比较快照 | | | | |"}

## 关键词主题

| 主题 | 视频数 | 最新浏览数合计 | 浏览增长合计 | 加权反应率 |
| --- | ---: | ---: | ---: | ---: |
${topicRows(model.topTopics)}

## 关键词近似结果数

\`estimated_total_results\` 是 YouTube 搜索接口返回的近似结果数，只能作为方向性信号，不能视为精确搜索量。

| 关键词 | 最新近似结果数 | 变化 | 匹配样本视频数 | 样本最新浏览数合计 |
| --- | ---: | ---: | ---: | ---: |
${queryRows(model.topQueries)}

## 日本热门榜

| 最佳排名 | 视频 | 出现次数 | 最新排名 |
| ---: | --- | ---: | ---: |
${popularRows(model)}

## 数据支持的事实

${bullets(summary.facts)}

## 合理推测

${bullets(summary.hypotheses)}

## 仍需验证

${bullets(summary.validationNeeds)}

## 企划与改善建议

${bullets(summary.recommendations)}

## 关键词扩展候选

这里只展示未批准候选。候选在人工批准前不会消耗 search.list 配额。

| 候选词 | 主题 | 分数 | 依据 |
| --- | --- | ---: | --- |
${keywordSuggestionRows(model.keywordSuggestions)}

## 评论舆论（实验性）

${opinionLines(model.opinion, "zh-CN")}

## 数据质量与局限

${bullets(summary.limitations)}
`;
}

async function insertAnalysisRun(
  pool,
  {
    windowStart,
    windowEnd,
    days,
    triggerType = "manual",
    sourceBatchId = null,
    requestId = null,
  },
) {
  const [result] = await pool.execute(
    `INSERT INTO analysis_runs
      (started_at, window_start, window_end, days, status, trigger_type,
       source_batch_id, request_id, parameters_json)
     VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
    [
      toMysqlDateTime(new Date()),
      toMysqlDateTime(windowStart),
      toMysqlDateTime(windowEnd),
      days,
      triggerType,
      sourceBatchId,
      requestId,
      JSON.stringify({
        source: "YouTube Data API v3",
        regionCode: "JP",
        reactionDefinition: "likes + comments when both are available",
      }),
    ],
  );
  return result.insertId;
}

async function finishAnalysisRun(
  pool,
  runId,
  {
    status,
    report = null,
    reportJa = null,
    summaryJson = null,
    error = null,
  },
) {
  await pool.execute(
    `UPDATE analysis_runs
     SET completed_at = ?, status = ?, report_markdown = ?,
         report_markdown_ja = ?, summary_json = ?, error_summary = ?
     WHERE id = ?`,
    [
      toMysqlDateTime(new Date()),
      status,
      report,
      reportJa,
      summaryJson ? JSON.stringify(summaryJson) : null,
      error ? String(error.message ?? error).slice(0, 4000) : null,
      runId,
    ],
  );
}

async function runAnalysis(
  config,
  pool,
  { days = 30, triggerType = "manual", requestId = null } = {},
) {
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - days * 86400000);
  let analysisRunId;

  try {
    const [batchRows] = await pool.query(
      `SELECT id
       FROM collection_batches
       WHERE status = 'success'
       ORDER BY observed_at DESC, id DESC
       LIMIT 1`,
    );
    const sourceBatchId = batchRows[0]?.id ?? null;
    analysisRunId = await insertAnalysisRun(pool, {
      windowStart,
      windowEnd,
      days,
      triggerType,
      sourceBatchId,
      requestId,
    });
    const [snapshotRows] = await pool.execute(
      `SELECT
        s.id, s.post_id, s.observed_at, s.views, s.likes, s.comments,
        p.title, p.channel_id, p.published_at, p.url, p.thumbnail_url,
        p.category_id,
        c.title AS channel_title, yc.title AS category_title
       FROM post_metric_snapshots s
       JOIN posts p ON p.post_id = s.post_id
       JOIN channels c ON c.channel_id = p.channel_id
       LEFT JOIN youtube_categories yc
         ON yc.category_id = p.category_id AND yc.region_code = 'JP'
       WHERE s.observed_at BETWEEN ? AND ?
       ORDER BY s.post_id, s.observed_at, s.id`,
      [toMysqlDateTime(windowStart), toMysqlDateTime(windowEnd)],
    );
    const postMetrics = buildPostMetrics(snapshotRows);
    const metricsByPost = new Map(postMetrics.map((item) => [item.postId, item]));

    const dimensionsByPost = new Map();
    const addDimension = (postId, type, value) => {
      if (!postId || !value || !metricsByPost.has(postId)) {
        return;
      }
      const normalizedValue = normalizeDimensionValue(value);
      if (!normalizedValue) {
        return;
      }
      if (!dimensionsByPost.has(postId)) {
        dimensionsByPost.set(postId, []);
      }
      const dimensions = dimensionsByPost.get(postId);
      const key = buildDimensionKey(type, normalizedValue);
      if (
        !dimensions.some(
          (item) => buildDimensionKey(item.type, item.value) === key,
        )
      ) {
        dimensions.push({ type, value: normalizedValue });
      }
    };

    for (const metric of postMetrics) {
      addDimension(metric.postId, "category", metric.categoryTitle);
    }
    const [queryDimensionRows] = await pool.execute(
      `SELECT m.post_id, q.topic
       FROM post_query_matches m
       JOIN tracked_queries q ON q.id = m.query_id
       WHERE m.last_matched_at >= ?`,
      [toMysqlDateTime(windowStart)],
    );
    for (const row of queryDimensionRows) {
      addDimension(row.post_id, "query_topic", row.topic);
    }
    const [tagRows] = await pool.query("SELECT post_id, tag FROM post_tags");
    for (const row of tagRows) {
      addDimension(row.post_id, "tag", row.tag);
    }
    const topicMetrics = buildTopicMetrics(postMetrics, dimensionsByPost);

    const [queryRows] = await pool.execute(
      `SELECT
        q.id AS query_id, q.name, q.query_text, q.topic,
        o.observed_at, o.estimated_total_results
       FROM tracked_queries q
       LEFT JOIN query_observations o
         ON o.query_id = q.id AND o.observed_at BETWEEN ? AND ?
       WHERE q.archived_at IS NULL
       ORDER BY q.id, o.observed_at`,
      [toMysqlDateTime(windowStart), toMysqlDateTime(windowEnd)],
    );
    const [matchRows] = await pool.execute(
      `SELECT query_id, post_id
       FROM post_query_matches
       WHERE last_matched_at >= ?`,
      [toMysqlDateTime(windowStart)],
    );
    const matchesByQuery = new Map();
    for (const row of matchRows) {
      const key = String(row.query_id);
      if (!matchesByQuery.has(key)) {
        matchesByQuery.set(key, []);
      }
      matchesByQuery.get(key).push(row.post_id);
    }
    const queryMetrics = buildQueryMetrics(queryRows, matchesByQuery, metricsByPost);

    const [popularRows] = await pool.execute(
      `SELECT post_id, observed_at, rank_position
       FROM popular_video_observations
       WHERE observed_at BETWEEN ? AND ?
       ORDER BY post_id, observed_at`,
      [toMysqlDateTime(windowStart), toMysqlDateTime(windowEnd)],
    );
    const popularMetrics = buildPopularMetrics(popularRows);
    const missingReactionCount = postMetrics.filter(
      (item) => item.latestReactions === null,
    ).length;
    const [commentRows] = await pool.execute(
      `SELECT c.comment_id, c.post_id, p.title AS post_title, c.author_key,
              c.text_content, c.published_at,
              GROUP_CONCAT(DISTINCT q.topic SEPARATOR '||') AS topics
       FROM comments c
       JOIN posts p ON p.post_id = c.post_id
       LEFT JOIN post_query_matches m ON m.post_id = c.post_id
       LEFT JOIN tracked_queries q ON q.id = m.query_id
       WHERE c.is_available = TRUE
         AND c.last_seen_at BETWEEN ? AND ?
       GROUP BY c.comment_id, c.post_id, p.title, c.author_key,
                c.text_content, c.published_at`,
      [toMysqlDateTime(windowStart), toMysqlDateTime(windowEnd)],
    );
    const commentInsights = buildCommentInsights(commentRows);
    const commentSummary = commentInsights.summary;
    const [keywordSuggestionRows] = await pool.query(
      `SELECT candidate_text, topic, CAST(total_score AS CHAR) AS total_score,
              reason_text
       FROM keyword_candidates
       WHERE status = 'suggested'
       ORDER BY total_score DESC, last_seen_at DESC
       LIMIT 8`,
    );
    const reportModel = buildReportModel({
      analysisRunId,
      windowStart,
      windowEnd,
      postMetrics,
      topicMetrics,
      queryMetrics,
      popularMetrics,
      missingReactionCount,
      commentSummary,
      keywordSuggestions: keywordSuggestionRows,
    });
    const report = renderReport(reportModel, "zh-CN");
    const reportJa = renderReport(reportModel, "ja-JP");

    await withTransaction(pool, async (connection) => {
      for (const item of postMetrics) {
        await connection.execute(
          `INSERT INTO analysis_post_metrics
            (analysis_run_id, post_id, earliest_observed_at, latest_observed_at,
             snapshot_count, earliest_views, latest_views, views_growth_abs,
             views_growth_pct, views_growth_per_day, latest_likes,
             latest_comments, latest_reactions, reaction_rate_pct,
             low_base_reaction_rate)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            analysisRunId,
            item.postId,
            item.earliestObservedAt,
            item.latestObservedAt,
            item.snapshotCount,
            item.earliestViews,
            item.latestViews,
            item.viewsGrowthAbs,
            item.viewsGrowthPct,
            item.viewsGrowthPerDay,
            item.latestLikes,
            item.latestComments,
            item.latestReactions,
            item.reactionRatePct,
            item.lowBaseReactionRate,
          ],
        );
      }
      for (const item of topicMetrics) {
        await connection.execute(
          `INSERT INTO analysis_topic_metrics
            (analysis_run_id, dimension_type, dimension_value, post_count,
             total_views, total_reactions, weighted_reaction_rate_pct,
             posts_with_growth_data, posts_with_positive_growth,
             total_views_growth_abs, average_views_growth_per_day)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            analysisRunId,
            item.dimensionType,
            item.dimensionValue,
            item.postCount,
            item.totalViews,
            item.totalReactions,
            item.weightedReactionRatePct,
            item.postsWithGrowthData,
            item.postsWithPositiveGrowth,
            item.totalViewsGrowthAbs,
            item.averageViewsGrowthPerDay,
          ],
        );
      }
      for (const item of queryMetrics) {
        await connection.execute(
          `INSERT INTO analysis_query_metrics
            (analysis_run_id, query_id, earliest_observed_at, latest_observed_at,
             snapshot_count, earliest_estimated_total_results,
             latest_estimated_total_results, estimated_total_results_growth_abs,
             estimated_total_results_growth_pct, matched_post_count,
             sample_total_latest_views, sample_total_views_growth_abs)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            analysisRunId,
            item.queryId,
            item.earliestObservedAt,
            item.latestObservedAt,
            item.snapshotCount,
            item.earliestEstimatedTotalResults,
            item.latestEstimatedTotalResults,
            item.estimatedTotalResultsGrowthAbs,
            item.estimatedTotalResultsGrowthPct,
            item.matchedPostCount,
            item.sampleTotalLatestViews,
            item.sampleTotalViewsGrowthAbs,
          ],
        );
      }
      for (const item of popularMetrics) {
        await connection.execute(
          `INSERT INTO analysis_popular_metrics
            (analysis_run_id, post_id, appearance_count, best_rank, latest_rank,
             first_observed_at, latest_observed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            analysisRunId,
            item.postId,
            item.appearanceCount,
            item.bestRank,
            item.latestRank,
            item.firstObservedAt,
            item.latestObservedAt,
          ],
        );
      }
      for (const item of commentInsights.metrics) {
        await connection.execute(
          `INSERT INTO analysis_comment_metrics
            (analysis_run_id, dimension_type, dimension_value, comment_count,
             distinct_authors, positive_count, neutral_count, negative_count,
             net_sentiment_pct)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            analysisRunId,
            item.dimensionType,
            item.dimensionValue,
            item.commentCount,
            item.distinctAuthors,
            item.positive,
            item.neutral,
            item.negative,
            item.netSentimentPct,
          ],
        );
      }
      for (const item of commentInsights.dailyMetrics) {
        await connection.execute(
          `INSERT INTO analysis_comment_daily_metrics
            (analysis_run_id, comment_date, dimension_type, dimension_value,
             comment_count, distinct_authors, positive_count, neutral_count,
             negative_count, net_sentiment_pct)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            analysisRunId,
            item.commentDate,
            item.dimensionType,
            item.dimensionValue,
            item.commentCount,
            item.distinctAuthors,
            item.positive,
            item.neutral,
            item.negative,
            item.netSentimentPct,
          ],
        );
      }
      for (const item of commentInsights.terms) {
        await connection.execute(
          `INSERT INTO analysis_comment_terms
            (analysis_run_id, dimension_type, dimension_value, sentiment_label,
             term_type, term, count, share_pct, lift_score)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            analysisRunId,
            item.dimensionType,
            item.dimensionValue,
            item.sentimentLabel,
            item.termType,
            item.term,
            item.count,
            item.sharePct,
            item.liftScore,
          ],
        );
      }
    });

    await finishAnalysisRun(pool, analysisRunId, {
      status: "success",
      report,
      reportJa,
      summaryJson: reportModel.summaryJson,
    });
    return {
      analysisRunId,
      windowStart,
      windowEnd,
      postCount: postMetrics.length,
      topicCount: topicMetrics.length,
      queryCount: queryMetrics.length,
      popularVideoCount: popularMetrics.length,
      report,
      reportJa,
      summaryJson: reportModel.summaryJson,
    };
  } catch (error) {
    if (analysisRunId) {
      await finishAnalysisRun(pool, analysisRunId, {
        status: "failed",
        error,
      });
    }
    throw error;
  }
}

export async function analyze(
  config,
  { days = 30, triggerType = "manual", requestId = null } = {},
) {
  const pool = createAppPool(config);
  try {
    return await withAdvisoryLock(pool, "sns_trend_lab_analyze", () =>
      runAnalysis(config, pool, { days, triggerType, requestId }),
    );
  } finally {
    await pool.end();
  }
}
