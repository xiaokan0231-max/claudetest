import test from "node:test";
import assert from "node:assert/strict";

import { analyze } from "../src/analyzer.js";
import { collect } from "../src/collector.js";
import {
  createAdminConnection,
  createAppPool,
  initDatabase,
} from "../src/db.js";
import { getConfig } from "../src/config.js";

const TEST_DATABASE = "sns_trend_lab_test";
const VIDEO_ID = "integration-video-1";
const CHANNEL_ID = "integration-channel-1";

function response(payload) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  };
}

function videoResource(viewCount) {
  return {
    id: VIDEO_ID,
    snippet: {
      channelId: CHANNEL_ID,
      channelTitle: "Integration Channel",
      title: "Integration Video",
      publishedAt: "2026-06-01T00:00:00Z",
      categoryId: "999",
      tags: ["integration", "生成AI"],
      defaultLanguage: "ja",
      defaultAudioLanguage: "ja",
      liveBroadcastContent: "none",
      thumbnails: {
        high: { url: "https://example.test/high.jpg" },
      },
    },
    contentDetails: { duration: "PT2M3S" },
    statistics: {
      viewCount: String(viewCount),
      commentCount: "2",
    },
  };
}

function createFakeFetch(state) {
  return async (input) => {
    const url = new URL(input);
    const resource = url.pathname.split("/").at(-1);

    if (resource === "videoCategories") {
      return response({
        items: [
          {
            id: "999",
            snippet: { title: "Integration Category", assignable: true },
          },
        ],
      });
    }

    if (resource === "search") {
      return response({
        pageInfo: { totalResults: state.available ? 123 : 0 },
        items: state.available ? [{ id: { videoId: VIDEO_ID } }] : [],
      });
    }

    if (resource === "videos" && url.searchParams.get("chart") === "mostPopular") {
      return response({
        items: state.available ? [videoResource(state.viewCount)] : [],
      });
    }

    if (resource === "videos") {
      return response({
        items: state.available ? [videoResource(state.viewCount)] : [],
      });
    }

    if (resource === "channels") {
      return response({
        items: state.available
          ? [
              {
                id: CHANNEL_ID,
                snippet: { title: "Integration Channel" },
                statistics: {
                  viewCount: "10000",
                  subscriberCount: "500",
                  videoCount: "20",
                  hiddenSubscriberCount: false,
                },
              },
            ]
          : [],
      });
    }

    if (resource === "commentThreads") {
      return response({
        items: state.available
          ? [
              {
                snippet: {
                  totalReplyCount: 1,
                  topLevelComment: {
                    id: "integration-comment-1",
                    snippet: {
                      authorChannelId: { value: "UCcommenter1" },
                      textOriginal: "great clip mail me x@y.com",
                      likeCount: 4,
                      publishedAt: "2026-06-01T02:00:00Z",
                    },
                  },
                },
              },
            ]
          : [],
      });
    }

    throw new Error(`Unexpected fake YouTube resource: ${resource}`);
  };
}

async function dropTestDatabase(config) {
  const admin = await createAdminConnection(config);
  try {
    await admin.query(
      `REVOKE ALL PRIVILEGES ON \`${TEST_DATABASE}\`.* FROM \`${config.db.user}\`@'localhost'`,
    );
    await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DATABASE}\``);
  } finally {
    await admin.end();
  }
}

