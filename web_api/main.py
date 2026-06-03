from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, Literal

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from .config import settings
from .db import engine, fetch_all, fetch_one, serialize_row
from .security import ACTION_TOKEN, require_write_request
from .tasks import launch_operation, run_node_cli


app = FastAPI(title="SNS Trend Lab", docs_url=None, redoc_url=None)


def error_response(status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"error": {"code": code, "message": message}},
    )


@app.exception_handler(HTTPException)
async def http_exception_handler(_: Request, exc: HTTPException) -> JSONResponse:
    if isinstance(exc.detail, dict) and "code" in exc.detail:
        return error_response(exc.status_code, exc.detail["code"], exc.detail["message"])
    return error_response(exc.status_code, "HTTP_ERROR", str(exc.detail))


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
    return error_response(422, "VALIDATION_ERROR", str(exc.errors()[0]["msg"]))


@app.exception_handler(Exception)
async def unexpected_exception_handler(_: Request, exc: Exception) -> JSONResponse:
    code = getattr(exc, "code", "INTERNAL_ERROR")
    status = 409 if code == "OPERATION_CONFLICT" else 500
    message = str(exc) if code == "OPERATION_CONFLICT" else "Unexpected server error"
    return error_response(status, code, message)


def parse_json(value: Any, fallback: Any) -> Any:
    if value is None:
        return fallback
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return fallback


def latest_analysis_id() -> str | None:
    row = fetch_one(
        """
        SELECT CAST(id AS CHAR) AS id
        FROM analysis_runs
        WHERE status = 'success'
        ORDER BY completed_at DESC, id DESC
        LIMIT 1
        """
    )
    return row["id"] if row else None


@app.get("/api/system/status")
def system_status() -> dict[str, Any]:
    latest_batch = fetch_one(
        """
        SELECT CAST(id AS CHAR) AS id, observed_at, completed_at, trigger_type,
               status, estimated_quota_units, actual_quota_units
        FROM collection_batches
        ORDER BY observed_at DESC, id DESC
        LIMIT 1
        """
    )
    latest_analysis = fetch_one(
        """
        SELECT CAST(id AS CHAR) AS id, completed_at, status, days,
               CAST(source_batch_id AS CHAR) AS source_batch_id
        FROM analysis_runs
        ORDER BY started_at DESC, id DESC
        LIMIT 1
        """
    )
    pending = bool(
        latest_batch
        and latest_batch.get("status") == "success"
        and (
            not latest_analysis
            or latest_analysis.get("status") != "success"
            or latest_analysis.get("source_batch_id") != latest_batch.get("id")
        )
    )
    return {
        "actionToken": ACTION_TOKEN,
        "database": settings.mysql_database,
        "source": "YouTube Data API v3",
        "timezone": settings.timezone,
        "quotaBudget": settings.quota_budget,
        "youtubeApiConfigured": settings.youtube_api_configured,
        "latestBatch": latest_batch,
        "latestAnalysis": latest_analysis,
        "newDataPendingAnalysis": pending,
    }


@app.get("/api/actions/collect-estimate")
async def collect_estimate() -> dict[str, Any]:
    payload = await asyncio.to_thread(run_node_cli, ["collect:estimate"])
    if not payload.get("ok"):
        error = payload.get("error") or {}
        raise HTTPException(
            status_code=400,
            detail={
                "code": error.get("code", "COLLECT_ESTIMATE_FAILED"),
                "message": error.get("message", "Unable to estimate collection quota"),
            },
        )
    return payload["result"]


class AnalyzeBody(BaseModel):
    days: Literal[7, 30, 90] = 30


class EmptyBody(BaseModel):
    pass


@app.post("/api/actions/collect", dependencies=[Depends(require_write_request)])
async def collect_action(_: EmptyBody) -> dict[str, str]:
    if not settings.youtube_api_configured:
        raise HTTPException(
            status_code=400,
            detail={"code": "MISSING_API_KEY", "message": "YouTube API key is not configured"},
        )
    return {"requestId": launch_operation("collect", {})}


@app.post("/api/actions/analyze", dependencies=[Depends(require_write_request)])
async def analyze_action(body: AnalyzeBody) -> dict[str, str]:
    return {"requestId": launch_operation("analyze", {"days": body.days})}


