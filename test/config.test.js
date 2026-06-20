import test from "node:test";
import assert from "node:assert/strict";

import { getConfig } from "../src/config.js";

// getConfig reads process.env; save/restore the keys these tests mutate.
function withEnv(overrides, fn) {
  const keys = Object.keys(overrides);
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("comment salt is only enforced when a command opts in", () => {
  withEnv(
    {
      MYSQL_PASSWORD: "x",
      SNS_COLLECT_COMMENTS: "true",
      COMMENT_HMAC_SALT: "short",
    },
    () => {
      // Read-only commands load fine even with a weak salt.
      assert.doesNotThrow(() => getConfig());
      // The collect path opts in and fails closed.
      assert.throws(
        () => getConfig({ requireCommentSalt: true }),
        /COMMENT_HMAC_SALT must be at least/,
      );
    },
  );
});

test("a strong salt passes the opt-in check, and disabled comments never throw", () => {
  withEnv(
    {
      MYSQL_PASSWORD: "x",
      SNS_COLLECT_COMMENTS: "true",
      COMMENT_HMAC_SALT: "0123456789abcdef0123",
    },
    () => {
      assert.doesNotThrow(() => getConfig({ requireCommentSalt: true }));
    },
  );
  withEnv(
    {
      MYSQL_PASSWORD: "x",
      SNS_COLLECT_COMMENTS: "false",
      COMMENT_HMAC_SALT: undefined,
    },
    () => {
      assert.doesNotThrow(() => getConfig({ requireCommentSalt: true }));
    },
  );
});
