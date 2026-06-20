import { createAppPool, withTransaction } from "./db.js";
import { tokenize } from "./text.js";
import { mysqlDateToDate } from "./utils.js";

const RELEVANCE_TERMS = [
  "ai",
  "生成ai",
  "人工知能",
  "chatgpt",
  "llm",
  "gemini",
  "claude",
  "openai",
  "data",
  "data science",
  "データ",
  "データエンジニア",
  "機械学習",
  "自動化",
  "dx",
  "ニュース",
  "仕事",
  "転職",
  "分析",
  "プロンプト",
  "エージェント",
  "python",
  "sql",
];

const STRONG_RELEVANCE_TERMS = [
  "ai",
  "生成ai",
  "aiニュース",
  "人工知能",
  "chatgpt",
  "llm",
  "gemini",
  "claude",
  "openai",
  "データエンジニア",
  "データサイエンス",
  "データ分析",
  "データ 分析",
  "data science",
  "data scientist",
  "機械学習",
  "プロンプト",
  "エージェント",
  "python",
  "sql",
];

const BLOCKLIST = new Set([
  "ai",
  "dx",
  "ニュース",
  "仕事",
  "解説",
  "動画",
  "shorts",
  "youtube",
  "おすすめ",
  "まとめ",
  "公式",
  "今日",
  "最新",
  "無料",
  "やばい",
  "daily",
  "campaign",
  "festival",
  "データパック",
]);

const SOURCE_WEIGHT = {
  title: 1,
  tag: 0.9,
  comment_term: 0.8,
  popular_title: 1.05,
  popular_tag: 0.95,
};

function numberValue(value, fallback = 0) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

