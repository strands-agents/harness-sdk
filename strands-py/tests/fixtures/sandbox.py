"""Shared ``TestSandbox`` fixture for exercising sandbox-routed code paths.

A concrete
:class:`~strands.sandbox.posix_shell.PosixShellSandbox` rooted at a working
directory, so tests drive the real sandbox code paths (base64 file transport,
shell quoting, ``ls`` parsing) against a temp dir instead of the host filesystem.
"""

import shlex
from collections.abc import AsyncGenerator
from typing import Any

from strands.sandbox.posix_shell import PosixShellSandbox, build_shell_env_prefix
from strands.sandbox.stream_process import _stream_process
from strands.sandbox.types import ExecutionResult, StreamChunk


class TestSandbox(PosixShellSandbox):
    """Run commands in a working directory via ``sh -c``, exercising real shell paths."""

    # Not a pytest test class despite the ``Test`` prefix .
    __test__ = False

    def __init__(self, working_dir: str) -> None:
        """Initialize the sandbox rooted at ``working_dir``.

        Args:
            working_dir: Directory commands run in unless ``cwd`` overrides it.
        """
        self.working_dir = working_dir

    async def execute_streaming(
        self,
        command: str,
        *,
        timeout: float | None = None,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        **kwargs: Any,
    ) -> AsyncGenerator[StreamChunk | ExecutionResult, None]:
        """Execute ``command`` via ``sh -c`` in the working directory, streaming output."""
        target_cwd = cwd if cwd is not None else self.working_dir
        env_prefix = build_shell_env_prefix(env)
        full_command = f"cd {shlex.quote(target_cwd)} && {env_prefix}{command}"
        async for chunk in _stream_process("sh", ["-c", full_command], timeout=timeout):
            yield chunk
