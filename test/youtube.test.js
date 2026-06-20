import test from "node:test";
import assert from "node:assert/strict";

import {
  buildYouTubeApiUrl,
  estimateCollectionQuota,
  estimateCollectionQuotaBuckets,
  QUOTA_BUCKETS,
  QUOTA_COSTS,
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
  // 3 searches x 100 real units = 300, plus 10 detail/channel/category units.
  assert.equal(estimateCollectionQuota(queries, 0), 310);
  assert.equal(estimateCollectionQuota(queries, 30), 312);
  assert.deepEqual(estimateCollectionQuotaBuckets(queries, 0), {
    [QUOTA_BUCKETS.search]: 3,
    [QUOTA_BUCKETS.standard]: 310,
  });
});

test("estimateCollectionQuota adds comment-thread requests", () => {
  const queries = [{ max_results: 50 }, { max_results: 50 }, { max_results: 50 }];
  assert.equal(estimateCollectionQuota(queries, 0, 40), 350);
});

test("search.list is charged its real 100-unit YouTube cost in the standard bucket", () => {
  assert.equal(QUOTA_COSTS.searchListUnits, 100);
  const buckets = estimateCollectionQuotaBuckets([{ max_results: 50 }], 0);
  // 1 search request, and 100 (search) + 6 (1 videos + 1 categories + 2 detail + 2 channel) standard units.
  assert.equal(buckets[QUOTA_BUCKETS.search], 1);
  assert.equal(buckets[QUOTA_BUCKETS.standard], 106);
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

test("YouTubeClient stops a search that would exceed the standard unit budget", async () => {
  let called = false;
  const client = new YouTubeClient({
    apiKey: "not-a-real-key",
    quotaBudget: 50,
    searchQuotaBudget: 100,
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
    /SNS_QUOTA_BUDGET=50/,
  );
  assert.equal(called, false);
});

test("YouTubeClient charges quota once per call, not once per retry attempt", async () => {
  let attempts = 0;
  const client = new YouTubeClient({
    apiKey: "k",
    quotaBudget: 10000,
    searchQuotaBudget: 100,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          ok: false,
          status: 429,
          json: async () => ({
            error: { message: "rate", errors: [{ reason: "rateLimitExceeded" }] },
          }),
        };
      }
      return { ok: true, json: async () => ({ items: [] }) };
    },
  });

  await client.searchVideos(
    {
      query_text: "x",
      region_code: "JP",
      relevance_language: "ja",
      safe_search: "moderate",
      max_results: 50,
    },
    new Date("2026-05-27T00:00:00.000Z"),
  );

  assert.equal(attempts, 2);
  assert.equal(client.quotaUsedByBucket[QUOTA_BUCKETS.search], 1);
  // 100 (one search.list), NOT 200 — a 429 retry must not re-charge the call.
  assert.equal(client.quotaUsedByBucket[QUOTA_BUCKETS.standard], 100);
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