test("collector persists snapshots, analysis, and unavailable status in MySQL", async () => {
  const baseConfig = getConfig();
  const config = {
    ...baseConfig,
    youtubeApiKey: "integration-test-key",
    quotaBudget: 1000,
    commentFetch: {
      enabled: true,
      salt: "integration-salt",
      maxVideos: 5,
      maxCommentsPerVideo: 50,
      maxPages: 1,
      order: "relevance",
    },
    db: { ...baseConfig.db, database: TEST_DATABASE },
  };
  const state = { available: true, viewCount: 100 };

  await dropTestDatabase(config).catch(() => {});
  await initDatabase(config);

  try {
    const first = await collect(config, { fetchImpl: createFakeFetch(state) });
    state.viewCount = 150;
    const second = await collect(config, { fetchImpl: createFakeFetch(state) });

    const pool = createAppPool(config);
    try {
      const [snapshotRows] = await pool.execute(
        `SELECT batch_id, views, likes, comments
         FROM post_metric_snapshots
         WHERE post_id = ?
         ORDER BY observed_at, id`,
        [VIDEO_ID],
      );
      assert.equal(snapshotRows.length, 2);
      assert.deepEqual(
        snapshotRows.map((row) => row.views),
        ["100", "150"],
      );
      assert.equal(snapshotRows[0].likes, null);
      assert.equal(snapshotRows[0].comments, "2");
      assert.notEqual(String(first.batchId), String(second.batchId));

      const [postRows] = await pool.execute(
        "SELECT thumbnail_url FROM posts WHERE post_id = ?",
        [VIDEO_ID],
      );
      assert.equal(postRows[0].thumbnail_url, "https://example.test/high.jpg");

      const [queryRows] = await pool.query(
        `SELECT returned_sample_count, estimated_total_results,
                total_results_is_approximate
         FROM query_observations`,
      );
      assert.equal(queryRows.length, 6);
      assert.ok(queryRows.every((row) => row.total_results_is_approximate === 1));

      const [popularRows] = await pool.query(
        "SELECT COUNT(*) AS count FROM popular_video_observations",
      );
      assert.equal(popularRows[0].count, "2");

      const [commentRows] = await pool.execute(
        "SELECT comment_id, author_key, text_content FROM comments WHERE post_id = ?",
        [VIDEO_ID],
      );
      assert.equal(commentRows.length, 1);
      assert.match(commentRows[0].author_key, /^[0-9a-f]{64}$/);
      assert.doesNotMatch(commentRows[0].text_content, /x@y\.com/);

      await assert.rejects(
        pool.execute(
          `INSERT INTO post_metric_snapshots
            (post_id, batch_id, observed_at, views)
           SELECT post_id, batch_id, observed_at, views
           FROM post_metric_snapshots
           WHERE post_id = ?
           ORDER BY id
           LIMIT 1`,
          [VIDEO_ID],
        ),
        /Duplicate entry/,
      );

      await assert.rejects(
        pool.execute(
          `INSERT INTO popular_video_observations
            (batch_id, observed_at, region_code, category_id, post_id, rank_position)
           SELECT batch_id, observed_at, region_code, category_id, post_id, rank_position
           FROM popular_video_observations
           ORDER BY id
           LIMIT 1`,
        ),
        /Duplicate entry/,
      );
    } finally {
      await pool.end();
    }

    const analysisResult = await analyze(config, { days: 30 });
    assert.equal(analysisResult.postCount, 1);

    const analysisPool = createAppPool(config);
    try {
      const [metricRows] = await analysisPool.execute(
        `SELECT views_growth_abs, latest_reactions, reaction_rate_pct
         FROM analysis_post_metrics
         WHERE analysis_run_id = ? AND post_id = ?`,
        [analysisResult.analysisRunId, VIDEO_ID],
      );
      assert.equal(metricRows[0].views_growth_abs, "50");
      assert.equal(metricRows[0].latest_reactions, null);
      assert.equal(metricRows[0].reaction_rate_pct, null);

      const [reportRows] = await analysisPool.execute(
        "SELECT report_markdown, report_markdown_ja, summary_json FROM analysis_runs WHERE id = ?",
        [analysisResult.analysisRunId],
      );
      assert.match(reportRows[0].report_markdown, /YouTube SNS 趋势分析报告/);
      assert.match(reportRows[0].report_markdown_ja, /YouTube SNS トレンド分析レポート/);
      assert.match(reportRows[0].report_markdown, /评论舆论/);
      assert.ok(reportRows[0].summary_json["zh-CN"]);

      const [commentMetricRows] = await analysisPool.execute(
        `SELECT comment_count, positive_count FROM analysis_comment_metrics
         WHERE analysis_run_id = ? AND dimension_type = 'overall'`,
        [analysisResult.analysisRunId],
      );
      assert.equal(commentMetricRows.length, 1);
      assert.equal(commentMetricRows[0].comment_count, 1);
    } finally {
      await analysisPool.end();
    }

    state.available = false;
    await collect(config, { fetchImpl: createFakeFetch(state) });

    const finalPool = createAppPool(config);
    try {
      const [postRows] = await finalPool.execute(
        "SELECT is_available, unavailable_since FROM posts WHERE post_id = ?",
        [VIDEO_ID],
      );
      assert.equal(postRows[0].is_available, 0);
      assert.ok(postRows[0].unavailable_since);

      const [snapshotCountRows] = await finalPool.execute(
        "SELECT COUNT(*) AS count FROM post_metric_snapshots WHERE post_id = ?",
        [VIDEO_ID],
      );
      assert.equal(snapshotCountRows[0].count, "2");
    } finally {
      await finalPool.end();
    }
  } finally {
    await dropTestDatabase(config);
  }
});
