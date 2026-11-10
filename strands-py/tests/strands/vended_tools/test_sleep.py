"""Tests for the sleep tool.

The sleep tool pauses execution via :func:`asyncio.sleep`. Tests use tiny
durations (single-digit millisecond values or less) and patch
:func:`asyncio.sleep` where the assertion is about the argument rather than
the delay itself, so the suite never actually blocks for a second. Coverage
spans input validation, the configurable cap, and cooperative cancellation.
"""

import asyncio
import importlib
import math
import types
from unittest.mock import AsyncMock, patch

import pytest

from strands.vended_tools.sleep import make_sleep, sleep
from strands.vended_tools.sleep.types import DEFAULT_MAX_DURATION

# The parent package rebinds ``sleep`` to the tool object, which shadows the
# submodule attribute. On Python 3.10 ``unittest.mock.patch`` walks a dotted
# target with ``getattr`` and stops at that tool, raising AttributeError; 3.11+
# resolves the longest importable prefix first. Reach the submodule via
# ``importlib`` so tests behave identically across supported Python versions.
_sleep_module = importlib.import_module("strands.vended_tools.sleep.sleep")


class TestInputValidation:
    """Boundary validation on the ``duration`` input."""

    @pytest.mark.asyncio
    async def test_rejects_negative_duration(self):
        with pytest.raises(ValueError, match="non-negative"):
            await sleep(duration=-0.1)

    @pytest.mark.asyncio
    async def test_rejects_nan_duration(self):
        with pytest.raises(ValueError, match="finite"):
            await sleep(duration=math.nan)

    @pytest.mark.asyncio
    async def test_rejects_positive_infinity(self):
        with pytest.raises(ValueError, match="finite"):
            await sleep(duration=math.inf)

    @pytest.mark.asyncio
    async def test_rejects_negative_infinity(self):
        with pytest.raises(ValueError, match="finite"):
            await sleep(duration=-math.inf)

    @pytest.mark.asyncio
    async def test_rejects_non_numeric_duration(self):
        with pytest.raises(ValueError, match="number"):
            await sleep(duration="1.0")  # type: ignore[arg-type]

    @pytest.mark.asyncio
    async def test_rejects_boolean_duration(self):
        with pytest.raises(ValueError, match="number"):
            await sleep(duration=True)  # type: ignore[arg-type]

    @pytest.mark.asyncio
    async def test_rejects_duration_above_max(self):
        capped = make_sleep(max_duration=0.5)
        with pytest.raises(ValueError, match="exceeds maximum"):
            await capped(duration=0.6)

    @pytest.mark.asyncio
    async def test_rejects_duration_above_default_max(self):
        with pytest.raises(ValueError, match="exceeds maximum"):
            await sleep(duration=DEFAULT_MAX_DURATION + 1)


class TestFactoryValidation:
    """The factory itself rejects bad ``max_duration`` values."""

    def test_rejects_zero_max(self):
        with pytest.raises(ValueError, match="positive"):
            make_sleep(max_duration=0)

    def test_rejects_negative_max(self):
        with pytest.raises(ValueError, match="positive"):
            make_sleep(max_duration=-1)

    def test_rejects_nan_max(self):
        with pytest.raises(ValueError, match="positive"):
            make_sleep(max_duration=math.nan)

    def test_rejects_infinite_max(self):
        with pytest.raises(ValueError, match="positive"):
            make_sleep(max_duration=math.inf)

    def test_rejects_non_numeric_max(self):
        with pytest.raises(ValueError, match="number"):
            make_sleep(max_duration="60")  # type: ignore[arg-type]


class TestCooperativeCancellation:
    """The sleep must abort promptly when the enclosing task is cancelled."""

    @pytest.mark.asyncio
    async def test_cancellation_propagates_before_full_duration(self):
        capped = make_sleep(max_duration=10)

        task = asyncio.create_task(capped(duration=5))
        # Let the coroutine reach the ``await asyncio.sleep`` point.
        await asyncio.sleep(0)
        task.cancel()

        with pytest.raises(asyncio.CancelledError):
            await task

    @pytest.mark.asyncio
    async def test_cancellation_does_not_wait_for_full_duration(self):
        """Cancelling should return in far less time than the requested sleep."""
        capped = make_sleep(max_duration=10)

        task = asyncio.create_task(capped(duration=5))
        await asyncio.sleep(0)

        loop = asyncio.get_running_loop()
        started = loop.time()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        elapsed = loop.time() - started
        # A cooperative cancel should return well under a second; the requested
        # sleep was 5 s.
        assert elapsed < 1.0


class TestHappyPath:
    """Successful sleeps return a completion message."""

    @pytest.mark.asyncio
    async def test_zero_duration_returns_immediately(self):
        result = await sleep(duration=0)
        assert result == "Slept for 0 seconds"

    @pytest.mark.asyncio
    async def test_small_duration_returns_expected_message(self):
        result = await sleep(duration=0.01)
        assert result == "Slept for 0.01 seconds"

    @pytest.mark.asyncio
    async def test_calls_asyncio_sleep_with_requested_duration(self):
        # A fake asyncio.sleep proves we hand the requested value straight through
        # to the primitive, without waiting a real second. Patch the module's
        # ``asyncio`` binding rather than ``asyncio.sleep`` itself so we don't
        # break other tests that concurrently use the real primitive.
        fake_sleep = AsyncMock()
        fake_asyncio = types.SimpleNamespace(sleep=fake_sleep)
        with patch.object(_sleep_module, "asyncio", fake_asyncio):
            result = await sleep(duration=1.5)

        fake_sleep.assert_awaited_once_with(1.5)
        assert result == "Slept for 1.5 seconds"

    @pytest.mark.asyncio
    async def test_integer_duration_is_accepted(self):
        fake_sleep = AsyncMock()
        fake_asyncio = types.SimpleNamespace(sleep=fake_sleep)
        with patch.object(_sleep_module, "asyncio", fake_asyncio):
            result = await sleep(duration=2)

        fake_sleep.assert_awaited_once_with(2.0)
        assert result == "Slept for 2 seconds"
