import test from "node:test";
import assert from "node:assert/strict";

import {
  buildReportModel,
  buildCommentInsights,
  buildCommentMetrics,
  buildPostMetrics,
  buildQueryMetrics,
  buildTopicMetrics,
  renderReport,
} from "../src/analyzer.js";
import { scoreSentiment } from "../src/sentiment.js";
import { buildCommentTerms, tokenize } from "../src/text.js";

function snapshot(overrides = {}) {
  return {
    id: "1",
    post_id: "video-1",
    observed_at: "2026-06-01 00:00:00.000000",
    views: "9007199254740993000",
    likes: "10",
    comments: "2",
    title: "Test video",
    channel_id: "channel-1",
    channel_title: "Test channel",
    published_at: "2026-05-31 00:00:00.000000",
    url: "https://www.youtube.com/watch?v=video-1",
    category_id: "28",
    category_title: "Science & Technology",
    ...overrides,
  };
}

test("buildPostMetrics calculates exact growth for very large counters", () => {
  const metrics = buildPostMetrics([
    snapshot(),
    snapshot({
      id: "2",
      observed_at: "2026-06-02 00:00:00.000000",
      views: "9007199254740993123",
      likes: "11",
      comments: "3",
    }),
  ]);

  assert.equal(metrics[0].viewsGrowthAbs, "123");
  assert.equal(metrics[0].viewsGrowthPerDay, "123.000000");
  assert.equal(metrics[0].latestReactions, "14");
});

test("buildPostMetrics keeps reactions null when a component is unavailable", () => {
  const [metric] = buildPostMetrics([snapshot({ likes: null })]);
  assert.equal(metric.latestReactions, null);
  assert.equal(metric.reactionRatePct, null);
});

test("buildTopicMetrics combines case variants without double-counting posts", () => {
  const postMetrics = buildPostMetrics([
    snapshot({ post_id: "video-1", views: "100" }),
    snapshot({ id: "2", post_id: "video-2", views: "200" }),
  ]);
  const dimensionsByPost = new Map([
    [
      "video-1",
      [
        { type: "tag", value: "AI" },
        { type: "tag", value: "ai" },
      ],
    ],
    ["video-2", [{ type: "tag", value: "ai" }]],
  ]);

  const metrics = buildTopicMetrics(postMetrics, dimensionsByPost);
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].dimensionValue, "AI");
  assert.equal(metrics[0].postCount, 2);
  assert.equal(metrics[0].totalViews, "300");
});

test("buildQueryMetrics does not report change from a single observation", () => {
  const metrics = buildQueryMetrics(
    [
      {
        query_id: "1",
        name: "生成AI",
        query_text: "生成AI",
        topic: "生成AI",
        observed_at: "2026-06-03 00:00:00.000000",
        estimated_total_results: "123",
      },
    ],
    new Map(),
    new Map(),
  );

  assert.equal(metrics[0].snapshotCount, 1);
  assert.equal(metrics[0].estimatedTotalResultsGrowthAbs, null);
  assert.equal(metrics[0].estimatedTotalResultsGrowthPct, null);
});

test("report labels result totals as approximate and discloses metric limits", () => {
  const report = renderReport({
    analysisRunId: "1",
    windowStart: "2026-05-01 00:00:00.000000",
    windowEnd: "2026-06-01 00:00:00.000000",
    postMetrics: [],
    topicMetrics: [],
    queryMetrics: [],
    popularMetrics: [],
    missingReactionCount: 0,
  });

  assert.match(report, /近似结果数/);
  assert.match(report, /不能视为精确搜索量/);
  assert.match(report, /YouTube 不公开分享数/);
  assert.match(report, /2025 年 3 月 31 日/);
  assert.match(report, /先运行真实数据采集/);
});

test("report avoids growth claims when videos have only one snapshot", () => {
  const postMetrics = buildPostMetrics([
    snapshot({ views: "1", likes: "1", comments: "0" }),
  ]);
  const report = renderReport({
    analysisRunId: "2",
    windowStart: "2026-05-01 00:00:00.000000",
    windowEnd: "2026-06-01 00:00:00.000000",
    postMetrics,
    topicMetrics: [],
    queryMetrics: [],
    popularMetrics: [],
    missingReactionCount: 0,
  });

  assert.match(report, /当前只有单次视频指标快照/);
  assert.match(report, /低基数/);
  assert.doesNotMatch(report, /最高增长视频提供了可测试的内容表达/);
});

