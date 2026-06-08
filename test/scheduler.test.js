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
  assert.match(plist, /collect --mode balanced --trigger scheduled/);
  assert.match(plist, /analyze --days 30/);
  assert.doesNotMatch(plist, /YOUTUBE_API_KEY|MYSQL_PASSWORD|not-a-real-key/);
});

test("launchd plist supports custom schedule options", () => {
  const plist = buildLaunchdPlist({
    projectRoot: "/tmp/sns-trend-lab",
    nodePath: "/usr/local/bin/node",
    schedule: {
      hour: 22,
      minute: 45,
      mode: "standard",
      runAnalyze: false,
      analyzeDays: 7,
    },
  });

  assert.match(plist, /<key>Hour<\/key>\s*<integer>22<\/integer>/);
  assert.match(plist, /<key>Minute<\/key>\s*<integer>45<\/integer>/);
  assert.match(plist, /collect --mode standard --trigger scheduled/);
  assert.doesNotMatch(plist, /analyze --days/);
});

test("launchd plist supports repeated daily intervals", () => {
  const plist = buildLaunchdPlist({
    projectRoot: "/tmp/sns-trend-lab",
    nodePath: "/usr/local/bin/node",
    schedule: {
      hour: 7,
      minute: 15,
      frequency: "every_6h",
      mode: "balanced",
      runAnalyze: true,
      analyzeDays: 90,
    },
  });

  assert.match(plist, /<key>StartCalendarInterval<\/key>\s*<array>/);
  assert.match(plist, /<integer>7<\/integer>/);
  assert.match(plist, /<integer>13<\/integer>/);
  assert.match(plist, /<integer>19<\/integer>/);
  assert.match(plist, /<integer>1<\/integer>/);
  assert.match(plist, /analyze --days 90/);
});
