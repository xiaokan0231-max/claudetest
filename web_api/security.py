from __future__ import annotations

import secrets
from urllib.parse import urlsplit

from fastapi import HTTPException, Request


ACTION_TOKEN = secrets.token_urlsafe(32)
LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}


def _origin_is_local(origin: str | None) -> bool:
    if not origin:
        return False
    parsed = urlsplit(origin)
    return parsed.scheme in {"http", "https"} and parsed.hostname in LOCAL_HOSTS


async def require_write_request(request: Request) -> None:
    content_type = request.headers.get("content-type", "")
    if not content_type.lower().startswith("application/json"):
        raise HTTPException(
            status_code=415,
            detail={"code": "JSON_REQUIRED", "message": "JSON Content-Type is required"},
        )
    if not _origin_is_local(request.headers.get("origin")):
        raise HTTPException(
            status_code=403,
            detail={"code": "ORIGIN_REJECTED", "message": "Local same-origin request required"},
        )
    if request.headers.get("x-action-token") != ACTION_TOKEN:
        raise HTTPException(
            status_code=403,
            detail={"code": "ACTION_TOKEN_INVALID", "message": "Action token is invalid"},
        )
