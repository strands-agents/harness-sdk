"""Spawn a process and stream its stdout/stderr as an async generator.

Mirrors ``strands-ts/src/sandbox/stream-process.ts``.

The shared process-supervision engine behind the shell-based backends (Docker,
SSH): a backend builds an argv, and this spawns the process, streams its output
as :class:`StreamChunk` objects, and yields a final :class:`ExecutionResult`.

Cancellation is cooperative -- cancelling the consuming task (or closing the
generator) runs the cleanup in ``finally``, which kills the process. ``timeout``
is wall-clock: measured from spawn and not reset by ongoing output.
"""

import asyncio
import codecs
import contextlib
import os
import signal
from collections.abc import AsyncGenerator

from .errors import SandboxTimeoutError
from .types import ExecutionResult, StreamChunk, StreamType

_READ_CHUNK_SIZE = 65536
_SIGNAL_EXIT_BASE = 128

# The child is spawned in its own process group (start_new_session) so the whole
# tree can be killed at once. Without this, "sh -c 'cmd; sleep 60'" leaves the
# sleep child holding the pipe write-end open after the parent dies, so the
# readers never see EOF and the generator hangs.
_USE_PROCESS_GROUP = hasattr(os, "killpg")


def _kill_tree(proc: asyncio.subprocess.Process) -> None:
    """SIGKILL the entire process tree (the group on POSIX, the lone process elsewhere)."""
    with contextlib.suppress(ProcessLookupError, PermissionError):
        if _USE_PROCESS_GROUP:
            os.killpg(proc.pid, signal.SIGKILL)
        else:
            proc.kill()


async def _read_text(stream: asyncio.StreamReader) -> AsyncGenerator[str, None]:
    """Yield a stream's output as UTF-8 text.

    Reads are size-bounded, so a multibyte character can straddle two of them.
    The incremental decoder holds its leading bytes until the rest arrives
    instead of turning each half into U+FFFD.
    """
    decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
    while data := await stream.read(_READ_CHUNK_SIZE):
        if text := decoder.decode(data):
            yield text
    if text := decoder.decode(b"", final=True):
        yield text


async def _stream_process(
    program: str,
    args: list[str],
    *,
    timeout: float | None = None,
    enoent_message: str | None = None,
) -> AsyncGenerator[StreamChunk | ExecutionResult, None]:
    """Spawn a command and stream its stdout/stderr, yielding the final result.

    Yields :class:`StreamChunk` objects as output arrives, then a single final
    :class:`ExecutionResult`. Signal termination maps to ``128 + signal`` (e.g.
    SIGKILL -> 137). Cancelling the consuming task kills the process.

    Args:
        program: The binary to spawn (e.g. ``"docker"``, ``"ssh"``).
        args: Arguments to pass to the binary.
        timeout: Maximum wall-clock execution time in seconds, measured from
            spawn (not reset by output). ``None`` means no timeout.
        enoent_message: Message to surface as ``stderr`` (with exit code 127)
            when ``program`` is not on PATH. If ``None``, the underlying
            :class:`FileNotFoundError` propagates instead.

    Yields:
        :class:`StreamChunk` objects for output, then a final
        :class:`ExecutionResult`.

    Raises:
        SandboxTimeoutError: If execution exceeds ``timeout`` seconds.
        FileNotFoundError: If ``program`` is not found and ``enoent_message`` is ``None``.
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            program,
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=_USE_PROCESS_GROUP,
        )
    except FileNotFoundError:
        if enoent_message is None:
            raise
        yield ExecutionResult(exit_code=127, stdout="", stderr=enoent_message)
        return

    queue: asyncio.Queue[StreamChunk | None] = asyncio.Queue()
    out_buf: list[str] = []
    err_buf: list[str] = []
    timed_out = False

    async def pump(stream: asyncio.StreamReader, stream_type: StreamType, buf: list[str]) -> None:
        async for text in _read_text(stream):
            buf.append(text)
            await queue.put(StreamChunk(data=text, stream_type=stream_type))

    assert proc.stdout is not None and proc.stderr is not None
    pumps = asyncio.gather(pump(proc.stdout, "stdout", out_buf), pump(proc.stderr, "stderr", err_buf))

    async def reader() -> None:
        await pumps
        await proc.wait()
        await queue.put(None)

    async def enforce_timeout(timeout: float) -> None:
        nonlocal timed_out
        await asyncio.sleep(timeout)
        if proc.returncode is None:
            timed_out = True
            _kill_tree(proc)
            await queue.put(None)  # signal the consumer loop to stop

    tasks = [asyncio.ensure_future(reader())]
    if timeout is not None:
        tasks.append(asyncio.ensure_future(enforce_timeout(timeout)))

    try:
        while (item := await queue.get()) is not None:
            yield item

        if timed_out:
            raise SandboxTimeoutError(timeout, "".join(out_buf), "".join(err_buf))

        returncode = proc.returncode if proc.returncode is not None else 1
        exit_code = _SIGNAL_EXIT_BASE - returncode if returncode < 0 else returncode
        yield ExecutionResult(exit_code=exit_code, stdout="".join(out_buf), stderr="".join(err_buf))
    finally:
        if proc.returncode is None:
            _kill_tree(proc)
        pumps.cancel()
        for task in tasks:
            task.cancel()
        await asyncio.gather(pumps, *tasks, return_exceptions=True)
