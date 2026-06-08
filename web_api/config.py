from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy.engine import URL


PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")


def _integer(name: str, default: int) -> int:
    raw = os.getenv(name, str(default))
    value = int(raw)
    if value < 1:
        raise ValueError(f"{name} must be positive")
    return value


@dataclass(frozen=True)
class Settings:
    project_root: Path = PROJECT_ROOT
    mysql_host: str = os.getenv("MYSQL_HOST", "localhost")
    mysql_port: int = _integer("MYSQL_PORT", 3306)
    mysql_database: str = os.getenv("MYSQL_DATABASE", "sns_trend_lab")
    mysql_user: str = os.getenv("MYSQL_USER", "sns_collector")
    mysql_password: str = os.getenv("MYSQL_PASSWORD", "")
    quota_budget: int = _integer("SNS_QUOTA_BUDGET", 1000)
    search_quota_budget: int = _integer("SNS_SEARCH_QUOTA_BUDGET", 100)
    timezone: str = os.getenv("SNS_TIMEZONE", "Asia/Tokyo")
    youtube_api_configured: bool = bool(os.getenv("YOUTUBE_API_KEY"))
    google_cloud_project: str = os.getenv("GOOGLE_CLOUD_PROJECT", "")

    @property
    def database_url(self) -> URL:
        return URL.create(
            "mysql+pymysql",
            username=self.mysql_user,
            password=self.mysql_password,
            host=self.mysql_host,
            port=self.mysql_port,
            database=self.mysql_database,
            query={"charset": "utf8mb4"},
        )


settings = Settings()
