from __future__ import annotations

import asyncio
import inspect
import threading
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any
from unittest.mock import ANY

import pytest

from strands import Agent, tool
from strands._async import run_async
from strands.background_tasks._errors import BackgroundTaskTimeoutError
from strands.background_tasks.in_process._manager import InProcessTaskManager
from strands.interrupt import Interrupt, InterruptException
from strands.types.tools import AgentTool, ToolContext, ToolResult
from tests.fixtures.mocked_model_provider import MockedModelProvider

_Callback = Callable[[dict[str, str], ToolContext], str | Awaitable[str]]


@dataclass(frozen=True)
class _Fixture:
    manager: InProcessTaskManager
    work: AgentTool


def _create_fixture(callback: _Callback, *, max_concurrency: int = 4) -> _Fixture:
    @tool(name="work")
    def work(value: str) -> str:
        """Perform controlled test work."""
        return value

    agent = Agent(model=MockedModelProvider([]), callback_handler=None)

    async def execute_tool(
        selected_tool: AgentTool,
        context: ToolContext,
        _middleware_interrupt: Callable[..., Any],
    ) -> ToolResult:
        assert selected_tool is work
        try:
            result = callback(context.tool_use["input"], context)
            if inspect.isawaitable(result):
                result = await result
            return {
                "toolUseId": context.tool_use["toolUseId"],
                "status": "success",
                "content": [{"text": result}],
            }
        except InterruptException:
            raise
        except Exception as error:
            return {
                "toolUseId": context.tool_use["toolUseId"],
                "status": "error",
                "content": [{"text": f"Error: {error}"}],
            }

    return _Fixture(InProcessTaskManager(agent, execute_tool, max_concurrency=max_concurrency), work)


async def _submit(
    manager: InProcessTaskManager,
    work: AgentTool,
    value: str,
    tool_use_id: str | None = None,
    pass_id: str | None = None,
) -> dict[str, Any]:
    return await manager.submit(
        {
            "name": "work",
            "toolUseId": tool_use_id or f"tool-use-{value}",
            "input": {"value": value},
        },
        {},
        pass_id or f"pass-{value}",
        work,
    )


@pytest.mark.asyncio
async def test_submit_executes_selected_tool_with_transient_invocation_state() -> None:
    invocation_state = {
        "request_id": "request-1",
        "callback": lambda: "not serializable",
    }

    async def callback(input_data: dict[str, str], context: ToolContext) -> str:
        assert context.invocation_state is invocation_state
        tru_tool_name = context.tool_use["name"]
        exp_tool_name = "hook-alias"
        assert tru_tool_name == exp_tool_name
        return input_data["value"].upper()

    fixture = _create_fixture(callback)
    admitted = await fixture.manager.submit(
        {
            "name": "hook-alias",
            "toolUseId": "tool-use-1",
            "input": {"value": "hello"},
        },
        invocation_state,
        "pass-1",
        fixture.work,
    )

    await fixture.manager.wait_for_idle()
    exp_completed = {
        "task_id": admitted["task_id"],
        "tool_use_id": "tool-use-1",
        "tool_name": "hook-alias",
        "status": "completed",
        "created_at": ANY,
        "last_updated_at": ANY,
        "result": {"content": [{"text": "HELLO"}]},
    }
    tru_completed = await fixture.manager.get(admitted["task_id"])
    assert tru_completed == exp_completed

    tru_tasks = await fixture.manager.list()
    exp_tasks = [exp_completed]
    assert tru_tasks == exp_tasks

    await fixture.manager.remove([admitted["task_id"]])
    tru_removed = await fixture.manager.get(admitted["task_id"])
    exp_removed = None
    assert tru_removed == exp_removed


