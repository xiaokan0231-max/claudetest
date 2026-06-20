import test from "node:test";
import assert from "node:assert/strict";

import {
  extractKeywordCandidateTerms,
  normalizeCandidate,
  SCORE_WEIGHTS,
  totalScore,
} from "../src/keyword-suggestions.js";

test("candidate score weights sum to 1 and growth carries real weight", () => {
  const sum = Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(Math.round(sum * 1000) / 1000, 1);
  assert.ok(SCORE_WEIGHTS.growth > 0, "growth must influence the total score");
  // A rising-but-quiet candidate (high growth) must out-rank an identical one
  // with no growth, which the old weighting (growth weight 0) could not do.
  const base = { heat: 40, comment: 40, growth: 0, relevance: 40, freshness: 40 };
  const rising = { ...base, growth: 90 };
  assert.ok(totalScore(rising) > totalScore(base));
});

test("keyword suggestions extract AI/data candidates and filter existing queries", () => {
  const existing = new Set(["生成ai"]);
  const terms = extractKeywordCandidateTerms(
    "【生成AIニュース】ChatGPT エージェントとデータ分析の仕事術",
    existing,
  );
  assert.ok(terms.includes("ChatGPT"));
  assert.ok(terms.includes("エージェントとデータ分析の仕事術"));
  assert.ok(terms.includes("データ 分析"));
  assert.ok(!terms.includes("生成AI"));
});

test("keyword candidate normalization removes search-hostile noise", () => {
  assert.equal(normalizeCandidate(" ＃生成AI｜活用  "), "生成AI 活用");
});