@app.get("/api/actions/{request_id}")
def action_status(request_id: str) -> dict[str, Any]:
    row = fetch_one(
        """
        SELECT id, operation_type, status, parameters_json, requested_at,
               started_at, completed_at, error_summary
        FROM operation_requests
        WHERE id = :id
        """,
        {"id": request_id},
    )
    if not row:
        raise HTTPException(
            status_code=404,
            detail={"code": "ACTION_NOT_FOUND", "message": "Action request was not found"},
        )
    row["parameters"] = parse_json(row.pop("parameters_json"), {})
    return row


@app.get("/api/dashboard")
def dashboard() -> dict[str, Any]:
    run_id = latest_analysis_id()
    stats = fetch_one(
        """
        SELECT
          (SELECT COUNT(DISTINCT post_id) FROM post_query_matches) AS keyword_sample_videos,
          (SELECT COUNT(*) FROM tracked_queries WHERE archived_at IS NULL) AS query_count,
          (SELECT COUNT(*) FROM v_latest_popular_videos) AS popular_video_count,
          (SELECT COUNT(DISTINCT observed_at) FROM collection_batches WHERE status = 'success') AS observation_count
        """
    ) or {}
    latest_batch = fetch_one(
        """
        SELECT CAST(id AS CHAR) AS id, observed_at, completed_at, trigger_type,
               status, estimated_quota_units, actual_quota_units
        FROM collection_batches
        ORDER BY observed_at DESC, id DESC
        LIMIT 1
        """
    )
    top_videos: list[dict[str, Any]] = []
    query_performance: list[dict[str, Any]] = []
    scatter: list[dict[str, Any]] = []
    growth_rankings: list[dict[str, Any]] = []
    growth_trends: list[dict[str, Any]] = []
    recommendations: dict[str, Any] = {"zh-CN": [], "ja-JP": []}
    opinion: dict[str, Any] = {"overall": None, "byTopic": []}
    if run_id:
        top_videos = fetch_all(
            """
            SELECT CAST(m.analysis_run_id AS CHAR) AS analysis_run_id, p.post_id,
                   p.title, p.thumbnail_url, p.url, c.title AS channel_title,
                   CAST(m.latest_views AS CHAR) AS latest_views,
                   CAST(m.views_growth_abs AS CHAR) AS views_growth_abs,
                   CAST(m.reaction_rate_pct AS CHAR) AS reaction_rate_pct,
                   m.low_base_reaction_rate,
                   qt.topics
            FROM analysis_post_metrics m
            JOIN posts p ON p.post_id = m.post_id
            JOIN channels c ON c.channel_id = p.channel_id
            JOIN (
              SELECT pqm.post_id,
                     GROUP_CONCAT(DISTINCT q.topic ORDER BY q.topic SEPARATOR '||') AS topics
              FROM post_query_matches pqm
              JOIN tracked_queries q ON q.id = pqm.query_id
              GROUP BY pqm.post_id
            ) qt ON qt.post_id = p.post_id
            WHERE m.analysis_run_id = :run_id
            ORDER BY m.latest_views DESC
            LIMIT 8
            """,
            {"run_id": run_id},
        )
        query_performance = fetch_all(
            """
            SELECT CAST(aqm.query_id AS CHAR) AS query_id, q.name, q.topic,
                   CAST(aqm.sample_total_latest_views AS CHAR) AS sample_total_latest_views,
                   CAST(aqm.latest_estimated_total_results AS CHAR) AS latest_estimated_total_results,
                   aqm.matched_post_count
            FROM analysis_query_metrics aqm
            JOIN tracked_queries q ON q.id = aqm.query_id
            WHERE aqm.analysis_run_id = :run_id
            ORDER BY aqm.sample_total_latest_views DESC
            """,
            {"run_id": run_id},
        )
        scatter = fetch_all(
            """
            SELECT p.post_id, p.title, c.title AS channel_title,
                   CAST(m.latest_views AS CHAR) AS latest_views,
                   CAST(m.reaction_rate_pct AS CHAR) AS reaction_rate_pct,
                   m.low_base_reaction_rate,
                   qt.topics
            FROM analysis_post_metrics m
            JOIN posts p ON p.post_id = m.post_id
            JOIN channels c ON c.channel_id = p.channel_id
            JOIN (
              SELECT pqm.post_id,
                     GROUP_CONCAT(DISTINCT q.topic ORDER BY q.topic SEPARATOR '||') AS topics
              FROM post_query_matches pqm
              JOIN tracked_queries q ON q.id = pqm.query_id
              GROUP BY pqm.post_id
            ) qt ON qt.post_id = p.post_id
            WHERE m.analysis_run_id = :run_id
              AND m.reaction_rate_pct IS NOT NULL
            ORDER BY m.latest_views DESC
            LIMIT 500
            """,
            {"run_id": run_id},
        )
        growth_rankings = fetch_all(
            """
            SELECT p.post_id, p.title, p.thumbnail_url,
                   CAST(m.views_growth_abs AS CHAR) AS views_growth_abs,
                   CAST(m.views_growth_per_day AS CHAR) AS views_growth_per_day
            FROM analysis_post_metrics m
            JOIN posts p ON p.post_id = m.post_id
            JOIN (SELECT DISTINCT post_id FROM post_query_matches) sample
              ON sample.post_id = m.post_id
            WHERE m.analysis_run_id = :run_id
              AND m.views_growth_per_day IS NOT NULL
            ORDER BY m.views_growth_per_day DESC
            LIMIT 8
            """,
            {"run_id": run_id},
        )
        growth_trends = fetch_all(
            """
            WITH top_growth AS (
              SELECT m.post_id
              FROM analysis_post_metrics m
              JOIN (SELECT DISTINCT post_id FROM post_query_matches) sample
                ON sample.post_id = m.post_id
              WHERE m.analysis_run_id = :run_id
                AND m.views_growth_per_day IS NOT NULL
              ORDER BY m.views_growth_per_day DESC
              LIMIT 5
            )
            SELECT s.post_id, p.title, s.observed_at,
                   CAST(s.views AS CHAR) AS views
            FROM post_metric_snapshots s
            JOIN top_growth g ON g.post_id = s.post_id
            JOIN posts p ON p.post_id = s.post_id
            JOIN analysis_runs ar ON ar.id = :run_id
            WHERE s.observed_at BETWEEN ar.window_start AND ar.window_end
            ORDER BY s.post_id, s.observed_at
            """,
            {"run_id": run_id},
        )
        report = fetch_one(
            "SELECT summary_json FROM analysis_runs WHERE id = :run_id",
            {"run_id": run_id},
        )
        if report:
            summary = parse_json(report["summary_json"], {})
            recommendations = {
                "zh-CN": summary.get("zh-CN", {}).get("recommendations", []),
                "ja-JP": summary.get("ja-JP", {}).get("recommendations", []),
            }
        opinion_rows = fetch_all(
            """
            SELECT dimension_type, dimension_value, comment_count, distinct_authors,
                   positive_count, neutral_count, negative_count,
                   CAST(net_sentiment_pct AS CHAR) AS net_sentiment_pct
            FROM analysis_comment_metrics
            WHERE analysis_run_id = :run_id
            ORDER BY (dimension_type = 'overall') DESC, comment_count DESC
            """,
            {"run_id": run_id},
        )
        opinion = {
            "overall": next(
                (row for row in opinion_rows if row["dimension_type"] == "overall"),
                None,
            ),
            "byTopic": [
                row for row in opinion_rows if row["dimension_type"] == "query_topic"
            ][:8],
        }

    popular = fetch_all(
        """
        SELECT rank_position, post_id, title, channel_title, thumbnail_url, url,
               CAST(views AS CHAR) AS views
        FROM v_latest_popular_videos
        ORDER BY rank_position
        LIMIT 10
        """
    )
    quota_breakdown = []
    if latest_batch:
        quota_breakdown = fetch_all(
            """
            SELECT run_type, SUM(quota_units) AS quota_units
            FROM collection_runs
            WHERE batch_id = :batch_id
            GROUP BY run_type
            ORDER BY quota_units DESC, run_type
            """,
            {"batch_id": latest_batch["id"]},
        )
    return {
        "analysisRunId": run_id,
        "stats": stats,
        "latestBatch": latest_batch,
        "topVideos": top_videos,
        "queryPerformance": query_performance,
        "scatter": scatter,
        "growthRankings": growth_rankings,
        "growthTrends": growth_trends,
        "popular": popular,
        "recommendations": recommendations,
        "opinion": opinion,
        "quotaBreakdown": quota_breakdown,
        "quotaBudget": settings.quota_budget,
    }