def test_submit_from_sync_bridge_survives_temporary_event_loop() -> None:
    release = threading.Event()

    async def callback(input_data: dict[str, str], _: ToolContext) -> str:
        while not release.is_set():
            await asyncio.sleep(0)
        return input_data["value"].upper()

    fixture = _create_fixture(callback)
    admitted = run_async(lambda: _submit(fixture.manager, fixture.work, "detached"))

    release.set()
    tru_completed = run_async(lambda: fixture.manager.wait(admitted["task_id"]))
    exp_completed = {
        **admitted,
        "status": "completed",
        "last_updated_at": ANY,
        "result": {"content": [{"text": "DETACHED"}]},
    }
    assert tru_completed == exp_completed


@pytest.mark.asyncio
async def test_submit_deduplicates_repeated_submissions_within_one_pass() -> None:
    execution_count = 0

    def callback(input_data: dict[str, str], _: ToolContext) -> str:
        nonlocal execution_count
        execution_count += 1
        return input_data["value"]

    fixture = _create_fixture(callback)
    first = await _submit(fixture.manager, fixture.work, "same", "tool-use-1", "pass-1")
    duplicate = await _submit(fixture.manager, fixture.work, "same", "tool-use-1", "pass-1")
    later_pass = await _submit(fixture.manager, fixture.work, "same", "tool-use-1", "pass-2")

    tru_duplicate_id = duplicate["task_id"]
    exp_duplicate_id = first["task_id"]
    assert tru_duplicate_id == exp_duplicate_id
    assert later_pass["task_id"] != first["task_id"]

    await fixture.manager.wait_for_idle()
    tru_execution_count = execution_count
    exp_execution_count = 2
    assert tru_execution_count == exp_execution_count


@pytest.mark.asyncio
async def test_wait_projects_tool_errors() -> None:
    def callback(_: dict[str, str], __: ToolContext) -> str:
        raise RuntimeError("tool failed")

    fixture = _create_fixture(callback)
    failed = await _submit(fixture.manager, fixture.work, "failed")

    tru_failed = await fixture.manager.wait(failed["task_id"])
    exp_failed = {
        **failed,
        "status": "failed",
        "last_updated_at": ANY,
        "result": {"content": [{"text": "Error: tool failed"}]},
        "error": {"type": "tool_error", "message": "tool failed"},
    }
    assert tru_failed == exp_failed


@pytest.mark.asyncio
async def test_cancel_stops_tool_execution() -> None:
    started = asyncio.Event()
    cancel_signal: Any = None

    async def callback(_: dict[str, str], context: ToolContext) -> str:
        nonlocal cancel_signal
        cancel_signal = context.cancel_signal
        started.set()
        while not cancel_signal.is_set():
            await asyncio.sleep(0)
        return "late"

    fixture = _create_fixture(callback)
    admitted = await _submit(fixture.manager, fixture.work, "cancel")
    await started.wait()
    waiting = asyncio.create_task(fixture.manager.wait(admitted["task_id"]))

    exp_cancelled = {
        **admitted,
        "status": "cancelled",
        "last_updated_at": ANY,
    }
    tru_cancelled = await fixture.manager.cancel(admitted["task_id"])
    assert tru_cancelled == exp_cancelled

    tru_waited = await waiting
    assert tru_waited == exp_cancelled
    tru_signal = {
        "aborted": cancel_signal.is_set(),
        "reason": cancel_signal.reason,
    }
    exp_signal = {
        "aborted": True,
        "reason": "Cancellation requested",
    }
    assert tru_signal == exp_signal
    await fixture.manager.wait_for_idle()


@pytest.mark.asyncio
async def test_wait_for_idle_rejects_invalid_timeout() -> None:
    fixture = _create_fixture(lambda input_data, _: input_data["value"])

    with pytest.raises(TypeError):
        await fixture.manager.wait_for_idle(timeout=0)


