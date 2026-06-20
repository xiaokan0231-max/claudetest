from __future__ import annotations

import asyncio
import json
import re
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator, Literal

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from .config import settings
from .db import engine, fetch_all, fetch_one, serialize_row
from .quota import fetch_google_quota
from .security import ACTION_TOKEN, require_write_request
from .tasks import launch_operation, reconcile_stale_operations, run_node_cli


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    # Self-heal operations orphaned by a previous crash/restart so the single-active
    # guard can never permanently wedge the write path. Best-effort: a startup DB
    # hiccup must not prevent the server (which is mostly read-only) from booting.
    try:
        reconcile_stale_operations()
    except Exception:  # noqa: BLE001 - never block startup on reconciliation
        pass
    yield


app = FastAPI(
    title="SNS Trend Lab", docs_url=None, redoc_url=None, lifespan=lifespan
)


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
        "searchQuotaBudget": settings.search_quota_budget,
        "googleCloudProjectConfigured": bool(settings.google_cloud_project),
        "youtubeApiConfigured": settings.youtube_api_configured,
        "latestBatch": latest_batch,
        "latestAnalysis": latest_analysis,
        "newDataPendingAnalysis": pending,
    }


@app.get("/api/system/quota")
async def system_quota() -> dict[str, Any]:
    local_usage = fetch_all(
        """
        SELECT CAST(q.batch_id AS CHAR) AS batch_id, b.observed_at,
               q.quota_bucket, q.estimated_units, q.actual_units
        FROM collection_quota_usage q
        JOIN collection_batches b ON b.id = q.batch_id
        ORDER BY b.observed_at DESC, q.quota_bucket
        LIMIT 100
        """
    )
    try:
        result = await asyncio.to_thread(
            fetch_google_quota,
            settings.google_cloud_project,
        )
    except Exception as exc:
        result = {
            "status": "unavailable",
            "errorCode": "GOOGLE_QUOTA_UNAVAILABLE",
            "message": str(exc)[:500],
            "buckets": [],
        }
    result["localUsage"] = local_usage
    result["localBudgets"] = {
        "standard_units_per_day": settings.quota_budget,
        "search_requests_per_day": settings.search_quota_budget,
    }
    return result


def _quota_bucket(quota: dict[str, Any], metric: str) -> dict[str, Any] | None:
    for bucket in quota.get("buckets") or []:
        if (
            bucket.get("quotaMetric") == metric
            and bucket.get("period") == "day"
            and bucket.get("scope") == "project"
        ):
            return bucket
    return None


def _enrich_quota_plan_with_google(
    plan: dict[str, Any],
    quota: dict[str, Any],
) -> dict[str, Any]:
    search_bucket = _quota_bucket(quota, "youtube.googleapis.com/search_list")
    standard_bucket = _quota_bucket(quota, "youtube.googleapis.com/default")
    if not search_bucket and not standard_bucket:
        return {**plan, "googleQuota": quota}

    updated = json.loads(json.dumps(plan))
    if search_bucket:
        limit = float(search_bucket.get("limit") or 0)
        used = float(search_bucket.get("used") or 0)
        target = int(limit * updated.get("targetSearchUsageRatio", 0.75))
        updated["search"].update(
            {
                "limit": limit,
                "used": used,
                "target": target,
                "safeAvailable": max(0, target - used),
            }
        )
    if standard_bucket:
        limit = float(standard_bucket.get("limit") or 0)
        used = float(standard_bucket.get("used") or 0)
        target = int(limit * updated.get("targetStandardUsageRatio", 0.7))
        updated["standard"].update(
            {
                "limit": limit,
                "used": used,
                "target": target,
                "safeAvailable": max(0, target - used),
            }
        )

    enabled_queries = int(updated["collection"].get("enabledQueryCount") or 0)
    suggested = int(updated["candidates"].get("suggestedCount") or 0)
    estimated_search = float(updated["collection"].get("estimatedSearchRequests") or 0)
    estimated_standard = float(updated["collection"].get("estimatedStandardUnits") or 0)
    safe_search = float(updated["search"].get("safeAvailable") or 0)
    safe_standard = float(updated["standard"].get("safeAvailable") or 0)
    safe_approval_slots = max(0, int(safe_search - enabled_queries))
    updated["candidates"]["safeApprovalSlots"] = safe_approval_slots
    updated["candidates"]["recommendedApprovalCount"] = min(suggested, safe_approval_slots)
    updated["collection"]["shouldCollect"] = (
        enabled_queries > 0
        and estimated_search <= safe_search
        and estimated_standard <= safe_standard
    )
    updated["quotaStatus"] = quota.get("status", updated.get("quotaStatus"))
    updated["source"] = "google_cloud_monitoring"
    updated["googleQuota"] = quota
    return updated


