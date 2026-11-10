"""Unit tests for _ConcurrencyController (idempotency + invocation locking)."""

import asyncio
import threading
from unittest.mock import MagicMock

import pytest

from strands.agent._concurrency import _ConcurrencyController, _InflightInvocation
from strands.types.agent import ConcurrentInvocationMode
from strands.types.exceptions import IdempotencyAbortedError


@pytest.fixture
def controller():
    return _ConcurrencyController(ConcurrentInvocationMode.THROW)


@pytest.fixture
def reentrant_controller():
    return _ConcurrencyController(ConcurrentInvocationMode.UNSAFE_REENTRANT)


def test_mode_property(controller, reentrant_controller):
    assert controller.mode == ConcurrentInvocationMode.THROW
    assert reentrant_controller.mode == ConcurrentInvocationMode.UNSAFE_REENTRANT


def test_begin_first_call_acquires_lock_and_registers_token(controller):
    result = controller.begin("abc")

    assert result.waiting_on is None
    assert result.registered_token == "abc"
    assert result.lock_acquired is True


def test_begin_without_token_acquires_lock_but_registers_nothing(controller):
    result = controller.begin(None)

    assert result.waiting_on is None
    assert result.registered_token is None
    assert result.lock_acquired is True


def test_begin_duplicate_token_returns_waiting_on(controller):
    controller.begin("abc")
    second = controller.begin("abc")

    assert second.waiting_on is not None
    assert second.lock_acquired is False
    assert second.registered_token is None
    assert isinstance(second.waiting_on, _InflightInvocation)


def test_begin_different_token_while_inflight_fails_lock(controller):
    controller.begin("abc")

    second = controller.begin("def")

    assert second.waiting_on is None
    assert second.registered_token is None
    assert second.lock_acquired is False


def test_begin_no_token_while_inflight_fails_lock(controller):
    controller.begin("abc")

    second = controller.begin(None)

    assert second.waiting_on is None
    assert second.registered_token is None
    assert second.lock_acquired is False


def test_complete_with_result_signals_waiters(controller):
    first = controller.begin("abc")
    dup = controller.begin("abc")

    mock_result = MagicMock()
    controller.complete(first.registered_token, result=mock_result)

    assert dup.waiting_on.settled
    assert dup.waiting_on.result is mock_result
    assert dup.waiting_on.error is None


def test_complete_with_error_signals_waiters(controller):
    first = controller.begin("abc")
    dup = controller.begin("abc")

    err = RuntimeError("boom")
    controller.complete(first.registered_token, error=err)

    assert dup.waiting_on.settled
    assert dup.waiting_on.error is err
    assert dup.waiting_on.result is None


def test_complete_with_neither_result_nor_error_sets_aborted(controller):
    first = controller.begin("abc")
    dup = controller.begin("abc")

    controller.complete(first.registered_token)

    assert dup.waiting_on.settled
    assert isinstance(dup.waiting_on.error, IdempotencyAbortedError)


def test_settle_is_idempotent_first_outcome_wins():
    """settle() called twice keeps the first outcome and stays settled.

    The controller serializes settle() via the inflight lock, so this guards the
    idempotency contract directly at the _InflightInvocation level.
    """
    inflight = _InflightInvocation()
    first_result = MagicMock()

    inflight.settle(first_result, None)
    inflight.settle(None, RuntimeError("second"))  # must be ignored

    assert inflight.settled is True
    assert inflight.result is first_result
    assert inflight.error is None


def test_complete_is_idempotent_on_double_call(controller):
    """except + finally both call complete(); second must no-op."""
    first = controller.begin("abc")
    dup = controller.begin("abc")

    err = RuntimeError("first")
    controller.complete(first.registered_token, error=err)
    # Second call (e.g. from finally with result=None) must not overwrite.
    controller.complete(first.registered_token, result=None)

    assert dup.waiting_on.error is err  # unchanged


def test_complete_with_none_token_is_noop(controller):
    controller.begin("abc")
    # Should not touch the inflight slot.
    controller.complete(None, error=RuntimeError("x"))

    # Inflight slot still owns "abc".
    second = controller.begin("def")
    assert second.lock_acquired is False  # "abc" is still inflight


def test_complete_after_cleared_is_noop(controller):
    first = controller.begin("abc")
    controller.complete(first.registered_token, result=MagicMock())

    # Slot is clear; calling complete again on the same token is a safe no-op.
    controller.complete(first.registered_token, error=RuntimeError("late"))


def test_release_lock_when_held(controller):
    controller.begin("abc")
    controller.release_lock()

    # Lock is now free; a new begin (after completing the inflight) should acquire it.
    controller.complete("abc", result=MagicMock())
    result = controller.begin("def")
    assert result.lock_acquired is True


def test_release_lock_when_not_held_is_noop(controller):
    controller.release_lock()  # should not raise
    controller.release_lock()


