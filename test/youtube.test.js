import test from "node:test";
import assert from "node:assert/strict";

import {
  buildYouTubeApiUrl,
  estimateCollectionQuota,
  estimateCollectionQuotaBuckets,
  QUOTA_BUCKETS,
  YouTubeClient,
} from "../src/youtube.js";
import { selectThumbnailUrl } from "../src/collector.js";

test("buildYouTubeApiUrl builds the fixed JP keyword-search parameters", () => {
  const url = buildYouTubeApiUrl("search", {
    part: "snippet",
    type: "video",
    q: "生成AI",
    regionCode: "JP",
    relevanceLanguage: "ja",
    safeSearch: "moderate",
    order: "date",
    publishedAfter: "2026-05-27T00:00:00.000Z",
    maxResults: 50,
  });

  assert.equal(url.pathname, "/youtube/v3/search");
  assert.equal(url.searchParams.get("type"), "video");
  assert.equal(url.searchParams.get("regionCode"), "JP");
  assert.equal(url.searchParams.get("relevanceLanguage"), "ja");
  assert.equal(url.searchParams.get("safeSearch"), "moderate");
  assert.equal(url.searchParams.get("order"), "date");
  assert.equal(url.searchParams.get("maxResults"), "50");
});

test("estimateCollectionQuota separates search requests from standard units", () => {
  const queries = [
    { max_results: 50 },
    { max_results: 50 },
    { max_results: 50 },
  ];
  assert.equal(estimateCollectionQuota(queries, 0), 10);
  assert.equal(estimateCollectionQuota(queries, 30), 12);
  assert.deepEqual(estimateCollectionQuotaBuckets(queries, 0), {
    [QUOTA_BUCKETS.search]: 3,
    [QUOTA_BUCKETS.standard]: 10,
  });
});

test("estimateCollectionQuota adds comment-thread requests", () => {
  const queries = [{ max_results: 50 }, { max_results: 50 }, { max_results: 50 }];
  assert.equal(estimateCollectionQuota(queries, 0, 40), 50);
});

test("YouTubeClient stops before a search request that exceeds its local bucket budget", async () => {
  let called = false;
  const client = new YouTubeClient({
    apiKey: "not-a-real-key",
    quotaBudget: 1000,
    searchQuotaBudget: 0,
    fetchImpl: async () => {
      called = true;
      throw new Error("should not be called");
    },
  });

  await assert.rejects(
    client.searchVideos(
      {
        query_text: "生成AI",
        region_code: "JP",
        relevance_language: "ja",
        safe_search: "moderate",
        max_results: 50,
      },
      new Date("2026-05-27T00:00:00.000Z"),
    ),
    /SNS_SEARCH_QUOTA_BUDGET=0/,
  );
  assert.equal(called, false);
});

test("YouTubeClient does not retry a non-temporary API error", async () => {
  let calls = 0;
  const client = new YouTubeClient({
    apiKey: "not-a-real-key",
    quotaBudget: 1000,
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: false,
        status: 403,
        json: async () => ({
          error: {
            message: "API key not valid",
            errors: [{ reason: "keyInvalid" }],
          },
        }),
      };
    },
  });

  await assert.rejects(
    client.listCategories(),
    /YouTube API request failed \(403\) \[keyInvalid\]/,
  );
  assert.equal(calls, 1);
});

test("collector selects the highest available thumbnail", () => {
  assert.equal(
    selectThumbnailUrl({
      default: { url: "default" },
      high: { url: "high" },
      maxres: { url: "maxres" },
    }),
    "maxres",
  );
  assert.equal(selectThumbnailUrl({}), null);
});
