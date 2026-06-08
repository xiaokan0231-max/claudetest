from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import quote
from zoneinfo import ZoneInfo

import google.auth
from google.auth.transport.requests import AuthorizedSession


MONITORING_SCOPE = "https://www.googleapis.com/auth/monitoring.read"
SERVICE_USAGE_SCOPE = "https://www.googleapis.com/auth/cloud-platform.read-only"
SERVICE = "youtube.googleapis.com"
API_BASE = "https://monitoring.googleapis.com/v3"
SERVICE_USAGE_BASE = "https://serviceusage.googleapis.com/v1beta1"
PACIFIC = ZoneInfo("America/Los_Angeles")


QUOTA_EXPLANATIONS = {
    ("youtube.googleapis.com/search_list", "1/d/{project}"): {
        "zh-CN": "每天允许调用 search.list 的次数。每次关键词搜索会消耗这里的 1 次，同时 search.list 也会消耗通用 Queries 单位。",
        "ja-JP": "search.list を 1 日に呼び出せる回数です。キーワード検索 1 回ごとに 1 回消費し、同時に通常の Queries 単位も消費します。",
    },
    ("youtube.googleapis.com/search_list", "1/min/{project}"): {
        "zh-CN": "每分钟允许调用 search.list 的次数，用来防止短时间内搜索请求过快。",
        "ja-JP": "search.list を 1 分間に呼び出せる回数です。短時間の検索リクエスト集中を防ぐための制限です。",
    },
    ("youtube.googleapis.com/default", "1/d/{project}"): {
        "zh-CN": "YouTube Data API 的通用每日单位配额。videos.list、channels.list、commentThreads.list 等常规端点按官方成本消耗这里的单位。",
        "ja-JP": "YouTube Data API の通常の日次ユニット上限です。videos.list、channels.list、commentThreads.list などの通常エンドポイントが公式コストに従って消費します。",
    },
    ("youtube.googleapis.com/default", "1/min/{project}"): {
        "zh-CN": "整个项目每分钟可消耗的通用请求单位上限，主要限制瞬时请求速度。",
        "ja-JP": "プロジェクト全体で 1 分間に消費できる通常リクエスト単位の上限です。瞬間的なリクエスト速度を制限します。",
    },
    ("youtube.googleapis.com/default", "1/min/{project}/{user}"): {
        "zh-CN": "单个终端用户每分钟可消耗的通用请求单位上限。当前应用主要使用 API Key，本页无法按用户拆出实时用量。",
        "ja-JP": "エンドユーザー 1 人あたり 1 分間に消費できる通常リクエスト単位の上限です。このアプリは主に API Key を使うため、ユーザー別のリアルタイム使用量は表示できません。",
    },
    ("youtube.googleapis.com/video_batch_get_stats", "1/d/{project}"): {
        "zh-CN": "Google Console 中的视频批量统计读取配额，通常对应批量获取视频统计类数据的内部配额指标。",
        "ja-JP": "Google Console に表示される動画統計の一括取得クォータです。動画統計データをまとめて取得する内部的な制限指標です。",
    },
    ("youtube.googleapis.com/video_batch_get_stats", "1/min/{project}"): {
        "zh-CN": "视频批量统计读取的每分钟速率限制。",
        "ja-JP": "動画統計の一括取得に対する 1 分あたりのレート制限です。",
    },
    ("youtube.googleapis.com/video_insert", "1/d/{project}"): {
        "zh-CN": "每天允许通过 videos.insert 上传视频的次数。本项目目前只采集公开数据，不上传视频，所以通常为 0。",
        "ja-JP": "videos.insert で 1 日にアップロードできる動画数です。このプロジェクトは公開データ収集のみで動画をアップロードしないため、通常は 0 です。",
    },
    ("youtube.googleapis.com/video_insert", "1/min/{project}"): {
        "zh-CN": "视频上传接口的每分钟速率限制。本项目目前不使用上传接口。",
        "ja-JP": "動画アップロード API の 1 分あたりのレート制限です。このプロジェクトでは現在使用していません。",
    },
}


def _number(point: dict[str, Any]) -> float:
    value = point.get("value") or {}
    for key in ("int64Value", "doubleValue"):
        if key in value:
            return float(value[key])
    return 0.0


def _parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _today_window(now: datetime) -> tuple[datetime, datetime]:
    pacific_now = now.astimezone(PACIFIC)
    start = pacific_now.replace(hour=0, minute=0, second=0, microsecond=0)
    reset = start + timedelta(days=1)
    return start.astimezone(timezone.utc), reset.astimezone(timezone.utc)


