"""Tests for the python_repl tool."""

import asyncio
import base64
import importlib
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from strands.agent.state import AgentState
from strands.experimental.tools.python_repl.python_repl import (
    PythonReplError,
    _build_error_message,
    make_python_repl,
)
from strands.types.tools import ToolContext

# importlib.import_module bypasses the package attribute collision: the python_repl
# package exports a `python_repl` name that shadows the submodule on attribute lookup.
_python_repl_module = importlib.import_module("strands.experimental.tools.python_repl.python_repl")

# ---- Helpers ----


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


class _FakeMontyError(Exception):
    """Stand-in for a Monty error in tests.

    The real MontyError/MontyRuntimeError are Rust-backed types that cannot be
    instantiated directly in Python. Tests that need to raise or catch a MontyError
    patch the module-level ``MontyError`` name with this class.
    """

    def display(self) -> str:
        return str(self.args[0]) if self.args else ""




def _mock_session(value: object = None, dump: bytes = b"session-dump") -> MagicMock:
    session = MagicMock()
    session.feed_run = AsyncMock(return_value=value)
    session.dump = AsyncMock(return_value=dump)
    session.load_session = AsyncMock()
    session.__aenter__ = AsyncMock(return_value=session)
    session.__aexit__ = AsyncMock(return_value=False)
    return session


def _mock_pool(session: MagicMock) -> MagicMock:
    pool = MagicMock()
    pool.checkout = MagicMock(return_value=session)
    pool.__aenter__ = AsyncMock(return_value=pool)
    pool.__aexit__ = AsyncMock(return_value=False)
    return pool


def _make_monty_patch(session: MagicMock) -> MagicMock:
    pool = _mock_pool(session)
    monty = MagicMock()
    monty.__aenter__ = AsyncMock(return_value=pool)
    monty.__aexit__ = AsyncMock(return_value=False)
    return monty


# ---- make_python_repl validation ----


