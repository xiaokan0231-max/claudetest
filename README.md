# SNS Trend Lab

> A local-first analytics workbench for Japanese YouTube trends — collect public
> data with the YouTube Data API v3, store time-series snapshots in MySQL, and
> turn them into bilingual (中文 / 日本語) growth, sentiment, and keyword-discovery
> insights. No CSV/Excel files, no data leaving your machine.

SNS Trend Lab tracks keyword searches and the Japan *mostPopular* chart over time,
materializes growth / engagement / comment-opinion metrics, suggests new keywords
to follow, watches your free-tier API quota, and serves everything through a local
React dashboard. An agent-facing **Skill** layer adds open-ended, judgment-heavy
analysis on top of the same database.

---

## Architecture

Three layers, one MySQL database (`sns_trend_lab`):

```
┌─ Frontend ── web/        React 19 + Vite + TypeScript + ECharts + i18next
│                          Dashboard, video / popular / comment / quota / report
│                          / skill-analysis / keyword pages (中文 · 日本語)
│      │ fetch /api/*   (Vite dev-proxies to :8787)
├─ Backend ─── web_api/    FastAPI (Python 3.12) + SQLAlchemy
│                          Read-only queries + delegates write actions to the CLI.
│                          Never exposes API keys, DB passwords, or raw API output.
│      │ read SQL ↑        subprocess `node src/cli.js … --json` ↓
├─ Engine ──── src/        Node.js 22 CLI (ESM)
│                          The only writer: YouTube API → MySQL, analysis,
│                          scheduling, keyword suggestions, quota planning.
│      │ YouTube Data API v3 ↑↓     MySQL ↑↓
└─ Data ────── MySQL `sns_trend_lab`   +   YouTube Data API v3 (region JP)
```

The engine is the single source of truth for writes; the web backend only reads
the database and shells out to the CLI for controlled collect / analyze / schedule
actions. The Skill reads the same materialized tables the dashboard shows.

## Features

- **Time-series collection** — keyword `search.list` + Japan `mostPopular`, stored
  as per-batch snapshots so growth is measured from real earliest-vs-latest views.
- **Growth & engagement analysis** — views growth/day, reaction rate, low-base
  flagging, per-topic / per-category / per-tag aggregation, bilingual Markdown
  reports persisted in the database.
- **Comment opinion (privacy-preserving)** — public comments stored only as
  **HMAC-pseudonymized author keys + PII-scrubbed text**; heuristic sentiment,
  daily sentiment trend, hot words / phrases / emoji / hashtags.
- **Keyword candidate discovery** — mines candidate keywords from titles, tags,
  and comment terms, scores them (heat / comment / growth / relevance / freshness),
  and offers an approve → reject → archive review workflow.
- **Quota optimizer** — models YouTube quota as two buckets (search requests/day
  vs standard units/day), tracks per-batch usage, optionally reads real
  **Google Cloud Monitoring** quota, and recommends a safe collection strategy.
- **Flexible scheduling** — a macOS `launchd` job runs collect (+ optional analyze)
  at a chosen time and frequency (once/day, or every 2h/4h/6h/12h).
- **Skill Analysis layer** — ad-hoc, structured analyses (report + sections +
  data-driven charts) saved to the database and rendered on a dedicated page.

## Tech stack

| Layer | Stack |
|---|---|
| Engine | Node.js ≥22 (ESM), `mysql2`, `dotenv`, built-in `Intl.Segmenter` (JA) |
| Backend | Python 3.12, FastAPI, SQLAlchemy, PyMySQL, uvicorn (managed with `uv`) |
| Frontend | React 19, Vite, TypeScript, ECharts, `@tanstack/react-table`, i18next, react-markdown |
| Data | MySQL 8 (`utf8mb4`), YouTube Data API v3 |

## Prerequisites

