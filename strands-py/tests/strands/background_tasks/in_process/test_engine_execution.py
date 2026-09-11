from __future__ import annotations

import asyncio
import math
import threading
from unittest.mock import ANY

import pytest

from strands.background_tasks.in_process._types import (
    CancelSignal,
    InProcessTaskExecutionContext,
    InProcessTaskExecutionOutcome,
    InProcessTaskRecord,
)

from ._engine_test_helpers import (
    assert_task,
    create_admission,
    create_engine,
    create_result,
    deferred,
)


@pytest.mark.asyncio
async def test_admission_and_updates_prevent_callbacks_from_mutating_engine_state() -> None:
    statuses: list[str] = []

    async def execute(context: InProcessTaskExecutionContext) -> InProcessTaskExecutionOutcome:
        return {"status": "completed", "result": create_result(context.tool_name.upper())}

    def on_task_updated(task: InProcessTaskRecord) -> None:
        statuses.append(task["status"])
        if task["status"] == "working":
            task["status"] = "cancelled"
        if task["status"] == "completed":
            raise RuntimeError("notification failed")

    engine = create_engine(execute, on_task_updated=on_task_updated)
    admitted = engine.submit(**create_admission("hello"))

    admitted["status"] = "cancelled"
    await engine.wait_for_idle()
    completed = engine.get(admitted["task_id"])
    assert_task(completed, admitted, {"status": "completed", "result": create_result("HELLO")})

    tru_tasks = engine.list()
    exp_tasks = [completed]
    assert tru_tasks == exp_tasks

    tru_statuses = statuses
    exp_statuses = ["queued", "working", "completed"]
    assert tru_statuses == exp_statuses

    assert completed is not None
    completed["status"] = "cancelled"
    engine.list()[0]["status"] = "failed"
    assert_task(
        engine.get(admitted["task_id"]),
        admitted,
        {"status": "completed", "result": create_result("HELLO")},
    )

    engine.remove(admitted["task_id"])
    tru_tasks = engine.list()
    exp_tasks = []
    assert tru_tasks == exp_tasks


@pytest.mark.asyncio
async def test_execution_bounds_concurrency() -> None:
    releases = [deferred(), deferred(), deferred()]
    started = [asyncio.Event(), asyncio.Event(), asyncio.Event()]

    async def execute(context: InProcessTaskExecutionContext) -> InProcessTaskExecutionOutcome:
        index = int(context.tool_name)
        started[index].set()
        return await releases[index][0]

    engine = create_engine(execute, max_concurrency=2)
    tasks = [engine.submit(**create_admission(str(index))) for index in range(3)]
    await asyncio.gather(started[0].wait(), started[1].wait())
    assert_task(engine.get(tasks[2]["task_id"]), tasks[2], {"status": "queued"})

    releases[0][1]({"status": "completed", "result": create_result("0")})
    await started[2].wait()
    releases[1][1]({"status": "completed", "result": create_result("1")})
    releases[2][1]({"status": "completed", "result": create_result("2")})
    await engine.wait_for_idle()


@pytest.mark.asyncio
async def test_execution_propagates_asyncio_cancellation() -> None:
    started = asyncio.Event()
    execution_task: asyncio.Task[None] | None = None

    async def execute(_: InProcessTaskExecutionContext) -> InProcessTaskExecutionOutcome:
        nonlocal execution_task
        execution_task = asyncio.current_task()
        started.set()
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    engine = create_engine(execute)
    task = engine.submit(**create_admission("cancel"))
    await started.wait()
    assert execution_task is not None

    engine.cancel(task["task_id"], reason="Stop work")
    execution_task.cancel()
    await engine.wait_for_idle()

    assert execution_task.cancelled()
    assert_task(engine.get(task["task_id"]), task, {"status": "cancelled"})


