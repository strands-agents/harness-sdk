"""Tests for the python_repl tool — consumer-level concerns only.

run_session, cancellation, state-restore fallback, and build_error_message
are tested in test_monty.py.
"""

import asyncio
import base64
import logging
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from strands.agent.state import AgentState
from strands.experimental.tools import _monty as _monty_module
from strands.experimental.tools._python_repl import _python_repl as _python_repl_module
from strands.experimental.tools._python_repl._python_repl import (
    PythonReplError,
    make_python_repl,
)
from strands.types.tools import ToolContext

from .conftest import FakeMontyError, make_monty_patch, mock_session


def _fresh_context(initial_state: dict | None = None) -> tuple[AgentState, ToolContext]:
    state = AgentState(initial_state or {})

    class _Agent:
        pass

    agent = _Agent()
    agent.state = state  # type: ignore[attr-defined]
    ctx = ToolContext(
        tool_use={"name": "python_repl", "toolUseId": "test-id", "input": {}},
        agent=agent,
        invocation_state={},
    )
    return state, ctx


class TestMakePythonRepl:
    def test_rejects_empty_name(self):
        with pytest.raises(ValueError, match="non-empty"):
            make_python_repl(name="")

    @pytest.mark.parametrize(
        "kwargs,match",
        [
            ({"max_duration_secs": 0}, "max_duration_secs"),
            ({"max_duration_secs": -1}, "max_duration_secs"),
            ({"max_memory_bytes": 0}, "max_memory_bytes"),
            ({"max_output_chars": 0}, "max_output_chars"),
            ({"max_session_bytes": 0}, "max_session_bytes"),
            ({"timeout_secs": 0}, "timeout_secs"),
            ({"timeout_secs": -5.0}, "timeout_secs"),
        ],
    )
    def test_rejects_invalid_limits(self, kwargs, match):
        with pytest.raises(ValueError, match=match):
            make_python_repl(**kwargs)  # type: ignore[arg-type]

    def test_factory_defaults_and_custom_overrides(self):
        default_tool = make_python_repl()
        assert default_tool.tool_name == "python_repl"

        custom_tool = make_python_repl(name="py_exec", description="run code")
        assert custom_tool.tool_name == "py_exec"
        assert custom_tool.tool_spec["description"] == "run code"

    def test_warns_when_timeout_less_than_max_duration(self, caplog):
        with caplog.at_level(logging.WARNING):
            make_python_repl(max_duration_secs=30.0, timeout_secs=10.0)

        assert any("timeout_secs (10.0) is less than max_duration_secs (30.0)" in r.message for r in caplog.records)


