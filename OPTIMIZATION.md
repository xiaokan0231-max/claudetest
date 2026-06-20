# Optimization roadmap

Tracker for the code- and product-level improvements identified in a multi-lens
review (reliability, data quality, product, performance, privacy, strategy).
Status: ✅ done · 🔜 planned · 🚫 declined (with reason).

## Wave 1 — correctness, reliability & privacy (✅ done)

Bounded, verified-bug fixes. All covered by tests; all four suites pass.

- ✅ **Search.list quota cost corrected (100×).** `QUOTA_COSTS.searchList` modeled a
  search as 1 unit, but YouTube bills 100. Search now charges its real 100 standard
  units to the standard pool while still counting as one request in the search bucket;
  `SNS_QUOTA_BUDGET` default recalibrated 1000 → 10000 (the real free-tier daily quota)
  so honest accounting doesn't block collection. `src/youtube.js`, `src/config.js`,
  `.env.example`.
- ✅ **Keyword-discovery growth weight.** `totalScore` summed heat/comment/relevance/
  freshness (=1.0) and ignored the `growth` sub-score it computes and shows in the UI.
  Weights are now an exported constant including `growth` (sums to 1), so rising-but-quiet
  candidates rank. `src/keyword-suggestions.js`.
- ✅ **Negation-aware sentiment.** Substring counting scored 不好看 / 好きじゃない /
  "not good" as positive. Added a negation pass that flips negated positives.
  `src/sentiment.js`.
- ✅ **Low-base reaction-rate null bug.** `null < 100n` coerced missing views to "low
  base"; now only a real `< 100` is flagged. `src/analyzer.js`.
- ✅ **Self-healing collection.** A crash left `operation_requests` stuck `running`,
  and the single-active guard then 409'd every future web collect/analyze. Added a
  FastAPI startup reconciler + a Node batch reaper (run inside the collect advisory
  lock). `web_api/tasks.py`, `web_api/main.py`, `src/collector.js`, `src/db.js`.
- ✅ **Privacy: fail-closed salt.** Empty/short `COMMENT_HMAC_SALT` silently degraded
  author pseudonymization to a reversible hash; config now refuses to load with comment
  collection enabled and a salt under 16 chars. `src/config.js`.
- ✅ **Flaky test fixed.** `test_dashboard_and_default_video_scope` asserted collection
  and analysis are always in sync (broke on every collect); now asserts the true subset
  invariant. `web_api/tests/test_api.py`.
- ✅ **LICENSE + "before you publish" checklist.** `LICENSE` (MIT), `README.md`.
- ✅ **Dashboard view perf** (earlier): `v_latest_popular_videos` 6s → 0.1s. `sql/schema.sql`.
- ✅ **Collection proxy fix** (earlier): Node fetch now honors `SNS_HTTPS_PROXY`.
  `src/proxy.js`, `src/cli.js`.

## Wave 2 — product differentiation (🔜 planned)

- 🔜 **Movers radar.** Run-over-run / window-over-window deltas (new / risen / fallen
  topics, keywords, popular entrants) — the project's real moat vs point-in-time tools.
  Prereq: replace the 2-point growth slope with a window-aware OLS rate + low-confidence
  flag so deltas are trustworthy.
- 🔜 **Activate channel data.** `channel_metric_snapshots` is collected every batch but
  never analyzed or surfaced (no `analysis_channel_metrics`, no `/api/channels`, no page).
  Add channel velocity ("which creators are rising").
- 🔜 **Cheaper, more complete discovery.** Add a channel-uploads (`playlistItems`, 1 unit)
  feed to catch tracked creators' new videos without spending a 100-unit search.
- 🔜 **Alerting / "what changed".** The tool is passive; add a signals feed on the Movers
  foundation (optional local notification).
- 🔜 **Report honesty pass.** `buildReportModel`'s hypotheses/recommendations/limitations
  are hardcoded constants; relabel them as a methodology checklist and enrich the
  data-derived facts. Suppress net-sentiment labels below ~20 comments; round percentages.
- 🔜 **CLI boundary hardening + tests.** Explicit result-frame + exit-code-authoritative
  parsing of the Node↔FastAPI seam, with a `parse_cli_payload` test table.
- 🔜 **Server-side quota-plan enforcement** at `POST /api/actions/collect`.

## Wave 3 — portfolio & operability (🔜 planned)

- 🔜 **Predictive-validity backtest.** Does keyword "heat" at week N precede views at N+2?
  The immutable time-series store enables a leave-future-out backtest — the strongest
  analytical-rigor signal for a reviewer. *(No lens proposed this; surfaced by the
  completeness critic — arguably the highest-value single addition.)*
- 🔜 **Reproducibility.** `docker compose up` against a seeded DB, a checked-in sanitized
  demo fixture + `npm run demo`, first-run onboarding (replace spinner walls), CI running
  the four test suites + a status badge.
- 🔜 **Repositioning + docs.** Re-cut README around one wedge ("Japan AI/data-engineering
  content-opportunity radar"); add `ARCHITECTURE.md` / ADRs leading with the engineering
  decisions (single-writer, advisory lock, least-privilege, PII pseudonymization, quota
  governance) and an ops runbook.
- 🔜 **Retention prune** for the unbounded `analysis_comment_terms` (~1.2M rows).

## Declined (🚫 — over-engineered for a single-user local tool)

- 🚫 **Partition / tiered rollup of `post_metric_snapshots`.** SaaS-scale complexity and
  migration risk for ~256k rows that don't bite at this volume; the Wave-3 retention
  prune covers the genuinely unbounded table far more cheaply.
- 🚫 **Separate comment schema / at-rest encryption.** Disproportionate for a local DB
  the owner controls; the real exposure ("don't dump/share the DB") is covered by the
  publish checklist.
- 🚫 **Move per-step run logging into the snapshot transaction.** Subsumed by the
  reconciler + reaper; only reconciles counts nobody acts on.