@app.get("/api/quota/plan")
async def quota_plan() -> dict[str, Any]:
    payload = await asyncio.to_thread(run_node_cli, ["quota:plan"])
    if not payload.get("ok"):
        error = payload.get("error") or {}
        raise HTTPException(
            status_code=400,
            detail={
                "code": error.get("code", "QUOTA_PLAN_FAILED"),
                "message": error.get("message", "Unable to build quota plan"),
            },
        )
    try:
        google_quota = await asyncio.to_thread(
            fetch_google_quota,
            settings.google_cloud_project,
        )
    except Exception as exc:
        google_quota = {
            "status": "unavailable",
            "errorCode": "GOOGLE_QUOTA_UNAVAILABLE",
            "message": str(exc)[:500],
            "buckets": [],
        }
    return _enrich_quota_plan_with_google(payload["result"], google_quota)


@app.get("/api/actions/collect-estimate")
async def collect_estimate(mode: Literal["standard", "balanced"] = "balanced") -> dict[str, Any]:
    payload = await asyncio.to_thread(run_node_cli, ["collect:estimate", "--mode", mode])
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


class CollectBody(BaseModel):
    mode: Literal["standard", "balanced"] = "balanced"


class ScheduleInstallBody(BaseModel):
    hour: int = Field(default=7, ge=0, le=23)
    minute: int = Field(default=0, ge=0, le=59)
    frequency: Literal["once", "every_2h", "every_4h", "every_6h", "every_12h"] = "once"
    mode: Literal["standard", "balanced"] = "balanced"
    runAnalyze: bool = True
    analyzeDays: int = Field(default=30, ge=1, le=365)


class EmptyBody(BaseModel):
    pass


@app.post("/api/actions/collect", dependencies=[Depends(require_write_request)])
async def collect_action(body: CollectBody) -> dict[str, str]:
    if not settings.youtube_api_configured:
        raise HTTPException(
            status_code=400,
            detail={"code": "MISSING_API_KEY", "message": "YouTube API key is not configured"},
        )
    return {"requestId": launch_operation("collect", {"mode": body.mode})}


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