def _list_time_series(
    session: AuthorizedSession,
    project: str,
    metric_type: str,
    start: datetime,
    end: datetime,
) -> list[dict[str, Any]]:
    filter_value = (
        f'metric.type="{metric_type}" '
        'resource.type="consumer_quota" '
        f'resource.label."service"="{SERVICE}"'
    )
    url = f"{API_BASE}/projects/{quote(project, safe='')}/timeSeries"
    params = {
        "filter": filter_value,
        "interval.startTime": start.isoformat().replace("+00:00", "Z"),
        "interval.endTime": end.isoformat().replace("+00:00", "Z"),
        "view": "FULL",
        "pageSize": "1000",
    }
    output: list[dict[str, Any]] = []
    while True:
        response = session.get(url, params=params, timeout=15)
        response.raise_for_status()
        payload = response.json()
        output.extend(payload.get("timeSeries", []))
        token = payload.get("nextPageToken")
        if not token:
            return output
        params["pageToken"] = token


def _labels(series: dict[str, Any]) -> tuple[str, str, str]:
    metric_labels = (series.get("metric") or {}).get("labels") or {}
    resource_labels = (series.get("resource") or {}).get("labels") or {}
    return (
        metric_labels.get("quota_metric", "unknown"),
        metric_labels.get("limit_name", "unknown"),
        resource_labels.get("location", "global"),
    )


def _quota_period(unit: str, limit_name: str) -> str:
    value = f"{unit} {limit_name}".lower()
    if "/d/" in value or "perday" in value or "day" in value:
        return "day"
    if "/min/" in value or "perminute" in value or "minute" in value:
        return "minute"
    return "other"


def _quota_scope(unit: str) -> str:
    if "{user}" in unit:
        return "project_user"
    if "{project}" in unit:
        return "project"
    return "global"


def _quota_display_name(metric_display: str, unit: str) -> str:
    period = _quota_period(unit, "")
    scope = _quota_scope(unit)
    suffix = {
        ("day", "project"): "per day",
        ("minute", "project"): "per minute",
        ("minute", "project_user"): "per minute per user",
        ("day", "project_user"): "per day per user",
    }.get((period, scope))
    return f"{metric_display} {suffix}" if suffix else metric_display


def _quota_sort_key(item: dict[str, Any]) -> tuple[int, str]:
    preferred = {
        ("youtube.googleapis.com/search_list", "day", "project"): 0,
        ("youtube.googleapis.com/default", "day", "project"): 1,
        ("youtube.googleapis.com/video_batch_get_stats", "day", "project"): 2,
        ("youtube.googleapis.com/video_batch_get_stats", "minute", "project"): 3,
        ("youtube.googleapis.com/video_insert", "day", "project"): 4,
        ("youtube.googleapis.com/video_insert", "minute", "project"): 5,
        ("youtube.googleapis.com/default", "minute", "project"): 6,
        ("youtube.googleapis.com/search_list", "minute", "project"): 7,
        ("youtube.googleapis.com/default", "minute", "project_user"): 8,
    }
    return (
        preferred.get((item["quotaMetric"], item["period"], item["scope"]), 99),
        item["displayName"],
    )


def _list_consumer_quota_metrics(
    session: AuthorizedSession,
    project: str,
) -> list[dict[str, Any]]:
    url = (
        f"{SERVICE_USAGE_BASE}/projects/{quote(project, safe='')}"
        f"/services/{SERVICE}/consumerQuotaMetrics"
    )
    params = {"view": "FULL", "pageSize": "500"}
    output: list[dict[str, Any]] = []
    while True:
        response = session.get(url, params=params, timeout=15)
        response.raise_for_status()
        payload = response.json()
        output.extend(payload.get("metrics", []))
        token = payload.get("nextPageToken")
        if not token:
            return output
        params["pageToken"] = token


def _build_quota_catalog(project: str) -> list[dict[str, Any]]:
    credentials, _ = google.auth.default(scopes=[SERVICE_USAGE_SCOPE])
    session = AuthorizedSession(credentials)
    metrics = _list_consumer_quota_metrics(session, project)
    catalog: list[dict[str, Any]] = []
    for metric in metrics:
        metric_name = metric.get("metric") or "unknown"
        metric_display = metric.get("displayName") or metric_name
        for limit in metric.get("consumerQuotaLimits", []):
            unit = limit.get("unit") or ""
            bucket = (limit.get("quotaBuckets") or [{}])[0]
            raw_limit = bucket.get("effectiveLimit") or bucket.get("defaultLimit")
            try:
                limit_value = float(raw_limit)
            except (TypeError, ValueError):
                continue
            if limit_value <= 0:
                continue
            period = _quota_period(unit, limit.get("name", ""))
            scope = _quota_scope(unit)
            explanation = QUOTA_EXPLANATIONS.get((metric_name, unit), {})
            catalog.append(
                {
                    "id": f'{metric_name}:{unit}:{scope}',
                    "quotaMetric": metric_name,
                    "metricDisplayName": metric_display,
                    "limitName": limit.get("name", "").rsplit("/", 1)[-1],
                    "displayName": _quota_display_name(metric_display, unit),
                    "unit": unit,
                    "period": period,
                    "scope": scope,
                    "location": "global",
                    "limit": limit_value,
                    "defaultLimit": float(bucket.get("defaultLimit") or limit_value),
                    "adjustable": True,
                    "description": explanation.get("zh-CN", ""),
                    "descriptionJa": explanation.get("ja-JP", explanation.get("zh-CN", "")),
                }
            )
    catalog.sort(key=_quota_sort_key)
    return catalog


