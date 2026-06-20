CREATE TABLE IF NOT EXISTS tracked_queries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(191) NOT NULL,
  query_text VARCHAR(500) NOT NULL,
  topic VARCHAR(191) NOT NULL,
  region_code CHAR(2) NOT NULL DEFAULT 'JP',
  relevance_language VARCHAR(16) NOT NULL DEFAULT 'ja',
  safe_search VARCHAR(16) NOT NULL DEFAULT 'moderate',
  max_results SMALLINT UNSIGNED NOT NULL DEFAULT 50,
  lookback_days SMALLINT UNSIGNED NOT NULL DEFAULT 7,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  archived_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_tracked_queries_name (name),
  CONSTRAINT chk_tracked_queries_max_results CHECK (max_results BETWEEN 1 AND 50),
  CONSTRAINT chk_tracked_queries_lookback_days CHECK (lookback_days BETWEEN 1 AND 30)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS keyword_candidates (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  candidate_text VARCHAR(191) NOT NULL,
  normalized_text VARCHAR(191) NOT NULL,
  topic VARCHAR(191) NOT NULL DEFAULT '生成AI',
  source_type VARCHAR(32) NOT NULL,
  source_ref_type VARCHAR(32) NULL,
  source_ref_id VARCHAR(191) NULL,
  source_title VARCHAR(1000) NULL,
  heat_score DECIMAL(10,4) NOT NULL DEFAULT 0,
  comment_score DECIMAL(10,4) NOT NULL DEFAULT 0,
  growth_score DECIMAL(10,4) NOT NULL DEFAULT 0,
  relevance_score DECIMAL(10,4) NOT NULL DEFAULT 0,
  freshness_score DECIMAL(10,4) NOT NULL DEFAULT 0,
  total_score DECIMAL(10,4) NOT NULL DEFAULT 0,
  reason_text VARCHAR(1000) NOT NULL,
  evidence_json JSON NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'suggested',
  tracked_query_id BIGINT UNSIGNED NULL,
  first_seen_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  last_seen_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  approved_at DATETIME(6) NULL,
  rejected_at DATETIME(6) NULL,
  archived_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_keyword_candidates_normalized (normalized_text),
  KEY idx_keyword_candidates_status_score (status, total_score),
  KEY idx_keyword_candidates_topic (topic),
  KEY idx_keyword_candidates_tracked_query (tracked_query_id),
  CONSTRAINT fk_keyword_candidates_tracked_query
    FOREIGN KEY (tracked_query_id) REFERENCES tracked_queries(id) ON DELETE SET NULL,
  CONSTRAINT chk_keyword_candidates_status
    CHECK (status IN ('suggested', 'approved', 'rejected', 'archived'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS collection_batches (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  started_at DATETIME(6) NOT NULL,
  observed_at DATETIME(6) NOT NULL,
  completed_at DATETIME(6) NULL,
  trigger_type VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL,
  estimated_quota_units INT UNSIGNED NOT NULL DEFAULT 0,
  actual_quota_units INT UNSIGNED NOT NULL DEFAULT 0,
  request_id VARCHAR(64) NULL,
  error_summary TEXT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_collection_batches_observed_at (observed_at),
  KEY idx_collection_batches_status (status),
  UNIQUE KEY uq_collection_batches_request_id (request_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS collection_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  batch_id BIGINT UNSIGNED NOT NULL,
  query_id BIGINT UNSIGNED NULL,
  run_type VARCHAR(32) NOT NULL,
  started_at DATETIME(6) NOT NULL,
  completed_at DATETIME(6) NULL,
  status VARCHAR(32) NOT NULL,
  request_count INT UNSIGNED NOT NULL DEFAULT 0,
  returned_count INT UNSIGNED NOT NULL DEFAULT 0,
  quota_units INT UNSIGNED NOT NULL DEFAULT 0,
  error_summary TEXT NULL,
  PRIMARY KEY (id),
  KEY idx_collection_runs_batch_id (batch_id),
  KEY idx_collection_runs_query_id (query_id),
  CONSTRAINT fk_collection_runs_batch
    FOREIGN KEY (batch_id) REFERENCES collection_batches(id) ON DELETE CASCADE,
  CONSTRAINT fk_collection_runs_query
    FOREIGN KEY (query_id) REFERENCES tracked_queries(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS collection_quota_usage (
  batch_id BIGINT UNSIGNED NOT NULL,
  quota_bucket VARCHAR(64) NOT NULL,
  estimated_units INT UNSIGNED NOT NULL DEFAULT 0,
  actual_units INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (batch_id, quota_bucket),
  KEY idx_collection_quota_usage_bucket (quota_bucket, batch_id),
  CONSTRAINT fk_collection_quota_usage_batch
    FOREIGN KEY (batch_id) REFERENCES collection_batches(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS channels (
  channel_id VARCHAR(64) NOT NULL,
  title VARCHAR(500) NOT NULL,
  url VARCHAR(2048) NOT NULL,
  first_seen_at DATETIME(6) NOT NULL,
  last_seen_at DATETIME(6) NOT NULL,
  is_available BOOLEAN NOT NULL DEFAULT TRUE,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (channel_id),
  KEY idx_channels_last_seen_at (last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS youtube_categories (
  category_id VARCHAR(32) NOT NULL,
  region_code CHAR(2) NOT NULL,
  title VARCHAR(255) NOT NULL,
  assignable BOOLEAN NULL,
  updated_at DATETIME(6) NOT NULL,
  PRIMARY KEY (category_id, region_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS posts (
  post_id VARCHAR(64) NOT NULL,
  channel_id VARCHAR(64) NOT NULL,
  title VARCHAR(1000) NOT NULL,
  published_at DATETIME(6) NOT NULL,
  url VARCHAR(2048) NOT NULL,
  thumbnail_url VARCHAR(2048) NULL,
  duration_seconds INT UNSIGNED NULL,
  category_id VARCHAR(32) NULL,
  default_language VARCHAR(32) NULL,
  default_audio_language VARCHAR(32) NULL,
  live_broadcast_content VARCHAR(32) NULL,
  first_seen_at DATETIME(6) NOT NULL,
  last_seen_at DATETIME(6) NOT NULL,
  is_available BOOLEAN NOT NULL DEFAULT TRUE,
  unavailable_since DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (post_id),
  KEY idx_posts_channel_id (channel_id),
  KEY idx_posts_published_at (published_at),
  KEY idx_posts_last_seen_at (last_seen_at),
  KEY idx_posts_category_id (category_id),
  CONSTRAINT fk_posts_channel
    FOREIGN KEY (channel_id) REFERENCES channels(channel_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS post_tags (
  post_id VARCHAR(64) NOT NULL,
  tag VARCHAR(500) NOT NULL,
  PRIMARY KEY (post_id, tag),
  CONSTRAINT fk_post_tags_post
    FOREIGN KEY (post_id) REFERENCES posts(post_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS comments (
  comment_id VARCHAR(128) NOT NULL,
  post_id VARCHAR(64) NOT NULL,
  author_key CHAR(64) NULL,
  parent_id VARCHAR(128) NULL,
  text_content MEDIUMTEXT NULL,
  like_count BIGINT UNSIGNED NULL,
  reply_count BIGINT UNSIGNED NULL,
  published_at DATETIME(6) NULL,
  first_seen_at DATETIME(6) NOT NULL,
  last_seen_at DATETIME(6) NOT NULL,
  batch_id BIGINT UNSIGNED NULL,
  is_available BOOLEAN NOT NULL DEFAULT TRUE,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (comment_id),
  KEY idx_comments_post_id (post_id),
  KEY idx_comments_author_key (author_key),
  KEY idx_comments_published_at (published_at),
  CONSTRAINT fk_comments_post
    FOREIGN KEY (post_id) REFERENCES posts(post_id) ON DELETE CASCADE,
  CONSTRAINT fk_comments_batch
    FOREIGN KEY (batch_id) REFERENCES collection_batches(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS post_query_matches (
  post_id VARCHAR(64) NOT NULL,
  query_id BIGINT UNSIGNED NOT NULL,
  first_matched_at DATETIME(6) NOT NULL,
  last_matched_at DATETIME(6) NOT NULL,
  first_rank SMALLINT UNSIGNED NOT NULL,
  latest_rank SMALLINT UNSIGNED NOT NULL,
  last_batch_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (post_id, query_id),
  KEY idx_post_query_matches_query_id (query_id),
  KEY idx_post_query_matches_last_matched_at (last_matched_at),
  CONSTRAINT fk_post_query_matches_post
    FOREIGN KEY (post_id) REFERENCES posts(post_id) ON DELETE CASCADE,
  CONSTRAINT fk_post_query_matches_query
    FOREIGN KEY (query_id) REFERENCES tracked_queries(id) ON DELETE CASCADE,
  CONSTRAINT fk_post_query_matches_batch
    FOREIGN KEY (last_batch_id) REFERENCES collection_batches(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS post_metric_snapshots (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  post_id VARCHAR(64) NOT NULL,
  batch_id BIGINT UNSIGNED NOT NULL,
  observed_at DATETIME(6) NOT NULL,
  views BIGINT UNSIGNED NOT NULL,
  impressions BIGINT UNSIGNED NULL,
  likes BIGINT UNSIGNED NULL,
  comments BIGINT UNSIGNED NULL,
  shares BIGINT UNSIGNED NULL,
  saves BIGINT UNSIGNED NULL,
  clicks BIGINT UNSIGNED NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_post_metric_snapshots_post_batch (post_id, batch_id),
  KEY idx_post_metric_snapshots_post_observed (post_id, observed_at),
  KEY idx_post_metric_snapshots_observed_at (observed_at),
  CONSTRAINT fk_post_metric_snapshots_post
    FOREIGN KEY (post_id) REFERENCES posts(post_id) ON DELETE CASCADE,
  CONSTRAINT fk_post_metric_snapshots_batch
    FOREIGN KEY (batch_id) REFERENCES collection_batches(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS channel_metric_snapshots (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  channel_id VARCHAR(64) NOT NULL,
  batch_id BIGINT UNSIGNED NOT NULL,
  observed_at DATETIME(6) NOT NULL,
  view_count BIGINT UNSIGNED NULL,
  subscriber_count BIGINT UNSIGNED NULL,
  hidden_subscriber_count BOOLEAN NULL,
  video_count BIGINT UNSIGNED NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_channel_metric_snapshots_channel_batch (channel_id, batch_id),
  KEY idx_channel_metric_snapshots_channel_observed (channel_id, observed_at),
  CONSTRAINT fk_channel_metric_snapshots_channel
    FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE,
  CONSTRAINT fk_channel_metric_snapshots_batch
    FOREIGN KEY (batch_id) REFERENCES collection_batches(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS query_observations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  query_id BIGINT UNSIGNED NOT NULL,
  batch_id BIGINT UNSIGNED NOT NULL,
  observed_at DATETIME(6) NOT NULL,
  returned_sample_count INT UNSIGNED NOT NULL,
  estimated_total_results BIGINT UNSIGNED NULL,
  total_results_is_approximate BOOLEAN NOT NULL DEFAULT TRUE,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_query_observations_query_batch (query_id, batch_id),
  KEY idx_query_observations_query_observed (query_id, observed_at),
  CONSTRAINT fk_query_observations_query
    FOREIGN KEY (query_id) REFERENCES tracked_queries(id) ON DELETE CASCADE,
  CONSTRAINT fk_query_observations_batch
    FOREIGN KEY (batch_id) REFERENCES collection_batches(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS popular_video_observations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  batch_id BIGINT UNSIGNED NOT NULL,
  observed_at DATETIME(6) NOT NULL,
  region_code CHAR(2) NOT NULL,
  category_id VARCHAR(32) NULL,
  post_id VARCHAR(64) NOT NULL,
  rank_position SMALLINT UNSIGNED NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_popular_video_observations_rank (batch_id, region_code, rank_position),
  UNIQUE KEY uq_popular_video_observations_post (batch_id, region_code, post_id),
  KEY idx_popular_video_observations_post_observed (post_id, observed_at),
  CONSTRAINT fk_popular_video_observations_batch
    FOREIGN KEY (batch_id) REFERENCES collection_batches(id) ON DELETE CASCADE,
  CONSTRAINT fk_popular_video_observations_post
    FOREIGN KEY (post_id) REFERENCES posts(post_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE popular_video_observations
  DROP INDEX uq_popular_video_observations_rank,
  DROP INDEX uq_popular_video_observations_post,
  ADD UNIQUE KEY uq_popular_video_observations_rank (batch_id, region_code, rank_position),
  ADD UNIQUE KEY uq_popular_video_observations_post (batch_id, region_code, post_id);

CREATE TABLE IF NOT EXISTS analysis_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  started_at DATETIME(6) NOT NULL,
  completed_at DATETIME(6) NULL,
  window_start DATETIME(6) NOT NULL,
  window_end DATETIME(6) NOT NULL,
  days INT UNSIGNED NOT NULL,
  status VARCHAR(32) NOT NULL,
  trigger_type VARCHAR(32) NOT NULL DEFAULT 'manual',
  source_batch_id BIGINT UNSIGNED NULL,
  request_id VARCHAR(64) NULL,
  parameters_json JSON NULL,
  summary_json JSON NULL,
  report_markdown LONGTEXT NULL,
  report_markdown_ja LONGTEXT NULL,
  error_summary TEXT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY idx_analysis_runs_completed_at (completed_at),
  KEY idx_analysis_runs_status (status),
  KEY idx_analysis_runs_source_batch_id (source_batch_id),
  UNIQUE KEY uq_analysis_runs_request_id (request_id),
  CONSTRAINT fk_analysis_runs_source_batch
    FOREIGN KEY (source_batch_id) REFERENCES collection_batches(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS operation_requests (
  id VARCHAR(64) NOT NULL,
  operation_type VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL,
  parameters_json JSON NULL,
  requested_at DATETIME(6) NOT NULL,
  started_at DATETIME(6) NULL,
  completed_at DATETIME(6) NULL,
  error_summary TEXT NULL,
  PRIMARY KEY (id),
  KEY idx_operation_requests_requested_at (requested_at),
  KEY idx_operation_requests_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS analysis_post_metrics (
  analysis_run_id BIGINT UNSIGNED NOT NULL,
  post_id VARCHAR(64) NOT NULL,
  earliest_observed_at DATETIME(6) NOT NULL,
  latest_observed_at DATETIME(6) NOT NULL,
  snapshot_count INT UNSIGNED NOT NULL,
  earliest_views BIGINT UNSIGNED NOT NULL,
  latest_views BIGINT UNSIGNED NOT NULL,
  views_growth_abs BIGINT NULL,
  views_growth_pct DECIMAL(18,6) NULL,
  views_growth_per_day DECIMAL(24,6) NULL,
  latest_likes BIGINT UNSIGNED NULL,
  latest_comments BIGINT UNSIGNED NULL,
  latest_reactions BIGINT UNSIGNED NULL,
  reaction_rate_pct DECIMAL(18,6) NULL,
  low_base_reaction_rate BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (analysis_run_id, post_id),
  KEY idx_analysis_post_metrics_post_id (post_id),
  KEY idx_analysis_post_metrics_latest_views (analysis_run_id, latest_views),
  CONSTRAINT fk_analysis_post_metrics_run
    FOREIGN KEY (analysis_run_id) REFERENCES analysis_runs(id) ON DELETE CASCADE,
  CONSTRAINT fk_analysis_post_metrics_post
    FOREIGN KEY (post_id) REFERENCES posts(post_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS analysis_topic_metrics (
  analysis_run_id BIGINT UNSIGNED NOT NULL,
  dimension_type VARCHAR(32) COLLATE utf8mb4_bin NOT NULL,
  dimension_value VARCHAR(500) COLLATE utf8mb4_bin NOT NULL,
  post_count INT UNSIGNED NOT NULL,
  total_views DECIMAL(30,0) NOT NULL,
  total_reactions DECIMAL(30,0) NULL,
  weighted_reaction_rate_pct DECIMAL(18,6) NULL,
  posts_with_growth_data INT UNSIGNED NOT NULL,
  posts_with_positive_growth INT UNSIGNED NOT NULL,
  total_views_growth_abs DECIMAL(30,0) NULL,
  average_views_growth_per_day DECIMAL(24,6) NULL,
  PRIMARY KEY (analysis_run_id, dimension_type, dimension_value),
  KEY idx_analysis_topic_metrics_views (analysis_run_id, total_views),
  CONSTRAINT fk_analysis_topic_metrics_run
    FOREIGN KEY (analysis_run_id) REFERENCES analysis_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE analysis_topic_metrics
  MODIFY dimension_type VARCHAR(32) COLLATE utf8mb4_bin NOT NULL,
  MODIFY dimension_value VARCHAR(500) COLLATE utf8mb4_bin NOT NULL;

CREATE TABLE IF NOT EXISTS analysis_query_metrics (
  analysis_run_id BIGINT UNSIGNED NOT NULL,
  query_id BIGINT UNSIGNED NOT NULL,
  earliest_observed_at DATETIME(6) NULL,
  latest_observed_at DATETIME(6) NULL,
  snapshot_count INT UNSIGNED NOT NULL,
  earliest_estimated_total_results BIGINT UNSIGNED NULL,
  latest_estimated_total_results BIGINT UNSIGNED NULL,
  estimated_total_results_growth_abs BIGINT NULL,
  estimated_total_results_growth_pct DECIMAL(18,6) NULL,
  matched_post_count INT UNSIGNED NOT NULL,
  sample_total_latest_views DECIMAL(30,0) NOT NULL,
  sample_total_views_growth_abs DECIMAL(30,0) NULL,
  PRIMARY KEY (analysis_run_id, query_id),
  CONSTRAINT fk_analysis_query_metrics_run
    FOREIGN KEY (analysis_run_id) REFERENCES analysis_runs(id) ON DELETE CASCADE,
  CONSTRAINT fk_analysis_query_metrics_query
    FOREIGN KEY (query_id) REFERENCES tracked_queries(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS analysis_popular_metrics (
  analysis_run_id BIGINT UNSIGNED NOT NULL,
  post_id VARCHAR(64) NOT NULL,
  appearance_count INT UNSIGNED NOT NULL,
  best_rank SMALLINT UNSIGNED NOT NULL,
  latest_rank SMALLINT UNSIGNED NOT NULL,
  first_observed_at DATETIME(6) NOT NULL,
  latest_observed_at DATETIME(6) NOT NULL,
  PRIMARY KEY (analysis_run_id, post_id),
  CONSTRAINT fk_analysis_popular_metrics_run
    FOREIGN KEY (analysis_run_id) REFERENCES analysis_runs(id) ON DELETE CASCADE,
  CONSTRAINT fk_analysis_popular_metrics_post
    FOREIGN KEY (post_id) REFERENCES posts(post_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS analysis_comment_metrics (
  analysis_run_id BIGINT UNSIGNED NOT NULL,
  dimension_type VARCHAR(32) NOT NULL,
  dimension_value VARCHAR(500) NOT NULL,
  comment_count INT UNSIGNED NOT NULL,
  distinct_authors INT UNSIGNED NOT NULL,
  positive_count INT UNSIGNED NOT NULL,
  neutral_count INT UNSIGNED NOT NULL,
  negative_count INT UNSIGNED NOT NULL,
  net_sentiment_pct DECIMAL(18,6) NULL,
  PRIMARY KEY (analysis_run_id, dimension_type, dimension_value),
  KEY idx_analysis_comment_metrics_count (analysis_run_id, comment_count),
  CONSTRAINT fk_analysis_comment_metrics_run
    FOREIGN KEY (analysis_run_id) REFERENCES analysis_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS analysis_comment_terms (
  analysis_run_id BIGINT UNSIGNED NOT NULL,
  dimension_type VARCHAR(32) NOT NULL,
  dimension_value VARCHAR(191) NOT NULL,
  sentiment_label VARCHAR(16) NOT NULL DEFAULT 'all',
  term_type VARCHAR(16) NOT NULL,
  term VARCHAR(255) COLLATE utf8mb4_bin NOT NULL,
  count INT UNSIGNED NOT NULL,
  share_pct DECIMAL(18,6) NULL,
  lift_score DECIMAL(18,6) NULL,
  PRIMARY KEY (
    analysis_run_id, dimension_type, dimension_value,
    sentiment_label, term_type, term
  ),
  KEY idx_analysis_comment_terms_rank (
    analysis_run_id, dimension_type, dimension_value,
    sentiment_label, term_type, count
  ),
  CONSTRAINT fk_analysis_comment_terms_run
    FOREIGN KEY (analysis_run_id) REFERENCES analysis_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS analysis_comment_daily_metrics (
  analysis_run_id BIGINT UNSIGNED NOT NULL,
  comment_date DATE NOT NULL,
  dimension_type VARCHAR(32) NOT NULL,
  dimension_value VARCHAR(500) NOT NULL,
  comment_count INT UNSIGNED NOT NULL,
  distinct_authors INT UNSIGNED NOT NULL,
  positive_count INT UNSIGNED NOT NULL,
  neutral_count INT UNSIGNED NOT NULL,
  negative_count INT UNSIGNED NOT NULL,
  net_sentiment_pct DECIMAL(18,6) NULL,
  PRIMARY KEY (analysis_run_id, comment_date, dimension_type, dimension_value),
  KEY idx_analysis_comment_daily_date (analysis_run_id, comment_date),
  CONSTRAINT fk_analysis_comment_daily_run
    FOREIGN KEY (analysis_run_id) REFERENCES analysis_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS skill_analysis_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  completed_at DATETIME(6) NULL,
  status VARCHAR(32) NOT NULL,
  locale VARCHAR(16) NOT NULL DEFAULT 'zh-CN',
  question TEXT NOT NULL,
  title VARCHAR(500) NOT NULL,
  source_batch_id BIGINT UNSIGNED NULL,
  source_analysis_run_id BIGINT UNSIGNED NULL,
  window_start DATETIME(6) NULL,
  window_end DATETIME(6) NULL,
  report_markdown LONGTEXT NULL,
  sections_json JSON NULL,
  charts_json JSON NULL,
  error_summary TEXT NULL,
  PRIMARY KEY (id),
  KEY idx_skill_analysis_runs_created_at (created_at),
  KEY idx_skill_analysis_runs_status (status),
  KEY idx_skill_analysis_runs_source_analysis (source_analysis_run_id),
  CONSTRAINT fk_skill_analysis_runs_source_batch
    FOREIGN KEY (source_batch_id) REFERENCES collection_batches(id) ON DELETE SET NULL,
  CONSTRAINT fk_skill_analysis_runs_source_analysis
    FOREIGN KEY (source_analysis_run_id) REFERENCES analysis_runs(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE OR REPLACE VIEW v_latest_post_metrics AS
SELECT
  p.post_id,
  p.title,
  p.channel_id,
  c.title AS channel_title,
  p.published_at,
  p.url,
  p.thumbnail_url,
  p.category_id,
  p.is_available,
  s.observed_at,
  s.views,
  s.likes,
  s.comments,
  s.shares,
  s.saves,
  s.clicks
FROM posts p
JOIN channels c ON c.channel_id = p.channel_id
JOIN (
  SELECT ranked.*
  FROM (
    SELECT
      snapshots.*,
      ROW_NUMBER() OVER (
        PARTITION BY snapshots.post_id
        ORDER BY snapshots.observed_at DESC, snapshots.id DESC
      ) AS row_num
    FROM post_metric_snapshots snapshots
  ) ranked
  WHERE ranked.row_num = 1
) s ON s.post_id = p.post_id;

CREATE OR REPLACE VIEW v_post_growth_metrics AS
SELECT
  p.post_id,
  p.title,
  p.channel_id,
  c.title AS channel_title,
  p.thumbnail_url,
  p.url,
  p.published_at,
  earliest.observed_at AS earliest_observed_at,
  latest.observed_at AS latest_observed_at,
  earliest.views AS earliest_views,
  latest.views AS latest_views,
  CAST(latest.views AS SIGNED) - CAST(earliest.views AS SIGNED) AS views_growth_abs,
  CASE
    WHEN earliest.views > 0 THEN
      (CAST(latest.views AS DECIMAL(30,6)) - CAST(earliest.views AS DECIMAL(30,6)))
      / CAST(earliest.views AS DECIMAL(30,6)) * 100
    ELSE NULL
  END AS views_growth_pct,
  CASE
    WHEN TIMESTAMPDIFF(SECOND, earliest.observed_at, latest.observed_at) > 0 THEN
      (CAST(latest.views AS DECIMAL(30,6)) - CAST(earliest.views AS DECIMAL(30,6)))
      / (TIMESTAMPDIFF(SECOND, earliest.observed_at, latest.observed_at) / 86400)
    ELSE NULL
  END AS views_growth_per_day
FROM posts p
JOIN channels c ON c.channel_id = p.channel_id
JOIN (
  SELECT ranked.*
  FROM (
    SELECT
      snapshots.*,
      ROW_NUMBER() OVER (
        PARTITION BY snapshots.post_id
        ORDER BY snapshots.observed_at ASC, snapshots.id ASC
      ) AS row_num
    FROM post_metric_snapshots snapshots
  ) ranked
  WHERE ranked.row_num = 1
) earliest ON earliest.post_id = p.post_id
JOIN (
  SELECT ranked.*
  FROM (
    SELECT
      snapshots.*,
      ROW_NUMBER() OVER (
        PARTITION BY snapshots.post_id
        ORDER BY snapshots.observed_at DESC, snapshots.id DESC
      ) AS row_num
    FROM post_metric_snapshots snapshots
  ) ranked
  WHERE ranked.row_num = 1
) latest ON latest.post_id = p.post_id;

CREATE OR REPLACE VIEW v_latest_query_metrics AS
SELECT
  q.id AS query_id,
  q.name,
  q.query_text,
  q.topic,
  q.enabled,
  q.archived_at,
  o.observed_at,
  o.returned_sample_count,
  o.estimated_total_results,
  o.total_results_is_approximate
FROM tracked_queries q
JOIN (
  SELECT ranked.*
  FROM (
    SELECT
      observations.*,
      ROW_NUMBER() OVER (
        PARTITION BY observations.query_id
        ORDER BY observations.observed_at DESC, observations.id DESC
      ) AS row_num
    FROM query_observations observations
  ) ranked
  WHERE ranked.row_num = 1
) o ON o.query_id = q.id;

CREATE OR REPLACE VIEW v_latest_popular_videos AS
SELECT
  o.region_code,
  o.category_id,
  o.rank_position,
  o.observed_at,
  p.post_id,
  p.title,
  p.channel_id,
  c.title AS channel_title,
  p.thumbnail_url,
  p.url,
  s.views,
  s.likes,
  s.comments
FROM popular_video_observations o
-- Resolve the latest batch per region/category once with a single grouped scan,
-- then join it back. The previous correlated `o.batch_id = (SELECT MAX(...) WHERE
-- region/category match)` ran that aggregate once per row (O(n^2): ~4.4k x ~4.4k
-- table scans => ~2.2s) and the `<=>` comparison blocked index use.
JOIN (
  SELECT region_code, category_id, MAX(batch_id) AS batch_id
  FROM popular_video_observations
  GROUP BY region_code, category_id
) latest
  ON latest.region_code = o.region_code
  AND latest.category_id <=> o.category_id
  AND latest.batch_id = o.batch_id
JOIN posts p ON p.post_id = o.post_id
JOIN channels c ON c.channel_id = p.channel_id
-- Fetch the latest snapshot for each of the (few) popular posts via an indexed
-- per-post lookup (idx_post_metric_snapshots_post_observed) instead of joining
-- v_latest_post_metrics, which would materialize the latest-snapshot window over
-- the entire post_metric_snapshots table (~250k rows) just to enrich ~50 rows.
LEFT JOIN LATERAL (
  SELECT s_inner.views, s_inner.likes, s_inner.comments
  FROM post_metric_snapshots s_inner
  WHERE s_inner.post_id = o.post_id
  ORDER BY s_inner.observed_at DESC, s_inner.id DESC
  LIMIT 1
) s ON TRUE;
