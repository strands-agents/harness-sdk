"""Tests for the sandbox-routed edit tool.

Exercises the tool against a real ``NotASandboxLocalEnvironment`` (host
filesystem), calling it directly as an async function. Errors surface as
raised ``ValueError`` — the raw function raises; the error→status wrapping
only happens through the tool's ``stream`` path. Path semantics assume
POSIX, so these tests are skipped on Windows.
"""

import sys

import pytest

from strands.agent.state import AgentState
from strands.sandbox.not_a_sandbox_local_environment import NotASandboxLocalEnvironment
from strands.types.tools import ToolContext
from strands.vended_tools.edit import edit, make_edit

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="POSIX path semantics assumed")


class _FakeAgent:
    def __init__(self, sandbox: NotASandboxLocalEnvironment | None = None) -> None:
        self.sandbox = sandbox or NotASandboxLocalEnvironment()
        self.state = AgentState()


def _tool_context(sandbox: NotASandboxLocalEnvironment | None = None) -> ToolContext:
    agent = _FakeAgent(sandbox=sandbox)
    return ToolContext(
        tool_use={"name": "edit", "toolUseId": "test-id", "input": {}},
        agent=agent,
        invocation_state={},
    )


def _write(path, content: str) -> str:
    path.write_text(content)
    return str(path)


@pytest.fixture
def edit_tool():
    return make_edit(sandbox=NotASandboxLocalEnvironment())


@pytest.fixture
def ctx():
    return _tool_context()


class TestStrReplace:
    @pytest.mark.asyncio
    async def test_replaces_unique_match(self, edit_tool, ctx, tmp_path):
        file_path = _write(tmp_path / "f.txt", "alpha\nbeta\ngamma")
        result = await edit_tool(
            command="str_replace", path=file_path, tool_context=ctx, old_str="beta", new_str="BETA"
        )
        assert result == f"Edited {file_path}."
        assert (tmp_path / "f.txt").read_text() == "alpha\nBETA\ngamma"

    @pytest.mark.asyncio
    async def test_rejects_missing_match(self, edit_tool, ctx, tmp_path):
        file_path = _write(tmp_path / "f.txt", "alpha\nbeta")
        with pytest.raises(ValueError, match="did not appear verbatim"):
            await edit_tool(command="str_replace", path=file_path, tool_context=ctx, old_str="zeta", new_str="x")

    @pytest.mark.asyncio
    async def test_rejects_ambiguous_match(self, edit_tool, ctx, tmp_path):
        file_path = _write(tmp_path / "f.txt", "foo\nfoo\nfoo")
        with pytest.raises(ValueError, match="appears 3 times"):
            await edit_tool(command="str_replace", path=file_path, tool_context=ctx, old_str="foo", new_str="bar")
        # File untouched.
        assert (tmp_path / "f.txt").read_text() == "foo\nfoo\nfoo"

    @pytest.mark.asyncio
    async def test_requires_non_empty_old_str(self, edit_tool, ctx, tmp_path):
        file_path = _write(tmp_path / "f.txt", "x")
        with pytest.raises(ValueError, match="must be non-empty"):
            await edit_tool(command="str_replace", path=file_path, tool_context=ctx, old_str="", new_str="y")

    @pytest.mark.asyncio
    async def test_empty_new_str_deletes(self, edit_tool, ctx, tmp_path):
        file_path = _write(tmp_path / "f.txt", "keep\nremove-me\nkeep")
        await edit_tool(command="str_replace", path=file_path, tool_context=ctx, old_str="remove-me\n", new_str="")
        assert (tmp_path / "f.txt").read_text() == "keep\nkeep"

    @pytest.mark.asyncio
    async def test_multiline_old_str(self, edit_tool, ctx, tmp_path):
        file_path = _write(tmp_path / "f.txt", "a\nb\nc\nd")
        await edit_tool(command="str_replace", path=file_path, tool_context=ctx, old_str="b\nc", new_str="B\nC\nC2")
        assert (tmp_path / "f.txt").read_text() == "a\nB\nC\nC2\nd"


