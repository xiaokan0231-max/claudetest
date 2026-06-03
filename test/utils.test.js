import test from "node:test";
import assert from "node:assert/strict";

import {
  decimalRatio,
  hmacAuthorKey,
  normalizeUnsignedCount,
  parseIsoDuration,
  scrubPii,
  signedDifference,
} from "../src/utils.js";

test("parseIsoDuration handles day and time components", () => {
  assert.equal(parseIsoDuration("P1DT2H3M4S"), 93784);
  assert.equal(parseIsoDuration("PT45S"), 45);
  assert.equal(parseIsoDuration("not-a-duration"), null);
});

test("normalizeUnsignedCount preserves integers larger than Number.MAX_SAFE_INTEGER", () => {
  const count = "18446744073709551615";
  assert.equal(normalizeUnsignedCount(count), count);
  assert.equal(normalizeUnsignedCount(undefined), null);
  assert.throws(() => normalizeUnsignedCount("-1"), /non-negative integer/);
});

test("BigInt calculations avoid floating point precision loss", () => {
  assert.equal(
    signedDifference("9007199254740993123", "9007199254740993000"),
    123n,
  );
  assert.equal(decimalRatio("1", "3", { multiplier: 100n }), "33.333333");
});

test("hmacAuthorKey is stable per account but hides the raw channel id", () => {
  const a = hmacAuthorKey("salt", "UCabc123");
  const b = hmacAuthorKey("salt", "UCabc123");
  const c = hmacAuthorKey("salt", "UCxyz999");
  const d = hmacAuthorKey("different-salt", "UCabc123");
  assert.equal(a, b); // same account -> same key
  assert.notEqual(a, c); // different account -> different key
  assert.notEqual(a, d); // salt changes the key
  assert.match(a, /^[0-9a-f]{64}$/); // 64-hex digest, no raw id
  assert.ok(!a.includes("UCabc123"));
  assert.equal(hmacAuthorKey("salt", null), null);
});

test("scrubPii removes emails, urls, handles, and phone numbers but keeps content", () => {
  const cleaned = scrubPii(
    "連絡は a.b@mail.com か +81 90-1234-5678、詳細は https://x.com/foo と @bar まで。すごい動画！",
  );
  assert.doesNotMatch(cleaned, /a\.b@mail\.com/);
  assert.doesNotMatch(cleaned, /https?:\/\//);
  assert.doesNotMatch(cleaned, /@bar/);
  assert.doesNotMatch(cleaned, /1234/);
  assert.match(cleaned, /すごい動画/); // real content preserved
  assert.equal(scrubPii(null), null);
});
