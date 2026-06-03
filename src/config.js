import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

export const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

dotenv.config({ path: path.join(PROJECT_ROOT, ".env"), quiet: true });

function integerEnv(name, fallback, { min = 0 } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be an integer greater than or equal to ${min}`);
  }
  return value;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function getConfig({ requireApiKey = false } = {}) {
  const youtubeApiKey = process.env.YOUTUBE_API_KEY ?? "";
  if (requireApiKey && !youtubeApiKey) {
    throw new Error(
      "YOUTUBE_API_KEY is required. Add a YouTube Data API v3 key to .env.",
    );
  }

  return {
    projectRoot: PROJECT_ROOT,
    youtubeApiKey,
    timezone: process.env.SNS_TIMEZONE || "Asia/Tokyo",
    quotaBudget: integerEnv("SNS_QUOTA_BUDGET", 1000, { min: 1 }),
    activeWindowDays: integerEnv("SNS_ACTIVE_WINDOW_DAYS", 30, { min: 1 }),
    commentFetch: {
      enabled: (process.env.SNS_COLLECT_COMMENTS || "false").toLowerCase() === "true",
      salt: process.env.COMMENT_HMAC_SALT || "",
      maxVideos: integerEnv("SNS_COMMENT_MAX_VIDEOS", 20, { min: 1 }),
      maxCommentsPerVideo: integerEnv("SNS_COMMENT_MAX_PER_VIDEO", 200, { min: 1 }),
      maxPages: integerEnv("SNS_COMMENT_MAX_PAGES", 2, { min: 1 }),
      order: process.env.SNS_COMMENT_ORDER || "relevance",
    },
    db: {
      host: process.env.MYSQL_HOST || "localhost",
      port: integerEnv("MYSQL_PORT", 3306, { min: 1 }),
      database: process.env.MYSQL_DATABASE || "sns_trend_lab",
      user: process.env.MYSQL_USER || "sns_collector",
      password: requiredEnv("MYSQL_PASSWORD"),
    },
    adminDb: {
      host: process.env.MYSQL_HOST || "localhost",
      port: integerEnv("MYSQL_PORT", 3306, { min: 1 }),
      user: process.env.MYSQL_ADMIN_USER || "root",
      password: process.env.MYSQL_ADMIN_PASSWORD || "",
    },
  };
}

export function assertSqlIdentifier(value, label) {
  if (!/^[A-Za-z0-9_]+$/.test(value)) {
    throw new Error(`${label} must contain only letters, digits, and underscores`);
  }
  return value;
}