class TestInsert:
    @pytest.mark.asyncio
    async def test_insert_at_beginning(self, edit_tool, ctx, tmp_path):
        file_path = _write(tmp_path / "f.txt", "line2\nline3")
        await edit_tool(command="insert", path=file_path, tool_context=ctx, insert_line=0, new_str="line1")
        assert (tmp_path / "f.txt").read_text() == "line1\nline2\nline3"

    @pytest.mark.asyncio
    async def test_insert_after_line(self, edit_tool, ctx, tmp_path):
        file_path = _write(tmp_path / "f.txt", "a\nb\nc")
        await edit_tool(command="insert", path=file_path, tool_context=ctx, insert_line=1, new_str="B.5")
        assert (tmp_path / "f.txt").read_text() == "a\nB.5\nb\nc"

    @pytest.mark.asyncio
    async def test_insert_at_end(self, edit_tool, ctx, tmp_path):
        file_path = _write(tmp_path / "f.txt", "a\nb")
        # Two lines → insert_line=2 appends.
        await edit_tool(command="insert", path=file_path, tool_context=ctx, insert_line=2, new_str="c")
        assert (tmp_path / "f.txt").read_text() == "a\nb\nc"

    @pytest.mark.asyncio
    async def test_insert_into_empty_file(self, edit_tool, ctx, tmp_path):
        file_path = _write(tmp_path / "f.txt", "")
        await edit_tool(command="insert", path=file_path, tool_context=ctx, insert_line=0, new_str="hello")
        assert (tmp_path / "f.txt").read_text() == "hello"

    @pytest.mark.asyncio
    async def test_insert_multiline(self, edit_tool, ctx, tmp_path):
        file_path = _write(tmp_path / "f.txt", "a\nd")
        await edit_tool(command="insert", path=file_path, tool_context=ctx, insert_line=1, new_str="b\nc")
        assert (tmp_path / "f.txt").read_text() == "a\nb\nc\nd"

    @pytest.mark.asyncio
    async def test_rejects_out_of_bounds(self, edit_tool, ctx, tmp_path):
        file_path = _write(tmp_path / "f.txt", "a\nb")
        with pytest.raises(ValueError, match="Invalid insert_line"):
            await edit_tool(command="insert", path=file_path, tool_context=ctx, insert_line=99, new_str="x")

    @pytest.mark.asyncio
    async def test_rejects_negative_insert_line(self, edit_tool, ctx, tmp_path):
        file_path = _write(tmp_path / "f.txt", "a")
        with pytest.raises(ValueError, match="Invalid insert_line"):
            await edit_tool(command="insert", path=file_path, tool_context=ctx, insert_line=-1, new_str="x")

    @pytest.mark.asyncio
    async def test_requires_params(self, edit_tool, ctx, tmp_path):
        file_path = _write(tmp_path / "f.txt", "a")
        with pytest.raises(ValueError, match="are required"):
            await edit_tool(command="insert", path=file_path, tool_context=ctx, new_str="x")


class TestPathValidation:
    @pytest.mark.asyncio
    async def test_rejects_relative_path(self, edit_tool, ctx):
        with pytest.raises(ValueError, match="not an absolute path"):
            await edit_tool(command="str_replace", path="relative.txt", tool_context=ctx, old_str="a", new_str="b")

    @pytest.mark.asyncio
    async def test_rejects_parent_traversal(self, edit_tool, ctx):
        with pytest.raises(ValueError, match="path traversal is not allowed"):
            await edit_tool(
                command="str_replace", path="/tmp/../etc/passwd", tool_context=ctx, old_str="a", new_str="b"
            )


class TestSandboxBinding:
    @pytest.mark.asyncio
    async def test_bound_sandbox_overrides_agent_sandbox(self, tmp_path):
        bound = NotASandboxLocalEnvironment()
        bound_tool = make_edit(sandbox=bound)
        # The agent on the ToolContext is irrelevant when a sandbox is bound at construction.
        file_path = _write(tmp_path / "f.txt", "x")
        await bound_tool(command="str_replace", path=file_path, tool_context=_tool_context(), old_str="x", new_str="y")
        assert (tmp_path / "f.txt").read_text() == "y"

    @pytest.mark.asyncio
    async def test_default_edit_reads_agent_sandbox(self, tmp_path):
        file_path = _write(tmp_path / "f.txt", "hello")
        await edit(
            command="str_replace", path=file_path, tool_context=_tool_context(), old_str="hello", new_str="world"
        )
        assert (tmp_path / "f.txt").read_text() == "world"