def _number(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _peer_rank(rows: list[dict[str, Any]], post_id: str, field: str) -> dict[str, Any]:
    comparable = [row for row in rows if _number(row.get(field)) is not None]
    selected = next((row for row in comparable if row.get("post_id") == post_id), None)
    selected_value = _number(selected.get(field)) if selected else None
    if selected_value is None:
        return {"value": None, "rank": None, "total": len(comparable), "percentile": None}
    rank = 1 + sum(1 for row in comparable if (_number(row.get(field)) or 0) > selected_value)
    total = len(comparable)
    percentile = round((total - rank + 1) / total * 100, 2) if total else None
    return {
        "value": str(selected.get(field)),
        "rank": rank,
        "total": total,
        "percentile": percentile,
    }


def _extract_title_terms(title: str) -> list[str]:
    cleaned = re.sub(r"https?://\S+", " ", title or "")
    parts = re.split(r"[\s,，。・/／|｜【】\[\]()（）「」『』:：#]+", cleaned)
    terms: list[str] = []
    for part in parts:
        token = part.strip()
        if len(token) < 2 or token.isdigit():
            continue
        if token.lower() in {"shorts", "live", "official", "full"}:
            continue
        if token not in terms:
            terms.append(token)
        if len(terms) >= 12:
            break
    return terms


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
        SELECT CAST(q.id AS CHAR) AS id, q.name, q.query_text, q.topic, m.latest_rank
        FROM post_query_matches m
        JOIN tracked_queries q ON q.id = m.query_id
        WHERE m.post_id = :post_id
        ORDER BY q.id
        """,
        {"post_id": post_id},
    )
    item["popularHistory"] = fetch_all(
        """
        SELECT CAST(batch_id AS CHAR) AS batch_id, observed_at, region_code,
               rank_position
        FROM popular_video_observations
        WHERE post_id = :post_id
        ORDER BY observed_at DESC, rank_position
        LIMIT 30
        """,
        {"post_id": post_id},
    )
    item["popularSummary"] = fetch_one(
        """
        SELECT appearance_count, best_rank, latest_rank, first_observed_at,
               latest_observed_at
        FROM analysis_popular_metrics
        WHERE analysis_run_id = :run_id AND post_id = :post_id
        """,
        {"post_id": post_id, "run_id": run_id},
    )
    peer_rows = fetch_all(
        """
        SELECT DISTINCT m.post_id,
               CAST(m.latest_views AS CHAR) AS latest_views,
               CAST(m.reaction_rate_pct AS CHAR) AS reaction_rate_pct,
               CAST(m.views_growth_per_day AS CHAR) AS views_growth_per_day
        FROM analysis_post_metrics m
        JOIN post_query_matches pm ON pm.post_id = m.post_id
        JOIN tracked_queries q ON q.id = pm.query_id
        WHERE m.analysis_run_id = :run_id
          AND q.topic IN (
            SELECT DISTINCT q2.topic
            FROM post_query_matches pm2
            JOIN tracked_queries q2 ON q2.id = pm2.query_id
            WHERE pm2.post_id = :post_id
          )
        """,
        {"post_id": post_id, "run_id": run_id},
    )
    item["peerComparison"] = {
        "peerCount": len(peer_rows),
        "views": _peer_rank(peer_rows, post_id, "latest_views"),
        "reactionRate": _peer_rank(peer_rows, post_id, "reaction_rate_pct"),
        "growthPerDay": _peer_rank(peer_rows, post_id, "views_growth_per_day"),
    }
    query_texts = [str(query.get("query_text") or "") for query in item["queries"]]
    item["contentSignals"] = {
        "titleTerms": _extract_title_terms(item.get("title") or ""),
        "matchedQueries": [
            query for query in query_texts
            if query and query.lower() in str(item.get("title") or "").lower()
        ],
        "tagCount": len(item["tags"]),
        "discoverySources": {
            "keywordSample": len(item["queries"]) > 0,
            "popularChart": len(item["popularHistory"]) > 0,
        },
    }
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


@app.get("/api/comment-insights")
def comment_insights(
    analysis_run_id: str | None = None,
    topic: str | None = None,
    post_id: str | None = None,
    sentiment: Literal["all", "positive", "neutral", "negative"] = "all",
    date_from: str | None = None,
    date_to: str | None = None,
) -> dict[str, Any]:
    run_id = analysis_run_id or latest_analysis_id()
    if not run_id:
        return {
            "analysisRunId": None,
            "metrics": [],
            "daily": [],
            "terms": [],
            "sentimentTerms": [],
            "topicFeatures": [],
            "filters": {"runs": [], "topics": [], "videos": []},
        }
    dimension_type = "overall"
    dimension_value = "ALL"
    if post_id:
        dimension_type, dimension_value = "post", post_id
    elif topic:
        dimension_type, dimension_value = "query_topic", topic
    params: dict[str, Any] = {
        "run_id": run_id,
        "dimension_type": dimension_type,
        "dimension_value": dimension_value,
        "sentiment": sentiment,
    }
    daily_where = [
        "analysis_run_id = :run_id",
        "dimension_type = :dimension_type",
        "dimension_value = :dimension_value",
    ]
    if date_from:
        daily_where.append("comment_date >= :date_from")
        params["date_from"] = date_from
    if date_to:
        daily_where.append("comment_date <= :date_to")
        params["date_to"] = date_to
    metrics = fetch_all(
        """
        SELECT dimension_type, dimension_value, comment_count, distinct_authors,
               positive_count, neutral_count, negative_count,
               CAST(net_sentiment_pct AS CHAR) AS net_sentiment_pct
        FROM analysis_comment_metrics
        WHERE analysis_run_id = :run_id
        ORDER BY (dimension_type = 'overall') DESC, comment_count DESC
        """,
        params,
    )
    terms = fetch_all(
        """
        SELECT dimension_type, dimension_value, sentiment_label, term_type, term,
               count, CAST(share_pct AS CHAR) AS share_pct,
               CAST(lift_score AS CHAR) AS lift_score
        FROM analysis_comment_terms
        WHERE analysis_run_id = :run_id
          AND dimension_type = :dimension_type
          AND dimension_value = :dimension_value
          AND sentiment_label = :sentiment
        ORDER BY term_type, count DESC, term
        """,
        params,
    )
    sentiment_terms = fetch_all(
        """
        SELECT dimension_type, dimension_value, sentiment_label, term_type, term,
               count, CAST(share_pct AS CHAR) AS share_pct,
               CAST(lift_score AS CHAR) AS lift_score
        FROM analysis_comment_terms
        WHERE analysis_run_id = :run_id
          AND dimension_type = :dimension_type
          AND dimension_value = :dimension_value
          AND sentiment_label IN ('positive', 'negative')
          AND term_type = 'word'
        ORDER BY sentiment_label, count DESC, term
        """,
        params,
    )
    topic_features = fetch_all(
        """
        SELECT dimension_type, dimension_value, sentiment_label, term_type, term,
               count, CAST(share_pct AS CHAR) AS share_pct,
               CAST(lift_score AS CHAR) AS lift_score
        FROM analysis_comment_terms
        WHERE analysis_run_id = :run_id
          AND dimension_type = 'query_topic'
          AND sentiment_label = 'all'
          AND term_type = 'word'
          AND lift_score IS NOT NULL
          AND lift_score > 1
          AND (:topic_filter IS NULL OR dimension_value = :topic_filter)
        ORDER BY lift_score DESC, count DESC, term
        LIMIT 100
        """,
        {"run_id": run_id, "topic_filter": topic},
    )
    daily = fetch_all(
        f"""
        SELECT comment_date, dimension_type, dimension_value, comment_count,
               distinct_authors, positive_count, neutral_count, negative_count,
               CAST(net_sentiment_pct AS CHAR) AS net_sentiment_pct
        FROM analysis_comment_daily_metrics
        WHERE {" AND ".join(daily_where)}
        ORDER BY comment_date
        """,
        params,
    )
    return {
        "analysisRunId": run_id,
        "selection": {
            "dimensionType": dimension_type,
            "dimensionValue": dimension_value,
            "sentiment": sentiment,
        },
        "metrics": metrics,
        "selectedMetric": next(
            (
                row
                for row in metrics
                if row["dimension_type"] == dimension_type
                and row["dimension_value"] == dimension_value
            ),
            None,
        ),
        "daily": daily,
        "terms": terms,
        "sentimentTerms": sentiment_terms,
        "topicFeatures": topic_features,
        "filters": {
            "runs": fetch_all(
                """
                SELECT CAST(id AS CHAR) AS id, completed_at, days
                FROM analysis_runs WHERE status = 'success'
                ORDER BY completed_at DESC, id DESC LIMIT 30
                """
            ),
            "topics": fetch_all(
                """
                SELECT DISTINCT dimension_value AS topic
                FROM analysis_comment_metrics
                WHERE analysis_run_id = :run_id AND dimension_type = 'query_topic'
                ORDER BY dimension_value
                """,
                {"run_id": run_id},
            ),
            "videos": fetch_all(
                """
                SELECT m.dimension_value AS post_id, p.title, p.thumbnail_url,
                       c.title AS channel_title, m.comment_count,
                       CAST(m.net_sentiment_pct AS CHAR) AS net_sentiment_pct
                FROM analysis_comment_metrics m
                JOIN posts p ON p.post_id = m.dimension_value
                JOIN channels c ON c.channel_id = p.channel_id
                WHERE m.analysis_run_id = :run_id AND m.dimension_type = 'post'
                ORDER BY m.comment_count DESC
                """,
                {"run_id": run_id},
            ),
        },
    }


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
    batch["quotaBuckets"] = fetch_all(
        """
        SELECT quota_bucket, estimated_units, actual_units
        FROM collection_quota_usage
        WHERE batch_id = :id
        ORDER BY quota_bucket
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


@app.get("/api/skill-analyses")
def skill_analyses() -> dict[str, Any]:
    return {
        "items": fetch_all(
            """
            SELECT CAST(id AS CHAR) AS id, created_at, completed_at, status,
                   locale, question, title,
                   CAST(source_batch_id AS CHAR) AS source_batch_id,
                   CAST(source_analysis_run_id AS CHAR) AS source_analysis_run_id,
                   window_start, window_end, error_summary
            FROM skill_analysis_runs
            ORDER BY created_at DESC, id DESC
            LIMIT 100
            """
        )
    }


@app.get("/api/skill-analyses/{run_id}")
def skill_analysis_detail(run_id: str) -> dict[str, Any]:
    row = fetch_one(
        """
        SELECT CAST(id AS CHAR) AS id, created_at, completed_at, status, locale,
               question, title, CAST(source_batch_id AS CHAR) AS source_batch_id,
               CAST(source_analysis_run_id AS CHAR) AS source_analysis_run_id,
               window_start, window_end, report_markdown, sections_json,
               charts_json, error_summary
        FROM skill_analysis_runs
        WHERE id = :id
        """,
        {"id": run_id},
    )
    if not row:
        raise HTTPException(
            status_code=404,
            detail={"code": "SKILL_ANALYSIS_NOT_FOUND", "message": "Skill analysis was not found"},
        )
    row["sections"] = parse_json(row.pop("sections_json"), {})
    row["charts"] = parse_json(row.pop("charts_json"), [])
    return row


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


CandidateStatus = Literal["suggested", "approved", "rejected", "archived", "all"]


@app.get("/api/keyword-candidates")
async def keyword_candidates(status: CandidateStatus = "suggested") -> dict[str, Any]:
    payload = await asyncio.to_thread(
        run_node_cli,
        ["keywords:list", "--status", status],
    )
    if not payload.get("ok"):
        error = payload.get("error") or {}
        raise HTTPException(
            status_code=400,
            detail={
                "code": error.get("code", "KEYWORD_CANDIDATES_FAILED"),
                "message": error.get("message", "Unable to load keyword candidates"),
            },
        )
    return {"items": payload["result"]}


@app.post("/api/keyword-candidates/suggest", dependencies=[Depends(require_write_request)])
async def suggest_keyword_candidates(_: EmptyBody) -> dict[str, Any]:
    payload = await asyncio.to_thread(run_node_cli, ["keywords:suggest"])
    if not payload.get("ok"):
        error = payload.get("error") or {}
        raise HTTPException(
            status_code=400,
            detail={
                "code": error.get("code", "KEYWORD_SUGGEST_FAILED"),
                "message": error.get("message", "Unable to generate keyword candidates"),
            },
        )
    return payload["result"]


async def _mutate_keyword_candidate(candidate_id: str, command: str) -> dict[str, Any]:
    payload = await asyncio.to_thread(
        run_node_cli,
        [command, "--id", candidate_id],
    )
    if not payload.get("ok"):
        error = payload.get("error") or {}
        raise HTTPException(
            status_code=400,
            detail={
                "code": error.get("code", "KEYWORD_CANDIDATE_MUTATION_FAILED"),
                "message": error.get("message", "Unable to update keyword candidate"),
            },
        )
    return payload["result"]


@app.post("/api/keyword-candidates/{candidate_id}/approve", dependencies=[Depends(require_write_request)])
async def approve_keyword_candidate(candidate_id: str, _: EmptyBody) -> dict[str, Any]:
    return await _mutate_keyword_candidate(candidate_id, "keywords:approve")


@app.post("/api/keyword-candidates/{candidate_id}/reject", dependencies=[Depends(require_write_request)])
async def reject_keyword_candidate(candidate_id: str, _: EmptyBody) -> dict[str, Any]:
    return await _mutate_keyword_candidate(candidate_id, "keywords:reject")


@app.post("/api/keyword-candidates/{candidate_id}/archive", dependencies=[Depends(require_write_request)])
async def archive_keyword_candidate(candidate_id: str, _: EmptyBody) -> dict[str, Any]:
    return await _mutate_keyword_candidate(candidate_id, "keywords:archive")


@app.get("/api/schedule")
async def schedule_status() -> dict[str, Any]:
    payload = await asyncio.to_thread(run_node_cli, ["schedule:status"])
    if not payload.get("ok"):
        error = payload.get("error") or {}
        raise HTTPException(status_code=400, detail={"code": error.get("code", "SCHEDULE_ERROR"), "message": error.get("message", "Unable to read schedule")})
    return payload["result"]


@app.post("/api/schedule", dependencies=[Depends(require_write_request)])
async def schedule_install(body: ScheduleInstallBody) -> dict[str, Any]:
    payload = await asyncio.to_thread(
        run_node_cli,
        [
            "schedule:install",
            "--hour",
            str(body.hour),
            "--minute",
            str(body.minute),
            "--frequency",
            body.frequency,
            "--mode",
            body.mode,
            "--run-analyze",
            "true" if body.runAnalyze else "false",
            "--analyze-days",
            str(body.analyzeDays),
        ],
    )
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
