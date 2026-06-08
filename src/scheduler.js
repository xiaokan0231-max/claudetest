import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const LAUNCHD_LABEL = "com.kanxiao.sns-trend-lab";

export const DEFAULT_SCHEDULE = {
  hour: 7,
  minute: 0,
  frequency: "once",  // once | every_2h | every_4h | every_6h | every_12h
  mode: "balanced",
  runAnalyze: true,
  analyzeDays: 30,
};

const VALID_FREQUENCIES = ["once", "every_2h", "every_4h", "every_6h", "every_12h"];

// Returns the step in hours for a given frequency string.
function frequencyStepHours(frequency) {
  switch (frequency) {
    case "every_2h": return 2;
    case "every_4h": return 4;
    case "every_6h": return 6;
    case "every_12h": return 12;
    default: return 24; // "once"
  }
}

// Computes all HH trigger hours within 24h for a base hour and step.
export function triggerHours(baseHour, stepHours) {
  if (stepHours >= 24) return [baseHour];
  const hours = [];
  for (let h = baseHour; hours.length < 24 / stepHours; h = (h + stepHours) % 24) {
    hours.push(h);
  }
  return hours;
}

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

function parseInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (["true", "1", "yes", "on"].includes(String(value).toLowerCase())) return true;
  if (["false", "0", "no", "off"].includes(String(value).toLowerCase())) return false;
  return fallback;
}

export function normalizeScheduleOptions(options = {}) {
  const hour = parseInteger(options.hour, DEFAULT_SCHEDULE.hour);
  const minute = parseInteger(options.minute, DEFAULT_SCHEDULE.minute);
  const analyzeDays = parseInteger(options.analyzeDays ?? options["analyze-days"], DEFAULT_SCHEDULE.analyzeDays);
  if (options.mode !== undefined && !["standard", "balanced"].includes(String(options.mode))) {
    throw new Error("--mode must be standard or balanced");
  }
  const mode = options.mode === "standard" ? "standard" : "balanced";
  const runAnalyze = parseBoolean(options.runAnalyze ?? options["run-analyze"], DEFAULT_SCHEDULE.runAnalyze);
  const rawFrequency = options.frequency ?? DEFAULT_SCHEDULE.frequency;
  if (!VALID_FREQUENCIES.includes(String(rawFrequency))) {
    throw new Error(`--frequency must be one of: ${VALID_FREQUENCIES.join(", ")}`);
  }
  const frequency = String(rawFrequency);

  if (hour < 0 || hour > 23) throw new Error("--hour must be an integer from 0 to 23");
  if (minute < 0 || minute > 59) throw new Error("--minute must be an integer from 0 to 59");
  if (analyzeDays < 1 || analyzeDays > 365) throw new Error("--analyze-days must be an integer from 1 to 365");
  return { hour, minute, frequency, mode, runAnalyze, analyzeDays };
}

export function buildLaunchdCommand({
  projectRoot,
  nodePath = process.execPath,
  schedule = DEFAULT_SCHEDULE,
}) {
  const normalized = normalizeScheduleOptions(schedule);
  const commands = [
    `cd ${JSON.stringify(projectRoot)}`,
    `${JSON.stringify(nodePath)} src/cli.js collect --mode ${normalized.mode} --trigger scheduled`,
  ];
  if (normalized.runAnalyze) {
    commands.push(
      `${JSON.stringify(nodePath)} src/cli.js analyze --days ${normalized.analyzeDays} --trigger scheduled`,
    );
  }
  return commands.join(" && ");
}

function buildCalendarIntervalXml(normalized) {
  const step = frequencyStepHours(normalized.frequency);
  const hours = triggerHours(normalized.hour, step);
  const minute = normalized.minute;
  const dictItem = (h) =>
    `    <dict>\n      <key>Hour</key>\n      <integer>${h}</integer>\n      <key>Minute</key>\n      <integer>${minute}</integer>\n    </dict>`;
  if (hours.length === 1) {
    return `  <key>StartCalendarInterval</key>\n  ${dictItem(hours[0]).trimStart()}`;
  }
  return `  <key>StartCalendarInterval</key>\n  <array>\n${hours.map(dictItem).join("\n")}\n  </array>`;
}

