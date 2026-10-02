"""Error types raised by sandbox execution and file operations.

Mirrors ``strands-ts/src/sandbox/errors.ts``. Each error subclasses its stdlib
equivalent so existing ``except TimeoutError`` / ``except FileNotFoundError``
handlers keep working, while giving callers a sandbox-specific type to branch on.
"""


class SandboxTimeoutError(TimeoutError):
    """Raised by sandbox execution when the configured ``timeout`` elapses.

    ``stdout`` and ``stderr`` hold whatever the process wrote before it was killed.
    """

    def __init__(self, seconds: float | None, stdout: str = "", stderr: str = "") -> None:
        """Initialize the error with the timeout duration and the output captured so far.

        Args:
            seconds: The timeout duration, in seconds, that elapsed.
            stdout: Standard output captured before the kill.
            stderr: Standard error captured before the kill.
        """
        super().__init__(f"Execution timed out after {seconds} seconds")
        self.stdout = stdout
        self.stderr = stderr


class SandboxPathNotFoundError(FileNotFoundError):
    """Raised by :meth:`~strands.sandbox.base.Sandbox.list_files` when the path does not exist.

    Distinguishes genuine absence (a missing path, or a file where a directory
    was expected) from permission or transport failures, which raise plain
    :class:`OSError`/:class:`FileNotFoundError`.
    """

    def __init__(self, path: str) -> None:
        """Initialize the error with the missing path.

        Args:
            path: The path that does not exist.
        """
        super().__init__(f"Path not found: {path}")
