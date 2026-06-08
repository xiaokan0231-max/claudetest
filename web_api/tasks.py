from __future__ import annotations

import asyncio
import json
import os
import subprocess
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import text

from .config import settings
from .db import engine


ACTIVE_STATUSES = ("queued", "running")


def utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def sanitize_message(message: str) -> str:
    clean = message
    for secret_name in ("YOUTUBE_API_KEY", "MYSQL_PASSWORD", "MYSQL_ADMIN_PASSWORD"):
        secret = os.getenv(secret_name)
        if secret:
            clean = clean.replace(secret, "[redacted]")
    return clean[:4000]


def parse_cli_payload(stdout: str, stderr: str) -> dict[str, Any]:
    for stream in (stdout, stderr):
        for line in reversed(stream.splitlines()):
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(payload, dict) and "ok" in payload:
                return payload
    return {
        "ok": False,
        "error": {
            "code": "NODE_CLI_ERROR",
            "message": sanitize_message(stderr or stdout or "Node CLI returned no JSON output"),
        },
    }


def run_node_cli(args: list[str]) -> dict[str, Any]:
    command = [os.environ.get("NODE_BINARY", "node"), "src/cli.js", *args, "--json"]
    result = subprocess.run(
        command,
        cwd=settings.project_root,
        capture_output=True,
        text=True,
        shell=False,
        check=False,
        timeout=3600,
    )
    payload = parse_cli_payload(result.stdout, result.stderr)
    if result.returncode != 0 and payload.get("ok") is True:
        return {
            "ok": False,
            "error": {
                "code": "NODE_CLI_ERROR",
                "message": "Node CLI exited unsuccessfully",
            },
        }
    return payload


def create_operation(operation_type: str, parameters: dict[str, Any]) -> str:
    request_id = str(uuid.uuid4())
    with engine.begin() as connection:
        active = connection.execute(
            text(
                "SELECT id FROM operation_requests "
                "WHERE status IN ('queued', 'running') LIMIT 1"
            )
        ).first()
        if active:
            error = RuntimeError("Another web operation is already active")
            error.code = "OPERATION_CONFLICT"  # type: ignore[attr-defined]
            raise error
        connection.execute(
            text(
                """
                INSERT INTO operation_requests
                  (id, operation_type, status, parameters_json, requested_at)
                VALUES (:id, :operation_type, 'queued', :parameters_json, :requested_at)
                """
            ),
            {
                "id": request_id,
                "operation_type": operation_type,
                "parameters_json": json.dumps(parameters, ensure_ascii=False),
                "requested_at": utc_now(),
            },
        )
    return request_id


async def execute_operation(
    request_id: str,
    operation_type: str,
    parameters: dict[str, Any],
) -> None:
    with engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE operation_requests "
                "SET status = 'running', started_at = :started_at WHERE id = :id"
            ),
            {"id": request_id, "started_at": utc_now()},
        )

    if operation_type == "collect":
        args = ["collect", "--trigger", "web", "--request-id", request_id]
        mode = parameters.get("mode")
        if mode in {"standard", "balanced"}:
            args.extend(["--mode", mode])
    elif operation_type == "analyze":
        args = [
            "analyze",
            "--days",
            str(parameters["days"]),
            "--trigger",
            "web",
            "--request-id",
            request_id,
        ]
    else:
        payload = {
            "ok": False,
            "error": {"code": "INVALID_OPERATION", "message": "Unsupported operation"},
        }
        args = []

    if args:
        payload = await asyncio.to_thread(run_node_cli, args)

    status = "success" if payload.get("ok") else "failed"
    error = payload.get("error") or {}
    error_summary = None
    if status == "failed":
        error_summary = sanitize_message(
            f"{error.get('code', 'NODE_CLI_ERROR')}: {error.get('message', 'Operation failed')}"
        )
    with engine.begin() as connection:
        connection.execute(
            text(
                """
                UPDATE operation_requests
                SET status = :status, completed_at = :completed_at,
                    error_summary = :error_summary
                WHERE id = :id
                """
            ),
            {
                "id": request_id,
                "status": status,
                "completed_at": utc_now(),
                "error_summary": error_summary,
            },
        )


def launch_operation(operation_type: str, parameters: dict[str, Any]) -> str:
    loop = asyncio.get_running_loop()
    request_id = create_operation(operation_type, parameters)
    loop.create_task(execute_operation(request_id, operation_type, parameters))
    return request_id
