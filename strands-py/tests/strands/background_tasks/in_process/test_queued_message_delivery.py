from __future__ import annotations

import asyncio
import threading
from typing import Any

import pytest

from strands.types.tools import ToolContext
from tests.strands.background_tasks.in_process.test_manager import _create_fixture, _submit


@pytest.mark.asyncio
async def test_cancelling_a_drain_waiter_does_not_cancel_the_shared_drain() -> None:
    first_started = asyncio.Event()
    release_first = asyncio.Event()
    drain_started = asyncio.Event()
    release_drain = asyncio.Event()
    received: list[str] = []

    async def callback(input_data: dict[str, str], context: ToolContext) -> str:
        if input_data["value"] == "first":
            first_started.set()
            await release_first.wait()
            return "first done"

        async def handler(message: str | list[dict[str, Any]], **kwargs: Any) -> None:
            if message == "backlog":
                drain_started.set()
                await release_drain.wait()
            received.append(message if isinstance(message, str) else "content")

        context.on_message(handler)
        return "second done"

    fixture = _create_fixture(callback, max_concurrency=1)
    await _submit(fixture.manager, fixture.work, "first")
    await first_started.wait()
    queued = await _submit(fixture.manager, fixture.work, "second")
    assert await fixture.manager.message(queued["task_id"], "backlog") is True

    release_first.set()
    await drain_started.wait()

    # This waiter uses the same barrier as the tool's own completion path.
    waiter = asyncio.create_task(fixture.manager._wait_for_message_drain(queued["task_id"]))
    await asyncio.sleep(0)
    assert not waiter.done()
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter

    release_drain.set()
    completed = await asyncio.wait_for(fixture.manager.wait(queued["task_id"]), timeout=2)
    assert completed["status"] == "completed"
    assert received == ["backlog"]


@pytest.mark.asyncio
async def test_replacement_handler_waits_for_in_flight_backlog_message() -> None:
    first_started = asyncio.Event()
    release_first = asyncio.Event()
    old_handler_started = asyncio.Event()
    release_old_handler = asyncio.Event()
    replacement_registered = asyncio.Event()
    received: list[tuple[str, str]] = []

    async def callback(input_data: dict[str, str], context: ToolContext) -> str:
        if input_data["value"] == "first":
            first_started.set()
            await release_first.wait()
            return "first done"

        async def old_handler(message: str | list[dict[str, Any]], **kwargs: Any) -> None:
            assert isinstance(message, str)
            received.append(("old-start", message))
            old_handler_started.set()
            await release_old_handler.wait()
            received.append(("old-end", message))

        def replacement_handler(message: str | list[dict[str, Any]], **kwargs: Any) -> None:
            assert isinstance(message, str)
            received.append(("replacement", message))

        context.on_message(old_handler)
        await old_handler_started.wait()
        context.on_message(replacement_handler)
        replacement_registered.set()
        return "second done"

    fixture = _create_fixture(callback, max_concurrency=1)
    await _submit(fixture.manager, fixture.work, "first")
    await first_started.wait()
    queued = await _submit(fixture.manager, fixture.work, "second")
    assert await fixture.manager.message(queued["task_id"], "one") is True
    assert await fixture.manager.message(queued["task_id"], "two") is True

    release_first.set()
    await old_handler_started.wait()
    await replacement_registered.wait()
    assert received == [("old-start", "one")]

    release_old_handler.set()
    completed = await asyncio.wait_for(fixture.manager.wait(queued["task_id"]), timeout=2)
    assert completed["status"] == "completed"
    assert received == [("old-start", "one"), ("old-end", "one"), ("replacement", "two")]


