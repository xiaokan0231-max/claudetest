import test from "node:test";
import assert from "node:assert/strict";

import { buildLaunchdPlist } from "../src/scheduler.js";

test("launchd plist runs collection and analysis daily at 07:00 without secrets", () => {
  const plist = buildLaunchdPlist({
    projectRoot: "/tmp/sns-trend-lab",
    nodePath: "/usr/local/bin/node",
  });

  assert.match(plist, /<key>Hour<\/key>\s*<integer>7<\/integer>/);
  assert.match(plist, /<key>Minute<\/key>\s*<integer>0<\/integer>/);
  assert.match(plist, /collect --trigger scheduled/);
  assert.match(plist, /analyze --days 30/);
  assert.doesNotMatch(plist, /YOUTUBE_API_KEY|MYSQL_PASSWORD|not-a-real-key/);
});