@pytest.mark.asyncio
async def test_execution_records_classified_failures() -> None:
    async def throw_error(_: InProcessTaskExecutionContext) -> InProcessTaskExecutionOutcome:
        raise TypeError("Execution exploded")

    thrown_engine = create_engine(throw_error)
    thrown = thrown_engine.submit(**create_admission("throw"))
    await thrown_engine.wait_for_idle()
    assert_task(
        thrown_engine.get(thrown["task_id"]),
        thrown,
        {"status": "failed", "failure": {"type": "execution_error", "message": "Execution exploded"}},
    )

    class OpaqueError(Exception):
        def __str__(self) -> str:
            raise RuntimeError("cannot stringify")

    async def throw_opaque(_: InProcessTaskExecutionContext) -> InProcessTaskExecutionOutcome:
        raise OpaqueError

    opaque_engine = create_engine(throw_opaque)
    opaque = opaque_engine.submit(**create_admission("opaque"))
    await opaque_engine.wait_for_idle()
    assert_task(
        opaque_engine.get(opaque["task_id"]),
        opaque,
        {
            "status": "failed",
            "failure": {"type": "execution_error", "message": "Background task execution failed"},
        },
    )

    async def return_failure(_: InProcessTaskExecutionContext) -> InProcessTaskExecutionOutcome:
        return {
            "status": "failed",
            "failure": {"type": "tool_error", "message": "Tool failed"},
            "result": create_result("tool detail"),
        }

    returned_engine = create_engine(return_failure)
    returned = returned_engine.submit(**create_admission("return"))
    await returned_engine.wait_for_idle()
    assert_task(
        returned_engine.get(returned["task_id"]),
        returned,
        {
            "status": "failed",
            "failure": {"type": "tool_error", "message": "Tool failed"},
            "result": create_result("tool detail"),
        },
    )

    async def return_uncopyable(_: InProcessTaskExecutionContext) -> InProcessTaskExecutionOutcome:
        return {
            "status": "completed",
            "result": {
                "toolUseId": "uncopyable",
                "status": "success",
                "content": [{"json": {"handle": threading.Lock()}}],
            },
        }

    uncopyable_engine = create_engine(return_uncopyable)
    uncopyable = uncopyable_engine.submit(**create_admission("uncopyable"))
    await uncopyable_engine.wait_for_idle()
    assert_task(
        uncopyable_engine.get(uncopyable["task_id"]),
        uncopyable,
        {
            "status": "failed",
            "failure": {"type": "execution_error", "message": ANY},
        },
    )


@pytest.mark.asyncio
async def test_execution_timeout_retains_capacity_until_execution_settles() -> None:
    release, resolve = deferred()
    timed_out = asyncio.Event()
    hung_signal: CancelSignal | None = None

    async def execute(context: InProcessTaskExecutionContext) -> InProcessTaskExecutionOutcome:
        nonlocal hung_signal
        if context.tool_name == "hang":
            hung_signal = context.cancel_signal
            while not context.cancel_signal.aborted:
                await asyncio.sleep(0)
            timed_out.set()
            return await release
        return {"status": "completed", "result": create_result("next")}

    engine = create_engine(execute, max_concurrency=1, timeout=0.01)
    hung = engine.submit(**create_admission("hang"))
    next_task = engine.submit(**create_admission("next"))
    await timed_out.wait()
    try:
        tru_aborted = hung_signal is not None and hung_signal.aborted
        exp_aborted = True
        assert tru_aborted == exp_aborted
        assert_task(engine.get(next_task["task_id"]), next_task, {"status": "queued"})
    finally:
        resolve({"status": "completed", "result": create_result("late")})

    await engine.wait_for_idle()
    assert_task(
        engine.get(next_task["task_id"]),
        next_task,
        {"status": "completed", "result": create_result("next")},
    )
    assert_task(
        engine.get(hung["task_id"]),
        hung,
        {"status": "failed", "failure": {"type": "timeout", "message": "Timed out after 0.01s"}},
    )


@pytest.mark.asyncio
async def test_execution_infinity_disables_timeouts(monkeypatch: pytest.MonkeyPatch) -> None:
    finish, resolve = deferred()

    async def execute(_: InProcessTaskExecutionContext) -> InProcessTaskExecutionOutcome:
        return await finish

    loop = asyncio.get_running_loop()
    call_later = loop.call_later

    def fail_call_later(*_: object) -> None:
        raise AssertionError("timeout scheduled")

    monkeypatch.setattr(loop, "call_later", fail_call_later)
    engine = create_engine(execute, timeout=math.inf)
    task = engine.submit(**create_admission("work"))
    await asyncio.sleep(0)
    monkeypatch.setattr(loop, "call_later", call_later)

    resolve({"status": "completed", "result": create_result("done")})
    await engine.wait_for_idle()
    assert_task(engine.get(task["task_id"]), task, {"status": "completed", "result": create_result("done")})