VIDEO_SORTS = {
    "latest_views": "m.latest_views",
    "reaction_rate": "m.reaction_rate_pct",
    "growth": "m.views_growth_abs",
    "published_at": "p.published_at",
}


@app.get("/api/videos")
def videos(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    analysis_run_id: str | None = None,
    topic: str | None = None,
    category_id: str | None = None,
    search: str | None = None,
    low_base: bool = False,
    sort: str = "latest_views",
    direction: Literal["asc", "desc"] = "desc",
) -> dict[str, Any]:
    run_id = analysis_run_id or latest_analysis_id()
    if not run_id:
        return {"items": [], "total": 0, "page": page, "pageSize": page_size, "filters": {}}
    sort_column = VIDEO_SORTS.get(sort, VIDEO_SORTS["latest_views"])
    where = ["m.analysis_run_id = :run_id"]
    params: dict[str, Any] = {"run_id": run_id}
    if topic:
        where.append("FIND_IN_SET(:topic, REPLACE(qt.topics, '||', ',')) > 0")
        params["topic"] = topic
    if category_id:
        where.append("p.category_id = :category_id")
        params["category_id"] = category_id
    if search:
        where.append("(p.title LIKE :search OR c.title LIKE :search)")
        params["search"] = f"%{search}%"
    if low_base:
        where.append("m.low_base_reaction_rate = TRUE")
    where_sql = " AND ".join(where)
    base_from = """
        FROM analysis_post_metrics m
        JOIN posts p ON p.post_id = m.post_id
        JOIN channels c ON c.channel_id = p.channel_id
        JOIN (
          SELECT pqm.post_id,
                 GROUP_CONCAT(DISTINCT q.topic ORDER BY q.topic SEPARATOR '||') AS topics
          FROM post_query_matches pqm
          JOIN tracked_queries q ON q.id = pqm.query_id
          GROUP BY pqm.post_id
        ) qt ON qt.post_id = p.post_id
        LEFT JOIN youtube_categories yc
          ON yc.category_id = p.category_id AND yc.region_code = 'JP'
    """
    count = fetch_one(
        f"SELECT COUNT(*) AS total {base_from} WHERE {where_sql}",
        params,
    ) or {"total": 0}
    scatter_items = fetch_all(
        f"""
        SELECT p.post_id, p.title, c.title AS channel_title, qt.topics,
               CAST(m.latest_views AS CHAR) AS latest_views,
               CAST(m.reaction_rate_pct AS CHAR) AS reaction_rate_pct,
               m.low_base_reaction_rate
        {base_from}
        WHERE {where_sql}
          AND m.reaction_rate_pct IS NOT NULL
        ORDER BY m.latest_views DESC
        LIMIT 1000
        """,
        params,
    )
    params.update({"limit": page_size, "offset": (page - 1) * page_size})
    items = fetch_all(
        f"""
        SELECT CAST(m.analysis_run_id AS CHAR) AS analysis_run_id, p.post_id,
               p.title, p.thumbnail_url, p.url, p.published_at, p.category_id,
               yc.title AS category_title, c.title AS channel_title, qt.topics,
               CAST(m.latest_views AS CHAR) AS latest_views,
               CAST(m.latest_likes AS CHAR) AS latest_likes,
               CAST(m.latest_comments AS CHAR) AS latest_comments,
               CAST(m.latest_reactions AS CHAR) AS latest_reactions,
               CAST(m.reaction_rate_pct AS CHAR) AS reaction_rate_pct,
               CAST(m.views_growth_abs AS CHAR) AS views_growth_abs,
               CAST(m.views_growth_per_day AS CHAR) AS views_growth_per_day,
               m.snapshot_count, m.low_base_reaction_rate, m.latest_observed_at
        {base_from}
        WHERE {where_sql}
        ORDER BY {sort_column} {direction.upper()}, p.post_id
        LIMIT :limit OFFSET :offset
        """,
        params,
    )
    filters = {
        "topics": fetch_all(
            """
            SELECT DISTINCT q.topic
            FROM post_query_matches m
            JOIN tracked_queries q ON q.id = m.query_id
            ORDER BY q.topic
            """
        ),
        "categories": fetch_all(
            """
            SELECT DISTINCT p.category_id, yc.title AS category_title
            FROM post_query_matches m
            JOIN posts p ON p.post_id = m.post_id
            LEFT JOIN youtube_categories yc
              ON yc.category_id = p.category_id AND yc.region_code = 'JP'
            WHERE p.category_id IS NOT NULL
            ORDER BY p.category_id
            """
        ),
        "runs": fetch_all(
            """
            SELECT CAST(id AS CHAR) AS id, completed_at, days, status
            FROM analysis_runs
            WHERE status = 'success'
            ORDER BY completed_at DESC, id DESC
            LIMIT 30
            """
        ),
    }
    return {
        "items": items,
        "total": count["total"],
        "page": page,
        "pageSize": page_size,
        "analysisRunId": run_id,
        "scatter": scatter_items,
        "filters": filters,
    }


