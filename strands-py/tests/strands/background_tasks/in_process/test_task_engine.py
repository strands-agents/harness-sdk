from __future__ import annotations

import asyncio
import threading
from dataclasses import dataclass

import pytest

from strands.background_tasks.in_process._task_engine import TaskEngine, TaskNotFoundError
from strands.background_tasks.in_process._task_types import (
    TaskCancellation,
    TaskCancelSignal,
    TaskExecutionContext,
    TaskOutcome,
)


@dataclass(frozen=True)
class _Input:
    value: str


@pytest.mark.asyncio
async def test_generic_engine_preserves_consumer_owned_input_and_result() -> None:
    input = _Input("work")
    result = threading.Lock()

    async def execute(context: TaskExecutionContext[_Input]) -> TaskOutcome[object]:
        assert context.input is input
        return {"status": "completed", "result": result}

    engine = TaskEngine[_Input, object](
        max_concurrency=1,
        timeout=1,
        execute=execute,
        on_task_updated=lambda _: None,
    )
    admitted = engine.submit(input)
    assert admitted["input"] is input

    await engine.wait_for_idle()

    completed = engine.get(admitted["task_id"])
    assert completed is not None
    assert completed["result"] is result
    completed["status"] = "cancelled"
    stored = engine.get(admitted["task_id"])
    assert stored is not None
    assert stored["status"] == "completed"


def test_generic_engine_reports_missing_tasks_without_background_tool_types() -> None:
    async def execute(context: TaskExecutionContext[str]) -> TaskOutcome[str]:
        return {"status": "completed", "result": context.input}

    engine = TaskEngine[str, str](
        max_concurrency=1,
        timeout=1,
        execute=execute,
        on_task_updated=lambda _: None,
    )

    with pytest.raises(TaskNotFoundError, match="was not found"):
        engine.cancel("missing", reason="stop")


async def _wait_for_abort(signal: TaskCancellation) -> None:
    aborted = asyncio.Event()
    signal.add_abort_callback(aborted.set)
    await aborted.wait()


@pytest.mark.asyncio
async def test_generic_engine_aborts_default_cancel_signal_with_reason() -> None:
    started = asyncio.Event()
    signals: list[TaskCancellation] = []
    callback_calls: list[str] = []

    async def execute(context: TaskExecutionContext[str]) -> TaskOutcome[str]:
        signals.append(context.cancel_signal)
        removed = lambda: callback_calls.append("removed")  # noqa: E731
        context.cancel_signal.add_abort_callback(removed)
        context.cancel_signal.remove_abort_callback(removed)
        context.cancel_signal.add_abort_callback(lambda: callback_calls.append("aborted"))
        started.set()
        await _wait_for_abort(context.cancel_signal)
        return {"status": "completed", "result": "ignored"}

    engine = TaskEngine[str, str](
        max_concurrency=1,
        timeout=float("inf"),
        execute=execute,
        on_task_updated=lambda _: None,
    )
    task = engine.submit("work")
    await started.wait()

    cancelled = engine.cancel(task["task_id"], reason="stop")
    await engine.wait_for_idle()

    assert cancelled["status"] == "cancelled"
    assert isinstance(signals[0], TaskCancelSignal)
    assert signals[0].aborted
    assert signals[0].reason == "stop"
    assert callback_calls == ["aborted"]
    signals[0].abort("again")
    signals[0].add_abort_callback(lambda: callback_calls.append("late"))
    assert signals[0].reason == "stop"
    assert callback_calls == ["aborted", "late"]


@pytest.mark.asyncio
async def test_generic_engine_times_out_execution() -> None:
    async def execute(context: TaskExecutionContext[str]) -> TaskOutcome[str]:
        await _wait_for_abort(context.cancel_signal)
        return {"status": "completed", "result": "ignored"}

    engine = TaskEngine[str, str](
        max_concurrency=1,
        timeout=0.01,
        execute=execute,
        on_task_updated=lambda _: None,
    )
    task = engine.submit("work")
    await engine.wait_for_idle()

    timed_out = engine.get(task["task_id"])
    assert timed_out is not None
    assert timed_out["status"] == "failed"
    assert timed_out["failure"] == {"type": "timeout", "message": "Timed out after 0.01s"}
