import { createAppPool } from "./db.js";
import { toMysqlDateTime } from "./utils.js";

const ALLOWED_CHART_TYPES = new Set([
  "bar",
  "stackedBar",
  "line",
  "scatter",
  "table",
]);
const SECTION_KEYS = [
  "facts",
  "hypotheses",
  "validationNeeds",
  "recommendations",
  "limitations",
];

function requireText(value, name, maxLength) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${name} is required`);
  if (text.length > maxLength) throw new Error(`${name} is too long`);
  if (/<\/?[a-z][\s\S]*?>/i.test(text)) {
    throw new Error(`${name} must not contain HTML`);
  }
  return text;
}

function optionalId(value, name) {
  if (value === null || value === undefined || value === "") return null;
  if (!/^\d+$/.test(String(value))) throw new Error(`${name} must be an integer ID`);
  return String(value);
}

function validateSections(value) {
  const sections = value && typeof value === "object" ? value : {};
  const output = {};
  for (const key of SECTION_KEYS) {
    const items = sections[key] ?? [];
    if (!Array.isArray(items) || items.length > 50) {
      throw new Error(`sections.${key} must be an array with at most 50 items`);
    }
    output[key] = items.map((item, index) =>
      requireText(item, `sections.${key}[${index}]`, 4000),
    );
  }
  return output;
}

function validateCharts(value) {
  const charts = value ?? [];
  if (!Array.isArray(charts) || charts.length > 8) {
    throw new Error("charts must be an array with at most 8 items");
  }
  return charts.map((chart, index) => {
    if (!chart || typeof chart !== "object") {
      throw new Error(`charts[${index}] must be an object`);
    }
    const type = String(chart.type ?? "");
    if (!ALLOWED_CHART_TYPES.has(type)) {
      throw new Error(`charts[${index}].type is not allowed`);
    }
    const rows = chart.rows ?? [];
    if (!Array.isArray(rows) || rows.length > 500) {
      throw new Error(`charts[${index}].rows must contain at most 500 rows`);
    }
    const fields = chart.fields && typeof chart.fields === "object" ? chart.fields : {};
    for (const [field, name] of Object.entries(fields)) {
      if (!["x", "y", "series", "label", "value"].includes(field)) {
        throw new Error(`charts[${index}].fields.${field} is not allowed`);
      }
      requireText(name, `charts[${index}].fields.${field}`, 128);
    }
    for (const [rowIndex, row] of rows.entries()) {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        throw new Error(`charts[${index}].rows[${rowIndex}] must be an object`);
      }
      if (Object.keys(row).length > 20) {
        throw new Error(`charts[${index}].rows[${rowIndex}] has too many fields`);
      }
      for (const [key, item] of Object.entries(row)) {
        requireText(key, `charts[${index}].rows[${rowIndex}] field`, 128);
        if (
          item !== null &&
          !["string", "number", "boolean"].includes(typeof item)
        ) {
          throw new Error(`charts[${index}].rows[${rowIndex}].${key} is invalid`);
        }
      }
    }
    return {
      type,
      title: requireText(chart.title, `charts[${index}].title`, 500),
      subtitle: chart.subtitle
        ? requireText(chart.subtitle, `charts[${index}].subtitle`, 1000)
        : "",
      fields,
      rows,
    };
  });
}

export function validateSkillAnalysis(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Skill analysis input must be an object");
  }
  const locale = input.locale === "ja-JP" || input.locale === "ja" ? "ja-JP" : "zh-CN";
  return {
    locale,
    question: requireText(input.question, "question", 10000),
    title: requireText(input.title, "title", 500),
    sourceBatchId: optionalId(input.sourceBatchId, "sourceBatchId"),
    sourceAnalysisRunId: optionalId(
      input.sourceAnalysisRunId,
      "sourceAnalysisRunId",
    ),
    windowStart: input.windowStart ? toMysqlDateTime(input.windowStart) : null,
    windowEnd: input.windowEnd ? toMysqlDateTime(input.windowEnd) : null,
    reportMarkdown: requireText(input.reportMarkdown, "reportMarkdown", 200000),
    sections: validateSections(input.sections),
    charts: validateCharts(input.charts),
  };
}

export async function saveSkillAnalysis(config, input) {
  const value = validateSkillAnalysis(input);
  const pool = createAppPool(config);
  try {
    const [result] = await pool.execute(
      `INSERT INTO skill_analysis_runs
        (completed_at, status, locale, question, title, source_batch_id,
         source_analysis_run_id, window_start, window_end, report_markdown,
         sections_json, charts_json)
       VALUES (?, 'success', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        toMysqlDateTime(new Date()),
        value.locale,
        value.question,
        value.title,
        value.sourceBatchId,
        value.sourceAnalysisRunId,
        value.windowStart,
        value.windowEnd,
        value.reportMarkdown,
        JSON.stringify(value.sections),
        JSON.stringify(value.charts),
      ],
    );
    return { id: String(result.insertId), ...value };
  } finally {
    await pool.end();
  }
}

export async function listSkillAnalyses(config) {
  const pool = createAppPool(config);
  try {
    const [rows] = await pool.query(
      `SELECT CAST(id AS CHAR) AS id, created_at, completed_at, status, locale,
              question, title, CAST(source_batch_id AS CHAR) AS source_batch_id,
              CAST(source_analysis_run_id AS CHAR) AS source_analysis_run_id,
              window_start, window_end, error_summary
       FROM skill_analysis_runs
       ORDER BY created_at DESC, id DESC
       LIMIT 100`,
    );
    return rows;
  } finally {
    await pool.end();
  }
}

export async function showSkillAnalysis(config, runId = "latest") {
  const pool = createAppPool(config);
  try {
    const [rows] =
      runId === "latest"
        ? await pool.query(
            `SELECT * FROM skill_analysis_runs
             WHERE status = 'success'
             ORDER BY created_at DESC, id DESC LIMIT 1`,
          )
        : await pool.execute(
            "SELECT * FROM skill_analysis_runs WHERE id = ? LIMIT 1",
            [runId],
          );
    if (rows.length === 0) throw new Error(`Skill analysis not found: ${runId}`);
    const row = rows[0];
    return {
      ...row,
      id: String(row.id),
      source_batch_id: row.source_batch_id ? String(row.source_batch_id) : null,
      source_analysis_run_id: row.source_analysis_run_id
        ? String(row.source_analysis_run_id)
        : null,
      sections: row.sections_json ?? {},
      charts: row.charts_json ?? [],
    };
  } finally {
    await pool.end();
  }
}