class TestStatePersistence:
    @pytest.mark.asyncio
    async def test_persists_session_to_state(self):
        session = mock_session(dump=b"new-dump")
        monty = make_monty_patch(session)
        state, ctx = _fresh_context()
        tool = make_python_repl()

        with patch.object(_monty_module, "AsyncMonty", return_value=monty):
            await tool(code="x = 1", tool_context=ctx)

        exp_stored = base64.b64encode(b"new-dump").decode("ascii")
        assert state.get("python_repl_session") == exp_stored

    @pytest.mark.asyncio
    async def test_restores_prior_state(self):
        prior_dump = b"prior-dump"
        prior_encoded = base64.b64encode(prior_dump).decode("ascii")
        session = mock_session()
        monty = make_monty_patch(session)
        state, ctx = _fresh_context({"python_repl_session": prior_encoded})
        tool = make_python_repl()

        with patch.object(_monty_module, "AsyncMonty", return_value=monty):
            await tool(code="x", tool_context=ctx)

        session.load_session.assert_awaited_once_with(prior_dump)

    @pytest.mark.asyncio
    async def test_second_call_sees_first_calls_state(self):
        tool = make_python_repl()
        _, ctx = _fresh_context()

        await tool(code="x = 42", tool_context=ctx)
        result = await tool(code="print(x + 1)", tool_context=ctx)

        assert "43" in result

    @pytest.mark.asyncio
    async def test_reset_clears_state_before_run(self):
        prior_encoded = base64.b64encode(b"stale").decode("ascii")
        session = mock_session()
        monty = make_monty_patch(session)
        state, ctx = _fresh_context({"python_repl_session": prior_encoded})
        tool = make_python_repl()

        with patch.object(_monty_module, "AsyncMonty", return_value=monty):
            await tool(code="x = 1", tool_context=ctx, reset_state=True)

        session.load_session.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_reset_clears_state_even_when_run_fails(self):
        prior_encoded = base64.b64encode(b"stale").decode("ascii")

        session = MagicMock()
        session.feed_run = AsyncMock(side_effect=FakeMontyError("boom"))
        session.dump = AsyncMock(return_value=b"")
        session.load_session = AsyncMock()
        session.__aenter__ = AsyncMock(return_value=session)
        session.__aexit__ = AsyncMock(return_value=False)
        monty = make_monty_patch(session)

        state, ctx = _fresh_context({"python_repl_session": prior_encoded})
        tool = make_python_repl()

        with patch.object(_monty_module, "AsyncMonty", return_value=monty):
            with patch.object(_python_repl_module, "MontyError", FakeMontyError):
                with pytest.raises(PythonReplError):
                    await tool(code="raise ValueError()", tool_context=ctx, reset_state=True)

        assert state.get("python_repl_session") is None


class TestBase64ErrorHandling:
    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "bad_state",
        [12345, "!!!corrupt-base64!!!"],
        ids=["TypeError", "binascii.Error"],
    )
    async def test_malformed_state_discards_and_runs_fresh(self, bad_state):
        session = mock_session()
        monty = make_monty_patch(session)
        state, ctx = _fresh_context({"python_repl_session": bad_state})
        tool = make_python_repl()

        with patch.object(_monty_module, "AsyncMonty", return_value=monty):
            tru_result = await tool(code="x = 1", tool_context=ctx)

        assert tru_result == "(no output)"
        session.load_session.assert_not_awaited()


class TestMontyErrorWrapping:
    @pytest.mark.asyncio
    async def test_monty_error_becomes_python_repl_error(self):
        session = MagicMock()
        session.feed_run = AsyncMock(side_effect=FakeMontyError("name 'x' is not defined"))
        session.dump = AsyncMock(return_value=b"")
        session.load_session = AsyncMock()
        session.__aenter__ = AsyncMock(return_value=session)
        session.__aexit__ = AsyncMock(return_value=False)
        monty = make_monty_patch(session)

        _, ctx = _fresh_context()
        tool = make_python_repl()

        with patch.object(_monty_module, "AsyncMonty", return_value=monty):
            with patch.object(_python_repl_module, "MontyError", FakeMontyError):
                with pytest.raises(PythonReplError):
                    await tool(code="x", tool_context=ctx)

    @pytest.mark.asyncio
    async def test_runtime_error_is_not_retried_on_fresh_session(self):
        tool = make_python_repl()
        _, ctx = _fresh_context()

        await tool(code="data = [1, 2, 3]", tool_context=ctx)

        with pytest.raises(PythonReplError, match="IndexError"):
            await tool(code="data[10]", tool_context=ctx)


class TestSessionSizeCap:
    @pytest.mark.asyncio
    async def test_oversized_dump_is_discarded(self):
        raw_dump = b"x" * 30
        session = mock_session(dump=raw_dump)
        monty = make_monty_patch(session)
        prior_encoded = base64.b64encode(b"old").decode("ascii")
        state, ctx = _fresh_context({"python_repl_session": prior_encoded})
        tool = make_python_repl(max_session_bytes=35)

        with patch.object(_monty_module, "AsyncMonty", return_value=monty):
            tru_result = await tool(code="x = 1", tool_context=ctx)

        # base64 of 30 bytes is 40 chars, exceeds 35-byte limit.
        assert state.get("python_repl_session") == prior_encoded
        assert "too large to persist" in tru_result

    @pytest.mark.asyncio
    async def test_small_dump_is_persisted(self):
        small_dump = b"x" * 10
        session = mock_session(dump=small_dump)
        monty = make_monty_patch(session)
        state, ctx = _fresh_context()
        tool = make_python_repl(max_session_bytes=50)

        with patch.object(_monty_module, "AsyncMonty", return_value=monty):
            await tool(code="x = 1", tool_context=ctx)

        assert state.get("python_repl_session") == base64.b64encode(small_dump).decode("ascii")


