import test from "node:test";
import assert from "node:assert/strict";

import { buildQuotaRecommendation } from "../src/quota-optimizer.js";

test("quota planner keeps a buffer and recommends candidate approval slots", () => {
  const plan = buildQuotaRecommendation({
    searchLimit: 100,
    searchUsed: 6,
    standardLimit: 10000,
    standardUsed: 52,
    estimatedByBucket: {
      search_requests_per_day: 3,
      standard_units_per_day: 60,
    },
    baseStandardUnits: 20,
    enabledQueryCount: 3,
    activePostCount: 240,
    suggestedCandidateCount: 20,
    approvedCandidateCount: 0,
    commentFetch: { enabled: true, maxVideos: 5, maxPages: 1 },
  });
  assert.equal(plan.search.target, 75);
  assert.equal(plan.search.safeAvailable, 69);
  assert.equal(plan.candidates.recommendedApprovalCount, 20);
  assert.equal(plan.collection.shouldCollect, true);
  assert.equal(plan.collection.recommendedCommentPages, 2);
});

test("quota planner does not expand when search target is already exhausted", () => {
  const plan = buildQuotaRecommendation({
    searchLimit: 100,
    searchUsed: 90,
    standardLimit: 10000,
    standardUsed: 10,
    estimatedByBucket: {
      search_requests_per_day: 3,
      standard_units_per_day: 20,
    },
    baseStandardUnits: 20,
    enabledQueryCount: 3,
    activePostCount: 10,
    suggestedCandidateCount: 5,
    approvedCandidateCount: 0,
    commentFetch: { enabled: false, maxVideos: 0, maxPages: 0 },
  });
  assert.equal(plan.search.safeAvailable, 0);
  assert.equal(plan.candidates.recommendedApprovalCount, 0);
  assert.equal(plan.collection.shouldCollect, false);
});
