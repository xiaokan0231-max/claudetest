import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const LAUNCHD_LABEL = "com.kanxiao.sns-trend-lab";

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function launchdPaths() {
  const home = os.homedir();
  return {
    plistPath: path.join(
      home,
      "Library",
      "LaunchAgents",
      `${LAUNCHD_LABEL}.plist`,
    ),
    logDir: path.join(home, "Library", "Logs", "sns-trend-lab"),
  };
}

export function buildLaunchdPlist({ projectRoot, nodePath = process.execPath }) {
  const { logDir } = launchdPaths();
  const command = [
    `cd ${JSON.stringify(projectRoot)}`,
    `${JSON.stringify(nodePath)} src/cli.js collect --trigger scheduled`,
    `${JSON.stringify(nodePath)} src/cli.js analyze --days 30 --trigger scheduled`,
  ].join(" && ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>${xmlEscape(command)}</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>7</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(logDir, "stdout.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(logDir, "stderr.log"))}</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
`;
}

function runLaunchctl(args, { ignoreFailure = false } = {}) {
  const result = spawnSync("launchctl", args, {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (!ignoreFailure && result.status !== 0) {
    throw new Error(
      `launchctl ${args[0]} failed: ${result.stderr || result.stdout || "unknown error"}`,
    );
  }
  return result;
}

export async function installSchedule(config) {
  if (process.platform !== "darwin") {
    throw new Error("schedule:install is supported only on macOS");
  }
  const { plistPath, logDir } = launchdPaths();
  await fs.mkdir(path.dirname(plistPath), { recursive: true });
  await fs.mkdir(logDir, { recursive: true });
  await fs.writeFile(
    plistPath,
    buildLaunchdPlist({ projectRoot: config.projectRoot }),
    { mode: 0o600 },
  );
  const domain = `gui/${process.getuid()}`;
  runLaunchctl(["bootout", domain, plistPath], { ignoreFailure: true });
  runLaunchctl(["bootstrap", domain, plistPath]);
  return { plistPath, logDir };
}

export function scheduleStatus() {
  if (process.platform !== "darwin") {
    throw new Error("schedule:status is supported only on macOS");
  }
  const target = `gui/${process.getuid()}/${LAUNCHD_LABEL}`;
  const result = runLaunchctl(["print", target], { ignoreFailure: true });
  return {
    installed: result.status === 0,
    details: result.stdout || "",
    ...launchdPaths(),
  };
}

export async function uninstallSchedule() {
  if (process.platform !== "darwin") {
    throw new Error("schedule:uninstall is supported only on macOS");
  }
  const { plistPath } = launchdPaths();
  const domain = `gui/${process.getuid()}`;
  runLaunchctl(["bootout", domain, plistPath], { ignoreFailure: true });
  await fs.rm(plistPath, { force: true });
  return { plistPath };
}
