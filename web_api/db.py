from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Iterable

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine, RowMapping

from .config import settings


engine = create_engine(
    settings.database_url,
    pool_pre_ping=True,
    pool_recycle=1800,
    future=True,
)


def serialize_value(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, bytes):
        return value.decode("utf-8")
    return value


def serialize_row(row: RowMapping) -> dict[str, Any]:
    return {key: serialize_value(value) for key, value in row.items()}


def serialize_rows(rows: Iterable[RowMapping]) -> list[dict[str, Any]]:
    return [serialize_row(row) for row in rows]


def fetch_all(
    sql: str,
    params: dict[str, Any] | None = None,
    *,
    db_engine: Engine = engine,
) -> list[dict[str, Any]]:
    with db_engine.connect() as connection:
        rows = connection.execute(text(sql), params or {}).mappings().all()
    return serialize_rows(rows)


def fetch_one(
    sql: str,
    params: dict[str, Any] | None = None,
    *,
    db_engine: Engine = engine,
) -> dict[str, Any] | None:
    with db_engine.connect() as connection:
        row = connection.execute(text(sql), params or {}).mappings().first()
    return serialize_row(row) if row else None