@app.get("/api/videos/{post_id}")
def video_detail(post_id: str, analysis_run_id: str | None = None) -> dict[str, Any]:
    run_id = analysis_run_id or latest_analysis_id()
    if not run_id:
        raise HTTPException(status_code=404, detail={"code": "VIDEO_NOT_FOUND", "message": "Video was not found"})
    item = fetch_one(
        """
        SELECT p.post_id, p.title, p.thumbnail_url, p.url, p.published_at,
               p.duration_seconds, p.category_id, yc.title AS category_title,
               p.is_available, c.title AS channel_title, c.url AS channel_url,
               CAST(m.latest_views AS CHAR) AS latest_views,
               CAST(m.latest_likes AS CHAR) AS latest_likes,
               CAST(m.latest_comments AS CHAR) AS latest_comments,
               CAST(m.latest_reactions AS CHAR) AS latest_reactions,
               CAST(m.reaction_rate_pct AS CHAR) AS reaction_rate_pct,
               CAST(m.views_growth_abs AS CHAR) AS views_growth_abs,
               CAST(m.views_growth_per_day AS CHAR) AS views_growth_per_day,
               m.snapshot_count, m.low_base_reaction_rate, m.latest_observed_at
        FROM posts p
        JOIN channels c ON c.channel_id = p.channel_id
        LEFT JOIN youtube_categories yc
          ON yc.category_id = p.category_id AND yc.region_code = 'JP'
        JOIN analysis_post_metrics m
          ON m.post_id = p.post_id AND m.analysis_run_id = :run_id
        WHERE p.post_id = :post_id
        """,
        {"post_id": post_id, "run_id": run_id},
    )
    if not item:
        raise HTTPException(status_code=404, detail={"code": "VIDEO_NOT_FOUND", "message": "Video was not found"})
    item["tags"] = fetch_all(
        "SELECT tag FROM post_tags WHERE post_id = :post_id ORDER BY tag LIMIT 100",
        {"post_id": post_id},
    )
    item["queries"] = fetch_all(
        """
        SELECT CAST(q.id AS CHAR) AS id, q.name, q.topic, m.latest_rank
        FROM post_query_matches m
        JOIN tracked_queries q ON q.id = m.query_id
        WHERE m.post_id = :post_id
        ORDER BY q.id
        """,
        {"post_id": post_id},
    )
    item["snapshots"] = fetch_all(
        """
        SELECT observed_at, CAST(views AS CHAR) AS views,
               CAST(likes AS CHAR) AS likes, CAST(comments AS CHAR) AS comments
        FROM post_metric_snapshots
        WHERE post_id = :post_id
        ORDER BY observed_at
        """,
        {"post_id": post_id},
    )
    return item


