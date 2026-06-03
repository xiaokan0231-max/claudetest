import crypto from "node:crypto";

export function chunk(items, size) {
  const output = [];
  for (let index = 0; index < items.length; index += size) {
    output.push(items.slice(index, index + size));
  }
  return output;
}

export function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

export function toMysqlDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${value}`);
  }
  return date.toISOString().replace("T", " ").replace("Z", "000");
}

export function mysqlDateToDate(value) {
  if (value instanceof Date) {
    return value;
  }
  return new Date(`${String(value).replace(" ", "T")}Z`);
}

export function parseIsoDuration(value) {
  if (!value) {
    return null;
  }
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    value,
  );
  if (!match) {
    return null;
  }
  const [, days = "0", hours = "0", minutes = "0", seconds = "0"] = match;
  return (
    Number(days) * 86400 +
    Number(hours) * 3600 +
    Number(minutes) * 60 +
    Number(seconds)
  );
}

export function normalizeUnsignedCount(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const text = String(value);
  if (!/^\d+$/.test(text)) {
    throw new Error(`Expected a non-negative integer count, got ${text}`);
  }
  return text;
}

export function bigIntOrNull(value) {
  return value === undefined || value === null || value === ""
    ? null
    : BigInt(value);
}

export function signedDifference(latest, earliest) {
  const latestValue = bigIntOrNull(latest);
  const earliestValue = bigIntOrNull(earliest);
  if (latestValue === null || earliestValue === null) {
    return null;
  }
  return latestValue - earliestValue;
}

export function sumBigInts(values) {
  let total = 0n;
  let found = false;
  for (const value of values) {
    const parsed = bigIntOrNull(value);
    if (parsed !== null) {
      total += parsed;
      found = true;
    }
  }
  return found ? total : null;
}

export function percentage(numerator, denominator) {
  const numeratorValue = bigIntOrNull(numerator);
  const denominatorValue = bigIntOrNull(denominator);
  if (
    numeratorValue === null ||
    denominatorValue === null ||
    denominatorValue <= 0n
  ) {
    return null;
  }
  return Number(numeratorValue) / Number(denominatorValue) * 100;
}

export function decimalRatio(
  numerator,
  denominator,
  { multiplier = 1n, scale = 6 } = {},
) {
  const numeratorValue = bigIntOrNull(numerator);
  const denominatorValue = bigIntOrNull(denominator);
  if (
    numeratorValue === null ||
    denominatorValue === null ||
    denominatorValue === 0n
  ) {
    return null;
  }
  const scaleFactor = 10n ** BigInt(scale);
  const scaled =
    (numeratorValue * BigInt(multiplier) * scaleFactor) / denominatorValue;
  return scaledIntegerToDecimal(scaled, scale);
}

export function scaledIntegerToDecimal(value, scale = 6) {
  const parsed = BigInt(value);
  const negative = parsed < 0n;
  const absolute = negative ? -parsed : parsed;
  const text = absolute.toString().padStart(scale + 1, "0");
  const integerPart = text.slice(0, -scale) || "0";
  const fractionalPart = text.slice(-scale);
  return `${negative ? "-" : ""}${integerPart}.${fractionalPart}`;
}

export function decimalToScaledInteger(value, scale = 6) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value));
  if (!match) {
    throw new Error(`Invalid decimal value: ${value}`);
  }
  const [, sign, integerPart, fractionalPart = ""] = match;
  const padded = fractionalPart.padEnd(scale, "0").slice(0, scale);
  const parsed = BigInt(`${integerPart}${padded}`);
  return sign === "-" ? -parsed : parsed;
}

export function formatCount(value) {
  const parsed = bigIntOrNull(value);
  return parsed === null ? "N/A" : parsed.toLocaleString("en-US");
}

export function formatPercent(value) {
  return value === null || value === undefined
    ? "N/A"
    : `${Number(value).toFixed(2)}%`;
}

export function formatJst(value) {
  if (!value) {
    return "N/A";
  }
  const date = mysqlDateToDate(value);
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function escapeMarkdown(value) {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
}

// Pseudonymize a comment author: same account -> same key, but the raw channel
// ID cannot be recovered without the secret salt. Keyed HMAC (not a bare hash)
// so the small, enumerable channel-ID space stays non-reversible.
export function hmacAuthorKey(salt, channelId) {
  if (!channelId) {
    return null;
  }
  return crypto.createHmac("sha256", salt).update(String(channelId)).digest("hex");
}

// Remove direct identifiers users sometimes type into comment text, so stored
// text is scrubbed even though the surrounding analysis keeps the content.
export function scrubPii(text) {
  if (text === null || text === undefined) {
    return text;
  }
  return String(text)
    .replace(/[\w.+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]+/g, "[email]")
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/(?:\+?\d[\d\-\s().]{7,}\d)/g, "[phone]")
    .replace(/@[A-Za-z0-9_]{2,}/g, "[handle]");
}
