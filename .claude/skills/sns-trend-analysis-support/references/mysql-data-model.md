# sns_trend_lab MySQL Data Model

All business timestamps are stored as UTC `DATETIME(6)` and should be presented in JST. YouTube IDs are strings. Public counters use `BIGINT UNSIGNED`; avoid JavaScript `Number` conversion.

## Collection Control

| Table | Purpose |
| --- | --- |
| `tracked_queries` | Enabled Japanese keyword searches and topics |
| `collection_batches` | One complete collection attempt |
| `collection_runs` | Per-query and per-resource API step status |

## Raw Content and Snapshots

| Table | Purpose |
| --- | --- |
| `channels` | Public channel metadata |
| `channel_metric_snapshots` | Subscriber, view, and video-count snapshots |
| `posts` | YouTube video metadata and availability |
| `post_tags` | Public video tags |
| `post_query_matches` | Video-to-keyword relationships |
| `post_metric_snapshots` | View, like, and comment snapshots; unsupported metrics remain `NULL` |
| `comments` | Pseudonymized public comments: HMAC `author_key` (no raw ID/name) + PII-scrubbed `text_content` |
| `query_observations` | Returned sample count and approximate result count |
| `popular_video_observations` | Japan `mostPopular` ranking snapshots |
| `youtube_categories` | Japan video category names |

## Materialized Analysis

| Table | Purpose |
| --- | --- |
| `analysis_runs` | Analysis window, status, parameters, and Markdown report body |
| `analysis_post_metrics` | Latest video metrics and growth calculations |
| `analysis_topic_metrics` | Query topic, category, and tag aggregations |
| `analysis_query_metrics` | Approximate result-count movement and sample performance |
| `analysis_popular_metrics` | Popular-chart rank and persistence |

## DBeaver Views

| View | Use |
| --- | --- |
| `v_latest_post_metrics` | Latest public metrics per available video snapshot |
| `v_post_growth_metrics` | Earliest-to-latest video view growth |
| `v_latest_query_metrics` | Latest approximate keyword result count |
| `v_latest_popular_videos` | Latest Japan popular-chart snapshot |

Prefer these views for quick inspection. Use materialized analysis tables when the user asks about a specific analysis run.