@app.get("/api/popular")
def popular() -> dict[str, Any]:
    items = fetch_all(
        """
        SELECT v.rank_position, v.post_id, v.title, v.channel_title,
               v.thumbnail_url, v.url, CAST(v.views AS CHAR) AS views,
               CAST(v.likes AS CHAR) AS likes, CAST(v.comments AS CHAR) AS comments,
               COALESCE(apm.appearance_count, 1) AS appearance_count,
               COALESCE(apm.best_rank, v.rank_position) AS best_rank,
               COALESCE(apm.latest_rank, v.rank_position) AS latest_rank,
               CAST(COALESCE(apm.best_rank, v.rank_position) AS SIGNED)
                 - CAST(COALESCE(apm.latest_rank, v.rank_position) AS SIGNED) AS rank_change
        FROM v_latest_popular_videos v
        LEFT JOIN analysis_popular_metrics apm
          ON apm.post_id = v.post_id
         AND apm.analysis_run_id = (
           SELECT id FROM analysis_runs
           WHERE status = 'success'
           ORDER BY completed_at DESC, id DESC LIMIT 1
         )
        ORDER BY v.rank_position
        """
    )
    return {"items": items}


@app.get("/api/collections")
def collections(page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=100)) -> dict[str, Any]:
    total = fetch_one("SELECT COUNT(*) AS total FROM collection_batches") or {"total": 0}
    items = fetch_all(
        """
        SELECT CAST(b.id AS CHAR) AS id, b.started_at, b.observed_at, b.completed_at,
               b.trigger_type, b.status, b.estimated_quota_units, b.actual_quota_units,
               b.error_summary, CAST(b.request_id AS CHAR) AS request_id,
               COALESCE((SELECT returned_count FROM collection_runs r
                         WHERE r.batch_id = b.id AND r.run_type = 'video_refresh'
                         ORDER BY r.id DESC LIMIT 1), 0) AS video_count,
               COALESCE((SELECT returned_count FROM collection_runs r
                         WHERE r.batch_id = b.id AND r.run_type = 'channel_refresh'
                         ORDER BY r.id DESC LIMIT 1), 0) AS channel_count
        FROM collection_batches b
        ORDER BY b.observed_at DESC, b.id DESC
        LIMIT :limit OFFSET :offset
        """,
        {"limit": page_size, "offset": (page - 1) * page_size},
    )
    return {"items": items, "total": total["total"], "page": page, "pageSize": page_size}