def test_completion_clears_slot_so_next_begin_is_fresh(controller):
    first = controller.begin("abc")
    controller.complete(first.registered_token, result=MagicMock())
    controller.release_lock()

    second = controller.begin("abc")
    assert second.waiting_on is None
    assert second.registered_token == "abc"
    assert second.lock_acquired is True


def test_unsafe_reentrant_ignores_idempotency_token(reentrant_controller):
    first = reentrant_controller.begin("abc")
    second = reentrant_controller.begin("abc")

    assert first.waiting_on is None
    assert first.registered_token is None
    assert first.lock_acquired is True
    assert second.waiting_on is None
    assert second.registered_token is None
    assert second.lock_acquired is True


def test_unsafe_reentrant_complete_with_none_token_is_noop(reentrant_controller):
    first = reentrant_controller.begin("abc")
    # registered_token is None in UNSAFE_REENTRANT, so complete is a no-op.
    reentrant_controller.complete(first.registered_token, result=MagicMock())


def test_multiple_duplicates_all_wake_up(controller):
    first = controller.begin("abc")
    dup1 = controller.begin("abc")
    dup2 = controller.begin("abc")
    dup3 = controller.begin("abc")

    mock_result = MagicMock()
    controller.complete(first.registered_token, result=mock_result)

    assert dup1.waiting_on.settled
    assert dup2.waiting_on.settled
    assert dup3.waiting_on.settled
    # All three see the same _InflightInvocation instance.
    assert dup1.waiting_on is dup2.waiting_on is dup3.waiting_on
    assert dup1.waiting_on.result is mock_result


def test_duplicate_does_not_acquire_lock(controller):
    """Verify the lock stays held by the primary while a duplicate is waiting."""
    first = controller.begin("abc")
    assert first.lock_acquired is True

    dup = controller.begin("abc")
    assert dup.lock_acquired is False  # duplicate doesn't claim the lock

    # Now if a third party with a different token arrives, it should fail on lock.
    other = controller.begin("xyz")
    assert other.lock_acquired is False


def test_lock_acquire_fail_path_cleanup_via_complete(controller):
    """Simulate the lock-acquire-fail cleanup pattern used by stream_async."""
    controller.begin("abc")  # T1 owns the slot and the lock

    # T2 with same token would be a duplicate, but here we exercise a different
    # token to mirror the "lock-fail with newly-registered token" scenario.
    # Note: when token differs, registered_token is None (no cleanup needed).
    second = controller.begin("def")
    assert second.registered_token is None
    # Calling complete with None is a safe no-op:
    controller.complete(second.registered_token, error=RuntimeError("would-be ConcurrencyException"))


def test_concurrent_begin_only_one_primary_others_duplicates(controller):
    """Stress test: many threads call begin with the same token concurrently.

    Exactly one must become the primary (lock_acquired=True, registered_token set);
    all others must be duplicates (waiting_on set, registered_token=None).
    """
    barrier = threading.Barrier(10)
    results = []
    lock = threading.Lock()

    def call():
        barrier.wait()
        r = controller.begin("abc")
        with lock:
            results.append(r)

    threads = [threading.Thread(target=call) for _ in range(10)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    primaries = [r for r in results if r.registered_token == "abc"]
    duplicates = [r for r in results if r.waiting_on is not None]

    assert len(primaries) == 1
    assert len(duplicates) == 9
    assert primaries[0].lock_acquired is True
    assert all(d.lock_acquired is False for d in duplicates)
    assert all(d.registered_token is None for d in duplicates)


@pytest.mark.asyncio
async def test_register_waiter_resolves_when_primary_settles_from_another_thread(controller):
    """A waiter awaits a future (no thread parked) that resolves on cross-thread completion."""
    first = controller.begin("abc")
    dup = controller.begin("abc")

    wait_future = dup.waiting_on.register_waiter()
    assert not wait_future.done()

    mock_result = MagicMock()
    threading.Thread(target=lambda: controller.complete(first.registered_token, result=mock_result)).start()

    await asyncio.wait_for(wait_future, timeout=5)
    assert dup.waiting_on.result is mock_result


@pytest.mark.asyncio
async def test_register_waiter_resolves_immediately_when_already_settled(controller):
    """If the primary settles before the waiter registers, the awaitable resolves at once."""
    first = controller.begin("abc")
    dup = controller.begin("abc")
    controller.complete(first.registered_token, result=MagicMock())

    assert dup.waiting_on.settled is True
    await asyncio.wait_for(dup.waiting_on.register_waiter(), timeout=5)


@pytest.mark.asyncio
async def test_cancelling_one_waiter_does_not_strand_others(controller):
    """Cancelling one waiting duplicate must not cancel the shared signal for the rest."""
    first = controller.begin("abc")
    dup = controller.begin("abc")

    cancelled = dup.waiting_on.register_waiter()
    survivor = dup.waiting_on.register_waiter()
    cancelled.cancel()
    await asyncio.sleep(0)

    mock_result = MagicMock()
    threading.Thread(target=lambda: controller.complete(first.registered_token, result=mock_result)).start()

    await asyncio.wait_for(survivor, timeout=5)
    assert dup.waiting_on.result is mock_result
