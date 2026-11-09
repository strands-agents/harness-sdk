"""Shell tool for executing commands through a sandbox.

Provides :func:`make_shell` (a factory for a stateless, sandbox-routed shell tool)
and :data:`shell` (the default instance that reads the sandbox from the agent at
call time). Each call runs in a fresh shell; state such as variables and the
working directory does not persist across calls.

The command runs in whichever shell the sandbox provides -- ``sh`` for the Docker
and local environments, the remote login shell over SSH -- so it must not rely on
shell-specific syntax.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

from ...sandbox.errors import SandboxTimeoutError
from ...tools.decorator import tool
from ...types.tools import ToolContext
from .types import (
    SANDBOX_SHELL_DESCRIPTION,
    SANDBOX_SHELL_STDIO_DESCRIPTION,
    ShellExecutionError,
    ShellOutput,
    ShellResultKeys,
    ShellStdioOutput,
)

if TYPE_CHECKING:
    from ...sandbox.base import Sandbox
    from ...tools.decorator import DecoratedFunctionTool

_DEFAULT_TIMEOUT = 120


def make_shell(
    *,
    sandbox: Sandbox | None = None,
    name: str = "shell",
    description: str | None = None,
    result_keys: ShellResultKeys = "output_error",
) -> DecoratedFunctionTool:
    """Create a stateless, sandbox-routed shell tool.

    If a ``sandbox`` is passed, it is bound at creation time. Otherwise the tool
    reads the sandbox from ``tool_context.agent.sandbox`` at call time. Used by
    sandbox implementations in :meth:`~strands.sandbox.base.Sandbox.get_tools`
    and by users who want a customized shell tool.

    Args:
        sandbox: Sandbox to bind at creation. When ``None``, the agent's
            configured sandbox is used at call time.
        name: Tool name. Defaults to ``"shell"``.
        description: Tool description shown to the model. Defaults to a description
            matching ``result_keys``.
        result_keys: ``"output_error"`` returns ``{output, error, exit_code}``;
            ``"stdout_stderr"`` returns ``{stdout, stderr, exit_code}``.

    Returns:
        A decorated tool that executes shell commands through the sandbox.

    Raises:
        ValueError: If ``result_keys`` is not a supported value.
    """
    if result_keys not in ("output_error", "stdout_stderr"):
        raise ValueError(f"result_keys must be 'output_error' or 'stdout_stderr', got {result_keys!r}")
    stdio = result_keys == "stdout_stderr"
    if description is None:
        description = SANDBOX_SHELL_STDIO_DESCRIPTION if stdio else SANDBOX_SHELL_DESCRIPTION

    def _result(stdout: str, stderr: str, exit_code: int) -> ShellOutput | ShellStdioOutput:
        if stdio:
            return {"stdout": stdout, "stderr": stderr, "exit_code": exit_code}
        return {"output": stdout, "error": stderr, "exit_code": exit_code}

    @tool(name=name, description=description, context="tool_context")
    async def shell_tool(
        command: str, tool_context: ToolContext, timeout: int = _DEFAULT_TIMEOUT
    ) -> ShellOutput | ShellStdioOutput:
        """Executes a shell command and returns its output and exit code.

        Args:
            command: The shell command to execute.
            tool_context: Injected by the framework. Not user-facing.
            timeout: Timeout in seconds (default: 120).
        """
        active = sandbox if sandbox is not None else tool_context.agent.sandbox
        try:
            result = await active.execute(command, timeout=timeout)
        except SandboxTimeoutError as e:
            # The model only sees str(e), so the partial output rides in the message with the success field names.
            e.args = (f"{e}\n{json.dumps(_result(e.stdout, e.stderr, 124))}",)
            raise
        except Exception as e:
            # ShellExecutionError subclasses RuntimeError, so prior handlers still match.
            raise ShellExecutionError(str(e)) from e
        return _result(result.stdout, result.stderr, result.exit_code)

    return shell_tool


shell = make_shell()
"""Default shell tool. Reads the sandbox from the agent's context at call time."""