@app.get("/api/collections/{batch_id}")
def collection_detail(batch_id: str) -> dict[str, Any]:
    batch = fetch_one(
        """
        SELECT CAST(id AS CHAR) AS id, started_at, observed_at, completed_at,
               trigger_type, status, estimated_quota_units, actual_quota_units,
               error_summary, CAST(request_id AS CHAR) AS request_id
        FROM collection_batches WHERE id = :id
        """,
        {"id": batch_id},
    )
    if not batch:
        raise HTTPException(status_code=404, detail={"code": "COLLECTION_NOT_FOUND", "message": "Collection batch was not found"})
    batch["runs"] = fetch_all(
        """
        SELECT CAST(r.id AS CHAR) AS id, CAST(r.query_id AS CHAR) AS query_id,
               q.name AS query_name, r.run_type, r.started_at, r.completed_at,
               r.status, r.request_count, r.returned_count, r.quota_units,
               r.error_summary
        FROM collection_runs r
        LEFT JOIN tracked_queries q ON q.id = r.query_id
        WHERE r.batch_id = :id
        ORDER BY r.id
        """,
        {"id": batch_id},
    )
    return batch


@app.get("/api/reports")
def reports() -> dict[str, Any]:
    return {
        "items": fetch_all(
            """
            SELECT CAST(id AS CHAR) AS id, started_at, completed_at, window_start,
                   window_end, days, status, trigger_type,
                   CAST(source_batch_id AS CHAR) AS source_batch_id,
                   error_summary, report_markdown_ja IS NOT NULL AS has_japanese
            FROM analysis_runs
            ORDER BY started_at DESC, id DESC
            LIMIT 100
            """
        )
    }


