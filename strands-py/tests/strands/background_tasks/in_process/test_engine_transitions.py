from __future__ import annotations

import asyncio

import pytest

from strands.background_tasks._errors import BackgroundTaskNotFoundError
from strands.background_tasks.in_process._engine import InProcessTaskEngine
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
    create_state,
    deferred,
    get_state_value,
)


@pytest.mark.asyncio
async def test_wait_for_idle_cancels_observation_without_cancelling_work() -> None:
    finish, resolve = deferred()

    async def execute(_: InProcessTaskExecutionContext) -> InProcessTaskExecutionOutcome:
        return await finish

    engine = create_engine(execute)
    task = engine.submit(**create_admission("work"))
    idle_signal = CancelSignal()
    idle_waiting = asyncio.create_task(engine.wait_for_idle(cancel_signal=idle_signal))

    idle_signal.abort(RuntimeError("stop idle observation"))
    with pytest.raises(RuntimeError, match="stop idle observation"):
        await idle_waiting
    assert_task(engine.get(task["task_id"]), task, {"status": "working"})

    resolve({"status": "completed", "result": create_result("done")})
    await engine.wait_for_idle()


@pytest.mark.asyncio
async def test_resume_updates_state_and_restarts_execution() -> None:
    async def execute(context: InProcessTaskExecutionContext) -> InProcessTaskExecutionOutcome:
        if context.state is not None:
            return {"status": "completed", "result": create_result(get_state_value(context.state))}
        return {"status": "input_required", "state": create_state("waiting")}

    engine = create_engine(execute)
    task = engine.submit(**create_admission("work"))
    await engine.wait_for_idle()
    assert_task(
        engine.get(task["task_id"]),
        task,
        {"status": "input_required", "state": create_state("waiting")},
    )
    assert_task(
        engine.resume(
            task["task_id"],
            lambda _: (create_state("still waiting"), False),
        ),
        task,
        {"status": "input_required", "state": create_state("still waiting")},
    )
    engine.resume(task["task_id"], lambda state: (state, True))
    await engine.wait_for_idle()
    assert_task(
        engine.get(task["task_id"]),
        task,
        {"status": "completed", "result": create_result("still waiting")},
    )


@pytest.mark.asyncio
async def test_resume_restarts_execution_while_previous_execution_settles() -> None:
    executions = 0
    engine: InProcessTaskEngine

    async def execute(context: InProcessTaskExecutionContext) -> InProcessTaskExecutionOutcome:
        nonlocal executions
        executions += 1
        if context.state is None:
            return {"status": "input_required", "state": create_state("waiting")}
        return {"status": "completed", "result": create_result("done")}

    def on_task_updated(task: InProcessTaskRecord) -> None:
        if task["status"] == "input_required":
            engine.resume(task["task_id"], lambda state: (state, True))

    engine = create_engine(execute, on_task_updated=on_task_updated)
    task = engine.submit(**create_admission("work"))
    await engine.wait_for_idle()

    tru_executions = executions
    exp_executions = 2
    assert tru_executions == exp_executions
    assert_task(engine.get(task["task_id"]), task, {"status": "completed", "result": create_result("done")})


@pytest.mark.asyncio
async def test_cancel_running_work_and_remove_before_execution_settles() -> None:
    finish, resolve = deferred()
    execution_signal: CancelSignal | None = None

    async def execute(context: InProcessTaskExecutionContext) -> InProcessTaskExecutionOutcome:
        nonlocal execution_signal
        execution_signal = context.cancel_signal
        return await finish

    engine = create_engine(execute)
    task = engine.submit(**create_admission("work"))
    await asyncio.sleep(0)

    assert_task(engine.cancel(task["task_id"], reason="Stop work"), task, {"status": "cancelled"})
    assert execution_signal is not None
    tru_reason = execution_signal.reason
    exp_reason = "Stop work"
    assert tru_reason == exp_reason

    engine.remove(task["task_id"])
    tru_task = engine.get(task["task_id"])
    exp_task = None
    assert tru_task == exp_task
    with pytest.raises(BackgroundTaskNotFoundError, match="was not found"):
        engine.cancel(task["task_id"], reason="Again")

    resolve({"status": "completed", "result": create_result("late")})
    await engine.wait_for_idle()


@pytest.mark.asyncio
async def test_cancel_scheduled_work_without_executing_it() -> None:
    executed = False

    async def execute(_: InProcessTaskExecutionContext) -> InProcessTaskExecutionOutcome:
        nonlocal executed
        executed = True
        return {"status": "completed", "result": create_result("late")}

    engine = create_engine(execute)
    task = engine.submit(**create_admission("work"))

    assert_task(engine.cancel(task["task_id"], reason="Stop work"), task, {"status": "cancelled"})
    await engine.wait_for_idle()

    assert not executed
    assert_task(engine.get(task["task_id"]), task, {"status": "cancelled"})


@pytest.mark.asyncio
async def test_cancel_queued_work_without_executing_it() -> None:
    finish, resolve = deferred()
    executions: list[str] = []

    async def execute(context: InProcessTaskExecutionContext) -> InProcessTaskExecutionOutcome:
        executions.append(context.tool_name)
        return await finish

    engine = create_engine(execute, max_concurrency=1)
    engine.submit(**create_admission("running"))
    queued = engine.submit(**create_admission("queued"))

    assert_task(engine.cancel(queued["task_id"], reason="No longer needed"), queued, {"status": "cancelled"})
    resolve({"status": "completed", "result": create_result("done")})
    await engine.wait_for_idle()

    tru_executions = executions
    exp_executions = ["running"]
    assert tru_executions == exp_executions


def test_init_rejects_invalid_execution_configuration() -> None:
    async def complete(_: InProcessTaskExecutionContext) -> InProcessTaskExecutionOutcome:
        return {"status": "completed", "result": create_result("done")}

    with pytest.raises(TypeError, match="max_concurrency must be a positive"):
        create_engine(complete, max_concurrency=0)
    with pytest.raises(TypeError, match="timeout must be a positive"):
        create_engine(complete, timeout=0)
    create_engine(complete, timeout=2**31)