export function buildLaunchdPlist({
  projectRoot,
  nodePath = process.execPath,
  schedule = DEFAULT_SCHEDULE,
}) {
  const { logDir } = launchdPaths();
  const normalized = normalizeScheduleOptions(schedule);
  const command = buildLaunchdCommand({ projectRoot, nodePath, schedule: normalized });

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
${buildCalendarIntervalXml(normalized)}
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

function matchInteger(xml, key, fallback) {
  const pattern = new RegExp(`<key>${key}<\\/key>\\s*<integer>(\\d+)<\\/integer>`);
  const match = xml.match(pattern);
  return match ? Number(match[1]) : fallback;
}

function commandFromPlist(xml) {
  const matches = [...xml.matchAll(/<string>([\s\S]*?)<\/string>/g)];
  return matches.length >= 3
    ? matches[2][1]
        .replaceAll("&amp;", "&")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&quot;", '"')
        .replaceAll("&apos;", "'")
    : "";
}

function detectFrequency(xml) {
  // Count <dict> entries inside StartCalendarInterval
  const arrayMatch = xml.match(/<key>StartCalendarInterval<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (arrayMatch) {
    const dictCount = (arrayMatch[1].match(/<dict>/g) ?? []).length;
    if (dictCount >= 12) return "every_2h";
    if (dictCount >= 6) return "every_4h";
    if (dictCount >= 4) return "every_6h";
    if (dictCount >= 2) return "every_12h";
  }
  return "once";
}

export async function readScheduleConfig() {
  const { plistPath } = launchdPaths();
  try {
    const xml = await fs.readFile(plistPath, "utf8");
    const command = commandFromPlist(xml);
    const mode = command.includes("collect --mode standard") ? "standard" : "balanced";
    const daysMatch = command.match(/analyze --days\s+(\d+)/);
    return normalizeScheduleOptions({
      hour: matchInteger(xml, "Hour", DEFAULT_SCHEDULE.hour),
      minute: matchInteger(xml, "Minute", DEFAULT_SCHEDULE.minute),
      frequency: detectFrequency(xml),
      mode,
      runAnalyze: Boolean(daysMatch),
      analyzeDays: daysMatch ? Number(daysMatch[1]) : DEFAULT_SCHEDULE.analyzeDays,
    });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { ...DEFAULT_SCHEDULE };
    }
    throw error;
  }
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

export async function installSchedule(config, scheduleOptions = {}) {
  if (process.platform !== "darwin") {
    throw new Error("schedule:install is supported only on macOS");
  }
  const { plistPath, logDir } = launchdPaths();
  const schedule = normalizeScheduleOptions(scheduleOptions);
  await fs.mkdir(path.dirname(plistPath), { recursive: true });
  await fs.mkdir(logDir, { recursive: true });
  await fs.writeFile(
    plistPath,
    buildLaunchdPlist({ projectRoot: config.projectRoot, schedule }),
    { mode: 0o600 },
  );
  const domain = `gui/${process.getuid()}`;
  runLaunchctl(["bootout", domain, plistPath], { ignoreFailure: true });
  runLaunchctl(["bootstrap", domain, plistPath]);
  return { plistPath, logDir, schedule };
}

export async function scheduleStatus() {
  if (process.platform !== "darwin") {
    throw new Error("schedule:status is supported only on macOS");
  }
  const target = `gui/${process.getuid()}/${LAUNCHD_LABEL}`;
  const result = runLaunchctl(["print", target], { ignoreFailure: true });
  const schedule = await readScheduleConfig();
  return {
    installed: result.status === 0,
    details: result.stdout || "",
    schedule,
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