export function normalizeCandidate(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/^[#＃]+/, "")
    .replace(/["'`“”‘’]/g, "")
    .replace(/[|｜]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 191);
}

function normalizedKey(value) {
  return normalizeCandidate(value).toLocaleLowerCase("ja-JP");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function termMatches(key, term) {
  if (/^[a-z0-9+#.\s-]+$/i.test(term)) {
    return new RegExp(
      `(^|[^a-z0-9])${escapeRegExp(term)}(?=$|[^a-z0-9])`,
      "i",
    ).test(key);
  }
  return key.includes(term);
}

function containsRelevantTerm(value) {
  const key = normalizedKey(value);
  return RELEVANCE_TERMS.some((term) => termMatches(key, term));
}

function containsStrongRelevantTerm(value) {
  const key = normalizedKey(value);
  return STRONG_RELEVANCE_TERMS.some((term) => termMatches(key, term));
}

function relevanceHits(value) {
  const key = normalizedKey(value);
  return RELEVANCE_TERMS.filter((term) => termMatches(key, term)).length;
}

function classifyTopic(value, fallback = "生成AI") {
  const key = normalizedKey(value);
  if (key.includes("データ") || key.includes("sql") || key.includes("python")) {
    return "データエンジニア";
  }
  if (key.includes("ニュース") || key.includes("最新")) {
    return "AIニュース";
  }
  if (key.includes("転職") || key.includes("仕事")) {
    return "データエンジニア";
  }
  return fallback || "生成AI";
}

function isUsefulCandidate(value, existingTerms) {
  const text = normalizeCandidate(value);
  const key = normalizedKey(text);
  if (text.length < 3 || text.length > 40) {
    return false;
  }
  if (/https?:|www\.|@/.test(key)) {
    return false;
  }
  if (/^[\d\s.,:/_-]+$/.test(key)) {
    return false;
  }
  if (BLOCKLIST.has(key)) {
    return false;
  }
  if (existingTerms.has(key)) {
    return false;
  }
  return containsStrongRelevantTerm(text);
}

function splitTitleCandidates(title) {
  const normalized = normalizeCandidate(title);
  const chunks = normalized
    .split(/[\s　:：;；,，、。.!！?？/／\\()[\]{}【】「」『』〈〉《》<>]+/u)
    .map(normalizeCandidate)
    .filter(Boolean);
  const tokens = tokenize(normalized);
  const output = new Set(chunks);
  for (let start = 0; start < tokens.length; start += 1) {
    for (let size = 1; size <= 3; size += 1) {
      const phrase = tokens.slice(start, start + size).join(" ");
      if (phrase) {
        output.add(phrase);
      }
    }
  }
  return [...output];
}

export function extractKeywordCandidateTerms(text, existingTerms = new Set()) {
  return splitTitleCandidates(text).filter((term) =>
    isUsefulCandidate(term, existingTerms),
  );
}

function recencyScore(publishedAt) {
  if (!publishedAt) {
    return 45;
  }
  const date = mysqlDateToDate(publishedAt);
  const ageDays = Math.max(0, (Date.now() - date.getTime()) / 86400000);
  if (ageDays <= 7) return 100;
  if (ageDays <= 30) return 75;
  if (ageDays <= 90) return 45;
  return 20;
}

function scoreVideoCandidate(text, row, sourceType) {
  const views = numberValue(row.latest_views);
  const comments = numberValue(row.latest_comments);
  const growthPerDay = Math.max(0, numberValue(row.views_growth_per_day));
  const popularBoost = row.popular_rank ? 15 : 0;
  const sourceWeight = SOURCE_WEIGHT[sourceType] ?? 1;
  const relevance = clamp(relevanceHits(text) * 28 + containsRelevantTerm(row.topics) * 12);
  return {
    heat: clamp((Math.log10(views + 10) * 18 + popularBoost) * sourceWeight),
    comment: clamp(Math.log10(comments + 2) * 22),
    growth: clamp(Math.log10(growthPerDay + 10) * 20),
    relevance,
    freshness: recencyScore(row.published_at),
  };
}

function scoreTermCandidate(text, row) {
  const count = numberValue(row.count);
  const lift = numberValue(row.lift_score, 1);
  return {
    heat: clamp(Math.log10(count + 2) * 18),
    comment: clamp(Math.log10(count + 2) * 34 + Math.max(0, lift - 1) * 8),
    growth: 35,
    relevance: clamp(relevanceHits(text) * 30 + containsRelevantTerm(row.dimension_value) * 15),
    freshness: 65,
  };
}

// Weights MUST sum to 1. `growth` was previously computed, stored, and shown in
// the UI's five-score breakdown but carried zero weight here, so "rising-but-quiet"
// candidates — the exact opportunities the discovery loop is meant to surface —
// were systematically under-ranked. It now carries real weight.
export const SCORE_WEIGHTS = {
  heat: 0.3,
  comment: 0.25,
  growth: 0.2,
  relevance: 0.2,
  freshness: 0.05,
};

export function totalScore(scores) {
  return (
    scores.heat * SCORE_WEIGHTS.heat +
    scores.comment * SCORE_WEIGHTS.comment +
    scores.growth * SCORE_WEIGHTS.growth +
    scores.relevance * SCORE_WEIGHTS.relevance +
    scores.freshness * SCORE_WEIGHTS.freshness
  );
}

function addCandidate(map, text, candidate) {
  const normalized = normalizeCandidate(text);
  const key = normalizedKey(normalized);
  if (!normalized || !key) {
    return;
  }
  const current = map.get(key);
  const score = totalScore(candidate.scores);
  const evidence = {
    sourceType: candidate.sourceType,
    sourceRefType: candidate.sourceRefType,
    sourceRefId: candidate.sourceRefId,
    sourceTitle: candidate.sourceTitle,
    reason: candidate.reason,
    totalScore: score,
  };
  if (!current || score > current.totalScore) {
    map.set(key, {
      candidateText: normalized,
      normalizedText: key,
      topic: candidate.topic,
      sourceType: candidate.sourceType,
      sourceRefType: candidate.sourceRefType,
      sourceRefId: candidate.sourceRefId,
      sourceTitle: candidate.sourceTitle,
      heatScore: candidate.scores.heat,
      commentScore: candidate.scores.comment,
      growthScore: candidate.scores.growth,
      relevanceScore: candidate.scores.relevance,
      freshnessScore: candidate.scores.freshness,
      totalScore: score,
      reasonText: candidate.reason,
      evidence: [evidence],
    });
  } else {
    current.evidence.push(evidence);
    current.heatScore = Math.max(current.heatScore, candidate.scores.heat);
    current.commentScore = Math.max(current.commentScore, candidate.scores.comment);
    current.growthScore = Math.max(current.growthScore, candidate.scores.growth);
    current.relevanceScore = Math.max(current.relevanceScore, candidate.scores.relevance);
  }
}

async function latestAnalysisId(pool) {
  const [rows] = await pool.query(
    `SELECT id
     FROM analysis_runs
     WHERE status = 'success'
     ORDER BY completed_at DESC, id DESC
     LIMIT 1`,
  );
  return rows[0]?.id ?? null;
}

async function existingSearchTerms(pool) {
  const [rows] = await pool.query(
    `SELECT name, query_text
     FROM tracked_queries
     WHERE archived_at IS NULL`,
  );
  return new Set(
    rows.flatMap((row) => [row.name, row.query_text]).map(normalizedKey),
  );
}

async function loadVideoSources(pool, analysisRunId) {
  if (analysisRunId) {
    const [rows] = await pool.execute(
      `SELECT p.post_id, p.title, p.published_at, c.title AS channel_title,
              CAST(m.latest_views AS CHAR) AS latest_views,
              CAST(m.latest_comments AS CHAR) AS latest_comments,
              CAST(m.views_growth_per_day AS CHAR) AS views_growth_per_day,
              GROUP_CONCAT(DISTINCT pt.tag SEPARATOR '||') AS tags,
              GROUP_CONCAT(DISTINCT q.topic SEPARATOR '||') AS topics,
              MIN(pop.rank_position) AS popular_rank
       FROM analysis_post_metrics m
       JOIN posts p ON p.post_id = m.post_id
       JOIN channels c ON c.channel_id = p.channel_id
       LEFT JOIN post_tags pt ON pt.post_id = p.post_id
       LEFT JOIN post_query_matches pqm ON pqm.post_id = p.post_id
       LEFT JOIN tracked_queries q ON q.id = pqm.query_id
       LEFT JOIN v_latest_popular_videos pop ON pop.post_id = p.post_id
       WHERE m.analysis_run_id = ?
       GROUP BY p.post_id, p.title, p.published_at, c.title,
                m.latest_views, m.latest_comments, m.views_growth_per_day
       ORDER BY m.latest_views DESC
       LIMIT 500`,
      [analysisRunId],
    );
    return rows;
  }
  const [rows] = await pool.query(
    `SELECT p.post_id, p.title, p.published_at, c.title AS channel_title,
            CAST(v.views AS CHAR) AS latest_views,
            CAST(v.comments AS CHAR) AS latest_comments,
            NULL AS views_growth_per_day,
            GROUP_CONCAT(DISTINCT pt.tag SEPARATOR '||') AS tags,
            GROUP_CONCAT(DISTINCT q.topic SEPARATOR '||') AS topics,
            MIN(pop.rank_position) AS popular_rank
     FROM posts p
     JOIN channels c ON c.channel_id = p.channel_id
     LEFT JOIN v_latest_post_metrics v ON v.post_id = p.post_id
     LEFT JOIN post_tags pt ON pt.post_id = p.post_id
     LEFT JOIN post_query_matches pqm ON pqm.post_id = p.post_id
     LEFT JOIN tracked_queries q ON q.id = pqm.query_id
     LEFT JOIN v_latest_popular_videos pop ON pop.post_id = p.post_id
     WHERE p.is_available = TRUE
     GROUP BY p.post_id, p.title, p.published_at, c.title, v.views, v.comments
     ORDER BY v.views DESC
     LIMIT 500`,
  );
  return rows;
}

async function loadCommentTermSources(pool, analysisRunId) {
  if (!analysisRunId) {
    return [];
  }
  const [rows] = await pool.execute(
    `SELECT term, term_type, count, CAST(lift_score AS CHAR) AS lift_score,
            dimension_type, dimension_value, sentiment_label
     FROM analysis_comment_terms
     WHERE analysis_run_id = ?
       AND sentiment_label = 'all'
       AND term_type IN ('word', 'phrase', 'hashtag')
     ORDER BY count DESC, term
     LIMIT 250`,
    [analysisRunId],
  );
  return rows;
}

function videoReason(row, sourceType) {
  const prefix =
    sourceType === "tag" || sourceType === "popular_tag"
      ? "来自 YouTube 标签"
      : "来自视频标题";
  const popular = row.popular_rank ? `，且在日本热门榜第 ${row.popular_rank} 位` : "";
  return `${prefix}；来源视频「${row.title}」最新浏览 ${numberValue(row.latest_views).toLocaleString("en-US")}，评论 ${numberValue(row.latest_comments).toLocaleString("en-US")}${popular}。`;
}

function termReason(row) {
  const label = row.term_type === "phrase" ? "评论热门短语" : row.term_type === "hashtag" ? "评论 Hashtag" : "评论热门词";
  const dimension =
    row.dimension_type === "query_topic" ? `，关联主题「${row.dimension_value}」` : "";
  return `${label}出现 ${numberValue(row.count).toLocaleString("en-US")} 次${dimension}，可作为 AI/数据领域的探索候选。`;
}

async function persistCandidates(pool, candidates) {
  for (const item of candidates) {
    await pool.execute(
      `INSERT INTO keyword_candidates
        (candidate_text, normalized_text, topic, source_type, source_ref_type,
         source_ref_id, source_title, heat_score, comment_score, growth_score,
         relevance_score, freshness_score, total_score, reason_text,
         evidence_json, status, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'suggested',
               UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))
       ON DUPLICATE KEY UPDATE
        last_seen_at = UTC_TIMESTAMP(6),
        topic = IF(status = 'suggested', VALUES(topic), topic),
        source_type = IF(status = 'suggested', VALUES(source_type), source_type),
        source_ref_type = IF(status = 'suggested', VALUES(source_ref_type), source_ref_type),
        source_ref_id = IF(status = 'suggested', VALUES(source_ref_id), source_ref_id),
        source_title = IF(status = 'suggested', VALUES(source_title), source_title),
        heat_score = IF(status = 'suggested', VALUES(heat_score), heat_score),
        comment_score = IF(status = 'suggested', VALUES(comment_score), comment_score),
        growth_score = IF(status = 'suggested', VALUES(growth_score), growth_score),
        relevance_score = IF(status = 'suggested', VALUES(relevance_score), relevance_score),
        freshness_score = IF(status = 'suggested', VALUES(freshness_score), freshness_score),
        total_score = IF(status = 'suggested', VALUES(total_score), total_score),
        reason_text = IF(status = 'suggested', VALUES(reason_text), reason_text),
        evidence_json = IF(status = 'suggested', VALUES(evidence_json), evidence_json)`,
      [
        item.candidateText,
        item.normalizedText,
        item.topic,
        item.sourceType,
        item.sourceRefType,
        item.sourceRefId,
        item.sourceTitle,
        item.heatScore.toFixed(4),
        item.commentScore.toFixed(4),
        item.growthScore.toFixed(4),
        item.relevanceScore.toFixed(4),
        item.freshnessScore.toFixed(4),
        item.totalScore.toFixed(4),
        item.reasonText.slice(0, 1000),
        JSON.stringify(item.evidence.slice(0, 8)),
      ],
    );
  }
}

export async function generateKeywordCandidates(config, { limit = 50 } = {}) {
  const pool = createAppPool(config);
  try {
    const analysisRunId = await latestAnalysisId(pool);
    const existingTerms = await existingSearchTerms(pool);
    const videos = await loadVideoSources(pool, analysisRunId);
    const terms = await loadCommentTermSources(pool, analysisRunId);
    const candidates = new Map();

    for (const row of videos) {
      const titleSource = row.popular_rank ? "popular_title" : "title";
      for (const text of splitTitleCandidates(row.title)) {
        if (!isUsefulCandidate(text, existingTerms)) continue;
        addCandidate(candidates, text, {
          sourceType: titleSource,
          sourceRefType: "post",
          sourceRefId: row.post_id,
          sourceTitle: row.title,
          topic: classifyTopic(text, String(row.topics ?? "").split("||")[0]),
          scores: scoreVideoCandidate(text, row, titleSource),
          reason: videoReason(row, titleSource),
        });
      }
      for (const tag of String(row.tags ?? "").split("||").filter(Boolean)) {
        const sourceType = row.popular_rank ? "popular_tag" : "tag";
        if (!isUsefulCandidate(tag, existingTerms)) continue;
        addCandidate(candidates, tag, {
          sourceType,
          sourceRefType: "post",
          sourceRefId: row.post_id,
          sourceTitle: row.title,
          topic: classifyTopic(tag, String(row.topics ?? "").split("||")[0]),
          scores: scoreVideoCandidate(tag, row, sourceType),
          reason: videoReason(row, sourceType),
        });
      }
    }

    for (const row of terms) {
      if (!isUsefulCandidate(row.term, existingTerms)) continue;
      addCandidate(candidates, row.term, {
        sourceType: "comment_term",
        sourceRefType: row.dimension_type,
        sourceRefId: row.dimension_value,
        sourceTitle: row.dimension_value,
        topic: classifyTopic(row.term, row.dimension_value),
        scores: scoreTermCandidate(row.term, row),
        reason: termReason(row),
      });
    }

    const ranked = [...candidates.values()]
      .sort(
        (left, right) =>
          right.totalScore - left.totalScore ||
          left.candidateText.localeCompare(right.candidateText, "ja"),
      )
      .slice(0, limit);
    await persistCandidates(pool, ranked);
    const items = await listKeywordCandidates(config, { status: "suggested", limit });
    return {
      generatedCount: ranked.length,
      analysisRunId: analysisRunId ? String(analysisRunId) : null,
      items,
    };
  } finally {
    await pool.end();
  }
}

export async function listKeywordCandidates(
  config,
  { status = null, limit = 100 } = {},
) {
  const pool = createAppPool(config);
  try {
    const params = [];
    let where = "";
    if (status && status !== "all") {
      where = "WHERE status = ?";
      params.push(status);
    }
    params.push(Number(limit));
    const [rows] = await pool.query(
      `SELECT CAST(id AS CHAR) AS id, candidate_text, normalized_text, topic,
              source_type, source_ref_type, source_ref_id, source_title,
              CAST(heat_score AS CHAR) AS heat_score,
              CAST(comment_score AS CHAR) AS comment_score,
              CAST(growth_score AS CHAR) AS growth_score,
              CAST(relevance_score AS CHAR) AS relevance_score,
              CAST(freshness_score AS CHAR) AS freshness_score,
              CAST(total_score AS CHAR) AS total_score,
              reason_text, evidence_json, status,
              CAST(tracked_query_id AS CHAR) AS tracked_query_id,
              first_seen_at, last_seen_at, approved_at, rejected_at, archived_at
       FROM keyword_candidates
       ${where}
       ORDER BY FIELD(status, 'suggested', 'approved', 'rejected', 'archived'),
                total_score DESC, last_seen_at DESC
       LIMIT ?`,
      params,
    );
    return rows.map((row) => ({
      ...row,
      evidence: typeof row.evidence_json === "string"
        ? JSON.parse(row.evidence_json || "[]")
        : row.evidence_json ?? [],
      evidence_json: undefined,
    }));
  } finally {
    await pool.end();
  }
}

export async function approveKeywordCandidate(config, id) {
  const pool = createAppPool(config);
  try {
    return await withTransaction(pool, async (connection) => {
      const [rows] = await connection.execute(
        `SELECT *
         FROM keyword_candidates
         WHERE id = ?
         LIMIT 1`,
        [id],
      );
      const candidate = rows[0];
      if (!candidate) {
        throw new Error(`Keyword candidate not found: ${id}`);
      }
      if (candidate.status === "rejected" || candidate.status === "archived") {
        throw new Error(`Keyword candidate ${id} is ${candidate.status}`);
      }
      const [existing] = await connection.execute(
        `SELECT id
         FROM tracked_queries
         WHERE query_text = ? AND archived_at IS NULL
         LIMIT 1`,
        [candidate.candidate_text],
      );
      let trackedQueryId = existing[0]?.id ?? null;
      if (trackedQueryId) {
        await connection.execute(
          `UPDATE tracked_queries
           SET enabled = TRUE, max_results = 50, lookback_days = 7
           WHERE id = ?`,
          [trackedQueryId],
        );
      } else {
        let name = candidate.candidate_text;
        const [nameRows] = await connection.execute(
          "SELECT 1 FROM tracked_queries WHERE name = ? LIMIT 1",
          [name],
        );
        if (nameRows.length > 0) {
          name = `${candidate.candidate_text} #${candidate.id}`;
        }
        const [result] = await connection.execute(
          `INSERT INTO tracked_queries
            (name, query_text, topic, region_code, relevance_language,
             safe_search, max_results, lookback_days, enabled)
           VALUES (?, ?, ?, 'JP', 'ja', 'moderate', 50, 7, TRUE)`,
          [name, candidate.candidate_text, candidate.topic],
        );
        trackedQueryId = result.insertId;
      }
      await connection.execute(
        `UPDATE keyword_candidates
         SET status = 'approved', tracked_query_id = ?, approved_at = UTC_TIMESTAMP(6)
         WHERE id = ?`,
        [trackedQueryId, id],
      );
      return {
        id: String(id),
        candidateText: candidate.candidate_text,
        trackedQueryId: String(trackedQueryId),
        status: "approved",
      };
    });
  } finally {
    await pool.end();
  }
}

export async function updateKeywordCandidateStatus(config, id, status) {
  if (!["suggested", "rejected", "archived"].includes(status)) {
    throw new Error("--status must be suggested, rejected, or archived");
  }
  const pool = createAppPool(config);
  try {
    const [result] = await pool.execute(
      `UPDATE keyword_candidates
       SET status = ?,
           rejected_at = CASE WHEN ? = 'rejected' THEN UTC_TIMESTAMP(6) ELSE rejected_at END,
           archived_at = CASE WHEN ? = 'archived' THEN UTC_TIMESTAMP(6) ELSE archived_at END
       WHERE id = ?`,
      [status, status, status, id],
    );
    if (result.affectedRows === 0) {
      throw new Error(`Keyword candidate not found: ${id}`);
    }
    return { id: String(id), status };
  } finally {
    await pool.end();
  }
}