@pytest.mark.asyncio
async def test_wait_for_idle_raises_timeout_error() -> None:
    async def callback(_: dict[str, str], context: ToolContext) -> str:
        while not context.cancel_signal.is_set():
            await asyncio.sleep(0)
        return "cancelled"

    fixture = _create_fixture(callback)
    admitted = await _submit(fixture.manager, fixture.work, "slow")

    with pytest.raises(BackgroundTaskTimeoutError):
        await fixture.manager.wait_for_idle(timeout=0.01)

    tru_idle_waiters = await fixture.manager._runtime.run(lambda: len(fixture.manager._engine._idle_waiters))
    exp_idle_waiters = 0
    assert tru_idle_waiters == exp_idle_waiters

    await fixture.manager.cancel(admitted["task_id"])
    await fixture.manager.wait_for_idle()


@pytest.mark.asyncio
async def test_resume_applies_input_to_tool_interrupts() -> None:
    def callback(input_data: dict[str, str], context: ToolContext) -> str:
        if input_data["value"] == "complete":
            return "complete"
        response = context.interrupt("approve_work", reason="Approve work?")
        return f"approved:{response}"

    fixture = _create_fixture(callback)
    completed = await _submit(fixture.manager, fixture.work, "complete")
    await fixture.manager.wait(completed["task_id"])
    admitted = await _submit(fixture.manager, fixture.work, "interrupt", "tool-use-1")
    tru_input_required = await fixture.manager.wait(admitted["task_id"])
    exp_input_required = {
        **admitted,
        "status": "input_required",
        "last_updated_at": ANY,
        "interrupts": [
            {
                "id": ANY,
                "name": "approve_work",
                "reason": "Approve work?",
                "source": "tool",
            },
        ],
    }
    assert tru_input_required == exp_input_required
    interrupt = tru_input_required["interrupts"][0]

    with pytest.raises(RuntimeError, match="cannot be removed before reaching a terminal status"):
        await fixture.manager.remove([completed["task_id"], admitted["task_id"]])
    tru_completed = await fixture.manager.get(completed["task_id"])
    assert tru_completed is not None

    tru_queued = await fixture.manager.resume(
        admitted["task_id"],
        [{"interruptId": interrupt["id"], "response": "yes"}],
    )
    exp_queued = {
        **admitted,
        "status": "queued",
        "last_updated_at": ANY,
    }
    assert tru_queued == exp_queued

    tru_resumed = await fixture.manager.wait(admitted["task_id"])
    exp_resumed = {
        **admitted,
        "status": "completed",
        "last_updated_at": ANY,
        "result": {"content": [{"text": "approved:yes"}]},
    }
    assert tru_resumed == exp_resumed


def test_resume_after_origin_event_loop_closes() -> None:
    def callback(input_data: dict[str, str], context: ToolContext) -> str:
        response = context.interrupt("approve_work", reason="Approve work?")
        return f"{input_data['value']}:{response}"

    fixture = _create_fixture(callback)

    async def submit_and_wait() -> tuple[dict[str, Any], dict[str, Any]]:
        admitted = await _submit(fixture.manager, fixture.work, "interrupt")
        return admitted, await fixture.manager.wait(admitted["task_id"])

    admitted, input_required = asyncio.run(submit_and_wait())
    interrupt = input_required["interrupts"][0]

    async def resume_and_wait() -> dict[str, Any]:
        await fixture.manager.resume(
            admitted["task_id"],
            [{"interruptId": interrupt["id"], "response": "yes"}],
        )
        return await fixture.manager.wait(admitted["task_id"])

    resumed = asyncio.run(resume_and_wait())

    assert resumed == {
        **admitted,
        "status": "completed",
        "last_updated_at": ANY,
        "result": {"content": [{"text": "interrupt:yes"}]},
    }