test("scoreSentiment labels JA/ZH/emoji comment text", () => {
  assert.equal(scoreSentiment("この動画は最高で面白い！👍").label, "positive");
  assert.equal(scoreSentiment("最悪、つまらない").label, "negative");
  assert.equal(scoreSentiment("普通の内容です").label, "neutral");
  assert.equal(scoreSentiment("").label, "neutral");
});

test("buildCommentMetrics aggregates overall and per-topic sentiment", () => {
  const summary = buildCommentMetrics([
    { author_key: "a", text_content: "最高に面白い", topics: "生成AI" },
    { author_key: "a", text_content: "神動画", topics: "生成AI||AIニュース" },
    { author_key: "b", text_content: "最悪でつまらない", topics: "生成AI" },
    { author_key: "c", text_content: "普通", topics: "" },
  ]);
  assert.equal(summary.overall.commentCount, 4);
  assert.equal(summary.overall.distinctAuthors, 3);
  assert.equal(summary.overall.positive, 2);
  assert.equal(summary.overall.negative, 1);
  assert.equal(summary.overall.neutral, 1);
  const seisei = summary.byTopic.find((topic) => topic.topic === "生成AI");
  assert.equal(seisei.commentCount, 3);
  assert.equal(seisei.distinctAuthors, 2);
});

test("buildCommentInsights materializes video, daily, phrase, and sentiment terms", () => {
  const insight = buildCommentInsights([
    {
      comment_id: "1",
      post_id: "video-1",
      post_title: "AI video",
      author_key: "a",
      text_content: "最高 生成 AI 🔥 #生成AI",
      published_at: "2026-06-01 10:00:00.000000",
      topics: "生成AI",
    },
    {
      comment_id: "2",
      post_id: "video-1",
      post_title: "AI video",
      author_key: "b",
      text_content: "最悪 生成 AI",
      published_at: "2026-06-02 10:00:00.000000",
      topics: "生成AI",
    },
  ]);
  assert.ok(insight.metrics.some((item) => item.dimensionType === "post"));
  assert.equal(insight.dailyMetrics.length, 6);
  assert.ok(insight.terms.some((item) => item.termType === "phrase"));
  assert.ok(
    insight.terms.some(
      (item) => item.sentimentLabel === "positive" && item.termType === "word",
    ),
  );
});

test("tokenize drops stopwords, single chars, and numbers", () => {
  const tokens = tokenize("これは すごい 動画 123 ね");
  assert.ok(tokens.includes("すごい"));
  assert.ok(!tokens.some((token) => token === "動画")); // stopword
  assert.ok(!tokens.includes("123")); // number
  assert.ok(!tokens.includes("ね")); // single char
});

test("buildCommentTerms extracts words, emoji, and hashtags", () => {
  const terms = buildCommentTerms([
    { text_content: "この動画は最高 🔥 #生成AI" },
    { text_content: "すごい構成 🔥🔥 #生成AI #AI" },
  ]);
  assert.ok(terms.words.length > 0);
  assert.ok(!terms.words.some((word) => word.term === "動画")); // stopword filtered
  assert.equal(terms.emojis[0].term, "🔥");
  assert.equal(terms.emojis[0].count, 3);
  assert.equal(terms.hashtags.find((tag) => tag.term === "#生成AI").count, 2);
});

test("report includes an opinion section from comment summary", () => {
  const zh = renderReport({
    analysisRunId: "9",
    windowStart: "2026-05-01 00:00:00.000000",
    windowEnd: "2026-06-01 00:00:00.000000",
    postMetrics: [],
    topicMetrics: [],
    queryMetrics: [],
    popularMetrics: [],
    missingReactionCount: 0,
    commentSummary: buildCommentMetrics([
      { author_key: "a", text_content: "最高", topics: "生成AI" },
    ]),
  });
  assert.match(zh, /评论舆论/);
});

test("report model generates deterministic Chinese and Japanese summaries", () => {
  const model = buildReportModel({
    analysisRunId: "3",
    windowStart: "2026-05-01 00:00:00.000000",
    windowEnd: "2026-06-01 00:00:00.000000",
    postMetrics: [],
    topicMetrics: [],
    queryMetrics: [],
    popularMetrics: [],
    missingReactionCount: 0,
  });
  const japanese = renderReport(model, "ja-JP");

  assert.ok(model.summaryJson["zh-CN"].recommendations.length > 0);
  assert.ok(model.summaryJson["ja-JP"].recommendations.length > 0);
  assert.match(japanese, /YouTube SNS トレンド分析レポート/);
  assert.match(japanese, /正確な検索量ではありません/);
});
