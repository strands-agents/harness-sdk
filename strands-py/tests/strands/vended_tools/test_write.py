"""Tests for the sandbox-routed write tool.

Exercises the tool against a real ``NotASandboxLocalEnvironment`` (host
filesystem), calling it directly as an async function. Errors surface as
raised ``ValueError`` — the raw function raises; the error->status wrapping
only happens through the tool's ``stream`` path. The sandbox-execution
tests assume POSIX path semantics and are skipped on Windows; the pure
path-validation tests run everywhere.
"""

import sys
from unittest.mock import AsyncMock

import pytest

from strands.agent.state import AgentState
from strands.sandbox.not_a_sandbox_local_environment import NotASandboxLocalEnvironment
from strands.types.tools import ToolContext
from strands.vended_tools.write import make_write, write

posix_only = pytest.mark.skipif(sys.platform == "win32", reason="POSIX path semantics assumed")


class _FakeAgent:
    def __init__(self, sandbox: object | None = None) -> None:
        self.sandbox = sandbox if sandbox is not None else NotASandboxLocalEnvironment()
        self.state = AgentState()


def _tool_context(sandbox: object | None = None) -> ToolContext:
    agent = _FakeAgent(sandbox=sandbox)
    return ToolContext(
        tool_use={"name": "write", "toolUseId": "test-id", "input": {}},
        agent=agent,
        invocation_state={},
    )


@pytest.fixture
def write_tool():
    return make_write(sandbox=NotASandboxLocalEnvironment())


@pytest.fixture
def ctx():
    return _tool_context()


@posix_only
class TestWrite:
    @pytest.mark.asyncio
    async def test_creates_file(self, write_tool, ctx, tmp_path):
        file_path = str(tmp_path / "new.txt")
        result = await write_tool(path=file_path, content="hello\nworld", tool_context=ctx)
        assert result == f"Wrote 2 lines to {file_path}."
        assert (tmp_path / "new.txt").read_text() == "hello\nworld"

    @pytest.mark.asyncio
    async def test_overwrites_existing_file(self, write_tool, ctx, tmp_path):
        existing = tmp_path / "f.txt"
        existing.write_text("old content")
        result = await write_tool(path=str(existing), content="new", tool_context=ctx)
        assert result == f"Wrote 1 line to {existing}."
        assert existing.read_text() == "new"

    @pytest.mark.asyncio
    async def test_empty_content_reports_zero_lines(self, write_tool, ctx, tmp_path):
        file_path = str(tmp_path / "empty.txt")
        result = await write_tool(path=file_path, content="", tool_context=ctx)
        assert result == f"Wrote 0 lines to {file_path}."
        assert (tmp_path / "empty.txt").read_text() == ""

    @pytest.mark.asyncio
    async def test_single_line_without_trailing_newline(self, write_tool, ctx, tmp_path):
        file_path = str(tmp_path / "one.txt")
        result = await write_tool(path=file_path, content="just one line", tool_context=ctx)
        assert result == f"Wrote 1 line to {file_path}."

    @pytest.mark.asyncio
    async def test_trailing_newline_counts_the_empty_tail(self, write_tool, ctx, tmp_path):
        # ``"a\nb\n".split("\n") == ["a", "b", ""]`` — three entries for two
        # text lines plus the final newline. Matches the harness tool's count.
        file_path = str(tmp_path / "tail.txt")
        result = await write_tool(path=file_path, content="a\nb\n", tool_context=ctx)
        assert result == f"Wrote 3 lines to {file_path}."

    @pytest.mark.asyncio
    async def test_creates_parent_directories(self, write_tool, ctx, tmp_path):
        nested = tmp_path / "a" / "b" / "c.txt"
        await write_tool(path=str(nested), content="deep", tool_context=ctx)
        assert nested.read_text() == "deep"


class TestPathValidation:
    """Lexical path validation — runs on every platform."""

    @pytest.mark.asyncio
    async def test_rejects_relative_path(self, ctx):
        with pytest.raises(ValueError, match="not absolute"):
            await write(path="relative.txt", content="x", tool_context=ctx)

    @pytest.mark.asyncio
    async def test_rejects_parent_traversal_posix(self, ctx):
        with pytest.raises(ValueError, match="path traversal is not allowed"):
            await write(path="/tmp/../etc/passwd", content="x", tool_context=ctx)

    @pytest.mark.asyncio
    async def test_rejects_parent_traversal_windows(self, ctx):
        with pytest.raises(ValueError, match="path traversal is not allowed"):
            await write(path="C:\\project\\..\\etc\\hosts", content="x", tool_context=ctx)


@posix_only
class TestSandboxBinding:
    @pytest.mark.asyncio
    async def test_bound_sandbox_overrides_agent_sandbox(self, tmp_path):
        bound = NotASandboxLocalEnvironment()
        bound_tool = make_write(sandbox=bound)
        agent_sandbox = AsyncMock()
        file_path = str(tmp_path / "f.txt")
        await bound_tool(path=file_path, content="from-bound", tool_context=_tool_context(sandbox=agent_sandbox))
        assert (tmp_path / "f.txt").read_text() == "from-bound"
        agent_sandbox.write_text.assert_not_called()

    @pytest.mark.asyncio
    async def test_default_write_reads_agent_sandbox(self, tmp_path):
        agent_sandbox = AsyncMock()
        file_path = str(tmp_path / "f.txt")
        await write(path=file_path, content="from-agent", tool_context=_tool_context(sandbox=agent_sandbox))
        agent_sandbox.write_text.assert_called_once_with(file_path, "from-agent")