def test_cancel_reclaims_execution_from_stopped_origin_event_loop() -> None:
    started = threading.Event()

    async def callback(input_data: dict[str, str], context: ToolContext) -> str:
        if input_data["value"] != "stopped":
            return input_data["value"]
        started.set()
        while not context.cancel_signal.is_set():
            await asyncio.sleep(0)
        return input_data["value"]

    fixture = _create_fixture(callback, max_concurrency=1)
    origin_loop = asyncio.new_event_loop()

    async def submit_from_origin() -> dict[str, Any]:
        admitted = await _submit(fixture.manager, fixture.work, "stopped")
        while not started.is_set():
            await asyncio.sleep(0)
        return admitted

    admitted = origin_loop.run_until_complete(submit_from_origin())

    async def cancel_and_run_next() -> dict[str, Any]:
        await fixture.manager.cancel(admitted["task_id"])
        next_task = await _submit(fixture.manager, fixture.work, "next")
        return await asyncio.wait_for(fixture.manager.wait(next_task["task_id"]), timeout=1)

    try:
        completed = asyncio.run(cancel_and_run_next())
        assert completed == {
            "task_id": ANY,
            "tool_use_id": "tool-use-next",
            "tool_name": "work",
            "status": "completed",
            "created_at": ANY,
            "last_updated_at": ANY,
            "result": {"content": [{"text": "next"}]},
        }
    finally:
        pending = asyncio.all_tasks(origin_loop)
        for task in pending:
            task.cancel()
        origin_loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
        origin_loop.close()


@pytest.mark.asyncio
async def test_resume_applies_input_to_middleware_interrupts() -> None:
    agent = Agent(model=MockedModelProvider([]), callback_handler=None)

    @tool(name="work")
    def work(value: str) -> str:
        """Perform controlled test work."""
        return value

    async def execute_tool(
        selected_tool: AgentTool,
        context: ToolContext,
        middleware_interrupt: Callable[..., Any],
    ) -> ToolResult:
        assert selected_tool is work
        response = middleware_interrupt("approve_work", reason="Approve work?").response
        return {
            "toolUseId": context.tool_use["toolUseId"],
            "status": "success",
            "content": [{"text": f"approved:{response}"}],
        }

    manager = InProcessTaskManager(agent, execute_tool)
    admitted = await _submit(manager, work, "interrupt", "tool-use-1")
    input_required = await manager.wait(admitted["task_id"])
    interrupt = input_required["interrupts"][0]

    assert interrupt == {
        "id": ANY,
        "name": "approve_work",
        "reason": "Approve work?",
        "source": "middleware",
    }

    await manager.resume(
        admitted["task_id"],
        [{"interruptId": interrupt["id"], "response": "yes"}],
    )
    resumed = await manager.wait(admitted["task_id"])

    assert resumed == {
        **admitted,
        "status": "completed",
        "last_updated_at": ANY,
        "result": {"content": [{"text": "approved:yes"}]},
    }


@pytest.mark.asyncio
async def test_wait_fails_interrupts_outside_the_tool_context() -> None:
    def callback(_: dict[str, str], __: ToolContext) -> str:
        raise InterruptException(
            Interrupt(
                id="v1:before_tool_call:tool-use-1:approve_hook",
                name="approve_hook",
            )
        )

    fixture = _create_fixture(callback)
    admitted = await _submit(fixture.manager, fixture.work, "hook-interrupt", "tool-use-1")

    tru_failed = await fixture.manager.wait(admitted["task_id"])
    exp_failed = {
        **admitted,
        "status": "failed",
        "last_updated_at": ANY,
        "error": {"type": "execution_error", "message": "Interrupt raised: approve_hook"},
    }
    assert tru_failed == exp_failed


@pytest.mark.asyncio
async def test_report_progress_keeps_latest_bounded_update() -> None:
    reported = asyncio.Event()
    release = asyncio.Event()

    async def callback(_: dict[str, str], context: ToolContext) -> str:
        context.report_progress("first")
        context.report_progress("a" * 600)
        reported.set()
        await release.wait()
        return "done"

    fixture = _create_fixture(callback)
    admitted = await _submit(fixture.manager, fixture.work, "progress")
    await reported.wait()

    async def latest_progress() -> dict[str, Any]:
        while True:
            snapshot = await fixture.manager.get(admitted["task_id"])
            assert snapshot is not None
            if "progress" in snapshot and snapshot["progress"]["update_count"] == 2:
                return snapshot
            await asyncio.sleep(0)

    working = await asyncio.wait_for(latest_progress(), timeout=2)
    assert working["progress"] == {
        "message": "a" * 512,
        "update_count": 2,
        "updated_at": ANY,
    }
    release.set()
    completed = await fixture.manager.wait(admitted["task_id"])
    assert completed["progress"] == working["progress"]


