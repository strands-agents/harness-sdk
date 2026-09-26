"""Tests for _monty.py — shared Monty sandbox primitives.

Only tests that are NOT covered through the python_repl tool tests live here:
run_session state-restore fallback, timeout, and build_error_message formatting.
"""

import asyncio
from unittest.mock import MagicMock, patch

import pytest

from strands.experimental.tools import _monty as _monty_module
from strands.experimental.tools._monty import build_error_message, run_session

from .conftest import FakeMontyError, make_monty_patch, mock_session


class TestRunSession:
    @pytest.mark.asyncio
    async def test_incompatible_dump_falls_back_to_fresh_session(self):
        session = mock_session()
        session.load_session.side_effect = FakeMontyError("bad dump")
        monty = make_monty_patch(session)

        with patch.object(_monty_module, "AsyncMonty", return_value=monty):
            with patch.object(_monty_module, "MontyError", FakeMontyError):
                result = await run_session(
                    "x = 1",
                    state=b"garbage",
                    feed_kwargs={"print_callback": MagicMock(output=[])},
                )

        assert result == b"session-dump"

    @pytest.mark.asyncio
    async def test_timeout_raises(self):
        async def slow_feed_run(code, *, print_callback=None):
            await asyncio.sleep(10)

        session = mock_session()
        session.feed_run = slow_feed_run
        monty = make_monty_patch(session)

        with patch.object(_monty_module, "AsyncMonty", return_value=monty):
            with pytest.raises(asyncio.TimeoutError):
                await run_session(
                    "x",
                    timeout=0.05,
                    feed_kwargs={"print_callback": MagicMock(output=[])},
                )


class TestBuildErrorMessage:
    def test_includes_error_and_stdout(self):
        error = FakeMontyError("x is not defined")
        result = build_error_message(error, [("stdout", "before\n")], max_output_chars=1000)
        assert "x is not defined" in result
        assert "before\n" in result
        assert "stdout before failure" in result

    def test_no_stdout_section_when_output_empty(self):
        error = FakeMontyError("boom")
        result = build_error_message(error, [], max_output_chars=1000)
        assert "boom" in result
        assert "stdout" not in result

    def test_stdout_truncated(self):
        error = FakeMontyError("kaboom")
        result = build_error_message(error, [("stdout", "a" * 200)], max_output_chars=10)
        assert "kaboom" in result
        assert "[output truncated]" in result
        assert "a" * 200 not in result
