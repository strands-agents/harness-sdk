"""Python REPL tool: run Python through a sandbox.

Provides :func:`make_python_repl` (a factory for a sandbox-routed Python tool) and
:data:`python_repl` (the default instance that uses the agent's sandbox).
Each call pipes the code to a fresh interpreter process in the sandbox,
so variables, imports, and definitions do not persist across calls.
Files written to the sandbox filesystem persist for as long as the sandbox does,
so code can checkpoint intermediate results to disk.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

from ...sandbox.constants import LANGUAGE_PATTERN
from ...sandbox.errors import SandboxTimeoutError
from ...tools.decorator import tool
from ...types.tools import ToolContext
from .types import PYTHON_REPL_DESCRIPTION, PythonReplError, PythonReplOutput

if TYPE_CHECKING:
    from ...sandbox.base import Sandbox
    from ...tools.decorator import DecoratedFunctionTool

_DEFAULT_LANGUAGE = "python3"
_DEFAULT_TIMEOUT = 120


def make_python_repl(
    *,
    sandbox: Sandbox | None = None,
    name: str = "python_repl",
    description: str = PYTHON_REPL_DESCRIPTION,
    language: str = _DEFAULT_LANGUAGE,
) -> DecoratedFunctionTool:
    """Create a sandbox-routed Python REPL tool.

    If a ``sandbox`` is passed, it is bound at creation time. Otherwise the tool
    reads the sandbox from ``tool_context.agent.sandbox`` at call time.

    Args:
        sandbox: Sandbox to bind at creation. When ``None``, the agent's
            configured sandbox is used at call time.
        name: Tool name. Defaults to ``"python_repl"``.
        description: Tool description shown to the model.
        language: Python interpreter used to run the code. Defaults to ``"python3"``.

    Returns:
        A decorated tool that executes Python code through the sandbox.

    Raises:
        ValueError: If ``name`` is empty or ``language`` contains invalid characters.
    """
    if not name:
        raise ValueError("name must be a non-empty string")
    # Sandboxes validate this too, but only at call time; fail at construction instead.
    if not LANGUAGE_PATTERN.fullmatch(language):
        raise ValueError(f"language contains invalid characters: {language}")

    @tool(name=name, description=description, context="tool_context")
    async def python_repl_tool(
        code: str, tool_context: ToolContext, timeout: int = _DEFAULT_TIMEOUT
    ) -> PythonReplOutput:
        """Executes Python code and returns its output, error, and exit code.

        Args:
            code: Python source to execute.
            tool_context: Injected by the framework. Not user-facing.
            timeout: Timeout in seconds (default: 120). Must be positive.

        Raises:
            ValueError: If ``timeout`` is not positive.
            SandboxTimeoutError: If execution exceeds ``timeout``. The message carries the partial
                output as JSON with the success field names and ``exit_code``.
            PythonReplError: If the sandbox fails to run the code.
        """
        # The model sets timeout; reject non-positive values rather than rely on backend-specific semantics.
        if timeout <= 0:
            raise ValueError(f"timeout must be a positive number of seconds, got {timeout}")
        active = sandbox if sandbox is not None else tool_context.agent.sandbox
        try:
            result = await active.execute_code(code, language, timeout=timeout)
        except SandboxTimeoutError as e:
            # The model only sees str(e), so the partial output rides in the message with the success field names.
            partial: PythonReplOutput = {"output": e.stdout, "error": e.stderr, "exit_code": 124}
            e.args = (f"{e}\n{json.dumps(partial)}",)
            raise
        except Exception as e:
            raise PythonReplError(str(e)) from e
        return {"output": result.stdout, "error": result.stderr, "exit_code": result.exit_code}

    return python_repl_tool


python_repl = make_python_repl()
"""Default Python REPL tool. Reads the sandbox from the agent's context at call time."""