@pytest.mark.asyncio
async def test_message_runs_registered_handler_on_tool_loop_and_unregisters() -> None:
    registered = asyncio.Event()
    release = asyncio.Event()
    received: list[str] = []
    origin_loop = asyncio.get_running_loop()
    unregister_handler: Callable[[], None] | None = None

    async def callback(_: dict[str, str], context: ToolContext) -> str:
        nonlocal unregister_handler

        async def handler(message: str | list[dict[str, Any]], **kwargs: Any) -> None:
            assert asyncio.get_running_loop() is origin_loop
            assert isinstance(message, str)
            received.append(message)

        unregister_handler = context.on_message(handler)
        registered.set()
        await release.wait()
        return "done"

    fixture = _create_fixture(callback)
    admitted = await _submit(fixture.manager, fixture.work, "message")
    await registered.wait()
    await fixture.manager.message(admitted["task_id"], "hello")
    assert received == ["hello"]
    assert unregister_handler is not None
    unregister_handler()
    unregister_handler()
    with pytest.raises(RuntimeError, match="does not accept messages"):
        await fixture.manager.message(admitted["task_id"], "later")
    release.set()
    await fixture.manager.wait(admitted["task_id"])
    with pytest.raises(RuntimeError, match="cannot accept messages in status 'completed'"):
        await fixture.manager.message(admitted["task_id"], "too late")


@pytest.mark.asyncio
async def test_message_rejects_working_task_without_handler() -> None:
    started = asyncio.Event()
    release = asyncio.Event()

    async def callback(_: dict[str, str], __: ToolContext) -> str:
        started.set()
        await release.wait()
        return "done"

    fixture = _create_fixture(callback)
    admitted = await _submit(fixture.manager, fixture.work, "unsupported")
    await started.wait()
    with pytest.raises(RuntimeError, match="does not accept messages"):
        await fixture.manager.message(admitted["task_id"], "hello")
    release.set()
    await fixture.manager.wait(admitted["task_id"])


@pytest.mark.asyncio
async def test_queued_messages_drain_before_a_short_async_tool_finishes() -> None:
    first_started = asyncio.Event()
    release_first = asyncio.Event()
    received: list[str] = []

    async def callback(input_data: dict[str, str], context: ToolContext) -> str:
        if input_data["value"] == "first":
            first_started.set()
            await release_first.wait()
            return "first done"

        async def handler(message: str | list[dict[str, Any]], **kwargs: Any) -> None:
            await asyncio.sleep(0)
            received.append(message if isinstance(message, str) else "content")

        context.on_message(handler)
        return "second done"

    fixture = _create_fixture(callback, max_concurrency=1)
    await _submit(fixture.manager, fixture.work, "first")
    await first_started.wait()
    second = await _submit(fixture.manager, fixture.work, "second")
    assert await fixture.manager.message(second["task_id"], "queued") is True

    release_first.set()
    completed = await fixture.manager.wait(second["task_id"])
    assert completed["status"] == "completed"
    assert received == ["queued"]


