# YouTube Metrics and Analysis Guide

## Core Metrics

### Reactions

```text
reaction_count = likes + comments
reaction_rate_pct = reaction_count / views * 100
```

Calculate reactions only when both likes and comments are present. YouTube does not publicly expose shares through this workflow. Mark reaction rates based on fewer than 100 views as low-base.

### View Growth

For videos with at least two snapshots:

```text
views_growth_abs = latest_views - earliest_views
views_growth_pct = views_growth_abs / earliest_views * 100
views_growth_per_day = views_growth_abs / observation_days
```

Do not calculate percentage growth when earliest views are zero. Prefer daily growth when video ages or observation windows differ.

### Keyword Direction

`query_observations.estimated_total_results` is the YouTube search API's approximate result count. It can indicate direction across repeated observations, but it is not search volume, demand, or an exact count.

### Popular Chart Persistence

Use `analysis_popular_metrics.appearance_count`, `best_rank`, and `latest_rank` to describe repeated appearances in Japan's `mostPopular` chart. Chart presence does not reveal the underlying recommendation or traffic-source cause.

## Comparison Rules

- Compare videos with similar ages and observation windows when possible.
- Separate total reach from reaction rate.
- Treat channel size as distribution context, not a performance explanation by itself.
- A video may belong to multiple query topics or tags; topic totals are overlapping samples.
- Tag and topic case variants such as `AI` and `ai` are combined into one analysis group.
- Do not infer watch time, completion rate, traffic source, or subscriber conversion from public API data.
- Disclose the YouTube Shorts `viewCount` definition change effective 2025-03-31.

## Evidence Discipline

Use three labels:

1. **Data-supported fact**: Directly present in snapshots or deterministic calculations.
2. **Reasonable hypothesis**: A plausible explanation tied to observable evidence.
3. **Still-to-validate item**: A claim requiring YouTube Analytics, a longer window, or a controlled content test.

Never convert topic, keyword, category, tag, title, channel scale, or chart correlation into a causal claim.

## Recommendation Design

Make recommendations testable:

```text
Action -> Evidence -> Expected signal -> Validation method
```

Example:

```text
Publish two videos using the highest-growth query topic.
Evidence: That topic has the strongest sample view growth per day.
Expected signal: Higher seven-day view growth than comparable recent videos.
Validation method: Compare videos of similar age and format over the same window.
```