class TestOutputTruncation:
    @pytest.mark.asyncio
    async def test_truncates_long_output(self):
        session = mock_session()
        monty = make_monty_patch(session)
        _, ctx = _fresh_context()
        tool = make_python_repl(max_output_chars=10)

        with patch.object(_monty_module, "AsyncMonty", return_value=monty):
            with patch.object(_python_repl_module, "CollectStreams") as MockCollectStreams:
                mock_collector = MagicMock()
                mock_collector.output = [("stdout", "a" * 200)]
                MockCollectStreams.return_value = mock_collector
                tru_result = await tool(code="...", tool_context=ctx)

        assert tru_result.endswith("[output truncated]")
        assert len(tru_result) < 200


class TestConcurrencyLock:
    @pytest.mark.asyncio
    async def test_concurrent_calls_serialise_state_writes(self):
        """Two concurrent calls must not interleave their read-run-write sequences."""
        intervals: list[tuple[float, float]] = []

        def make_labeled_session(dump_bytes: bytes) -> MagicMock:
            s = MagicMock()

            async def _feed(code, *, print_callback=None):
                start = time.monotonic()
                await asyncio.sleep(0.05)
                intervals.append((start, time.monotonic()))
                return code

            s.feed_run = _feed
            s.dump = AsyncMock(return_value=dump_bytes)
            s.load_session = AsyncMock()
            s.__aenter__ = AsyncMock(return_value=s)
            s.__aexit__ = AsyncMock(return_value=False)
            return s

        session_a = make_labeled_session(b"dump-a")
        session_b = make_labeled_session(b"dump-b")
        sessions = iter([session_a, session_b])

        pool = MagicMock()
        pool.__aenter__ = AsyncMock(return_value=pool)
        pool.__aexit__ = AsyncMock(return_value=False)
        pool.checkout = MagicMock(side_effect=lambda **kw: next(sessions))

        monty = MagicMock()
        monty.__aenter__ = AsyncMock(return_value=pool)
        monty.__aexit__ = AsyncMock(return_value=False)

        state, ctx = _fresh_context()
        tool = make_python_repl()

        with patch.object(_monty_module, "AsyncMonty", return_value=monty):
            await asyncio.gather(
                tool(code="a", tool_context=ctx),
                tool(code="b", tool_context=ctx),
            )

        assert len(intervals) == 2
        (s1, e1), (s2, e2) = intervals
        assert e1 <= s2 or e2 <= s1, f"Intervals overlapped: {intervals}"


class TestPublicImport:
    def test_python_repl_import_is_tool_not_module(self):
        import sys
        import types

        key = "strands.experimental.tools"
        saved = sys.modules.pop(key, None)
        try:
            from strands.experimental.tools import python_repl as pr

            assert not isinstance(pr, types.ModuleType), (
                f"python_repl resolved to module {pr!r}; expected DecoratedFunctionTool"
            )
            assert callable(pr)
        finally:
            if saved is not None:
                sys.modules[key] = saved

    def test_make_python_repl_import_is_function(self):
        import sys
        import types

        key = "strands.experimental.tools"
        saved = sys.modules.pop(key, None)
        try:
            from strands.experimental.tools import make_python_repl as mpr

            assert not isinstance(mpr, types.ModuleType)
            assert callable(mpr)
        finally:
            if saved is not None:
                sys.modules[key] = saved