@pytest.mark.asyncio
async def test_working_message_waits_for_replacement_drain_after_old_handler() -> None:
    first_started = asyncio.Event()
    release_first = asyncio.Event()
    second_started = asyncio.Event()
    release_tool = asyncio.Event()
    first_handler_started = asyncio.Event()
    release_first_handler = asyncio.Event()
    replacement_handler_started = asyncio.Event()
    release_replacement_handler = asyncio.Event()
    direct_message_received = asyncio.Event()
    received: list[tuple[str, str]] = []
    tool_context: ToolContext | None = None

    async def callback(input_data: dict[str, str], context: ToolContext) -> str:
        nonlocal tool_context
        if input_data["value"] == "first":
            first_started.set()
            await release_first.wait()
            return "first done"
        tool_context = context

        async def first_handler(message: str | list[dict[str, Any]], **kwargs: Any) -> None:
            received.append(("first", str(message)))
            if message == "A":
                first_handler_started.set()
                await release_first_handler.wait()

        context.on_message(first_handler)
        second_started.set()
        await release_tool.wait()
        return "second done"

    fixture = _create_fixture(callback, max_concurrency=1)
    await _submit(fixture.manager, fixture.work, "first")
    await first_started.wait()
    second = await _submit(fixture.manager, fixture.work, "second")
    assert await fixture.manager.message(second["task_id"], "A") is True
    assert await fixture.manager.message(second["task_id"], "B") is True

    release_first.set()
    await second_started.wait()
    await first_handler_started.wait()
    working_message = asyncio.create_task(fixture.manager.message(second["task_id"], "M"))
    await asyncio.sleep(0)
    assert not working_message.done()
    assert tool_context is not None

    async def replacement_handler(message: str | list[dict[str, Any]], **kwargs: Any) -> None:
        received.append(("replacement", str(message)))
        if message == "B":
            replacement_handler_started.set()
            await release_replacement_handler.wait()
        if message == "M":
            direct_message_received.set()

    tool_context.on_message(replacement_handler)
    release_first_handler.set()
    await replacement_handler_started.wait()
    assert not working_message.done()
    assert not direct_message_received.is_set()

    release_replacement_handler.set()
    await direct_message_received.wait()
    await working_message
    assert received == [("first", "A"), ("replacement", "B"), ("replacement", "M")]

    release_tool.set()
    await fixture.manager.wait(second["task_id"])


@pytest.mark.asyncio
async def test_message_old_unregister_keeps_replacement_handler() -> None:
    registered = asyncio.Event()
    release = asyncio.Event()
    received: list[str] = []

    async def callback(_: dict[str, str], context: ToolContext) -> str:
        def old_handler(message: str | list[dict[str, Any]], **kwargs: Any) -> None:
            received.append("old")

        def new_handler(message: str | list[dict[str, Any]], **kwargs: Any) -> None:
            received.append("new")

        old_unregister = context.on_message(old_handler)
        context.on_message(new_handler)
        old_unregister()
        registered.set()
        await release.wait()
        return "done"

    fixture = _create_fixture(callback)
    admitted = await _submit(fixture.manager, fixture.work, "replacement")
    await registered.wait()
    await fixture.manager.message(admitted["task_id"], "hello")
    assert received == ["new"]
    release.set()
    await fixture.manager.wait(admitted["task_id"])


@pytest.mark.asyncio
async def test_message_cancellation_cancels_pending_async_handler() -> None:
    registered = asyncio.Event()
    handling = asyncio.Event()
    handler_cancelled = asyncio.Event()
    release_tool = asyncio.Event()

    async def callback(_: dict[str, str], context: ToolContext) -> str:
        async def handler(message: str | list[dict[str, Any]], **kwargs: Any) -> None:
            handling.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                handler_cancelled.set()
                raise

        context.on_message(handler)
        registered.set()
        await release_tool.wait()
        return "done"

    fixture = _create_fixture(callback)
    admitted = await _submit(fixture.manager, fixture.work, "cancel-message")
    await registered.wait()
    pending = asyncio.create_task(fixture.manager.message(admitted["task_id"], "hello"))
    await handling.wait()
    pending.cancel()
    with pytest.raises(asyncio.CancelledError):
        await pending
    await asyncio.wait_for(handler_cancelled.wait(), timeout=2)
    release_tool.set()
    await fixture.manager.wait(admitted["task_id"])