@pytest.mark.asyncio
async def test_replacement_with_empty_pending_queue_still_waits_for_in_flight_message() -> None:
    first_started = asyncio.Event()
    release_first = asyncio.Event()
    old_handler_started = asyncio.Event()
    release_old_handler = asyncio.Event()
    replacement_registered = asyncio.Event()
    release_tool = asyncio.Event()
    replacement_called = asyncio.Event()
    received: list[tuple[str, str]] = []

    async def callback(input_data: dict[str, str], context: ToolContext) -> str:
        if input_data["value"] == "first":
            first_started.set()
            await release_first.wait()
            return "first done"

        async def old_handler(message: str | list[dict[str, Any]], **kwargs: Any) -> None:
            assert isinstance(message, str)
            received.append(("old-start", message))
            old_handler_started.set()
            await release_old_handler.wait()
            received.append(("old-end", message))

        def replacement_handler(message: str | list[dict[str, Any]], **kwargs: Any) -> None:
            assert isinstance(message, str)
            received.append(("replacement", message))
            replacement_called.set()

        context.on_message(old_handler)
        await old_handler_started.wait()
        context.on_message(replacement_handler)
        replacement_registered.set()
        await release_tool.wait()
        return "second done"

    fixture = _create_fixture(callback, max_concurrency=1)
    await _submit(fixture.manager, fixture.work, "first")
    await first_started.wait()
    queued = await _submit(fixture.manager, fixture.work, "second")
    assert await fixture.manager.message(queued["task_id"], "only-backlog-message") is True

    waiter: asyncio.Task[None] | None = None
    sender: asyncio.Task[bool | None] | None = None
    try:
        release_first.set()
        await old_handler_started.wait()
        await replacement_registered.wait()

        waiter = asyncio.create_task(fixture.manager._wait_for_message_drain(queued["task_id"]))
        await asyncio.sleep(0)
        assert not waiter.done()

        sender = asyncio.create_task(fixture.manager.message(queued["task_id"], "later-message"))
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(asyncio.shield(sender), timeout=0.05)
        assert not replacement_called.is_set()
        assert received == [("old-start", "only-backlog-message")]

        release_old_handler.set()
        await asyncio.wait_for(waiter, timeout=2)
        assert await asyncio.wait_for(sender, timeout=2) is None
        assert received == [
            ("old-start", "only-backlog-message"),
            ("old-end", "only-backlog-message"),
            ("replacement", "later-message"),
        ]
    finally:
        release_first.set()
        release_old_handler.set()
        release_tool.set()
        for pending in (waiter, sender):
            if pending is not None and not pending.done():
                pending.cancel()
        await asyncio.gather(*(pending for pending in (waiter, sender) if pending is not None), return_exceptions=True)
        await fixture.manager.wait_for_idle(timeout=2)


@pytest.mark.asyncio
async def test_unregistered_failing_drain_restores_accepted_messages_in_fifo_order() -> None:
    first_started = asyncio.Event()
    release_first = asyncio.Event()
    old_handler_started = asyncio.Event()
    fail_old_handler = asyncio.Event()
    old_handler_failed = asyncio.Event()
    register_replacement = asyncio.Event()
    replacement_registered = asyncio.Event()
    received: list[str] = []
    unregister: list[Any] = []

    async def callback(input_data: dict[str, str], context: ToolContext) -> str:
        if input_data["value"] == "first":
            first_started.set()
            await release_first.wait()
            return "first done"

        async def old_handler(message: str | list[dict[str, Any]], **kwargs: Any) -> None:
            old_handler_started.set()
            await fail_old_handler.wait()
            old_handler_failed.set()
            raise ValueError("delivery failed")

        def replacement_handler(message: str | list[dict[str, Any]], **kwargs: Any) -> None:
            assert isinstance(message, str)
            received.append(message)

        unregister.append(context.on_message(old_handler))
        await register_replacement.wait()
        context.on_message(replacement_handler)
        replacement_registered.set()
        return "second done"

    fixture = _create_fixture(callback, max_concurrency=1)
    await _submit(fixture.manager, fixture.work, "first")
    await first_started.wait()
    queued = await _submit(fixture.manager, fixture.work, "second")
    assert await fixture.manager.message(queued["task_id"], "one") is True
    assert await fixture.manager.message(queued["task_id"], "two") is True

    release_first.set()
    await old_handler_started.wait()
    assert unregister
    unregister[0]()
    fail_old_handler.set()
    await old_handler_failed.wait()
    register_replacement.set()
    await replacement_registered.wait()

    completed = await asyncio.wait_for(fixture.manager.wait(queued["task_id"]), timeout=2)
    assert completed["status"] == "completed"
    assert received == ["one", "two"]


@pytest.mark.asyncio
async def test_nested_message_mapping_cannot_exceed_pending_byte_limit() -> None:
    first_started = asyncio.Event()
    release_first = asyncio.Event()

    async def callback(input_data: dict[str, str], _: ToolContext) -> str:
        if input_data["value"] == "first":
            first_started.set()
            await release_first.wait()
        return "done"

    fixture = _create_fixture(callback, max_concurrency=1)
    await _submit(fixture.manager, fixture.work, "first")
    await first_started.wait()
    queued = await _submit(fixture.manager, fixture.work, "second")
    oversized = [
        {
            "toolUse": {
                "name": "tool",
                "toolUseId": "use-id",
                "input": {f"k{index}": None for index in range(6_000)},
            }
        }
    ]

    with pytest.raises(RuntimeError, match="byte limit"):
        await fixture.manager.message(queued["task_id"], oversized)

    release_first.set()
    completed = await asyncio.wait_for(fixture.manager.wait(queued["task_id"]), timeout=2)
    assert completed["status"] == "completed"


