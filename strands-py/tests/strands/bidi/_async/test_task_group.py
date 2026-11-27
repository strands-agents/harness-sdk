import asyncio
import unittest.mock

import pytest

from strands.bidi._async._task_group import _TaskGroup


@pytest.mark.asyncio
async def test_task_group__aexit__():
    coro = unittest.mock.AsyncMock()

    async with _TaskGroup() as task_group:
        task_group.create_task(coro())

    coro.assert_called_once()


@pytest.mark.asyncio
async def test_task_group__aexit__task_exception():
    wait_event = asyncio.Event()

    async def wait():
        await wait_event.wait()

    async def fail():
        raise ValueError("test error")

    with pytest.raises(ValueError, match=r"test error"):
        async with _TaskGroup() as task_group:
            wait_task = task_group.create_task(wait())
            fail_task = task_group.create_task(fail())

    assert wait_task.cancelled()
    assert not fail_task.cancelled()


@pytest.mark.asyncio
async def test_task_group__aexit__task_cancelled():
    async def wait():
        asyncio.current_task().cancel()
        await asyncio.sleep(0)

    async with _TaskGroup() as task_group:
        wait_task = task_group.create_task(wait())

    assert wait_task.cancelled()


@pytest.mark.asyncio
async def test_task_group__aexit__context_cancelled():
    wait_event = asyncio.Event()

    async def wait():
        await wait_event.wait()

    tasks = []

    run_event = asyncio.Event()

    async def run():
        async with _TaskGroup() as task_group:
            tasks.append(task_group.create_task(wait()))
            run_event.set()

    run_task = asyncio.create_task(run())
    await run_event.wait()
    run_task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await run_task

    wait_task = tasks[0]
    assert wait_task.cancelled()
