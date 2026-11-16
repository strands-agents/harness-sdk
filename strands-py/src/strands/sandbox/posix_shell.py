"""Shell sandbox with default implementations for file and code operations.

Subclasses only need to implement :meth:`PosixShellSandbox.execute_streaming` —
all other operations are implemented by running shell commands through it. Use
this for remote environments where only shell access is available (Docker
containers, SSH connections, cloud runtimes).

Mirrors ``strands-ts/src/sandbox/posix-shell.ts``.
"""

import base64
import errno
import logging
import shlex
import uuid
from abc import ABC
from collections.abc import AsyncGenerator
from typing import Any

from .base import Sandbox
from .constants import ENV_KEY_PATTERN, LANGUAGE_PATTERN
from .errors import SandboxPathNotFoundError
from .types import ExecutionResult, FileInfo, StreamChunk

logger = logging.getLogger(__name__)


def validate_env_keys(env: dict[str, str]) -> None:
    """Validate environment variable names against :data:`ENV_KEY_PATTERN`.

    Args:
        env: Mapping of environment variable names to values.

    Raises:
        ValueError: If any key is not a valid POSIX environment variable name.
    """
    for key in env:
        if not ENV_KEY_PATTERN.fullmatch(key):
            raise ValueError(f"Invalid environment variable name: {key}")


def build_shell_env_prefix(env: dict[str, str] | None = None) -> str:
    """Build a shell ``export KEY=VALUE && ...`` prefix, or ``""`` when empty.

    Keys are validated; values are escaped with :func:`shlex.quote`. Used by
    shell-string backends (e.g. SSH); backends that set env via native flags
    (e.g. Docker's ``-e``) call :func:`validate_env_keys` directly.

    Uses ``export`` rather than an ``env KEY=VALUE`` command wrapper so the
    variables are set in the shell itself and inherited by every stage of a
    pipeline. ``execute_code`` runs ``base64 ... | <lang>``, and an ``env``
    wrapper would only bind the left side of the pipe, never reaching the
    interpreter. The trailing ``&&`` keeps the surrounding
    ``cd ... && <prefix><command>`` chain fail-fast.

    Args:
        env: Mapping of environment variable names to values.

    Returns:
        The shell ``export ... && `` prefix, or an empty string when ``env`` is
        ``None`` or empty.

    Raises:
        ValueError: If any key is not a valid POSIX environment variable name.
    """
    if not env:
        return ""
    validate_env_keys(env)
    assignments = " ".join(f"{key}={shlex.quote(value)}" for key, value in env.items())
    return f"export {assignments} && "


def _eof_marker() -> str:
    """Generate a unique heredoc EOF marker, mirroring the TS ``STRANDS_EOF_`` token."""
    return f"STRANDS_EOF_{uuid.uuid4().hex[:16]}"


