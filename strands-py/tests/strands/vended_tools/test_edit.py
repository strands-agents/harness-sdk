"""Tests for the sandbox-routed edit tool.

Exercises the tool against a real ``NotASandboxLocalEnvironment`` (host
filesystem), calling it directly as an async function. Errors surface as
raised ``ValueError`` — the raw function raises; the error→status wrapping
only happens through the tool's ``stream`` path. The sandbox-execution
tests assume POSIX path semantics and are skipped on Windows; the pure
path-validation tests run everywhere.
"""

import sys

import pytest

from strands.agent.state import AgentState
from strands.sandbox.not_a_sandbox_local_environment import NotASandboxLocalEnvironment
from strands.types.tools import ToolContext
from strands.vended_tools.edit import edit, make_edit

posix_only = pytest.mark.skipif(sys.platform == "win32", reason="POSIX path semantics assumed")


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


@posix_only
class TestStrReplace:
    @pytest.mark.asyncio
    async def test_replaces_unique_match(self, edit_tool, ctx, tmp_path):
        file_path = _write(tmp_path / "f.txt", "alpha\nbeta\ngamma")
        result = await edit_tool(path=file_path, tool_context=ctx, old_str="beta", new_str="BETA")
        assert result == f"Edited {file_path}."
        assert (tmp_path / "f.txt").read_text() == "alpha\nBETA\ngamma"

    @pytest.mark.asyncio
    async def test_rejects_empty_old_str(self, edit_tool, ctx, tmp_path):
        # An empty ``old_str`` would otherwise match at every character boundary
        # and surface as a confusing "appears N times" error. Reject up front.
        file_path = _write(tmp_path / "f.txt", "alpha")
        with pytest.raises(ValueError, match="old_str must not be empty"):
            await edit_tool(path=file_path, tool_context=ctx, old_str="", new_str="x")

    @pytest.mark.asyncio
    async def test_rejects_missing_match(self, edit_tool, ctx, tmp_path):
        file_path = _write(tmp_path / "f.txt", "alpha\nbeta")
        with pytest.raises(ValueError, match="did not appear verbatim"):
            await edit_tool(path=file_path, tool_context=ctx, old_str="zeta", new_str="x")

    @pytest.mark.asyncio
    async def test_rejects_ambiguous_match(self, edit_tool, ctx, tmp_path):
        file_path = _write(tmp_path / "f.txt", "foo\nfoo\nfoo")
        with pytest.raises(ValueError, match="appears 3 times"):
            await edit_tool(path=file_path, tool_context=ctx, old_str="foo", new_str="bar")
        # File untouched.
        assert (tmp_path / "f.txt").read_text() == "foo\nfoo\nfoo"

    @pytest.mark.asyncio
    async def test_empty_new_str_deletes(self, edit_tool, ctx, tmp_path):
        file_path = _write(tmp_path / "f.txt", "keep\nremove-me\nkeep")
        await edit_tool(path=file_path, tool_context=ctx, old_str="remove-me\n", new_str="")
        assert (tmp_path / "f.txt").read_text() == "keep\nkeep"

    @pytest.mark.asyncio
    async def test_multiline_old_str(self, edit_tool, ctx, tmp_path):
        file_path = _write(tmp_path / "f.txt", "a\nb\nc\nd")
        await edit_tool(path=file_path, tool_context=ctx, old_str="b\nc", new_str="B\nC\nC2")
        assert (tmp_path / "f.txt").read_text() == "a\nB\nC\nC2\nd"


class TestPathValidation:
    """Edit delegates to the shared ``validate_absolute_path`` helper.

    The validator's full semantics (POSIX/Windows/UNC, ``..`` on either
    separator) are covered in :mod:`tests.strands.vended_tools.test_paths`.
    This test just confirms the delegation: a path that the validator rejects
    surfaces as a ``ValueError`` from ``edit`` before any sandbox call.
    """

    @pytest.mark.asyncio
    async def test_rejects_relative_path(self, ctx):
        with pytest.raises(ValueError, match="not absolute"):
            await edit(path="relative.txt", tool_context=ctx, old_str="a", new_str="b")


@posix_only
class TestSandboxBinding:
    @pytest.mark.asyncio
    async def test_bound_sandbox_overrides_agent_sandbox(self, tmp_path):
        bound = NotASandboxLocalEnvironment()
        bound_tool = make_edit(sandbox=bound)

        # Give the ToolContext an agent whose sandbox would fail every call;
        # the tool must still succeed by using the construction-time bound one.
        class _ExplodingSandbox:
            async def read_text(self, *args: object, **kwargs: object) -> str:
                raise AssertionError("agent sandbox used despite bound sandbox")

            async def write_text(self, *args: object, **kwargs: object) -> None:
                raise AssertionError("agent sandbox used despite bound sandbox")

        agent = _FakeAgent()
        agent.sandbox = _ExplodingSandbox()  # type: ignore[assignment]
        ctx = ToolContext(
            tool_use={"name": "edit", "toolUseId": "test-id", "input": {}},
            agent=agent,
            invocation_state={},
        )
        file_path = _write(tmp_path / "f.txt", "x")
        await bound_tool(path=file_path, tool_context=ctx, old_str="x", new_str="y")
        assert (tmp_path / "f.txt").read_text() == "y"

    @pytest.mark.asyncio
    async def test_default_edit_reads_agent_sandbox(self, tmp_path):
        file_path = _write(tmp_path / "f.txt", "hello")
        await edit(path=file_path, tool_context=_tool_context(), old_str="hello", new_str="world")
        assert (tmp_path / "f.txt").read_text() == "world"
