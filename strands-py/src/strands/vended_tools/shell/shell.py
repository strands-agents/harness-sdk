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
import math
from typing import TYPE_CHECKING

from ...sandbox.errors import SandboxTimeoutError
from ...tools.decorator import tool
from ...types.tools import ToolContext
from .types import SANDBOX_SHELL_DESCRIPTION, ShellExecutionError, ShellOutput

if TYPE_CHECKING:
    from ...sandbox.base import Sandbox
    from ...tools.decorator import DecoratedFunctionTool

_DEFAULT_TIMEOUT = 120


def make_shell(
    *,
    sandbox: Sandbox | None = None,
    name: str = "shell",
    description: str = SANDBOX_SHELL_DESCRIPTION,
    default_timeout: int = _DEFAULT_TIMEOUT,
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
        description: Tool description shown to the model.
        default_timeout: Timeout in seconds used when the model omits ``timeout``.
            Becomes the schema default the model sees. Defaults to ``120``.

    Returns:
        A decorated tool that executes shell commands through the sandbox.

    Raises:
        ValueError: If ``default_timeout`` is not a positive finite number.
    """
    if not math.isfinite(default_timeout) or default_timeout <= 0:
        raise ValueError(f"default_timeout must be a positive finite number, got {default_timeout}")

    @tool(name=name, description=description, context="tool_context")
    async def shell_tool(command: str, tool_context: ToolContext, timeout: int = default_timeout) -> ShellOutput:
        """Executes a shell command and returns its output and exit code.

        Args:
            command: The shell command to execute.
            tool_context: Injected by the framework. Not user-facing.
            timeout: Optional per-execution timeout in seconds.
        """
        active = sandbox if sandbox is not None else tool_context.agent.sandbox
        try:
            result = await active.execute(command, timeout=timeout)
        except SandboxTimeoutError as e:
            # The model only sees str(e), so the partial output rides in the message with the success field names.
            partial: ShellOutput = {"output": e.stdout, "error": e.stderr, "exit_code": 124}
            e.args = (f"{e}\n{json.dumps(partial)}",)
            raise
        except Exception as e:
            # ShellExecutionError subclasses RuntimeError, so prior handlers still match.
            raise ShellExecutionError(str(e)) from e
        return {"output": result.stdout, "error": result.stderr, "exit_code": result.exit_code}

    return shell_tool


shell = make_shell()
"""Default shell tool. Reads the sandbox from the agent's context at call time."""
