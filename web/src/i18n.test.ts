import { describe, expect, it } from "vitest";
import i18n, { resources } from "./i18n";

describe("bilingual interface", () => {
  it("defaults to Chinese when no saved locale exists", () => {
    expect(["zh-CN", "ja-JP"]).toContain(i18n.language);
    expect(resources["zh-CN"].translation.nav.overview).toBe("概览");
  });

  it("provides matching Japanese navigation and report labels", () => {
    expect(resources["ja-JP"].translation.nav.videos).toBe("動画分析");
    expect(resources["ja-JP"].translation.reports.fallback).toContain("中国語");
  });
});
