"""Base sandbox interface.

Defines the abstract :class:`Sandbox` class that all sandbox implementations
must extend. The class provides six abstract operations (command execution,
code execution, and file I/O) and convenience wrappers for common patterns.

Mirrors ``strands-ts/src/sandbox/base.ts``. The streaming methods
(:meth:`Sandbox.execute_streaming`, :meth:`Sandbox.execute_code_streaming`) are
the abstract primitives; the non-streaming convenience methods
(:meth:`Sandbox.execute`, :meth:`Sandbox.execute_code`) consume the stream and
return the final :class:`ExecutionResult`.

Idiomatic divergences from the TypeScript oracle (see PR description):

- TS's ``ExecuteOptions`` *options object* (``timeout``, ``cwd``, ``signal``,
  ``env``) becomes Python keyword arguments (``timeout``, ``cwd``, ``env``),
  matching how the rest of ``strands-py`` models call options.
- TS's ``AbortSignal`` cancellation maps to asyncio task cancellation — the
  Pythonic way to cancel an in-flight coroutine/generator — rather than an
  explicit signal parameter.
- TS's discriminated union (``type: 'streamChunk' | 'executionResult'``) is
  discriminated in Python with ``isinstance`` checks on the dataclasses.
"""

import logging
from abc import ABC, abstractmethod
from collections.abc import AsyncGenerator
from typing import Any

from ..types.tools import AgentTool
from .types import ExecutionResult, FileInfo, HttpResult, StreamChunk

logger = logging.getLogger(__name__)


