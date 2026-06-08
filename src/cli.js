#!/usr/bin/env node

import { analyze } from "./analyzer.js";
import { collect, estimateCollection } from "./collector.js";
import { getConfig } from "./config.js";
import { createAppPool, initDatabase } from "./db.js";
import {
  approveKeywordCandidate,
  generateKeywordCandidates,
  listKeywordCandidates,
  updateKeywordCandidateStatus,
} from "./keyword-suggestions.js";
import { buildQuotaPlan } from "./quota-optimizer.js";
import {
  installSchedule,
  scheduleStatus,
  uninstallSchedule,
} from "./scheduler.js";
import {
  listSkillAnalyses,
  saveSkillAnalysis,
  showSkillAnalysis,
} from "./skill-analysis.js";

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    const next = rest[index + 1];
    if (next === undefined || next.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = next;
      index += 1;
    }
  }
  return { command, options };
}

function requireOption(options, name) {
  const value = options[name];
  if (!value || value === true) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

function printHelp() {
  console.log(`SNS Trend Lab CLI

Usage:
  npm run sns -- db:init
  npm run sns -- query:list
  npm run sns -- query:add --name <name> --query <query> --topic <topic>
  npm run sns -- query:disable --name <name>
  npm run sns -- quota:plan [--json]
  npm run sns -- keywords:suggest [--json]
  npm run sns -- keywords:list [--status suggested|approved|rejected|archived|all] [--json]
  npm run sns -- keywords:approve --id <id> [--json]
  npm run sns -- keywords:reject --id <id> [--json]
  npm run sns -- keywords:archive --id <id> [--json]
  npm run sns -- collect:estimate [--mode standard|balanced] [--json]
  npm run sns -- collect [--mode standard|balanced] [--trigger manual|scheduled|web] [--request-id <uuid>] [--json]
  npm run sns -- analyze [--days 30] [--trigger manual|scheduled|web] [--request-id <uuid>] [--json]
  npm run sns -- report:show [--run-id latest|<id>] [--lang zh|ja]
  npm run sns -- skill-analysis:save --json
  npm run sns -- skill-analysis:list [--json]
  npm run sns -- skill-analysis:show [--run-id latest|<id>] [--json]
  npm run sns -- schedule:install
    [--hour 7] [--minute 0] [--frequency once|every_12h|every_6h|every_4h|every_2h]
    [--mode standard|balanced]
    [--run-analyze true|false] [--analyze-days 30]
  npm run sns -- schedule:status
  npm run sns -- schedule:uninstall
`);
}

function printResult(options, result, message) {
  if (options.json) {
    console.log(JSON.stringify({ ok: true, result }));
  } else if (message) {
    console.log(message);
  }
}

function errorCode(error) {
  if (error?.code === "OPERATION_CONFLICT") {
    return "OPERATION_CONFLICT";
  }
  const message = String(error?.message ?? error);
  if (message.includes("YOUTUBE_API_KEY is required")) {
    return "MISSING_API_KEY";
  }
  if (
    message.includes("SNS_QUOTA_BUDGET") ||
    message.includes("SNS_SEARCH_QUOTA_BUDGET") ||
    message.includes("Estimated collection cost") ||
    message.includes("Estimated search cost")
  ) {
    return "QUOTA_BUDGET_EXCEEDED";
  }
  if (message.includes("YouTube API request failed")) {
    return "YOUTUBE_API_ERROR";
  }
  if (message.includes("required") || message.includes("must be") || message.includes("Unexpected")) {
    return "INVALID_ARGUMENT";
  }
  return "INTERNAL_ERROR";
}

async function readStdinJson() {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  if (!input.trim()) throw new Error("JSON input is required on stdin");
  try {
    return JSON.parse(input);
  } catch {
    throw new Error("stdin must contain valid JSON");
  }
}

async function queryList(config, options) {
  const pool = createAppPool(config);
  try {
    const [rows] = await pool.query(
      `SELECT id, name, query_text, topic, region_code, relevance_language,
              safe_search, max_results, lookback_days, enabled, archived_at
       FROM tracked_queries
       ORDER BY id`,
    );
    if (options.json) {
      printResult(options, rows);
    } else {
      console.table(rows);
    }
  } finally {
    await pool.end();
  }
}

async function queryAdd(config, options) {
  const name = requireOption(options, "name");
  const queryText = requireOption(options, "query");
  const topic = requireOption(options, "topic");
  const pool = createAppPool(config);
  try {
    await pool.execute(
      `INSERT INTO tracked_queries
        (name, query_text, topic, region_code, relevance_language, safe_search,
         max_results, lookback_days, enabled)
       VALUES (?, ?, ?, 'JP', 'ja', 'moderate', 50, 7, TRUE)
       ON DUPLICATE KEY UPDATE
        query_text = VALUES(query_text),
        topic = VALUES(topic),
        enabled = TRUE`,
      [name, queryText, topic],
    );
    console.log(`Enabled tracked query: ${name}`);
  } finally {
    await pool.end();
  }
}

async function queryDisable(config, options) {
  const name = requireOption(options, "name");
  const pool = createAppPool(config);
  try {
    const [result] = await pool.execute(
      "UPDATE tracked_queries SET enabled = FALSE WHERE name = ?",
      [name],
    );
    if (result.affectedRows === 0) {
      throw new Error(`Tracked query not found: ${name}`);
    }
    console.log(`Disabled tracked query: ${name}`);
  } finally {
    await pool.end();
  }
}

async function reportShow(config, options) {
  const runId = options["run-id"] || "latest";
  const language = options.lang || "zh";
  if (!["zh", "ja"].includes(language)) {
    throw new Error("--lang must be zh or ja");
  }
  const reportColumn = language === "ja" ? "report_markdown_ja" : "report_markdown";
  const pool = createAppPool(config);
  try {
    const [rows] =
      runId === "latest"
        ? await pool.query(
            `SELECT id, report_markdown, report_markdown_ja
             FROM analysis_runs
             WHERE status = 'success'
             ORDER BY completed_at DESC, id DESC
             LIMIT 1`,
          )
        : await pool.execute(
            `SELECT id, report_markdown, report_markdown_ja
             FROM analysis_runs
             WHERE id = ? AND status = 'success'
             LIMIT 1`,
            [runId],
          );
    if (rows.length === 0) {
      throw new Error(`No successful analysis report found for run: ${runId}`);
    }
    console.log(rows[0][reportColumn] || rows[0].report_markdown);
  } finally {
    await pool.end();
  }
}

function collectionMode(options) {
  const mode = options.mode || "standard";
  if (!["standard", "balanced"].includes(mode)) {
    throw new Error("--mode must be standard or balanced");
  }
  return mode;
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === "help" || command === "--help") {
    printHelp();
    return;
  }

  switch (command) {
    case "db:init": {
      const config = getConfig();
      await initDatabase(config);
      printResult(options, { database: config.db.database }, `Initialized MySQL database: ${config.db.database}`);
      break;
    }
    case "query:list":
      await queryList(getConfig(), options);
      break;
    case "query:add":
      await queryAdd(getConfig(), options);
      break;
    case "query:disable":
      await queryDisable(getConfig(), options);
      break;
    case "quota:plan": {
      const result = await buildQuotaPlan(getConfig());
      printResult(options, result, `Balanced plan: ${result.collection.enabledQueryCount} enabled keywords, ${result.candidates.recommendedApprovalCount} candidate approvals recommended.`);
      break;
    }
    case "keywords:suggest": {
      const result = await generateKeywordCandidates(getConfig());
      printResult(options, result, `Generated ${result.generatedCount} keyword candidates.`);
      break;
    }
    case "keywords:list": {
      const result = await listKeywordCandidates(getConfig(), {
        status: options.status || "suggested",
      });
      if (options.json) printResult(options, result);
      else console.table(result);
      break;
    }
    case "keywords:approve": {
      const result = await approveKeywordCandidate(
        getConfig(),
        requireOption(options, "id"),
      );
      printResult(options, result, `Approved candidate ${result.id}: ${result.candidateText}`);
      break;
    }
    case "keywords:reject": {
      const result = await updateKeywordCandidateStatus(
        getConfig(),
        requireOption(options, "id"),
        "rejected",
      );
      printResult(options, result, `Rejected candidate ${result.id}.`);
      break;
    }
    case "keywords:archive": {
      const result = await updateKeywordCandidateStatus(
        getConfig(),
        requireOption(options, "id"),
        "archived",
      );
      printResult(options, result, `Archived candidate ${result.id}.`);
      break;
    }
    case "collect:estimate": {
      const mode = collectionMode(options);
      const result = await estimateCollection(getConfig(), { mode });
      printResult(
        options,
        result,
        `Estimated ${mode} collection cost: ${result.estimatedQuotaUnits} / ${result.quotaBudget} quota units.`,
      );
      break;
    }
    case "collect": {
      const config = getConfig({ requireApiKey: true });
      const triggerType = options.trigger || "manual";
      if (!["manual", "scheduled", "web"].includes(triggerType)) {
        throw new Error("--trigger must be manual, scheduled, or web");
      }
      const result = await collect(config, {
        triggerType,
        requestId: options["request-id"] || null,
        mode: collectionMode(options),
      });
      printResult(
        options,
        result,
        `Collection batch ${result.batchId} completed: ${result.refreshedVideoCount} videos, ` +
          `${result.channelCount} channels, ${result.commentCount ?? 0} comments, ` +
          `${result.actualQuotaUnits} quota units used.`,
      );
      break;
    }
    case "analyze": {
      const days = Number.parseInt(options.days || "30", 10);
      if (!Number.isInteger(days) || days < 1) {
        throw new Error("--days must be a positive integer");
      }
      const triggerType = options.trigger || "manual";
      if (!["manual", "scheduled", "web"].includes(triggerType)) {
        throw new Error("--trigger must be manual, scheduled, or web");
      }
      const result = await analyze(getConfig(), {
        days,
        triggerType,
        requestId: options["request-id"] || null,
      });
      const output = { ...result };
      delete output.report;
      delete output.reportJa;
      printResult(
        options,
        output,
        `Analysis run ${result.analysisRunId} completed: ${result.postCount} videos, ` +
          `${result.topicCount} topic groups, ${result.queryCount} queries.`,
      );
      break;
    }
    case "report:show":
      await reportShow(getConfig(), options);
      break;
    case "skill-analysis:save": {
      const result = await saveSkillAnalysis(getConfig(), await readStdinJson());
      printResult(
        options,
        result,
        `Saved Skill analysis ${result.id}: ${result.title}`,
      );
      break;
    }
    case "skill-analysis:list": {
      const result = await listSkillAnalyses(getConfig());
      if (options.json) printResult(options, result);
      else console.table(result);
      break;
    }
    case "skill-analysis:show": {
      const result = await showSkillAnalysis(
        getConfig(),
        options["run-id"] || "latest",
      );
      printResult(options, result, result.report_markdown);
      break;
    }
    case "schedule:install": {
      const config = getConfig({ requireApiKey: true });
      const result = await installSchedule(config, {
        hour: options.hour,
        minute: options.minute,
        frequency: options.frequency,
        mode: options.mode,
        runAnalyze: options["run-analyze"],
        analyzeDays: options["analyze-days"],
      });
      const time = `${String(result.schedule.hour).padStart(2, "0")}:${String(result.schedule.minute).padStart(2, "0")}`;
      const analysis = result.schedule.runAnalyze
        ? `analyze ${result.schedule.analyzeDays} days`
        : "collect only";
      printResult(
        options,
        result,
        `Installed ${time} JST schedule (${result.schedule.mode}, ${analysis}): ${result.plistPath}\nLogs: ${result.logDir}`,
      );
      break;
    }
    case "schedule:status": {
      const result = await scheduleStatus();
      const safeResult = {
        installed: result.installed,
        plistPath: result.plistPath,
        logDir: result.logDir,
        schedule: result.schedule,
      };
      printResult(
        options,
        safeResult,
        `${result.installed ? "Schedule is installed." : "Schedule is not installed."}\nPlist: ${result.plistPath}\nLogs: ${result.logDir}`,
      );
      break;
    }
    case "schedule:uninstall": {
      const result = await uninstallSchedule();
      printResult(options, result, `Removed schedule: ${result.plistPath}`);
      break;
    }
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  const { options = {} } = (() => {
    try {
      return parseArgs(process.argv.slice(2));
    } catch {
      return {};
    }
  })();
  if (options.json) {
    console.error(
      JSON.stringify({
        ok: false,
        error: { code: errorCode(error), message: String(error.message ?? error) },
      }),
    );
  } else {
    console.error(`ERROR: ${error.message}`);
  }
  process.exitCode = 1;
});
