"""Tests for the shell tool.

The shell tool routes commands through the agent's sandbox (or a bound one).
Each call runs in a fresh shell; state does not persist across calls. These
spawn ``sh`` and require POSIX, so they are skipped on Windows.
"""

import sys
from types import SimpleNamespace

import pytest

from strands.sandbox.errors import SandboxTimeoutError
from strands.sandbox.not_a_sandbox_local_environment import NotASandboxLocalEnvironment
from strands.types.tools import ToolContext
from strands.vended_tools.shell import make_shell, shell
from strands.vended_tools.shell.types import SANDBOX_SHELL_DESCRIPTION, ShellExecutionError

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="POSIX shell required")


def _tool_context(sandbox: NotASandboxLocalEnvironment | None = None) -> ToolContext:
    """Build a ToolContext whose agent exposes a sandbox (or a fresh one)."""
    agent = SimpleNamespace(sandbox=sandbox or NotASandboxLocalEnvironment())
    return ToolContext(tool_use={"name": "shell", "toolUseId": "id", "input": {}}, agent=agent, invocation_state={})


class TestMakeShell:
    """Tests for a shell tool with a sandbox bound at creation."""

    @pytest.fixture
    def sandbox_shell(self):
        return make_shell(sandbox=NotASandboxLocalEnvironment())

    @pytest.mark.asyncio
    async def test_executes_command_via_sandbox(self, sandbox_shell):
        result = await sandbox_shell(command='echo "hello sandbox"', tool_context=_tool_context())
        assert "hello sandbox" in result["output"]
        assert result["error"] == ""
        assert result["exit_code"] == 0

    @pytest.mark.asyncio
    async def test_captures_stderr_via_sandbox(self, sandbox_shell):
        result = await sandbox_shell(command='echo "oops" >&2', tool_context=_tool_context())
        assert "oops" in result["error"]
        assert result["exit_code"] == 0

    @pytest.mark.asyncio
    async def test_reports_nonzero_exit_code(self, sandbox_shell):
        result = await sandbox_shell(command="exit 42", tool_context=_tool_context())
        assert result["exit_code"] == 42

    @pytest.mark.asyncio
    async def test_does_not_persist_state_between_calls(self, sandbox_shell):
        await sandbox_shell(command="export MY_VAR=hello", tool_context=_tool_context())
        result = await sandbox_shell(command='echo "${MY_VAR:-empty}"', tool_context=_tool_context())
        assert result["output"].strip() == "empty"

    @pytest.mark.asyncio
    async def test_respects_timeout(self, sandbox_shell):
        with pytest.raises(SandboxTimeoutError):
            await sandbox_shell(command="sleep 10", tool_context=_tool_context(), timeout=0.1)

    @pytest.mark.asyncio
    async def test_wraps_sandbox_error_as_shell_execution_error(self):
        class _BoomSandbox(NotASandboxLocalEnvironment):
            async def execute(self, *args, **kwargs):
                raise ValueError("boom")

        t = make_shell(sandbox=_BoomSandbox())
        with pytest.raises(ShellExecutionError, match="boom"):
            await t(command="echo hi", tool_context=_tool_context())

    @pytest.mark.asyncio
    async def test_execution_error_is_still_a_runtime_error(self):
        class _BoomSandbox(NotASandboxLocalEnvironment):
            async def execute(self, *args, **kwargs):
                raise ValueError("boom")

        t = make_shell(sandbox=_BoomSandbox())
        with pytest.raises(RuntimeError, match="boom"):
            await t(command="echo hi", tool_context=_tool_context())


class TestDefaultShell:
    """Tests for the default unbound ``shell`` instance (reads sandbox from agent context)."""

    @pytest.mark.asyncio
    async def test_reads_sandbox_from_agent_context(self):
        result = await shell(command="echo via-context", tool_context=_tool_context())
        assert "via-context" in result["output"]


class TestToolMetadata:
    """Tests for tool names, descriptions, and input schemas."""

    def test_default_name(self):
        assert shell.tool_name == "shell"

    def test_custom_name(self):
        assert make_shell(name="sandbox_shell").tool_name == "sandbox_shell"

    def test_default_description(self):
        assert make_shell().tool_spec["description"] == SANDBOX_SHELL_DESCRIPTION

    def test_custom_description(self):
        assert make_shell(description="custom desc").tool_spec["description"] == "custom desc"

    def test_schema_excludes_context(self):
        props = shell.tool_spec["inputSchema"]["json"]["properties"]
        assert "command" in props
        assert "timeout" in props
        assert "tool_context" not in props


class TestDeprecatedBashAliases:
    """The ``bash`` aliases are retained until v2.0.0, warn, and keep the pre-rename name.

    Keeping ``tool_name == "bash"`` is what makes the alias backwards compatible:
    consumers key registries, hooks, and defaults lists on the runtime name, so an
    alias that returned a tool named ``shell`` would still break them (see
    awsarron/stan#6).
    """

    def test_bash_alias_warns_and_keeps_its_name(self):
        import strands.vended_tools as vended_tools

        with pytest.deprecated_call(match="bash is deprecated"):
            tool = vended_tools.bash
        assert tool.tool_name == "bash"

    def test_bash_alias_returns_the_same_instance_each_time(self):
        import strands.vended_tools as vended_tools

        with pytest.deprecated_call(match="bash is deprecated"):
            first = vended_tools.bash
        with pytest.deprecated_call(match="bash is deprecated"):
            second = vended_tools.bash
        assert first is second

    def test_bash_alias_matches_shell_apart_from_the_name(self):
        import strands.vended_tools as vended_tools

        with pytest.deprecated_call(match="bash is deprecated"):
            tool = vended_tools.bash
        assert tool.tool_spec == {**shell.tool_spec, "name": "bash"}

    def test_make_bash_alias_warns_and_builds_a_bash_named_tool(self):
        import strands.vended_tools as vended_tools

        with pytest.deprecated_call(match="make_bash is deprecated"):
            tool = vended_tools.make_bash()
        assert tool.tool_name == "bash"

    def test_make_bash_alias_forwards_arguments(self):
        import strands.vended_tools as vended_tools

        with pytest.deprecated_call(match="make_bash is deprecated"):
            tool = vended_tools.make_bash(name="sandbox_shell", description="custom desc")
        assert tool.tool_name == "sandbox_shell"
        assert tool.tool_spec["description"] == "custom desc"

    def test_make_bash_is_marked_deprecated_for_static_analysis(self):
        import strands.vended_tools as vended_tools

        assert "make_shell" in vended_tools.make_bash.__deprecated__

    def test_make_bash_deprecation_message_is_a_literal(self):
        """PEP 702 checkers only honor @deprecated when the argument is a string literal.

        An f-string over _RENAME_RATIONALE keeps the runtime warning and __deprecated__
        attribute working while mypy silently reports nothing, so guard the source.
        """
        import ast
        import inspect

        import strands.vended_tools._bash as _bash

        tree = ast.parse(inspect.getsource(_bash))
        decorators = [
            decorator
            for node in ast.walk(tree)
            if isinstance(node, ast.FunctionDef) and node.name == "make_bash"
            for decorator in node.decorator_list
            if isinstance(decorator, ast.Call) and getattr(decorator.func, "id", None) == "deprecated"
        ]

        assert len(decorators) == 1
        assert isinstance(decorators[0].args[0], ast.Constant)

    def test_unknown_attribute_still_raises(self):
        import strands.vended_tools as vended_tools

        with pytest.raises(AttributeError):
            _ = vended_tools.not_a_real_tool