class PosixShellSandbox(Sandbox, ABC):
    """Abstract sandbox that provides shell-based defaults for file and code operations.

    Assumes a POSIX-compatible shell (sh/bash) on the target.

    Subclasses only need to implement :meth:`execute_streaming`. The remaining
    operations — ``execute_code_streaming``, ``read_file``, ``write_file``,
    ``remove_file``, and ``list_files`` — are implemented via shell commands
    piped through :meth:`execute_streaming`.

    Subclasses may override any method with a native implementation for better
    performance or to handle edge cases (e.g., binary-safe file transfer via
    Docker stdin pipes, or native API calls for cloud backends).

    Subclasses are responsible for honoring the execution options in
    :meth:`execute_streaming`, or they have no effect:

    - ``env`` — backends that build a shell-command string prepend
      :func:`build_shell_env_prefix`; backends that set env via process flags
      (e.g. Docker's ``-e``) call :func:`validate_env_keys` and pass the values
      directly. An implementation that ignores ``env`` will silently drop the
      caller's variables.
    - ``timeout`` — the base class does not enforce a timeout; a subclass that
      does not wire ``timeout`` into its process supervision will silently run
      without any time limit.
    - ``cwd`` — similarly must be applied by the subclass.
    """

    async def execute_code_streaming(
        self,
        code: str,
        language: str,
        *,
        timeout: float | None = None,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        **kwargs: Any,
    ) -> AsyncGenerator[StreamChunk | ExecutionResult, None]:
        """Execute code by piping it to a language interpreter over the shell.

        The code is base64-encoded and decoded inside a quoted heredoc on the
        target, then piped to the interpreter (``base64 -d << 'EOF' | <lang>``).
        This transports arbitrary source — including shell metacharacters,
        quotes, and newlines — without injection risk. The ``language`` is
        validated against :data:`LANGUAGE_PATTERN` first.

        Args:
            code: The source code to execute.
            language: The interpreter to use (e.g., ``"python3"``, ``"node"``).
            timeout: Maximum execution time in seconds. ``None`` means no timeout.
            cwd: Working directory for execution.
            env: Environment variables to set for this execution.
            **kwargs: Additional keyword arguments for forward compatibility.

        Yields:
            :class:`StreamChunk` objects for output, then a final
            :class:`ExecutionResult`.

        Raises:
            ValueError: If ``language`` contains invalid characters.
        """
        if not LANGUAGE_PATTERN.fullmatch(language):
            raise ValueError(f"language parameter contains invalid characters: {language}")
        encoded = base64.b64encode(code.encode()).decode("ascii")
        eof = _eof_marker()
        command = f"base64 -d << '{eof}' | {language}\n{encoded}\n{eof}"
        async for chunk in self.execute_streaming(command, timeout=timeout, cwd=cwd, env=env, **kwargs):
            yield chunk

    async def read_file(self, path: str, **kwargs: Any) -> bytes:
        """Read a file as raw bytes via base64 over the shell.

        Args:
            path: Path to the file to read.
            **kwargs: Additional keyword arguments for forward compatibility.

        Returns:
            The file contents as raw bytes.

        Raises:
            SandboxPathNotFoundError: If the file does not exist.
            IsADirectoryError: If ``path`` is a directory.
            PermissionError: If the file or its parent directory is not accessible.
            OSError: If the file cannot be read for another reason, or the command succeeds but its output
                is not valid base64 (e.g. a shell profile or locale warning prepended text to stdout).
        """
        quoted = shlex.quote(path)
        # Locale-independent exit codes: 77 = missing, 78 = directory, 79 = permission denied. `test -e` is also
        # false under an unsearchable ancestor, so check the deepest existing one. The braces keep a backend's
        # `cd ... &&` prefix out of the `||`.
        result = await self.execute(
            f'{{ test -e {quoted} || {{ p={quoted}; while p=$(dirname -- "$p"); ! test -d "$p"; do :; done; '
            f'test -x "$p" || exit 79; exit 77; }}; '
            f"test -r {quoted} || exit 79; test -d {quoted} && exit 78; base64 < {quoted}; }}"
        )
        if result.exit_code == 77:
            raise SandboxPathNotFoundError(path)
        if result.exit_code == 78:
            raise IsADirectoryError(errno.EISDIR, "Is a directory", path)
        if result.exit_code == 79:
            raise PermissionError(errno.EACCES, "Permission denied", path)
        if result.exit_code != 0:
            raise OSError(result.stderr or f"Failed to read file: {path}")
        # base64 output is ASCII-safe text; strip whitespace (line wrapping) and decode.
        try:
            # binascii.Error (raised by b64decode on malformed input) subclasses ValueError.
            return base64.b64decode("".join(result.stdout.split()))
        except ValueError as e:
            raise OSError(f"Failed to decode base64 contents of file: {path}") from e

    async def write_file(self, path: str, content: bytes, **kwargs: Any) -> None:
        """Write raw bytes to a file via base64 over the shell.

        Parent directories are created via ``mkdir -p``. The base64-encoded
        content is decoded inside a quoted heredoc on the target, preserving
        arbitrary binary content.

        Args:
            path: Path to the file to write.
            content: The content to write.
            **kwargs: Additional keyword arguments for forward compatibility.

        Raises:
            OSError: If the file cannot be written.
        """
        encoded = base64.b64encode(content).decode("ascii")
        quoted = shlex.quote(path)
        eof = _eof_marker()
        cmd = f"mkdir -p \"$(dirname {quoted})\" && base64 -d << '{eof}' > {quoted}\n{encoded}\n{eof}"
        result = await self.execute(cmd)
        if result.exit_code != 0:
            raise OSError(result.stderr or f"Failed to write file: {path}")

    async def remove_file(self, path: str, **kwargs: Any) -> None:
        """Remove a file via ``rm`` over the shell.

        Args:
            path: Path to the file to remove.
            **kwargs: Additional keyword arguments for forward compatibility.

        Raises:
            FileNotFoundError: If the file does not exist.
        """
        result = await self.execute(f"rm {shlex.quote(path)}")
        if result.exit_code != 0:
            raise FileNotFoundError(result.stderr or f"Failed to remove file: {path}")

    async def list_files(self, path: str, **kwargs: Any) -> list[FileInfo]:
        """List directory contents via ``ls -1ap`` parsing.

        Args:
            path: Path to the directory to list.
            **kwargs: Additional keyword arguments for forward compatibility.

        Returns:
            A list of :class:`FileInfo` entries (``size`` is always ``None`` for
            this shell-based listing).

        Raises:
            SandboxPathNotFoundError: If the directory does not exist (or ``path``
                is not a directory).
            OSError: If the listing fails for another reason.
        """
        quoted = shlex.quote(path)
        # Exit 77 distinguishes a missing directory from ls's own failures (locale-independent).
        result = await self.execute(f"test -d {quoted} || exit 77; env QUOTING_STYLE=literal ls -1ap {quoted}")
        if result.exit_code == 77:
            raise SandboxPathNotFoundError(path)
        if result.exit_code != 0:
            raise OSError(result.stderr or f"Failed to list directory: {path}")

        entries: list[FileInfo] = []
        for raw in result.stdout.split("\n"):
            line = raw.rstrip("\r")
            if not line or line in ("./", "../"):
                continue
            is_dir = line.endswith("/")
            name = line[:-1] if is_dir else line
            if name:
                entries.append(FileInfo(name=name, is_dir=is_dir))
        return entries
