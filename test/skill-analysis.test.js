import test from "node:test";
import assert from "node:assert/strict";

import { validateSkillAnalysis } from "../src/skill-analysis.js";

function input(overrides = {}) {
  return {
    question: "哪些评论主题值得继续观察？",
    title: "评论主题观察",
    locale: "zh-CN",
    reportMarkdown: "# 评论主题观察\n\n这是聚合分析。",
    sections: {
      facts: ["生成AI 评论数较多。"],
      hypotheses: [],
      validationNeeds: [],
      recommendations: [],
      limitations: ["评论是有偏样本。"],
    },
    charts: [
      {
        type: "bar",
        title: "热门词",
        fields: { x: "term", y: "count" },
        rows: [{ term: "生成AI", count: 12 }],
      },
    ],
    ...overrides,
  };
}

test("validateSkillAnalysis accepts bounded structured results", () => {
  const result = validateSkillAnalysis(input());
  assert.equal(result.locale, "zh-CN");
  assert.equal(result.charts[0].type, "bar");
});

test("validateSkillAnalysis rejects HTML and arbitrary chart types", () => {
  assert.throws(
    () => validateSkillAnalysis(input({ reportMarkdown: "<script>alert(1)</script>" })),
    /must not contain HTML/,
  );
  assert.throws(
    () => validateSkillAnalysis(input({ charts: [{ type: "pie", title: "x", rows: [] }] })),
    /not allowed/,
  );
});
