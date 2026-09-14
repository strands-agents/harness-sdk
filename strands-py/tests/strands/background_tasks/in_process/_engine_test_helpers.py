from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any
from unittest.mock import ANY

from strands.background_tasks.in_process._engine import InProcessTaskEngine
from strands.background_tasks.in_process._types import (
    InProcessTaskExecutionContext,
    InProcessTaskExecutionOutcome,
    InProcessTaskRecord,
)
from strands.types.tools import ToolResult


def create_engine(
    execute: Callable[[InProcessTaskExecutionContext], Awaitable[InProcessTaskExecutionOutcome]],
    *,
    max_concurrency: int = 2,
    timeout: float = 1.0,
    on_task_updated: Callable[[InProcessTaskRecord], None] | None = None,
) -> InProcessTaskEngine:
    return InProcessTaskEngine(
        max_concurrency=max_concurrency,
        timeout=timeout,
        execute=execute,
        on_task_updated=on_task_updated or (lambda _: None),
    )


def create_admission(value: str) -> dict[str, str]:
    return {
        "tool_use_id": value,
        "tool_name": value,
        "invocation_state_id": value,
    }


def create_result(value: str) -> ToolResult:
    return {
        "toolUseId": value,
        "status": "success",
        "content": [{"text": value}],
    }


def create_state(value: str) -> dict[str, Any]:
    return {
        "interrupts": {
            value: {
                "id": value,
                "name": value,
            }
        },
        "activated": True,
    }


def get_state_value(state: dict[str, Any]) -> str:
    return next(iter(state["interrupts"]))


def assert_task(
    actual: InProcessTaskRecord | None,
    task: InProcessTaskRecord,
    fields: dict[str, Any],
) -> None:
    exp_task = {
        "task_id": task["task_id"],
        "tool_use_id": task["tool_use_id"],
        "tool_name": task["tool_name"],
        "invocation_state_id": task["invocation_state_id"],
        **fields,
        "created_at": task["created_at"],
        "last_updated_at": ANY,
    }
    assert actual == exp_task


def deferred() -> tuple[
    asyncio.Future[InProcessTaskExecutionOutcome],
    Callable[[InProcessTaskExecutionOutcome], None],
]:
    future = asyncio.get_running_loop().create_future()
    return future, future.set_result
