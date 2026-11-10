"""Shared types and constants for the Python REPL tool."""

from typing import TypedDict


class PythonReplOutput(TypedDict):
    """Output of a Python REPL execution.

    Attributes:
        output: Standard output captured from the interpreter.
        error: Standard error captured from the interpreter, including tracebacks. Empty when there was none.
        exit_code: Exit code of the interpreter. Non-zero means the code failed.
    """

    output: str
    error: str
    exit_code: int


class PythonReplError(RuntimeError):
    """Raised when the sandbox fails to run the Python code.

    Raised for sandbox-level failures (for example, an unreachable container), not for
    errors in the code itself; those are reported through ``error`` and a non-zero
    ``exit_code``. Subclasses :class:`RuntimeError` so existing ``except RuntimeError``
    handlers keep working.
    """


PYTHON_REPL_DESCRIPTION = (
    "Executes Python code and returns output (stdout), error (stderr), and exit_code (non-zero means the "
    "code failed). Each call runs in a fresh interpreter; variables, imports, and definitions do not persist "
    "across calls. Files written to the working directory persist while the sandbox is alive, so save "
    "intermediate results to files when later calls need them. stdin is not available (input() fails). "
    "Use print() to surface values."
)
"""Description for the Python REPL tool."""
