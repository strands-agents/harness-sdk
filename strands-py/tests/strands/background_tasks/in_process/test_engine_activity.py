"""Activity history for in-process background tasks."""

from __future__ import annotations

import asyncio
from unittest.mock import ANY

import pytest

from strands.background_tasks._errors import BackgroundTaskNotFoundError
from strands.background_tasks.in_process._types import InProcessTaskExecutionContext, InProcessTaskExecutionOutcome

from ._engine_test_helpers import create_admission, create_engine, create_result, deferred


@pytest.mark.asyncio
async def test_get_activity_records_lifecycle_and_typed_progress() -> None:
    finish, resolve = deferred()

    async def execute(_: InProcessTaskExecutionContext) -> InProcessTaskExecutionOutcome:
        return await finish

    engine = create_engine(execute)
    task = engine.submit(**create_admission("work"))
    await asyncio.sleep(0)
    task_id = task["task_id"]
    engine.report_progress(task_id, "starting a tool", activity_type="tool_request")
    engine.report_progress(task_id, "tool finished", activity_type="tool_result")
    engine.report_progress(task_id, "still working")
    resolve({"status": "completed", "result": create_result("done")})
    await engine.wait_for_idle()

    tru_history = engine.get_activity(task_id)
    exp_history = {
        "events": [
            {"sequence": 1, "timestamp": ANY, "type": "lifecycle", "message": "queued"},
            {"sequence": 2, "timestamp": ANY, "type": "lifecycle", "message": "working"},
            {"sequence": 3, "timestamp": ANY, "type": "tool_request", "message": "starting a tool"},
            {"sequence": 4, "timestamp": ANY, "type": "tool_result", "message": "tool finished"},
            {"sequence": 5, "timestamp": ANY, "type": "progress", "message": "still working"},
            {"sequence": 6, "timestamp": ANY, "type": "lifecycle", "message": "completed"},
        ],
        "first_available_sequence": 1,
        "last_sequence": 6,
        "truncated": False,
    }
    assert tru_history == exp_history
    assert engine.get_activity(task_id, after_sequence=5)["events"] == exp_history["events"][5:]
    assert engine.get_activity(task_id, after_sequence=6)["events"] == []
    assert engine.get(task_id) == {
        **task,
        "status": "completed",
        "last_updated_at": ANY,
        "progress": {"message": "still working", "update_count": 3, "updated_at": ANY},
        "result": create_result("done"),
    }


@pytest.mark.asyncio
async def test_get_activity_bounds_history_and_detects_truncation() -> None:
    finish, resolve = deferred()

    async def execute(_: InProcessTaskExecutionContext) -> InProcessTaskExecutionOutcome:
        return await finish

    engine = create_engine(execute)
    task = engine.submit(**create_admission("work"))
    await asyncio.sleep(0)
    task_id = task["task_id"]
    for count in range(105):
        engine.report_progress(task_id, "x" * 600 if count == 104 else f"event {count}")

    tru_history = engine.get_activity(task_id)
    assert len(tru_history["events"]) == 100
    assert tru_history["first_available_sequence"] == 8
    assert tru_history["last_sequence"] == 107
    assert tru_history["truncated"] is True
    assert tru_history["events"][0]["message"] == "event 5"
    assert tru_history["events"][-1]["message"] == "x" * 512
    assert engine.get_activity(task_id, after_sequence=7)["truncated"] is False
    assert len(engine.get_activity(task_id, after_sequence=106)["events"]) == 1

    engine.cancel(task_id, reason="done")
    resolve({"status": "completed", "result": create_result("late")})
    await engine.wait_for_idle()


@pytest.mark.asyncio
async def test_get_activity_rejects_invalid_cursor_and_returns_copies() -> None:
    finish, resolve = deferred()

    async def execute(_: InProcessTaskExecutionContext) -> InProcessTaskExecutionOutcome:
        return await finish

    engine = create_engine(execute)
    task = engine.submit(**create_admission("work"))
    task_id = task["task_id"]
    for cursor in (True, -1, 1.0, "1", 2):
        with pytest.raises(ValueError, match="after_sequence"):
            engine.get_activity(task_id, after_sequence=cursor)  # type: ignore[arg-type]

    history = engine.get_activity(task_id)
    history["events"][0]["message"] = "mutated"
    history["events"].clear()
    assert engine.get_activity(task_id)["events"][0]["message"] == "queued"

    engine.cancel(task_id, reason="done")
    resolve({"status": "completed", "result": create_result("late")})
    await engine.wait_for_idle()


@pytest.mark.asyncio
async def test_report_progress_ignores_terminal_and_removed_tasks() -> None:
    async def execute(_: InProcessTaskExecutionContext) -> InProcessTaskExecutionOutcome:
        return {"status": "completed", "result": create_result("done")}

    engine = create_engine(execute)
    task = engine.submit(**create_admission("work"))
    await engine.wait_for_idle()
    task_id = task["task_id"]
    last_sequence = engine.get_activity(task_id)["last_sequence"]

    engine.report_progress(task_id, "late")
    assert engine.get_activity(task_id)["last_sequence"] == last_sequence
    engine.remove(task_id)
    engine.report_progress(task_id, "later")
    with pytest.raises(BackgroundTaskNotFoundError, match="was not found"):
        engine.get_activity(task_id)
