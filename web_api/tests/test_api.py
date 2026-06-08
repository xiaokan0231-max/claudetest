from fastapi.testclient import TestClient

from web_api.main import app
import web_api.main as main_module


client = TestClient(app)


def test_system_status_does_not_leak_secrets():
    response = client.get("/api/system/status")
    assert response.status_code == 200
    payload = response.json()
    text = response.text
    assert payload["database"] == "sns_trend_lab"
    assert "MYSQL_PASSWORD" not in text
    assert "YOUTUBE_API_KEY" not in text
    assert "password" not in text.lower()


def test_write_operations_require_json_origin_and_action_token():
    response = client.post("/api/actions/analyze", json={"days": 30})
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "ORIGIN_REJECTED"

    token = client.get("/api/system/status").json()["actionToken"]
    response = client.post(
        "/api/actions/analyze",
        headers={"Origin": "https://example.com", "X-Action-Token": token},
        json={"days": 30},
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "ORIGIN_REJECTED"


def test_dashboard_and_default_video_scope_use_real_database():
    dashboard = client.get("/api/dashboard")
    videos = client.get("/api/videos")
    assert dashboard.status_code == 200
    assert videos.status_code == 200
    assert dashboard.json()["analysisRunId"]
    assert int(videos.json()["total"]) == int(
        dashboard.json()["stats"]["keyword_sample_videos"]
    )
    assert videos.json()["items"]
    assert isinstance(videos.json()["items"][0]["latest_views"], str)


def test_report_locale_and_schedule_response_are_safe():
    reports = client.get("/api/reports").json()["items"]
    assert reports
    detail = client.get(f"/api/reports/{reports[0]['id']}?locale=ja-JP")
    assert detail.status_code == 200
    assert detail.json()["actualLocale"] in {"zh-CN", "ja-JP"}

    schedule = client.get("/api/schedule")
    assert schedule.status_code == 200
    assert "details" not in schedule.json()


def test_quota_endpoint_returns_google_buckets_without_secret_leak(monkeypatch):
    monkeypatch.setattr(
        main_module,
        "fetch_google_quota",
        lambda project: {
            "status": "available",
            "project": project,
            "asOf": "2026-06-03T00:00:00Z",
            "resetAt": "2026-06-04T07:00:00Z",
            "buckets": [
                {
                    "id": "youtube:daily",
                    "quotaMetric": "youtube.googleapis.com/default",
                    "limitName": "defaultPerDay",
                    "used": 12,
                    "limit": 10000,
                    "remaining": 9988,
                    "usageRatio": 0.0012,
                }
            ],
        },
    )
    response = client.get("/api/system/quota")
    assert response.status_code == 200
    assert response.json()["buckets"][0]["remaining"] == 9988
    assert "YOUTUBE_API_KEY" not in response.text


def test_comment_insights_and_skill_analysis_endpoints_are_read_only():
    comments = client.get("/api/comment-insights")
    skills = client.get("/api/skill-analyses")
    assert comments.status_code == 200
    assert comments.json()["analysisRunId"]
    assert comments.json()["metrics"]
    assert "sentimentTerms" in comments.json()
    assert "topicFeatures" in comments.json()
    assert skills.status_code == 200