@app.get("/api/reports/{run_id}")
def report_detail(run_id: str, locale: Literal["zh-CN", "ja-JP"] = "zh-CN") -> dict[str, Any]:
    row = fetch_one(
        """
        SELECT CAST(id AS CHAR) AS id, started_at, completed_at, window_start,
               window_end, days, status, trigger_type,
               CAST(source_batch_id AS CHAR) AS source_batch_id,
               summary_json, report_markdown, report_markdown_ja, error_summary
        FROM analysis_runs
        WHERE id = :id
        """,
        {"id": run_id},
    )
    if not row:
        raise HTTPException(status_code=404, detail={"code": "REPORT_NOT_FOUND", "message": "Analysis report was not found"})
    fallback = locale == "ja-JP" and not row.get("report_markdown_ja")
    actual_locale = "zh-CN" if fallback else locale
    markdown = row.get("report_markdown_ja") if actual_locale == "ja-JP" else row.get("report_markdown")
    summary = parse_json(row.pop("summary_json"), {})
    row.pop("report_markdown")
    row.pop("report_markdown_ja")
    return {
        **row,
        "requestedLocale": locale,
        "actualLocale": actual_locale,
        "localeFallback": fallback,
        "markdown": markdown or "",
        "summary": summary.get(actual_locale, summary.get("zh-CN", {})),
    }


class QueryCreateBody(BaseModel):
    name: str = Field(min_length=1, max_length=191)
    query_text: str = Field(min_length=1, max_length=500)
    topic: str = Field(min_length=1, max_length=191)
    max_results: int = Field(50, ge=1, le=50)
    lookback_days: int = Field(7, ge=1, le=30)


class QueryPatchBody(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=191)
    query_text: str | None = Field(None, min_length=1, max_length=500)
    topic: str | None = Field(None, min_length=1, max_length=191)
    enabled: bool | None = None
    max_results: int | None = Field(None, ge=1, le=50)
    lookback_days: int | None = Field(None, ge=1, le=30)


class QueryCopyBody(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=191)
    query_text: str | None = Field(None, min_length=1, max_length=500)
    topic: str | None = Field(None, min_length=1, max_length=191)


def query_row(query_id: str) -> dict[str, Any] | None:
    return fetch_one(
        """
        SELECT CAST(q.id AS CHAR) AS id, q.name, q.query_text, q.topic,
               q.region_code, q.relevance_language, q.safe_search,
               q.max_results, q.lookback_days, q.enabled, q.archived_at,
               q.created_at, q.updated_at,
               COUNT(o.id) AS observation_count
        FROM tracked_queries q
        LEFT JOIN query_observations o ON o.query_id = q.id
        WHERE q.id = :id
        GROUP BY q.id
        """,
        {"id": query_id},
    )


@app.get("/api/queries")
def queries(include_archived: bool = True) -> dict[str, Any]:
    where = "" if include_archived else "WHERE q.archived_at IS NULL"
    return {
        "items": fetch_all(
            f"""
            SELECT CAST(q.id AS CHAR) AS id, q.name, q.query_text, q.topic,
                   q.region_code, q.relevance_language, q.safe_search,
                   q.max_results, q.lookback_days, q.enabled, q.archived_at,
                   q.created_at, q.updated_at, COUNT(o.id) AS observation_count
            FROM tracked_queries q
            LEFT JOIN query_observations o ON o.query_id = q.id
            {where}
            GROUP BY q.id
            ORDER BY q.archived_at IS NOT NULL, q.id
            """
        )
    }


@app.post("/api/queries", dependencies=[Depends(require_write_request)])
def create_query(body: QueryCreateBody) -> dict[str, Any]:
    try:
        with engine.begin() as connection:
            result = connection.execute(
                text(
                    """
                    INSERT INTO tracked_queries
                      (name, query_text, topic, region_code, relevance_language,
                       safe_search, max_results, lookback_days, enabled)
                    VALUES (:name, :query_text, :topic, 'JP', 'ja', 'moderate',
                            :max_results, :lookback_days, TRUE)
                    """
                ),
                body.model_dump(),
            )
            query_id = str(result.lastrowid)
    except IntegrityError as exc:
        raise HTTPException(status_code=409, detail={"code": "QUERY_NAME_EXISTS", "message": "Query name already exists"}) from exc
    return query_row(query_id) or {}


