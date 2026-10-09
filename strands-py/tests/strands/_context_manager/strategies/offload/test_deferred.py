"""Tests for DeferredReplacements."""

import asyncio
import threading

import pytest

from strands._context_manager.strategies.offload.deferred import DeferredReplacements
from strands.agent.conversation_manager.compression.pin_message import pin_message
from strands.types.content import ContentBlock, Message, Messages


def _messages() -> Messages:
    return [
        Message(role="user", content=[ContentBlock(text="first")]),
        Message(role="assistant", content=[ContentBlock(text="second"), ContentBlock(text="third")]),
    ]


def _compute(replacement: ContentBlock | None, gate: asyncio.Event | None = None):
    async def compute() -> ContentBlock | None:
        if gate is not None:
            await gate.wait()
        return replacement

    return compute


@pytest.mark.asyncio
async def test_commit_waits_for_whole_batch_then_swaps_blocks_in_place():
    messages = _messages()
    gate = asyncio.Event()
    deferred = DeferredReplacements(max_pending=10)
    deferred.submit(messages[0]["content"][0], _compute(ContentBlock(text="FIRST")))
    deferred.submit(messages[1]["content"][1], _compute(ContentBlock(text="THIRD"), gate))
    await asyncio.sleep(0)

    assert deferred.commit(messages) is False
    assert messages[0]["content"][0] == {"text": "first"}

    gate.set()
    await asyncio.sleep(0)

    assert deferred.commit(messages) is True
    tru_messages = messages
    exp_messages = [
        {"role": "user", "content": [{"text": "FIRST"}]},
        {"role": "assistant", "content": [{"text": "second"}, {"text": "THIRD"}]},
    ]
    assert tru_messages == exp_messages
    assert deferred.commit(messages) is False


@pytest.mark.asyncio
async def test_submit_ignores_blocks_in_flight_and_beyond_the_batch_size():
    messages = _messages()
    deferred = DeferredReplacements(max_pending=1)
    deferred.submit(messages[0]["content"][0], _compute(ContentBlock(text="FIRST")))
    first_task = next(iter(deferred._pending.values()))[1]
    deferred.submit(messages[0]["content"][0], _compute(ContentBlock(text="AGAIN")))
    deferred.submit(messages[1]["content"][0], _compute(ContentBlock(text="SECOND")))

    tru_pending = [task for _, task in deferred._pending.values()]
    exp_pending = [first_task]
    assert tru_pending == exp_pending


@pytest.mark.asyncio
async def test_commit_drops_replacements_for_blocks_that_moved_on():
    messages = _messages()
    deferred = DeferredReplacements(max_pending=10)
    replaced = messages[0]["content"][0]
    removed = messages[1]["content"][0]
    pinned = messages[1]["content"][1]
    deferred.submit(replaced, _compute(ContentBlock(text="REPLACED")))
    deferred.submit(removed, _compute(ContentBlock(text="REMOVED")))
    deferred.submit(pinned, _compute(ContentBlock(text="PINNED")))
    await asyncio.sleep(0)

    other = ContentBlock(text="other")
    messages[0]["content"][0] = other
    del messages[1]["content"][0]
    pin_message(messages, 1)

    assert deferred.commit(messages) is False
    assert messages[0]["content"][0] is other
    assert messages[1]["content"] == [{"text": "third"}]
    assert deferred._pending == {}


@pytest.mark.asyncio
async def test_commit_skips_empty_and_failed_replacements():
    messages = _messages()

    async def failing() -> ContentBlock | None:
        raise RuntimeError("summarizer down")

    deferred = DeferredReplacements(max_pending=10)
    deferred.submit(messages[0]["content"][0], _compute(None))
    deferred.submit(messages[1]["content"][0], failing)
    await asyncio.sleep(0)

    assert deferred.commit(messages) is False
    assert messages == _messages()


@pytest.mark.asyncio
async def test_flush_waits_for_the_batch_then_commits():
    messages = _messages()
    gate = asyncio.Event()
    deferred = DeferredReplacements(max_pending=10)
    deferred.submit(messages[0]["content"][0], _compute(ContentBlock(text="FIRST"), gate))
    asyncio.get_running_loop().call_later(0.01, gate.set)

    assert await deferred.flush(messages, threading.Event()) is True
    assert messages[0]["content"][0] == {"text": "FIRST"}


@pytest.mark.asyncio
async def test_flush_cancels_the_batch_when_the_invocation_is_cancelled():
    messages = _messages()
    deferred = DeferredReplacements(max_pending=10)
    deferred.submit(messages[0]["content"][0], _compute(ContentBlock(text="FIRST"), asyncio.Event()))
    task = next(iter(deferred._pending.values()))[1]
    cancel_signal = threading.Event()
    cancel_signal.set()

    assert await asyncio.wait_for(deferred.flush(messages, cancel_signal), timeout=5) is False
    assert task.cancelled()
    assert messages == _messages()
    assert deferred._pending == {}