- Node.js ≥ 22, Python 3.12 + [`uv`](https://docs.astral.sh/uv/), MySQL 8 running locally, macOS (for `launchd` scheduling).
- A YouTube Data API v3 key (restrict it to that API in Google Cloud).

## Setup

1. Copy the env template and fill in **local** values (this file is git-ignored):

   ```bash
   cp .env.example .env
   # set YOUTUBE_API_KEY, MYSQL_* credentials, and a random COMMENT_HMAC_SALT
   ```

2. Install dependencies and initialize the database:

   ```bash
   npm install
   uv sync
   npm run sns -- db:init
   ```

   `db:init` is idempotent: it creates `sns_trend_lab`, the **DML-only**
   `sns_collector@localhost` user, the schema + views, and seed keywords. The
   admin connection is used only for initialization.

3. Run a collection and analysis (uses real API quota):

   ```bash
   npm run sns -- collect:estimate   # check quota cost first (free)
   npm run sns -- collect
   npm run sns -- analyze --days 30
   ```

4. Launch the local web app (build + serve on `http://127.0.0.1:8787`):

   ```bash
   npm run web
   # or, for live dev with hot reload on http://127.0.0.1:5173 :
   npm run web:dev
   ```

## CLI reference

```bash
# Database & keywords
npm run sns -- db:init
npm run sns -- query:list
npm run sns -- query:add --name <name> --query <query> --topic <topic>
npm run sns -- query:disable --name <name>

# Collection & analysis
npm run sns -- collect:estimate [--json]
npm run sns -- collect [--mode balanced|standard] [--trigger manual|scheduled|web]
npm run sns -- analyze --days 30
npm run sns -- report:show --run-id latest --lang zh|ja

# Quota & keyword discovery
npm run sns -- quota:plan [--json]
npm run sns -- keywords:suggest
npm run sns -- keywords:list [--status suggested|approved|rejected|archived|all]
npm run sns -- keywords:approve --id <id>
npm run sns -- keywords:reject  --id <id>

# Skill analyses (structured ad-hoc analysis)
npm run sns -- skill-analysis:list
npm run sns -- skill-analysis:show --run-id latest

# Scheduling (macOS launchd)
npm run sns -- schedule:install --hour 7 --minute 0 --frequency every_6h
npm run sns -- schedule:status
npm run sns -- schedule:uninstall
```

Every command accepts `--json` for machine-readable output (this is how the web
backend talks to the engine).

## Web app

`http://127.0.0.1:8787` — pages: **Overview**, **Videos**, **Popular (Japan Top)**,
**Quota**, **Comment Insights**, **Collections** (history + schedule editor),
**Reports**, **Skill Analysis**, **Keywords** (incl. candidate review). Fully
bilingual with a persisted language toggle.

## Data model (highlights)

Raw/time-series: `tracked_queries`, `collection_batches` / `collection_runs` /
`collection_quota_usage`, `channels`, `posts`, `comments`, and `*_metric_snapshots`.
Materialized analysis: `analysis_runs` (+ `analysis_post/topic/query/popular/comment_*`
metrics) and `skill_analysis_runs`. Plus `keyword_candidates` and read-only DBeaver
views `v_latest_post_metrics`, `v_post_growth_metrics`, `v_latest_query_metrics`,
`v_latest_popular_videos`.

## Privacy & safety

- **Secrets never enter git** — `.env` is git-ignored; the app reads keys/passwords
  only from the local environment and never writes them to logs, reports, the
  database, or the browser.
- **Comments are pseudonymized** — only an HMAC of the author channel ID (with a
  secret local salt) and PII-scrubbed text are stored; raw author identities are
  never persisted, and saved analyses never quote individual comments.
- **Least privilege** — the application MySQL user has DML-only grants.
- **Quota guardrails** — per-run budgets per quota bucket abort a collection before
  it would exceed your limits; `collect:estimate` previews cost.
- Treat YouTube `estimated_total_results` as a directional signal, not exact search
  volume. Sentiment is a heuristic estimate; correlation is not causation.

## Testing

```bash
npm test          # Node unit tests (local, no DB / API)
npm run test:web  # frontend (vitest + jsdom)
uv run pytest     # FastAPI backend
npm run test:db   # Node + MySQL integration (throwaway sns_trend_lab_test, mocked API)
npm run test:all  # everything
```

Tests never create real trend data — production collection requires
`npm run sns -- collect` with a valid API key.
