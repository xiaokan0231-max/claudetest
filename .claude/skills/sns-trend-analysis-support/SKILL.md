---
name: sns-trend-analysis-support
description: Analyze Japanese YouTube trend data stored in the local sns_trend_lab MySQL database and give evidence-based, non-causal recommendations. Use for open-ended, natural-language analysis that the SNS Trend Lab web dashboard has no pre-built view for — comparing keyword topics or videos across an analysis window, explaining why one video out-performed another, drafting Chinese or Japanese 企画・改善提案, or driving collection/analysis through the Node CLI. Reads the same materialized analysis tables the web app shows, and triggers YouTube Data API v3 collection/analysis via the CLI only when fresh data is needed.
---

# SNS Trend Analysis Support

This skill is the **agentic analysis layer** of SNS Trend Lab. The project also ships a local web dashboard (FastAPI + React) for routine viewing; this skill handles the open-ended, judgment-heavy work that has no pre-built button.

`sns_trend_lab` (local MySQL) is the only data source. Do not generate or analyze CSV, Excel, or JSON data files. Never request, print, store, or expose API keys, database passwords, or the comment HMAC salt — the CLI reads them from the local `.env`.

## Division of labor (read this first)

- **Web dashboard** = fixed views: KPIs, charts, video / popular / collection tables, report viewer, keyword CRUD. It answers questions someone already built a control for.
- **This skill** = everything the dashboard cannot pre-build: ad-hoc cross-slice comparison, "why did X grow vs Y", synthesizing recommendations, rewriting findings for a specific audience or language, and orchestrating the CLI by natural language.

Collection and analysis can be triggered from **either** the web app **or** the CLI — both write to the same `sns_trend_lab`. Prefer reading already-materialized results over recomputing, so your answers stay consistent with the dashboard.

## Reading results (default path)

Read [references/mysql-data-model.md](references/mysql-data-model.md) before writing SQL. For most questions, query the **materialized tables of the latest successful analysis run** instead of recomputing:

- `analysis_runs` — run window, status, `report_markdown` (zh-CN), `report_markdown_ja` (ja-JP), and `summary_json` (bilingual facts / hypotheses / validation needs / recommendations / limitations).
- `analysis_post_metrics`, `analysis_topic_metrics`, `analysis_query_metrics`, `analysis_popular_metrics` — per-video, per-topic, per-keyword, and per-chart metrics.
- Views `v_latest_post_metrics`, `v_post_growth_metrics`, `v_latest_query_metrics`, `v_latest_popular_videos` for quick latest-state lookups.

Read [references/metrics-and-analysis.md](references/metrics-and-analysis.md) before interpreting results, and [references/report-template.md](references/report-template.md) when drafting business-facing analysis.

## Running the pipeline (only when fresh data is needed)

Work from the project root (contains `package.json` and `src/cli.js`). Every command accepts `--json` for machine-readable output.

```bash
npm run sns -- collect:estimate                       # check quota cost before collecting
npm run sns -- collect                                # gather a new snapshot
npm run sns -- analyze --days 30                      # rebuild materialized metrics + bilingual report
npm run sns -- report:show --run-id latest --lang ja  # show a stored report (zh | ja)
```

Query and schedule management:

```bash
npm run sns -- query:list
npm run sns -- query:add --name <name> --query <query> --topic <topic>
npm run sns -- query:disable --name <name>
npm run sns -- schedule:status
```

Run `schedule:install` only after confirming a valid YouTube Data API v3 key in `.env`; the launchd job runs collect + analyze daily at 07:00 local time (keep the Mac on JST). `collect` and `analyze` are single-flight via a MySQL lock — if one is already running you get `OPERATION_CONFLICT`; wait rather than retry blindly.

## Operating rules (the core value of this skill)

- Treat `estimated_total_results` as an approximate directional signal, never exact search volume.
- Define reactions as `likes + comments` only when both are present; preserve missing metrics as `NULL`, never zero-fill. YouTube does not expose shares, saves, clicks, watch time, or traffic sources here.
- Compare a video's earliest vs latest snapshot; prefer daily growth when observation windows differ; flag low-base (under 100 views) reaction rates.
- Use keyword topic, category, tag, channel scale, and popular-chart persistence as possible context — **correlation is not causation**.
- Always separate **data-supported facts / reasonable hypotheses / still-to-validate** items.
- Frame recommendations as: Action → Evidence → Expected signal → Validation method.
- Disclose the YouTube Shorts `viewCount` definition change effective 2025-03-31.
- Comments: store public comment text only as pseudonymized opinion data — the HMAC-hashed `author_key` (never the raw channel ID, display name, or avatar) and PII-scrubbed `text_content`. Treat comments as a self-selected, biased sample (commenters, not all viewers, and only within the videos your keywords surface); sentiment is interpretation, not ground truth. Honor deletions and a retention window; do not store unnecessary personal information.

## Example tasks this skill is for

- "Compare 生成AI vs データエンジニア over the last 30 days — which is worth investing in, with evidence and a way to validate it?"
- "Why did this video outgrow that one? What can and can't I conclude from public data?"
- "Rewrite the latest report's improvement suggestions as a Japanese email to my manager."
- "Add the keyword 'Vtuber', run a collection, and summarize what came back."

## Output requirements

When responding in chat, state:

- Data source: YouTube Data API v3 via `sns_trend_lab`.
- Observation or analysis time in JST.
- Whether a new collection was run, and the local quota budget.
- Missing public metrics and other important limitations.
- Which statements are facts, which are hypotheses, and what still needs validation.

Reports are stored in `analysis_runs.report_markdown` and `analysis_runs.report_markdown_ja`; do not write report files.