@pytest.mark.asyncio
async def test_message_handler_registered_from_sync_thread_runs_off_runtime_loop() -> None:
    registered = asyncio.Event()
    release = asyncio.Event()
    handler_threads: list[str] = []

    async def callback(_: dict[str, str], context: ToolContext) -> str:
        def handler(message: str | list[dict[str, Any]], **kwargs: Any) -> None:
            handler_threads.append(threading.current_thread().name)

        await asyncio.to_thread(context.on_message, handler)
        registered.set()
        await release.wait()
        return "done"

    fixture = _create_fixture(callback)
    admitted = await _submit(fixture.manager, fixture.work, "sync-handler")
    await registered.wait()
    await fixture.manager.message(admitted["task_id"], "hello")
    assert len(handler_threads) == 1
    assert handler_threads[0] != "strands-background-tasks"
    release.set()
    await fixture.manager.wait(admitted["task_id"])


@pytest.mark.asyncio
async def test_message_after_interrupt_resume_uses_new_handler() -> None:
    registered = asyncio.Event()
    release = asyncio.Event()
    received: list[str] = []
    old_unregister: Callable[[], None] | None = None

    async def callback(_: dict[str, str], context: ToolContext) -> str:
        nonlocal old_unregister

        def old_handler(message: str | list[dict[str, Any]], **kwargs: Any) -> None:
            received.append("old")

        def new_handler(message: str | list[dict[str, Any]], **kwargs: Any) -> None:
            received.append("new")

        if old_unregister is None:
            old_unregister = context.on_message(old_handler)
        context.interrupt("approve_work", reason="Approve work?")
        context.on_message(new_handler)
        registered.set()
        await release.wait()
        return "done"

    fixture = _create_fixture(callback)
    admitted = await _submit(fixture.manager, fixture.work, "interrupt-message")
    input_required = await fixture.manager.wait(admitted["task_id"])
    with pytest.raises(RuntimeError, match="cannot accept messages in status 'input_required'"):
        await fixture.manager.message(admitted["task_id"], "while interrupted")
    interrupt = input_required["interrupts"][0]
    await fixture.manager.resume(admitted["task_id"], [{"interruptId": interrupt["id"], "response": "yes"}])
    await registered.wait()
    assert old_unregister is not None
    old_unregister()
    await fixture.manager.message(admitted["task_id"], "hello")
    assert received == ["new"]
    release.set()
    await fixture.manager.wait(admitted["task_id"])


def test_report_progress_before_immediate_runtime_completion_is_retained() -> None:
    def callback(_: dict[str, str], context: ToolContext) -> str:
        context.report_progress("finished quickly")
        return "done"

    fixture = _create_fixture(callback)

    async def invoke() -> dict[str, Any]:
        admitted = await _submit(fixture.manager, fixture.work, "quick-progress")
        return await fixture.manager.wait(admitted["task_id"])

    completed = run_async(invoke)
    assert completed["progress"] == {
        "message": "finished quickly",
        "update_count": 1,
        "updated_at": ANY,
    }


@pytest.mark.asyncio
async def test_delayed_update_for_removed_task_does_not_restore_snapshot() -> None:
    fixture = _create_fixture(lambda input_data, _context: input_data["value"])
    handle_task_updated = fixture.manager._engine._on_task_updated
    fixture.manager._engine._on_task_updated = lambda _record: None
    admitted = await _submit(fixture.manager, fixture.work, "removed")
    await fixture.manager.wait_for_idle()
    stale_record = fixture.manager._engine.get(admitted["task_id"])
    assert stale_record is not None
    assert stale_record["invocation_state_id"] in fixture.manager._executions
    await fixture.manager.remove([admitted["task_id"]])
    assert stale_record["invocation_state_id"] not in fixture.manager._executions

    updates: list[dict[str, Any]] = []
    fixture.manager._on_task_updated = updates.append
    fixture.manager._engine._on_task_updated = handle_task_updated
    handle_task_updated(stale_record)

    assert updates == []
