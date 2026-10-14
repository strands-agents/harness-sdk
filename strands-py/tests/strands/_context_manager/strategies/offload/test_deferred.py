"""Tests for DeferredReplacements."""

import asyncio
import math
import threading

import pytest

from strands._context_manager.strategies.offload import deferred as deferred_module
from strands._context_manager.strategies.offload.deferred import DeferredOptions, DeferredReplacements
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


def _deferred(**overrides) -> DeferredReplacements:
    options = {"max_concurrency": 10, "task_timeout": math.inf, "flush_timeout": 5.0, **overrides}
    return DeferredReplacements(DeferredOptions(**options))


async def _settle(deferred: DeferredReplacements) -> None:
    await deferred._engine.wait_for_idle()
    await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_commit_waits_for_whole_batch_then_swaps_blocks_in_place():
    messages = _messages()
    gate = asyncio.Event()
    deferred = _deferred()
    deferred.submit(messages[0]["content"][0], _compute(ContentBlock(text="FIRST")))
    deferred.submit(messages[1]["content"][1], _compute(ContentBlock(text="THIRD"), gate))
    await asyncio.sleep(0)

    assert deferred.commit(messages) is False
    assert messages[0]["content"][0] == {"text": "first"}

    gate.set()
    await _settle(deferred)

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
    deferred = _deferred(max_concurrency=1)
    deferred.submit(messages[0]["content"][0], _compute(ContentBlock(text="FIRST")))
    deferred.submit(messages[0]["content"][0], _compute(ContentBlock(text="AGAIN")))
    deferred.submit(messages[1]["content"][0], _compute(ContentBlock(text="SECOND")))

    tru_inputs = [record["input"].block for record in deferred._engine.list()]
    exp_inputs = [messages[0]["content"][0]]
    assert tru_inputs == exp_inputs


@pytest.mark.asyncio
async def test_commit_drops_replacements_for_blocks_that_moved_on():
    messages = _messages()
    deferred = _deferred()
    replaced = messages[0]["content"][0]
    removed = messages[1]["content"][0]
    pinned = messages[1]["content"][1]
    deferred.submit(replaced, _compute(ContentBlock(text="REPLACED")))
    deferred.submit(removed, _compute(ContentBlock(text="REMOVED")))
    deferred.submit(pinned, _compute(ContentBlock(text="PINNED")))
    await _settle(deferred)

    other = ContentBlock(text="other")
    messages[0]["content"][0] = other
    del messages[1]["content"][0]
    pin_message(messages, 1)

    assert deferred.commit(messages) is False
    assert messages[0]["content"][0] is other
    assert messages[1]["content"] == [{"text": "third"}]
    assert deferred._engine.list() == []


@pytest.mark.asyncio
async def test_failed_or_empty_replacements_leave_blocks_untouched():
    messages = _messages()

    async def failing() -> ContentBlock | None:
        raise RuntimeError("summarizer down")

    deferred = _deferred()
    deferred.submit(messages[0]["content"][0], _compute(None))
    deferred.submit(messages[1]["content"][0], failing)
    await _settle(deferred)

    assert deferred.commit(messages) is False
    assert messages == _messages()


@pytest.mark.asyncio
async def test_repeated_failures_back_off_then_probe(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(deferred_module, "_FAILURES_BEFORE_BACKOFF", 2)
    monkeypatch.setattr(deferred_module, "_BACKOFF_PROBE_INTERVAL", 3)
    messages = _messages()
    block = messages[0]["content"][0]

    async def failing() -> ContentBlock | None:
        raise RuntimeError("summarizer down")

    deferred = _deferred()
    for _ in range(2):
        deferred.submit(block, failing)
        await _settle(deferred)
        deferred.commit(messages)

    submitted: list[bool] = []
    for _ in range(3):
        deferred.submit(block, _compute(ContentBlock(text="FIRST")))
        submitted.append(bool(deferred._engine.list()))
    tru_submitted = submitted
    exp_submitted = [False, False, True]
    assert tru_submitted == exp_submitted

    await _settle(deferred)
    assert deferred.commit(messages) is True
    assert deferred._consecutive_failures == 0


@pytest.mark.asyncio
async def test_task_timeout_fails_only_the_stuck_replacement():
    messages = _messages()
    deferred = _deferred(task_timeout=0.01)
    deferred.submit(messages[0]["content"][0], _compute(ContentBlock(text="FIRST")))
    deferred.submit(messages[1]["content"][0], _compute(ContentBlock(text="NEVER"), asyncio.Event()))
    await _settle(deferred)

    assert deferred.commit(messages) is True
    tru_messages = messages
    exp_messages = [
        {"role": "user", "content": [{"text": "FIRST"}]},
        {"role": "assistant", "content": [{"text": "second"}, {"text": "third"}]},
    ]
    assert tru_messages == exp_messages


@pytest.mark.asyncio
async def test_flush_waits_for_the_batch_then_commits():
    messages = _messages()
    gate = asyncio.Event()
    deferred = _deferred()
    deferred.submit(messages[0]["content"][0], _compute(ContentBlock(text="FIRST"), gate))
    asyncio.get_running_loop().call_later(0.01, gate.set)

    assert await deferred.flush(messages, threading.Event()) is True
    assert messages[0]["content"][0] == {"text": "FIRST"}


@pytest.mark.asyncio
async def test_flush_drops_the_batch_when_the_invocation_is_cancelled():
    messages = _messages()
    deferred = _deferred()
    deferred.submit(messages[0]["content"][0], _compute(ContentBlock(text="FIRST"), asyncio.Event()))
    cancel_signal = threading.Event()
    cancel_signal.set()

    assert await asyncio.wait_for(deferred.flush(messages, cancel_signal), timeout=5) is False
    assert messages == _messages()
    assert deferred._engine.list() == []
    assert deferred._consecutive_failures == 0


@pytest.mark.asyncio
async def test_flush_drops_the_batch_when_the_deadline_passes():
    messages = _messages()
    deferred = _deferred(flush_timeout=0.05)
    deferred.submit(messages[0]["content"][0], _compute(ContentBlock(text="FIRST"), asyncio.Event()))

    assert await asyncio.wait_for(deferred.flush(messages, threading.Event()), timeout=5) is False
    assert messages == _messages()
    assert deferred._engine.list() == []
    assert deferred._consecutive_failures == 1


def test_init_rejects_invalid_flush_timeout():
    with pytest.raises(TypeError, match="flush_timeout must be a positive finite number"):
        DeferredReplacements(DeferredOptions(flush_timeout=math.inf))


@pytest.mark.asyncio
async def test_flush_rotates_engine_when_cancelled_work_does_not_stop():
    messages = _messages()
    release = asyncio.Event()
    started = asyncio.Event()

    async def suppress_cancellation() -> ContentBlock | None:
        started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            await release.wait()
        return ContentBlock(text="LATE")

    deferred = _deferred(flush_timeout=0.05)
    old_engine = deferred._engine
    deferred.submit(messages[0]["content"][0], suppress_cancellation)
    await started.wait()

    assert await asyncio.wait_for(deferred.flush(messages, threading.Event()), timeout=5) is False
    assert deferred._engine is not old_engine

    deferred.submit(messages[1]["content"][0], _compute(ContentBlock(text="SECOND")))
    await _settle(deferred)
    assert deferred.commit(messages) is True
    assert messages[1]["content"][0] == {"text": "SECOND"}

    release.set()
    await asyncio.wait_for(old_engine.wait_for_idle(), timeout=5)
    assert messages[0]["content"][0] == {"text": "first"}