@pytest.mark.asyncio
async def test_terminal_cleanup_counts_and_releases_async_drain_payloads() -> None:
    first_started = asyncio.Event()
    release_first = asyncio.Event()
    drain_started = asyncio.Event()
    drain_cancelled = asyncio.Event()
    never_release_drain = asyncio.Event()
    received: list[str] = []

    async def callback(input_data: dict[str, str], context: ToolContext) -> str:
        if input_data["value"] == "first":
            first_started.set()
            await release_first.wait()
            return "first done"

        async def handler(message: str | list[dict[str, Any]], **kwargs: Any) -> None:
            assert isinstance(message, str)
            received.append(message)
            drain_started.set()
            try:
                await never_release_drain.wait()
            except asyncio.CancelledError:
                drain_cancelled.set()
                raise

        context.on_message(handler)
        return "second done"

    fixture = _create_fixture(callback, max_concurrency=1)
    await _submit(fixture.manager, fixture.work, "first")
    await first_started.wait()
    queued = await _submit(fixture.manager, fixture.work, "second")
    assert await fixture.manager.message(queued["task_id"], "in-flight") is True
    assert await fixture.manager.message(queued["task_id"], "pending") is True

    release_first.set()
    await drain_started.wait()
    cancelled = await asyncio.wait_for(fixture.manager.cancel(queued["task_id"]), timeout=2)
    assert cancelled["status"] == "cancelled"
    assert cancelled["undelivered_messages"] == {"count": 2, "reason": "cancelled"}
    await asyncio.wait_for(drain_cancelled.wait(), timeout=2)

    manager = fixture.manager
    with manager._message_handlers_lock:
        assert queued["task_id"] not in manager._pending_messages
        assert queued["task_id"] not in manager._pending_message_bytes
        assert queued["task_id"] not in manager._pending_drain_messages
        assert queued["task_id"] not in manager._message_drains
        assert queued["task_id"] not in manager._message_handlers

    await manager.remove([queued["task_id"]])
    assert await manager.get(queued["task_id"]) is None
    assert received == ["in-flight"]


@pytest.mark.asyncio
async def test_sync_drain_failure_after_removal_does_not_restore_raw_message() -> None:
    first_started = asyncio.Event()
    release_first = asyncio.Event()
    handler_started = asyncio.Event()
    registration_finished = asyncio.Event()
    release_handler = threading.Event()
    received: list[str] = []

    async def callback(input_data: dict[str, str], context: ToolContext) -> str:
        if input_data["value"] == "first":
            first_started.set()
            await release_first.wait()
            return "first done"

        loop = asyncio.get_running_loop()

        def handler(message: str | list[dict[str, Any]], **kwargs: Any) -> None:
            assert isinstance(message, str)
            received.append(message)
            loop.call_soon_threadsafe(handler_started.set)
            release_handler.wait()
            raise ValueError("delivery failed after cancellation")

        def register_handler() -> None:
            context.on_message(handler)
            loop.call_soon_threadsafe(registration_finished.set)

        await asyncio.to_thread(register_handler)
        return "second done"

    fixture = _create_fixture(callback, max_concurrency=1)
    await _submit(fixture.manager, fixture.work, "first")
    await first_started.wait()
    queued = await _submit(fixture.manager, fixture.work, "second")
    assert await fixture.manager.message(queued["task_id"], "in-flight") is True

    try:
        release_first.set()
        await handler_started.wait()
        cancelled = await asyncio.wait_for(fixture.manager.cancel(queued["task_id"]), timeout=2)
        assert cancelled["status"] == "cancelled"
        assert cancelled["undelivered_messages"] == {"count": 1, "reason": "cancelled"}
        await fixture.manager.remove([queued["task_id"]])

        release_handler.set()
        await asyncio.wait_for(registration_finished.wait(), timeout=2)
        manager = fixture.manager
        with manager._message_handlers_lock:
            assert queued["task_id"] not in manager._pending_messages
            assert queued["task_id"] not in manager._pending_message_bytes
            assert queued["task_id"] not in manager._pending_drain_messages
            assert queued["task_id"] not in manager._message_drains
            assert queued["task_id"] not in manager._message_handlers
        assert await manager.get(queued["task_id"]) is None
        assert received == ["in-flight"]
    finally:
        release_first.set()
        release_handler.set()
        await fixture.manager.wait_for_idle(timeout=2)
