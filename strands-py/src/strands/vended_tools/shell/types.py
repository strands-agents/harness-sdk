"""Shared types and constants for the shell tool."""

from typing import Literal, TypedDict


class ShellOutput(TypedDict):
    """Output of a shell command execution.

    Attributes:
        output: Standard output captured from the command.
        error: Standard error captured from the command. Empty when there was none.
        exit_code: Exit code of the command. Non-zero means the command failed.
    """

    output: str
    error: str
    exit_code: int


class ShellStdioOutput(TypedDict):
    """Output of a shell command execution with ``result_keys="stdout_stderr"``.

    Attributes:
        stdout: Standard output captured from the command.
        stderr: Standard error captured from the command. Not a failure signal; check ``exit_code``.
        exit_code: Exit code of the command. Non-zero means the command failed.
    """

    stdout: str
    stderr: str
    exit_code: int


ShellResultKeys = Literal["output_error", "stdout_stderr"]
"""Key names for the shell tool's result: ``{output, error, exit_code}`` or ``{stdout, stderr, exit_code}``."""


class ShellExecutionError(RuntimeError):
    """Raised when a sandbox-routed shell command fails.

    Subclasses :class:`RuntimeError` so existing ``except RuntimeError`` handlers
    keep working, while giving callers a shell-specific type to branch on. Mirrors
    ``ShellExecutionError`` in ``strands-ts/src/vended-tools/shell/types.ts``.
    """


SANDBOX_SHELL_DESCRIPTION = (
    "Executes shell commands and returns output (stdout), error (stderr), and exit_code (non-zero means the "
    "command failed). Each call runs in a fresh shell; "
    "state such as variables and the working directory does not persist across calls."
)
"""Description for the shell tool."""

SANDBOX_SHELL_STDIO_DESCRIPTION = (
    "Executes shell commands and returns stdout, stderr, and exit_code (non-zero means the command failed). "
    "Each call runs in a fresh shell; "
    "state such as variables and the working directory does not persist across calls."
)
"""Description for the shell tool when it returns ``{stdout, stderr, exit_code}``."""
