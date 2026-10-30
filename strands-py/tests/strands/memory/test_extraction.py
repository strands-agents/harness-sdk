"""Tests for ``ExtractionCoordinator``.

Ported from the coordinator-focused parts of
``strands-ts/src/memory/extraction/__tests__/extraction.test.ts``. Each TS
``it(...)`` that exercises coordinator behavior maps to a ``test_...`` case here.
Where the TS suite drove the coordinator through ``MemoryManager`` + agent hooks,
these tests drive the :class:`ExtractionCoordinator` directly (``record`` /
``process`` / ``flush`` / ``schedule``) so attempt counts are deterministic and
no agent/manager wiring (Task 9/10) is required.

These tests are written test-first: ``ExtractionCoordinator`` lands in Task 8, so
they are expected to fail with an ``ImportError`` until that implementation
exists. The backoff constants are imported from the module under test and used in
assertions rather than hard-coded.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest

from strands.agent.invocation_context import _create_invocation_context, _reached_limit
from strands.memory.extraction.coordinator import (
    BACKOFF_PROBE_INTERVAL,
    SAVE_FAILURES_BEFORE_BACKOFF,
    ExtractionCoordinator,
    _ExtractionBinding,
)
from strands.memory.extraction.resolve_extraction_config import _resolve_extraction_config
from strands.memory.extraction.types import (
    ExtractionConfig,
    ExtractionResult,
    ExtractionTrigger,
    MemoryMessageFilter,
)
from strands.memory.types import AddMessagesContext
from strands.types.content import Message

# A stub model. The coordinator only passes ``default_model`` through to an
# extractor's context, so any sentinel object suffices.
_DEFAULT_MODEL: Any = SimpleNamespace(id="stub-model")


# --------------------------------------------------------------------------- #
# Test fakes / helpers
# --------------------------------------------------------------------------- #


class _NoopTrigger(ExtractionTrigger):
    """A trigger that never wires anything.

    The coordinator never calls ``attach`` (triggers are attached by the manager
    in Task 10), so a no-op satisfies ``ExtractionConfig.trigger`` without pulling
    in agent wiring.
    """

    name = "noop"

    def attach(self, context: Any) -> None:  # pragma: no cover - never called
        pass


def _trigger() -> _NoopTrigger:
    return _NoopTrigger()


def _make_store(
    name: str,
    extraction: ExtractionConfig,
    sink: str = "both",
) -> Any:
    """Build a writable fake store with the requested write sink(s).

    ``sink`` chooses which write method(s) the store exposes, mirroring the TS
    ``createExtractionStore`` helper:

    - ``"add"``       -> only ``add`` (extractor route)
    - ``"add_messages"`` -> only ``add_messages`` (passthrough route)
    - ``"both"``      -> both methods present

    ``search`` / ``add`` / ``add_messages`` are ``AsyncMock``s so tests can assert
    call counts/args and inject failures or gating.
    """
    store = SimpleNamespace()
    store.name = name
    store.description = None
    store.max_search_results = None
    store.writable = True
    store.extraction = extraction
    store.search = AsyncMock(return_value=[])
    store.add = AsyncMock(return_value=None)
    store.add_messages = AsyncMock(return_value=None)

    if sink == "add":
        del store.add_messages
    elif sink == "add_messages":
        del store.add
    return store


def _make_extractor(entries: list[ExtractionResult]) -> Any:
    """Build a fake ``Extractor`` whose ``extract`` is an ``AsyncMock``."""
    extractor = SimpleNamespace()
    extractor.extract = AsyncMock(return_value=list(entries))
    return extractor


def _coordinator(*stores: Any) -> ExtractionCoordinator:
    """Build an ``ExtractionCoordinator`` over the given fake stores.

    Resolves each store's ``extraction`` setting through the real
    :func:`_resolve_extraction_config` (the manager's job in production) so the
    coordinator receives ``_ExtractionBinding``s, matching how it is wired.
    """
    bindings = [
        _ExtractionBinding(store=store, config=_resolve_extraction_config(store.extraction, store)) for store in stores
    ]
    return ExtractionCoordinator(bindings, _DEFAULT_MODEL)


def _user_msg(text: str) -> Message:
    return {"role": "user", "content": [{"text": text}]}


def _assistant_msg(text: str) -> Message:
    return {"role": "assistant", "content": [{"text": text}]}


def _tool_use_msg() -> Message:
    return {"role": "assistant", "content": [{"toolUse": {"toolUseId": "1", "name": "t", "input": {}}}]}


def _added_metadata(call: Any) -> Any:
    """Pull the metadata argument from a recorded ``store.add`` call.

    Tolerates ``add(content, metadata)`` (positional) and
    ``add(content, metadata=...)`` (keyword).
    """
    if len(call.args) > 1:
        return call.args[1]
    return call.kwargs.get("metadata")


def _extractor_context(call: Any) -> Any:
    """Pull the ``ExtractorContext`` argument from a recorded ``extract`` call."""
    if len(call.args) > 1:
        return call.args[1]
    return call.kwargs.get("context")


def _add_messages_context(call: Any) -> Any:
    """Pull the ``AddMessagesContext`` argument from a recorded ``add_messages`` call.

    Tolerates ``add_messages(messages, context)`` (positional) and
    ``add_messages(messages, context=...)`` (keyword).
    """
    if len(call.args) > 1:
        return call.args[1]
    return call.kwargs.get("context")


def _saved_texts(mock: AsyncMock) -> list[str]:
    """Flatten every text block delivered across all calls to an add* mock."""
    texts: list[str] = []
    for call in mock.call_args_list:
        batch = call.args[0]
        for message in batch:
            for block in message["content"]:
                if "text" in block:
                    texts.append(block["text"])
    return texts


async def _drive(coordinator: ExtractionCoordinator, store: Any) -> None:
    """Request a save and await it.

    ``process`` returns the queued save task, or ``None`` when the store is
    backed off and this request is not a probe; awaiting the task drives the save
    to completion for deterministic assertions.
    """
    task = coordinator.process(store)
    if task is not None:
        await task


# --------------------------------------------------------------------------- #
# No-extractor passthrough
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_no_extractor_passthrough_hands_raw_batch_to_add_messages():
    store = _make_store("s", ExtractionConfig(trigger=_trigger()), sink="add_messages")
    coordinator = _coordinator(store)

    coordinator.record(_user_msg("I prefer dark mode"))
    coordinator.record(_assistant_msg("Noted"))
    await _drive(coordinator, store)

    store.add_messages.assert_called_once()
    batch = store.add_messages.call_args.args[0]
    assert len(batch) == 2
    assert batch[0]["role"] == "user"
    assert batch[1]["role"] == "assistant"


# --------------------------------------------------------------------------- #
# Extractor route
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_extractor_route_calls_extractor_and_writes_each_entry_via_add():
    extractor = _make_extractor(
        [ExtractionResult(content="fact one"), ExtractionResult(content="fact two", metadata={"k": "v"})]
    )
    store = _make_store("s", ExtractionConfig(trigger=_trigger(), extractor=extractor), sink="both")
    coordinator = _coordinator(store)

    coordinator.record(_user_msg("something happened"))
    await _drive(coordinator, store)

    extractor.extract.assert_called_once()
    assert store.add.call_count == 2
    assert store.add.call_args_list[0].args[0] == "fact one"
    assert store.add.call_args_list[1].args[0] == "fact two"
    assert _added_metadata(store.add.call_args_list[1]) == {"k": "v"}
    # The extractor route never uses the batch sink.
    store.add_messages.assert_not_called()


@pytest.mark.asyncio
async def test_extractor_route_passes_default_model_in_context():
    extractor = _make_extractor([])
    store = _make_store("s", ExtractionConfig(trigger=_trigger(), extractor=extractor), sink="both")
    coordinator = _coordinator(store)

    coordinator.record(_user_msg("hi"))
    await _drive(coordinator, store)

    extractor.extract.assert_called_once()
    context = _extractor_context(extractor.extract.call_args)
    assert context is not None
    assert context.default_model is _DEFAULT_MODEL


@pytest.mark.asyncio
async def test_extractor_route_writes_entries_concurrently():
    # Both add() calls should be in flight before either resolves: the first add
    # blocks until the second has started, which is only possible if the writes
    # run concurrently (a serial await loop would deadlock).
    second_started = asyncio.Event()
    first_invoked_during_second = False
    call_index = {"n": 0}

    async def add_impl(content: str, metadata: Any = None) -> None:
        nonlocal first_invoked_during_second
        index = call_index["n"]
        call_index["n"] += 1
        if index == 0:
            await second_started.wait()
            first_invoked_during_second = second_started.is_set()
        else:
            second_started.set()

    extractor = _make_extractor([ExtractionResult(content="a"), ExtractionResult(content="b")])
    store = _make_store("s", ExtractionConfig(trigger=_trigger(), extractor=extractor), sink="add")
    store.add.side_effect = add_impl
    coordinator = _coordinator(store)

    coordinator.record(_user_msg("x"))
    await _drive(coordinator, store)

    assert store.add.call_count == 2
    assert first_invoked_during_second is True


@pytest.mark.asyncio
async def test_extractor_route_rolls_back_and_retries_batch_on_entry_failure():
    extractor = _make_extractor([ExtractionResult(content="a"), ExtractionResult(content="b")])
    store = _make_store("s", ExtractionConfig(trigger=_trigger(), extractor=extractor), sink="add")
    # First batch: second entry write fails -> whole batch rolled back.
    store.add.side_effect = [None, RuntimeError("write failed"), None, None]
    coordinator = _coordinator(store)

    coordinator.record(_user_msg("x"))
    await _drive(coordinator, store)  # fails, mark rolled back
    await _drive(coordinator, store)  # retries the same batch

    # 2 writes on the first attempt + 2 on the retry.
    assert store.add.call_count == 4
    assert extractor.extract.call_count == 2


# --------------------------------------------------------------------------- #
# Message filter
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_filter_drops_tool_blocks_by_default_and_empties():
    store = _make_store("s", ExtractionConfig(trigger=_trigger()), sink="add_messages")
    coordinator = _coordinator(store)

    coordinator.record(_user_msg("keep me"))
    coordinator.record(_tool_use_msg())  # tool-only message -> emptied -> dropped
    await _drive(coordinator, store)

    store.add_messages.assert_called_once()
    batch = store.add_messages.call_args.args[0]
    assert len(batch) == 1
    assert batch[0]["role"] == "user"


@pytest.mark.asyncio
async def test_filter_honors_a_custom_filter():
    store = _make_store(
        "s",
        ExtractionConfig(trigger=_trigger(), filter=MemoryMessageFilter(exclude=["text"])),
        sink="add_messages",
    )
    coordinator = _coordinator(store)

    coordinator.record(_user_msg("this is text and should be excluded"))
    await _drive(coordinator, store)

    # The only message was text, excluded -> emptied -> nothing to write.
    store.add_messages.assert_not_called()


# --------------------------------------------------------------------------- #
# High-water-mark dedup
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_hwm_processes_only_messages_added_since_the_last_save():
    store = _make_store("s", ExtractionConfig(trigger=_trigger()), sink="add_messages")
    coordinator = _coordinator(store)

    coordinator.record(_user_msg("turn one"))
    await _drive(coordinator, store)
    coordinator.record(_user_msg("turn two"))
    await _drive(coordinator, store)

    assert store.add_messages.call_count == 2
    assert len(store.add_messages.call_args_list[0].args[0]) == 1
    second = store.add_messages.call_args_list[1].args[0]
    assert len(second) == 1
    assert second[0]["content"][0]["text"] == "turn two"


@pytest.mark.asyncio
async def test_hwm_does_nothing_when_no_new_messages_since_the_mark():
    store = _make_store("s", ExtractionConfig(trigger=_trigger()), sink="add_messages")
    coordinator = _coordinator(store)

    coordinator.record(_user_msg("only turn"))
    await _drive(coordinator, store)
    await _drive(coordinator, store)  # no new messages

    assert store.add_messages.call_count == 1


@pytest.mark.asyncio
async def test_hwm_retries_the_same_messages_on_the_next_save_if_a_write_fails():
    store = _make_store("s", ExtractionConfig(trigger=_trigger()), sink="add_messages")
    store.add_messages.side_effect = [RuntimeError("backend down"), None]
    coordinator = _coordinator(store)

    coordinator.record(_user_msg("important"))
    await _drive(coordinator, store)  # fails, mark rolled back
    await _drive(coordinator, store)  # retries

    assert store.add_messages.call_count == 2
    assert len(store.add_messages.call_args_list[1].args[0]) == 1


# --------------------------------------------------------------------------- #
# Backing off and recovering from a failing store
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_backs_off_to_periodic_probes_after_threshold_failures():
    store = _make_store("s", ExtractionConfig(trigger=_trigger()), sink="add_messages")
    store.add_messages.side_effect = RuntimeError("backend down")
    coordinator = _coordinator(store)

    # Each call buffers a message and requests a save; every save fails. Run
    # enough backed-off requests for exactly two probe intervals.
    probes = 2
    requests = SAVE_FAILURES_BEFORE_BACKOFF + BACKOFF_PROBE_INTERVAL * probes
    for index in range(requests):
        coordinator.record(_user_msg(f"m{index}"))
        await _drive(coordinator, store)

    # Attempts every request until backoff, then only every probe interval.
    assert store.add_messages.call_count == SAVE_FAILURES_BEFORE_BACKOFF + probes


@pytest.mark.asyncio
async def test_recovers_and_saves_the_buffered_backlog_when_the_store_comes_back():
    store = _make_store("s", ExtractionConfig(trigger=_trigger()), sink="add_messages")
    store.add_messages.side_effect = RuntimeError("down")
    coordinator = _coordinator(store)

    # Drive the store into backoff.
    for index in range(SAVE_FAILURES_BEFORE_BACKOFF):
        coordinator.record(_user_msg(f"down{index}"))
        await _drive(coordinator, store)

    # Store recovers; run probe-interval requests so a probe lands and succeeds.
    store.add_messages.reset_mock()
    store.add_messages.side_effect = None
    store.add_messages.return_value = None
    for index in range(BACKOFF_PROBE_INTERVAL):
        coordinator.record(_user_msg(f"up{index}"))
        await _drive(coordinator, store)

    # The recovering probe saved, and its batch includes the outage backlog.
    assert store.add_messages.called
    texts = _saved_texts(store.add_messages)
    assert "down0" in texts
    assert "up0" in texts


@pytest.mark.asyncio
async def test_a_healthy_store_keeps_saving_every_request_while_a_sibling_is_backed_off():
    bad = _make_store("bad", ExtractionConfig(trigger=_trigger()), sink="add_messages")
    bad.add_messages.side_effect = RuntimeError("down")
    good = _make_store("good", ExtractionConfig(trigger=_trigger()), sink="add_messages")
    coordinator = _coordinator(bad, good)

    probes = 2
    requests = SAVE_FAILURES_BEFORE_BACKOFF + BACKOFF_PROBE_INTERVAL * probes
    for index in range(requests):
        coordinator.record(_user_msg(f"m{index}"))
        await _drive(coordinator, bad)
        await _drive(coordinator, good)

    # Good store saves every request; bad store stops at backoff + its probes.
    assert good.add_messages.call_count == requests
    assert bad.add_messages.call_count == SAVE_FAILURES_BEFORE_BACKOFF + probes


@pytest.mark.asyncio
async def test_flush_resolves_even_when_a_store_is_failing():
    store = _make_store("s", ExtractionConfig(trigger=_trigger()), sink="add_messages")
    store.add_messages.side_effect = RuntimeError("down")
    coordinator = _coordinator(store)

    coordinator.record(_user_msg("x"))
    await _drive(coordinator, store)  # fails (swallowed)

    assert await coordinator.flush() is None


@pytest.mark.asyncio
async def test_flush_bypasses_backoff_and_writes_the_backlog_of_a_recovered_store():
    store = _make_store("s", ExtractionConfig(trigger=_trigger()), sink="add_messages")
    store.add_messages.side_effect = RuntimeError("down")
    coordinator = _coordinator(store)

    # Drive the store into backoff.
    for index in range(SAVE_FAILURES_BEFORE_BACKOFF):
        coordinator.record(_user_msg(f"down{index}"))
        await _drive(coordinator, store)

    # Store recovers and a final message arrives, but no probe has landed yet.
    store.add_messages.reset_mock()
    store.add_messages.side_effect = None
    store.add_messages.return_value = None
    coordinator.record(_user_msg("final"))

    # A single flush must write the backlog despite backoff (not be probe-gated).
    await coordinator.flush()

    store.add_messages.assert_called_once()
    texts = _saved_texts(store.add_messages)
    assert "final" in texts
    assert "down0" in texts


@pytest.mark.asyncio
async def test_a_fully_filtered_empty_turn_does_not_reset_the_failure_streak():
    # A no-extractor store; the default filter drops tool blocks. A turn of only
    # tool blocks contributes no extractable content, so it must not be mistaken
    # for a recovery that clears the prior failures. We prove the streak survives
    # by showing backoff still engages and the next request is probe-gated.
    store = _make_store("s", ExtractionConfig(trigger=_trigger()), sink="add_messages")
    store.add_messages.side_effect = RuntimeError("down")
    coordinator = _coordinator(store)

    # One short of backoff.
    for index in range(SAVE_FAILURES_BEFORE_BACKOFF - 1):
        coordinator.record(_user_msg(f"m{index}"))
        await _drive(coordinator, store)

    # An all-tool-blocks turn: its own content filters away.
    coordinator.record(_tool_use_msg())
    await _drive(coordinator, store)

    # The next real failure tips into backoff (it would not if the streak reset).
    coordinator.record(_user_msg("nth"))
    await _drive(coordinator, store)

    # Backed off: the next request is probe-gated, so the backend isn't called.
    store.add_messages.reset_mock()
    coordinator.record(_user_msg("after"))
    await _drive(coordinator, store)
    store.add_messages.assert_not_called()


# --------------------------------------------------------------------------- #
# Flush semantics
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_flush_force_extracts_a_buffered_tail_whose_trigger_never_fired():
    store = _make_store("s", ExtractionConfig(trigger=_trigger()), sink="add_messages")
    coordinator = _coordinator(store)

    # Buffer messages but never call process (the trigger never fired).
    coordinator.record(_user_msg("a"))
    coordinator.record(_user_msg("b"))
    store.add_messages.assert_not_called()

    await coordinator.flush()

    store.add_messages.assert_called_once()
    assert len(store.add_messages.call_args.args[0]) == 2


@pytest.mark.asyncio
async def test_flush_does_not_re_extract_messages_already_processed():
    store = _make_store("s", ExtractionConfig(trigger=_trigger()), sink="add_messages")
    coordinator = _coordinator(store)

    coordinator.record(_user_msg("a"))
    await _drive(coordinator, store)  # already extracted
    assert store.add_messages.call_count == 1

    await coordinator.flush()  # nothing fresh -> no-op
    assert store.add_messages.call_count == 1


@pytest.mark.asyncio
async def test_flush_is_a_no_op_when_nothing_is_buffered():
    store = _make_store("s", ExtractionConfig(trigger=_trigger()), sink="add_messages")
    coordinator = _coordinator(store)

    await coordinator.flush()

    store.add_messages.assert_not_called()


@pytest.mark.asyncio
async def test_flush_awaits_an_in_flight_write():
    release = asyncio.Event()
    completed = {"v": False}

    async def add_messages_impl(messages: Any, context: Any = None) -> None:
        await release.wait()
        completed["v"] = True

    store = _make_store("s", ExtractionConfig(trigger=_trigger()), sink="add_messages")
    store.add_messages.side_effect = add_messages_impl
    coordinator = _coordinator(store)

    coordinator.record(_user_msg("hello"))
    coordinator.schedule(store)  # non-blocking background save

    flushed = asyncio.ensure_future(coordinator.flush())
    await asyncio.sleep(0)  # let flush start waiting on the in-flight write
    assert completed["v"] is False

    release.set()
    await flushed
    assert completed["v"] is True


# --------------------------------------------------------------------------- #
# Background, non-blocking execution
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_background_save_does_not_block_scheduling_and_flush_awaits_it():
    release = asyncio.Event()
    started = asyncio.Event()
    completed = {"v": False}

    async def add_messages_impl(messages: Any, context: Any = None) -> None:
        started.set()
        await release.wait()
        completed["v"] = True

    store = _make_store("s", ExtractionConfig(trigger=_trigger()), sink="add_messages")
    store.add_messages.side_effect = add_messages_impl
    coordinator = _coordinator(store)

    coordinator.record(_user_msg("hello"))
    coordinator.schedule(store)  # returns immediately, write runs in background

    # The background write begins but hangs; scheduling did not block on it.
    await started.wait()
    assert completed["v"] is False

    # flush must await the in-flight write to completion once it is released.
    flushed = asyncio.ensure_future(coordinator.flush())
    await asyncio.sleep(0)
    assert completed["v"] is False
    release.set()
    await flushed
    assert completed["v"] is True


# --------------------------------------------------------------------------- #
# add_messages context (per-message seqs)
#
# Ported from the "addMessages context (per-message seqs)" describe block in
# strands-ts/src/memory/extraction/__tests__/extraction.test.ts. These assert the
# coordinator hands ``add_messages`` an ``AddMessagesContext`` carrying the
# per-message sequence numbers aligned with the filtered batch, so a store can
# build an idempotency key that survives retries.
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_add_messages_passes_sequence_numbers_aligned_with_the_filtered_batch():
    store = _make_store("s", ExtractionConfig(trigger=_trigger()), sink="add_messages")
    coordinator = _coordinator(store)

    coordinator.record(_user_msg("first"))
    coordinator.record(_user_msg("second"))
    await _drive(coordinator, store)

    store.add_messages.assert_called_once()
    batch = store.add_messages.call_args.args[0]
    ctx = _add_messages_context(store.add_messages.call_args)
    # Assert the whole context so an unexpected field added to the envelope later is caught.
    assert ctx == AddMessagesContext(sequence_numbers=[0, 1])
    assert len(ctx.sequence_numbers) == len(batch)


@pytest.mark.asyncio
async def test_add_messages_keeps_a_message_seq_when_an_earlier_message_is_filtered_to_empty():
    store = _make_store("s", ExtractionConfig(trigger=_trigger()), sink="add_messages")
    coordinator = _coordinator(store)

    # seq 0 (kept), seq 1 (tool-only, filtered to empty and dropped), seq 2 (kept).
    coordinator.record(_user_msg("a"))
    coordinator.record(_tool_use_msg())
    coordinator.record(_user_msg("b"))
    await _drive(coordinator, store)

    batch = store.add_messages.call_args.args[0]
    ctx = _add_messages_context(store.add_messages.call_args)
    assert len(batch) == 2
    # The dropped message leaves a gap: 1 is missing, survivors keep their own seqs.
    assert ctx == AddMessagesContext(sequence_numbers=[0, 2])


@pytest.mark.asyncio
async def test_add_messages_re_fires_the_same_seqs_for_a_batch_whose_save_failed():
    store = _make_store("s", ExtractionConfig(trigger=_trigger()), sink="add_messages")
    store.add_messages.side_effect = [RuntimeError("backend down"), None]
    coordinator = _coordinator(store)

    coordinator.record(_user_msg("first"))
    coordinator.record(_user_msg("second"))
    await _drive(coordinator, store)  # fails, mark rolled back
    await _drive(coordinator, store)  # retries the same batch

    assert store.add_messages.call_count == 2
    first = _add_messages_context(store.add_messages.call_args_list[0])
    second = _add_messages_context(store.add_messages.call_args_list[1])
    assert first == AddMessagesContext(sequence_numbers=[0, 1])
    # The retry carries the identical context in order, not a fresh renumbering.
    assert second == first


@pytest.mark.asyncio
async def test_add_messages_anchors_the_seq_to_the_message_not_the_batch_position():
    store = _make_store("s", ExtractionConfig(trigger=_trigger()), sink="add_messages")
    coordinator = _coordinator(store)

    # First turn (seq 0) saves cleanly; second turn (seq 1) fails then retries.
    coordinator.record(_user_msg("turn one"))
    await _drive(coordinator, store)
    store.add_messages.side_effect = [RuntimeError("backend down"), None]
    coordinator.record(_user_msg("turn two"))
    await _drive(coordinator, store)  # fails, rolled back
    await _drive(coordinator, store)  # retries turn two

    assert store.add_messages.call_count == 3
    retried = _add_messages_context(store.add_messages.call_args_list[2])
    # Retried batch carries the message's original seq (1), not a renumbered 0.
    assert retried == AddMessagesContext(sequence_numbers=[1])


@pytest.mark.asyncio
async def test_add_messages_gives_each_store_index_aligned_seqs_from_the_shared_buffer():
    a = _make_store("a", ExtractionConfig(trigger=_trigger()), sink="add_messages")
    b = _make_store("b", ExtractionConfig(trigger=_trigger()), sink="add_messages")
    coordinator = _coordinator(a, b)

    coordinator.record(_user_msg("first"))
    coordinator.record(_user_msg("second"))
    await _drive(coordinator, a)
    await _drive(coordinator, b)

    ctx_a = _add_messages_context(a.add_messages.call_args)
    ctx_b = _add_messages_context(b.add_messages.call_args)
    assert ctx_a == AddMessagesContext(sequence_numbers=[0, 1])
    assert ctx_b == AddMessagesContext(sequence_numbers=[0, 1])


@pytest.mark.asyncio
async def test_extractor_route_does_not_receive_add_messages_context():
    extractor = _make_extractor([ExtractionResult(content="fact")])
    store = _make_store("s", ExtractionConfig(trigger=_trigger(), extractor=extractor), sink="both")
    coordinator = _coordinator(store)

    coordinator.record(_user_msg("something happened"))
    await _drive(coordinator, store)

    # Extractor route writes via add; add_messages is never called, so no context is built for it.
    store.add_messages.assert_not_called()
    extractor.extract.assert_called_once()


@pytest.mark.asyncio
async def test_extractor_gets_a_handle_that_joins_the_request_usage_without_its_limits():
    extractor = _make_extractor([ExtractionResult(content="fact")])
    store = _make_store("s", ExtractionConfig(trigger=_trigger(), extractor=extractor), sink="add")
    coordinator = _coordinator(store)
    coordinator.record(_user_msg("I prefer dark mode"))
    request = _create_invocation_context({"turns": 1})
    request._usage["turns_taken"] = 1

    task = coordinator.process(store, None, request)
    await task

    handed = extractor.extract.call_args.args[1].invocation_context
    handed._record_usage({"inputTokens": 1, "outputTokens": 2, "totalTokens": 3})
    assert _reached_limit(handed) is None
    assert request.usage == {"turns_taken": 1, "inputTokens": 1, "outputTokens": 2, "totalTokens": 3}


@pytest.mark.asyncio
async def test_extractor_gets_no_handle_outside_a_request():
    extractor = _make_extractor([ExtractionResult(content="fact")])
    store = _make_store("s", ExtractionConfig(trigger=_trigger(), extractor=extractor), sink="add")
    coordinator = _coordinator(store)
    coordinator.record(_user_msg("I prefer dark mode"))

    await _drive(coordinator, store)

    assert extractor.extract.call_args.args[1].invocation_context is None