@app.patch("/api/queries/{query_id}", dependencies=[Depends(require_write_request)])
def update_query(query_id: str, body: QueryPatchBody) -> dict[str, Any]:
    current = query_row(query_id)
    if not current:
        raise HTTPException(status_code=404, detail={"code": "QUERY_NOT_FOUND", "message": "Tracked query was not found"})
    updates = body.model_dump(exclude_none=True)
    semantic = {"name", "query_text", "topic"} & updates.keys()
    if semantic and int(current["observation_count"]) > 0:
        raise HTTPException(status_code=409, detail={"code": "QUERY_IMMUTABLE", "message": "Observed query semantics cannot be edited; copy it instead"})
    if not updates:
        return current
    assignments = ", ".join(f"`{key}` = :{key}" for key in updates)
    updates["id"] = query_id
    try:
        with engine.begin() as connection:
            connection.execute(text(f"UPDATE tracked_queries SET {assignments} WHERE id = :id"), updates)
    except IntegrityError as exc:
        raise HTTPException(status_code=409, detail={"code": "QUERY_NAME_EXISTS", "message": "Query name already exists"}) from exc
    return query_row(query_id) or {}


@app.post("/api/queries/{query_id}/archive", dependencies=[Depends(require_write_request)])
def archive_query(query_id: str, _: EmptyBody) -> dict[str, Any]:
    with engine.begin() as connection:
        result = connection.execute(
            text("UPDATE tracked_queries SET enabled = FALSE, archived_at = UTC_TIMESTAMP(6) WHERE id = :id"),
            {"id": query_id},
        )
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail={"code": "QUERY_NOT_FOUND", "message": "Tracked query was not found"})
    return query_row(query_id) or {}


@app.post("/api/queries/{query_id}/restore", dependencies=[Depends(require_write_request)])
def restore_query(query_id: str, _: EmptyBody) -> dict[str, Any]:
    with engine.begin() as connection:
        result = connection.execute(
            text("UPDATE tracked_queries SET enabled = FALSE, archived_at = NULL WHERE id = :id"),
            {"id": query_id},
        )
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail={"code": "QUERY_NOT_FOUND", "message": "Tracked query was not found"})
    return query_row(query_id) or {}


@app.post("/api/queries/{query_id}/copy", dependencies=[Depends(require_write_request)])
def copy_query(query_id: str, body: QueryCopyBody) -> dict[str, Any]:
    current = query_row(query_id)
    if not current:
        raise HTTPException(status_code=404, detail={"code": "QUERY_NOT_FOUND", "message": "Tracked query was not found"})
    payload = {
        "name": body.name or f"{current['name']} copy",
        "query_text": body.query_text or current["query_text"],
        "topic": body.topic or current["topic"],
        "max_results": current["max_results"],
        "lookback_days": current["lookback_days"],
    }
    return create_query(QueryCreateBody(**payload))


@app.get("/api/schedule")
async def schedule_status() -> dict[str, Any]:
    payload = await asyncio.to_thread(run_node_cli, ["schedule:status"])
    if not payload.get("ok"):
        error = payload.get("error") or {}
        raise HTTPException(status_code=400, detail={"code": error.get("code", "SCHEDULE_ERROR"), "message": error.get("message", "Unable to read schedule")})
    return payload["result"]


@app.post("/api/schedule", dependencies=[Depends(require_write_request)])
async def schedule_install(_: EmptyBody) -> dict[str, Any]:
    payload = await asyncio.to_thread(run_node_cli, ["schedule:install"])
    if not payload.get("ok"):
        error = payload.get("error") or {}
        raise HTTPException(status_code=400, detail={"code": error.get("code", "SCHEDULE_ERROR"), "message": error.get("message", "Unable to install schedule")})
    return payload["result"]


@app.delete("/api/schedule", dependencies=[Depends(require_write_request)])
async def schedule_uninstall(_: EmptyBody) -> dict[str, Any]:
    payload = await asyncio.to_thread(run_node_cli, ["schedule:uninstall"])
    if not payload.get("ok"):
        error = payload.get("error") or {}
        raise HTTPException(status_code=400, detail={"code": error.get("code", "SCHEDULE_ERROR"), "message": error.get("message", "Unable to remove schedule")})
    return payload["result"]


WEB_DIST = Path(settings.project_root) / "web" / "dist"
if WEB_DIST.exists():
    assets = WEB_DIST / "assets"
    if assets.exists():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str) -> FileResponse:
        target = WEB_DIST / path
        if path and target.exists() and target.is_file():
            return FileResponse(target)
        return FileResponse(WEB_DIST / "index.html")
