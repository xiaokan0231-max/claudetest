import test from "node:test";
import assert from "node:assert/strict";

import {
  extractKeywordCandidateTerms,
  normalizeCandidate,
} from "../src/keyword-suggestions.js";

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