def fetch_google_quota(project: str, now: datetime | None = None) -> dict[str, Any]:
    if not project:
        return {
            "status": "unavailable",
            "errorCode": "GOOGLE_CLOUD_PROJECT_MISSING",
            "message": "GOOGLE_CLOUD_PROJECT is not configured",
            "buckets": [],
        }
    now = now or datetime.now(timezone.utc)
    start, reset = _today_window(now)
    catalog = _build_quota_catalog(project)
    credentials, _ = google.auth.default(scopes=[MONITORING_SCOPE])
    session = AuthorizedSession(credentials)
    usage_series = _list_time_series(
        session,
        project,
        "serviceruntime.googleapis.com/quota/rate/net_usage",
        start,
        now,
    )
    limit_series = _list_time_series(
        session,
        project,
        "serviceruntime.googleapis.com/quota/limit",
        start - timedelta(days=1),
        now,
    )

    usage: dict[tuple[str, str], float] = defaultdict(float)
    latest_usage: dict[tuple[str, str], float] = {}
    latest_at: datetime | None = None
    for series in usage_series:
        quota_metric, _, location = _labels(series)
        latest_point: tuple[datetime, float] | None = None
        for point in series.get("points", []):
            end_time = _parse_time((point.get("interval") or {}).get("endTime"))
            if end_time and end_time >= start:
                value = _number(point)
                usage[(quota_metric, location)] += value
                if latest_point is None or end_time > latest_point[0]:
                    latest_point = (end_time, value)
                if latest_at is None or end_time > latest_at:
                    latest_at = end_time
        if latest_point:
            latest_usage[(quota_metric, location)] = latest_point[1]

    limits: list[dict[str, Any]] = []
    for series in limit_series:
        quota_metric, limit_name, location = _labels(series)
        points = series.get("points", [])
        if not points:
            continue
        point = max(
            points,
            key=lambda item: (item.get("interval") or {}).get("endTime", ""),
        )
        limit = _number(point)
        if limit <= 0:
            continue
        limits.append(
            {
                "quotaMetric": quota_metric,
                "limitName": limit_name,
                "location": location,
                "limit": limit,
            }
        )

    if not catalog:
        for item in limits:
            period = _quota_period("", item["limitName"])
            catalog.append(
                {
                    "id": f'{item["quotaMetric"]}:{item["limitName"]}:{item["location"]}',
                    **item,
                    "metricDisplayName": item["quotaMetric"],
                    "displayName": item["limitName"],
                    "unit": "",
                    "period": period,
                    "scope": "project",
                    "defaultLimit": item["limit"],
                    "adjustable": True,
                    "description": "",
                    "descriptionJa": "",
                }
            )

    buckets = []
    for item in catalog:
        if item["scope"] == "project_user":
            used = None
        elif item["period"] == "day":
            used = usage[(item["quotaMetric"], item["location"])]
        elif item["period"] == "minute":
            used = latest_usage.get((item["quotaMetric"], item["location"]), 0.0)
        else:
            used = usage[(item["quotaMetric"], item["location"])]
        limit = item["limit"]
        used_number = float(used or 0)
        remaining = None if used is None else max(0.0, limit - used_number)
        buckets.append(
            {
                **item,
                "used": used,
                "remaining": remaining,
                "usageRatio": used_number / limit if limit and used is not None else None,
            }
        )
    buckets.sort(key=_quota_sort_key)
    total_daily_limit = sum(item["limit"] for item in buckets if item["period"] == "day")
    total_daily_used = sum(float(item["used"] or 0) for item in buckets if item["period"] == "day")
    total_daily_remaining = max(0.0, total_daily_limit - total_daily_used)
    stale = latest_at is None or now - latest_at > timedelta(minutes=30)
    return {
        "status": "stale" if stale else "available",
        "project": project,
        "asOf": latest_at.isoformat().replace("+00:00", "Z") if latest_at else None,
        "resetAt": reset.isoformat().replace("+00:00", "Z"),
        "buckets": buckets,
        "summary": {
            "dailyLimit": total_daily_limit,
            "dailyUsed": total_daily_used,
            "dailyRemaining": total_daily_remaining,
            "dailyUsageRatio": total_daily_used / total_daily_limit if total_daily_limit else None,
            "bucketCount": len(buckets),
        },
        "consoleUrl": (
            "https://console.cloud.google.com/iam-admin/quotas"
            f"?project={quote(project, safe='')}"
        ),
    }
