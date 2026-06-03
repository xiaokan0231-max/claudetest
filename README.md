# SNS Trend Lab

Collect public YouTube trend data into a local MySQL database and analyze growth
without CSV or Excel files.

## Setup

1. Enable YouTube Data API v3 in Google Cloud and create an API key restricted to
   that API.
2. Put the key in the local `.env` as `YOUTUBE_API_KEY`. Do not commit or paste
   the key into logs, reports, or database records.
3. Install dependencies and initialize the database:

```bash
npm install
npm run sns -- db:init
```

`db:init` creates `sns_trend_lab`, the DML-only `sns_collector@localhost` user,
the schema and views, and the default queries `生成AI`, `AIニュース`, and
`データエンジニア`. It is safe to run repeatedly and does not modify
`mensetsu_dojo`.

## Commands

```bash
npm run sns -- db:init
npm run sns -- query:list
npm run sns -- query:add --name "新しいキーワード" --query "新しいキーワード" --topic "topic"
npm run sns -- query:disable --name "新しいキーワード"
npm run sns -- collect
npm run sns -- analyze --days 30
npm run sns -- report:show --run-id latest
npm run sns -- schedule:install
npm run sns -- schedule:status
npm run sns -- schedule:uninstall
```

The default collection targets Japan (`JP`), prefers Japanese (`ja`), stores
daily snapshots for active videos, and keeps all structured data and report
history in the `sns_trend_lab` MySQL database.

The launchd schedule runs at 07:00 local system time. Keep the Mac timezone set
to `Asia/Tokyo` for a 07:00 JST run.

## DBeaver

Refresh the existing local MySQL connection and open `sns_trend_lab`. These
read-only views are intended for quick inspection:

```text
v_latest_post_metrics
v_post_growth_metrics
v_latest_query_metrics
v_latest_popular_videos
```

Markdown report history is stored in `analysis_runs.report_markdown`.
Japanese report history is stored in `analysis_runs.report_markdown_ja`.

## Local Web Workspace

The local-only web workspace uses FastAPI for the backend and React for the
frontend. It reads the same `sns_trend_lab` MySQL database and invokes the
existing Node CLI for controlled collection, analysis, and schedule actions.

```bash
uv sync
npm run web:dev
```

Open `http://127.0.0.1:5173` during development. To build and run the
production-style local server on `127.0.0.1:8787`:

```bash
npm run web
```

The workspace supports Chinese and Japanese, remembers the selected language,
and never exposes the YouTube API key, MySQL password, raw `launchctl` output,
or full YouTube API responses to the browser.

## Tests

```bash
npm test
npm run test:web
uv run pytest
npm run test:db
```

`npm test` is fully local. `npm run test:db` uses a temporary
`sns_trend_lab_test` database and mocked YouTube API responses to verify MySQL
persistence, snapshot growth, missing metrics, and unavailable-video handling.
The test database is removed afterward. Neither command creates real trend data;
production collection requires `npm run sns -- collect` with a valid API key.