class Sandbox(ABC):
    """Abstract execution environment.

    A Sandbox provides the runtime context where tools execute code, run
    commands, and interact with a filesystem. Multiple tools share the same
    Sandbox instance, giving them a common working directory and filesystem.

    Streaming methods (:meth:`execute_streaming`, :meth:`execute_code_streaming`)
    are the abstract primitives. Non-streaming convenience methods
    (:meth:`execute`, :meth:`execute_code`) consume the stream and return the
    final result.

    All abstract methods accept ``**kwargs`` for forward compatibility — new
    parameters with defaults can be added in future versions without breaking
    existing implementations.

    Example:
        Non-streaming (common case)::

            result = await sandbox.execute("echo hello")
            print(result.stdout)

        Streaming with stdout/stderr distinction::

            async for chunk in sandbox.execute_streaming("echo hello"):
                if isinstance(chunk, StreamChunk):
                    print(f"[{chunk.stream_type}] {chunk.data}", end="")
                elif isinstance(chunk, ExecutionResult):
                    print(f"Exit code: {chunk.exit_code}")
    """

    # ---- Streaming methods (abstract primitives) ----

    @abstractmethod
    async def execute_streaming(
        self,
        command: str,
        *,
        timeout: float | None = None,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        **kwargs: Any,
    ) -> AsyncGenerator[StreamChunk | ExecutionResult, None]:
        """Execute a shell command, streaming output.

        Yields :class:`StreamChunk` objects for stdout and stderr as output
        arrives. The final yield is an :class:`ExecutionResult` with the exit
        code and complete output.

        Args:
            command: The shell command to execute.
            timeout: Maximum execution time in seconds. ``None`` means no timeout.
            cwd: Working directory for execution. ``None`` means use the sandbox
                default.
            env: Environment variables to set for this command. Built-in
                sandboxes always apply these, though the mechanism differs;
                custom implementations must handle ``env`` explicitly or it has
                no effect.
            **kwargs: Additional keyword arguments for forward compatibility.

        Yields:
            :class:`StreamChunk` objects for output, then a final
            :class:`ExecutionResult`.
        """
        ...
        # Establishes this as an async generator function for type checkers.
        # Concrete subclasses must yield at least one ExecutionResult.
        yield  # type: ignore[misc]  # pragma: no cover

    @abstractmethod
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
        """Execute source code via a language interpreter, streaming output.

        Args:
            code: The source code to execute.
            language: The interpreter to use (e.g., ``"python3"``, ``"node"``).
            timeout: Maximum execution time in seconds. ``None`` means no timeout.
            cwd: Working directory for execution. ``None`` means use the sandbox
                default.
            env: Environment variables to set for this execution.
            **kwargs: Additional keyword arguments for forward compatibility.

        Yields:
            :class:`StreamChunk` objects for output, then a final
            :class:`ExecutionResult`.
        """
        ...
        yield  # type: ignore[misc]  # pragma: no cover

    @abstractmethod
    async def read_file(self, path: str, **kwargs: Any) -> bytes:
        """Read a file from the sandbox filesystem as raw bytes.

        Returns ``bytes`` to support both text and binary files. Use
        :meth:`read_text` for a convenience wrapper that decodes to a string.

        Args:
            path: Path to the file to read.
            **kwargs: Additional keyword arguments for forward compatibility.

        Returns:
            The file contents as raw bytes.

        Raises:
            FileNotFoundError: If the file does not exist or cannot be read.
        """
        ...

    @abstractmethod
    async def write_file(self, path: str, content: bytes, **kwargs: Any) -> None:
        """Write raw bytes to a file in the sandbox filesystem.

        Implementations should create parent directories if they do not exist.
        Use :meth:`write_text` for a convenience wrapper that encodes a string.

        Args:
            path: Path to the file to write.
            content: The content to write.
            **kwargs: Additional keyword arguments for forward compatibility.

        Raises:
            OSError: If the file cannot be written.
        """
        ...

    @abstractmethod
    async def remove_file(self, path: str, **kwargs: Any) -> None:
        """Remove a file from the sandbox filesystem.

        Args:
            path: Path to the file to remove.
            **kwargs: Additional keyword arguments for forward compatibility.

        Raises:
            FileNotFoundError: If the file does not exist.
        """
        ...

    @abstractmethod
    async def list_files(self, path: str, **kwargs: Any) -> list[FileInfo]:
        """List files in a sandbox directory.

        Returns :class:`FileInfo` entries with name, ``is_dir``, and ``size``
        metadata. Fields ``is_dir`` and ``size`` may be ``None`` if the backend
        cannot determine them.

        Args:
            path: Path to the directory to list.
            **kwargs: Additional keyword arguments for forward compatibility.

        Returns:
            A list of :class:`FileInfo` entries for the directory contents.

        Raises:
            FileNotFoundError: If the directory does not exist.
        """
        ...

    async def request(
        self,
        method: str,
        url: str,
        *,
        headers: dict[str, str] | None = None,
        body: bytes | str | None = None,
        timeout: float | None = None,
        max_bytes: int | None = None,
        **kwargs: Any,
    ) -> HttpResult:
        """Make an HTTP request inside the sandbox.

        Works with any HTTP method. Optional because not every sandbox needs
        HTTP access.

        Args:
            method: HTTP method (e.g. ``GET``, ``POST``, ``PUT``, ``DELETE``,
                ``PATCH``, ``HEAD``, ``OPTIONS``).
            url: The http(s) URL to request.
            headers: Request headers.
            body: Request body. ``str`` is sent as UTF-8; ``bytes`` is sent as-is.
                ``None`` sends no body.
            timeout: Maximum execution time in seconds. ``None`` means no timeout.
            max_bytes: Bound the response body to this many bytes. ``None`` means
                no limit. A response exceeding the cap raises
                :class:`SandboxHttpError` rather than returning a truncated body.
            **kwargs: Additional keyword arguments for forward compatibility.

        Returns:
            An :class:`HttpResult`. HTTP error statuses (4xx/5xx) are returned in ``status`` rather than raised.

        Raises:
            SandboxHttpError: On network/transport errors, or when the response
                body exceeds ``max_bytes``.
        """
        raise NotImplementedError(f"{type(self).__name__} does not implement request()")

    # ---- Tool vending ----

    def get_tools(self) -> list[AgentTool]:
        """Tools this sandbox vends to an agent.

        Returned tools are registered when the agent initializes; a tool is
        skipped if the user already registered one with the same name. The base
        implementation vends nothing; concrete sandboxes override this.

        Returns:
            The tools to register, or an empty list.
        """
        return []

    # ---- Non-streaming convenience methods ----

    async def execute(
        self,
        command: str,
        *,
        timeout: float | None = None,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        **kwargs: Any,
    ) -> ExecutionResult:
        """Execute a shell command and return the result.

        Consumes :meth:`execute_streaming` and returns the final
        :class:`ExecutionResult`. Use :meth:`execute_streaming` when you need to
        process output as it arrives.

        Args:
            command: The shell command to execute.
            timeout: Maximum execution time in seconds. ``None`` means no timeout.
            cwd: Working directory for execution. ``None`` means use the sandbox
                default.
            env: Environment variables to set for this command.
            **kwargs: Additional keyword arguments for forward compatibility.

        Returns:
            The execution result with exit code and output.

        Raises:
            RuntimeError: If ``execute_streaming`` did not yield an
                :class:`ExecutionResult`.
        """
        async for chunk in self.execute_streaming(command, timeout=timeout, cwd=cwd, env=env, **kwargs):
            if isinstance(chunk, ExecutionResult):
                return chunk
        raise RuntimeError("execute_streaming() did not yield an ExecutionResult")

    async def execute_code(
        self,
        code: str,
        language: str,
        *,
        timeout: float | None = None,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        **kwargs: Any,
    ) -> ExecutionResult:
        """Execute source code and return the result.

        Consumes :meth:`execute_code_streaming` and returns the final
        :class:`ExecutionResult`. Use :meth:`execute_code_streaming` when you
        need to process output as it arrives.

        Args:
            code: The source code to execute.
            language: The interpreter to use.
            timeout: Maximum execution time in seconds. ``None`` means no timeout.
            cwd: Working directory for execution. ``None`` means use the sandbox
                default.
            env: Environment variables to set for this execution.
            **kwargs: Additional keyword arguments for forward compatibility.

        Returns:
            The execution result with exit code and output.

        Raises:
            RuntimeError: If ``execute_code_streaming`` did not yield an
                :class:`ExecutionResult`.
        """
        async for chunk in self.execute_code_streaming(code, language, timeout=timeout, cwd=cwd, env=env, **kwargs):
            if isinstance(chunk, ExecutionResult):
                return chunk
        raise RuntimeError("execute_code_streaming() did not yield an ExecutionResult")

    # ---- Text convenience methods ----

    async def read_text(self, path: str, encoding: str = "utf-8", **kwargs: Any) -> str:
        """Read a text file from the sandbox filesystem.

        Convenience wrapper over :meth:`read_file` that decodes bytes as UTF-8
        (by default). For other encodings, call :meth:`read_file` and decode
        manually.

        Args:
            path: Path to the file to read.
            encoding: Text encoding to use. Defaults to UTF-8.
            **kwargs: Additional keyword arguments passed to :meth:`read_file`.

        Returns:
            The file contents decoded as a string.
        """
        return (await self.read_file(path, **kwargs)).decode(encoding)

    async def write_text(self, path: str, content: str, encoding: str = "utf-8", **kwargs: Any) -> None:
        """Write a text file to the sandbox filesystem.

        Convenience wrapper over :meth:`write_file` that encodes a string as
        UTF-8 (by default). For other encodings, encode manually and call
        :meth:`write_file`.

        Args:
            path: Path to the file to write.
            content: The text content to write.
            encoding: Text encoding to use. Defaults to UTF-8.
            **kwargs: Additional keyword arguments passed to :meth:`write_file`.
        """
        await self.write_file(path, content.encode(encoding), **kwargs)