class TestMakePythonRepl:
    def test_rejects_empty_name(self):
        with pytest.raises(ValueError, match="non-empty"):
            make_python_repl(name="")

    @pytest.mark.parametrize(
        "kwargs,match",
        [
            ({"max_duration_secs": 0}, "max_duration_secs"),
            ({"max_duration_secs": -1}, "max_duration_secs"),
            ({"max_memory": 0}, "max_memory"),
            ({"max_output_chars": 0}, "max_output_chars"),
            ({"max_session_bytes": 0}, "max_session_bytes"),
            ({"timeout": 0}, "timeout"),
            ({"timeout": -5.0}, "timeout"),
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


# ---- Successful execution ----


class TestExecution:
    @pytest.mark.asyncio
    async def test_returns_empty_output(self):
        session = _mock_session(value=42)
        monty = _make_monty_patch(session)
        _, ctx = _fresh_context()
        tool = make_python_repl()

        with patch.object(_python_repl_module, "AsyncMonty", return_value=monty):
            tru_result = await tool(code="42", tool_context=ctx)

        assert tru_result == "(no output)"

    @pytest.mark.asyncio
    async def test_persists_session_to_state(self):
        session = _mock_session(dump=b"new-dump")
        monty = _make_monty_patch(session)
        state, ctx = _fresh_context()
        tool = make_python_repl()

        with patch.object(_python_repl_module, "AsyncMonty", return_value=monty):
            await tool(code="x = 1", tool_context=ctx)

        tru_stored = state.get("python_repl_session")
        exp_stored = base64.b64encode(b"new-dump").decode("ascii")
        assert tru_stored == exp_stored

    @pytest.mark.asyncio
    async def test_restores_prior_state(self):
        prior_dump = b"prior-dump"
        prior_encoded = base64.b64encode(prior_dump).decode("ascii")
        session = _mock_session()
        monty = _make_monty_patch(session)
        state, ctx = _fresh_context({"python_repl_session": prior_encoded})
        tool = make_python_repl()

        with patch.object(_python_repl_module, "AsyncMonty", return_value=monty):
            await tool(code="x", tool_context=ctx)

        session.load_session.assert_awaited_once_with(prior_dump)


# ---- reset_state ----


class TestResetState:
    @pytest.mark.asyncio
    async def test_reset_clears_state_before_run(self):
        prior_encoded = base64.b64encode(b"stale").decode("ascii")
        session = _mock_session()
        monty = _make_monty_patch(session)
        state, ctx = _fresh_context({"python_repl_session": prior_encoded})
        tool = make_python_repl()

        with patch.object(_python_repl_module, "AsyncMonty", return_value=monty):
            await tool(code="x = 1", tool_context=ctx, reset_state=True)

        session.load_session.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_reset_clears_state_even_when_run_fails(self):
        prior_encoded = base64.b64encode(b"stale").decode("ascii")

        session = MagicMock()
        session.feed_run = AsyncMock(side_effect=_FakeMontyError("boom"))
        session.dump = AsyncMock(return_value=b"")
        session.load_session = AsyncMock()
        session.__aenter__ = AsyncMock(return_value=session)
        session.__aexit__ = AsyncMock(return_value=False)
        monty = _make_monty_patch(session)

        state, ctx = _fresh_context({"python_repl_session": prior_encoded})
        tool = make_python_repl()

        with patch.object(_python_repl_module, "AsyncMonty", return_value=monty):
            with patch.object(_python_repl_module, "MontyError", _FakeMontyError):
                with pytest.raises(PythonReplError):
                    await tool(code="raise ValueError()", tool_context=ctx, reset_state=True)

        assert state.get("python_repl_session") is None


# ---- Error handling ----


class TestErrorHandling:
    @pytest.mark.asyncio
    async def test_monty_error_becomes_python_repl_error(self):
        session = MagicMock()
        session.feed_run = AsyncMock(side_effect=_FakeMontyError("name 'x' is not defined"))
        session.dump = AsyncMock(return_value=b"")
        session.load_session = AsyncMock()
        session.__aenter__ = AsyncMock(return_value=session)
        session.__aexit__ = AsyncMock(return_value=False)
        monty = _make_monty_patch(session)

        _, ctx = _fresh_context()
        tool = make_python_repl()

        with patch.object(_python_repl_module, "AsyncMonty", return_value=monty):
            with patch.object(_python_repl_module, "MontyError", _FakeMontyError):
                with pytest.raises(PythonReplError):
                    await tool(code="x", tool_context=ctx)

    @pytest.mark.asyncio
    async def test_runtime_error_from_user_code_is_not_swallowed(self):
        # guards against feed_run MontyError being caught by the load_session handler
        # and silently re-running in a fresh empty session (#unrestorable-state-bug)
        prior_encoded = base64.b64encode(b"valid-state").decode("ascii")

        session = MagicMock()
        session.load_session = AsyncMock()  # load succeeds
        session.feed_run = AsyncMock(side_effect=_FakeMontyError("name 'data' is not defined"))
        session.dump = AsyncMock(return_value=b"")
        session.__aenter__ = AsyncMock(return_value=session)
        session.__aexit__ = AsyncMock(return_value=False)
        monty = _make_monty_patch(session)

        _, ctx = _fresh_context({"python_repl_session": prior_encoded})
        tool = make_python_repl()

        with patch.object(_python_repl_module, "AsyncMonty", return_value=monty):
            with patch.object(_python_repl_module, "MontyError", _FakeMontyError):
                with pytest.raises(PythonReplError, match="name 'data' is not defined"):
                    await tool(code="data[10]", tool_context=ctx)

    @pytest.mark.asyncio
    async def test_malformed_state_discards_and_runs_fresh(self):
        session = _mock_session()
        monty = _make_monty_patch(session)
        state, ctx = _fresh_context({"python_repl_session": 12345})
        tool = make_python_repl()

        with patch.object(_python_repl_module, "AsyncMonty", return_value=monty):
            tru_result = await tool(code="x = 1", tool_context=ctx)

        assert tru_result == "(no output)"
        session.load_session.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_corrupt_base64_discards_state_and_runs_fresh(self):
        session = _mock_session(value=7)
        monty = _make_monty_patch(session)
        state, ctx = _fresh_context({"python_repl_session": "!!!not-valid-base64!!!"})
        tool = make_python_repl()

        with patch.object(_python_repl_module, "AsyncMonty", return_value=monty):
            tru_result = await tool(code="7", tool_context=ctx)

        assert tru_result == "(no output)"

    @pytest.mark.asyncio
    async def test_unrestorable_dump_falls_back_to_fresh_session(self):
        tool = make_python_repl()
        state, ctx = _fresh_context({"python_repl_session": "!!!corrupt-base64!!!"})

        # Corrupt base64 → fresh session → code runs fine
        result = await tool(code="x = 42", tool_context=ctx)
        assert result == "(no output)"
        assert state.get("python_repl_session") is not None  # fresh dump persisted

    @pytest.mark.asyncio
    async def test_runtime_error_is_not_retried_on_fresh_session(self):
        tool = make_python_repl()
        _, ctx = _fresh_context()

        # First call: define `data` in session
        await tool(code="data = [1, 2, 3]", tool_context=ctx)

        # Second call: IndexError from user code — must raise, not fall back to fresh session
        with pytest.raises(PythonReplError, match="IndexError"):
            await tool(code="data[10]", tool_context=ctx)


# ---- Session size cap ----


class TestSessionSizeCap:
    @pytest.mark.asyncio
    async def test_discards_oversized_dump_and_warns_in_output(self):
        big_dump = b"x" * 100
        session = _mock_session(dump=big_dump)
        monty = _make_monty_patch(session)

        prior_encoded = base64.b64encode(b"old-dump").decode("ascii")
        state, ctx = _fresh_context({"python_repl_session": prior_encoded})
        tool = make_python_repl(max_session_bytes=50)

        with patch.object(_python_repl_module, "AsyncMonty", return_value=monty):
            tru_result = await tool(code="x = 1", tool_context=ctx)

        # Prior state unchanged — oversized dump not persisted
        assert state.get("python_repl_session") == prior_encoded
        # Model is told the session was not saved
        assert "too large to persist" in tru_result

    @pytest.mark.asyncio
    async def test_persists_dump_within_limit(self):
        small_dump = b"x" * 10
        session = _mock_session(dump=small_dump)
        monty = _make_monty_patch(session)

        state, ctx = _fresh_context()
        tool = make_python_repl(max_session_bytes=50)

        with patch.object(_python_repl_module, "AsyncMonty", return_value=monty):
            tru_result = await tool(code="x = 1", tool_context=ctx)

        tru_stored = state.get("python_repl_session")
        assert tru_stored == base64.b64encode(small_dump).decode("ascii")
        assert "too large to persist" not in tru_result


# ---- Output truncation ----


class TestOutputTruncation:
    @pytest.mark.asyncio
    async def test_truncates_long_output(self):
        session = _mock_session()
        monty = _make_monty_patch(session)
        _, ctx = _fresh_context()
        tool = make_python_repl(max_output_chars=10)

        with patch.object(_python_repl_module, "AsyncMonty", return_value=monty):
            with patch.object(_python_repl_module, "CollectStreams") as MockCollectStreams:
                mock_collector = MagicMock()
                mock_collector.output = [("stdout", "a" * 200)]
                MockCollectStreams.return_value = mock_collector
                tru_result = await tool(code="...", tool_context=ctx)

        assert tru_result.endswith("[output truncated]")
        assert len(tru_result) < 200


# ---- Cancellation ----


class TestCancellation:
    @pytest.mark.asyncio
    async def test_cancel_signal_aborts_run(self):
        run_started = asyncio.Event()

        async def slow_feed_run(code, *, print_callback=None):
            run_started.set()
            await asyncio.sleep(10)
            return None

        session = _mock_session()
        session.feed_run = slow_feed_run
        monty = _make_monty_patch(session)

        state, ctx = _fresh_context()
        tool = make_python_repl()

        async def run_and_cancel():
            coro_task = asyncio.ensure_future(tool(code="...", tool_context=ctx))
            await run_started.wait()
            ctx.cancel_signal.set()
            return await coro_task

        with patch.object(_python_repl_module, "AsyncMonty", return_value=monty):
            with pytest.raises(asyncio.CancelledError):
                await run_and_cancel()


# ---- Concurrency lock ----


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

        with patch.object(_python_repl_module, "AsyncMonty", return_value=monty):
            await asyncio.gather(
                tool(code="a", tool_context=ctx),
                tool(code="b", tool_context=ctx),
            )

        assert len(intervals) == 2
        # Serialised: one interval must finish before the other starts
        (s1, e1), (s2, e2) = intervals
        assert e1 <= s2 or e2 <= s1, f"Intervals overlapped: {intervals}"


# ---- Internal helpers ----


class TestBuildErrorMessage:
    def test_message_and_stdout_appended_on_failure(self):
        error = _FakeMontyError("x is not defined")
        tru_message = _build_error_message(error, [("stdout", "before\n")], max_output_chars=1000)
        assert "x is not defined" in tru_message
        assert "before\n" in tru_message
        assert "stdout before failure" in tru_message

    def test_no_stdout_section_when_output_empty(self):
        error = _FakeMontyError("boom")
        tru_message = _build_error_message(error, [], max_output_chars=1000)
        assert "boom" in tru_message
        assert "stdout" not in tru_message
