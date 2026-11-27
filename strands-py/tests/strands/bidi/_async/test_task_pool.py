import asyncio

import pytest

from strands.bidi._async._task_pool import _TaskPool


@pytest.fixture
def task_pool() -> _TaskPool:
    return _TaskPool()


def test_len(task_pool):
    tru_len = len(task_pool)
    exp_len = 0
    assert tru_len == exp_len


@pytest.mark.asyncio
async def test_create(task_pool: _TaskPool) -> None:
    event = asyncio.Event()

    async def coro():
        await event.wait()

    task = task_pool.create(coro())

    tru_len = len(task_pool)
    exp_len = 1
    assert tru_len == exp_len

    event.set()
    await task

    tru_len = len(task_pool)
    exp_len = 0
    assert tru_len == exp_len


@pytest.mark.asyncio
async def test_cancel(task_pool: _TaskPool) -> None:
    event = asyncio.Event()

    async def coro():
        await event.wait()

    task = task_pool.create(coro())
    await task_pool.cancel()

    tru_len = len(task_pool)
    exp_len = 0
    assert tru_len == exp_len

    assert task.done()
