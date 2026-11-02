"""Tests for the shell-based sandbox core (``strands.sandbox``).

Mirrors ``strands-ts/src/sandbox/__tests__/posix-shell.test.node.ts`` and its
``TestSandbox`` fixture, plus the security/adversarial cases recovered from the
prior Python sandbox attempt (PR #2198). Exercises the real
:class:`~strands.sandbox.posix_shell.PosixShellSandbox` code paths: base64 file
transport, shell quoting, ``ls`` parsing, language validation, env handling,
timeout, and cancellation.

These tests spawn ``sh`` and require a POSIX shell, so they are skipped on
Windows.
"""

import asyncio
import os
import shlex
import sys
from collections.abc import AsyncGenerator
from typing import Any

import pytest

from strands.sandbox import (
    ExecutionResult,
    FileInfo,
    PosixShellSandbox,
    StreamChunk,
)
from strands.sandbox.errors import SandboxPathNotFoundError
from strands.sandbox.posix_shell import (
    build_shell_env_prefix,
    validate_env_keys,
)

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="POSIX shell required")

_SIGNAL_BASE = 128


async def _stream_process(
    program: str,
    args: list[str],
    *,
    timeout: float | None = None,
) -> AsyncGenerator[StreamChunk | ExecutionResult, None]:
    """Spawn a process and stream stdout/stderr, yielding a final result.

    Python equivalent of the TypeScript ``streamProcess`` helper. Yields
    :class:`StreamChunk` objects as output arrives, then a final
    :class:`ExecutionResult`. Signal termination maps to ``128 + signal``.

    ``timeout`` here is an *idle* timeout: it fires when no output (chunk or
    completion) arrives within ``timeout`` seconds, not when total wall-clock
    execution exceeds it. A process that emits output steadily would never trip
    it. This is sufficient for the test fixture; concrete backends that reuse
    this pattern should document/enforce whichever semantics they intend.
    """
    proc = await asyncio.create_subprocess_exec(
        program,
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    queue: asyncio.Queue[StreamChunk | None] = asyncio.Queue()
    out_buf: list[str] = []
    err_buf: list[str] = []

    async def pump(stream: asyncio.StreamReader, stream_type: str, buf: list[str]) -> None:
        while True:
            data = await stream.read(65536)
            if not data:
                break
            text = data.decode(errors="replace")
            buf.append(text)
            await queue.put(StreamChunk(data=text, stream_type=stream_type))  # type: ignore[arg-type]

    assert proc.stdout is not None and proc.stderr is not None
    pumps = asyncio.gather(
        pump(proc.stdout, "stdout", out_buf),
        pump(proc.stderr, "stderr", err_buf),
    )

    async def waiter() -> None:
        await pumps
        await proc.wait()
        await queue.put(None)

    waiter_task = asyncio.ensure_future(waiter())

    try:
        while True:
            if timeout is not None:
                # Idle timeout: bounds the wait for the *next* item, not the total runtime.
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=timeout)
                except asyncio.TimeoutError:
                    proc.kill()
                    raise TimeoutError(f"Execution timed out after {timeout} seconds") from None
            else:
                item = await queue.get()
            if item is None:
                break
            yield item

        returncode = proc.returncode if proc.returncode is not None else 1
        if returncode < 0:
            exit_code = _SIGNAL_BASE + (-returncode)
        else:
            exit_code = returncode
        yield ExecutionResult(
            exit_code=exit_code,
            stdout="".join(out_buf),
            stderr="".join(err_buf),
        )
    finally:
        if proc.returncode is None:
            proc.kill()
        waiter_task.cancel()


class _ShellTestSandbox(PosixShellSandbox):
    """Concrete sandbox that runs commands in a working directory via ``sh -c``.

    Mirrors the TypeScript ``TestSandbox`` fixture so the same
    :class:`PosixShellSandbox` code paths (base64 transport, shell quoting,
    ``ls`` parsing) are exercised.
    """

    def __init__(self, working_dir: str) -> None:
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
        target_cwd = cwd if cwd is not None else self.working_dir
        env_prefix = build_shell_env_prefix(env)
        full_command = f"cd {shlex.quote(target_cwd)} && {env_prefix}{command}"
        async for chunk in _stream_process("sh", ["-c", full_command], timeout=timeout):
            yield chunk


@pytest.fixture
def sandbox(tmp_path) -> _ShellTestSandbox:
    return _ShellTestSandbox(str(tmp_path))


# ---- execute (via shell commands) ----


@pytest.mark.asyncio
async def test_execute_runs_a_command(sandbox):
    result = await sandbox.execute("echo hello")
    assert result.exit_code == 0
    assert result.stdout == "hello\n"


@pytest.mark.asyncio
async def test_execute_runs_in_working_dir(sandbox, tmp_path):
    result = await sandbox.execute("pwd")
    assert os.path.basename(str(tmp_path)) in result.stdout.strip()


@pytest.mark.asyncio
async def test_execute_respects_cwd_option(sandbox):
    result = await sandbox.execute("pwd", cwd="/tmp")
    assert result.stdout.strip().endswith("/tmp")


# ---- env option (via build_shell_env_prefix) ----


@pytest.mark.asyncio
async def test_env_passes_vars_to_command(sandbox):
    result = await sandbox.execute("printenv FOO", env={"FOO": "hello", "BAR": "world"})
    assert result.stdout.strip() == "hello"


@pytest.mark.asyncio
async def test_env_values_are_not_evaluated(sandbox):
    result = await sandbox.execute("printenv FOO", env={"FOO": "$(whoami)"})
    assert result.stdout.strip() == "$(whoami)"


@pytest.mark.asyncio
async def test_env_rejects_invalid_var_names(sandbox):
    with pytest.raises(ValueError, match="Invalid environment variable name"):
        await sandbox.execute("echo hi", env={"BAD-KEY": "v"})


# ---- build_shell_env_prefix ----


def test_build_shell_env_prefix_empty():
    assert build_shell_env_prefix() == ""
    assert build_shell_env_prefix({}) == ""


def test_build_shell_env_prefix_uses_export_with_fail_fast_separator():
    # `export ... &&` (not `env ... `) is what lets env reach the right side of
    # the `base64 ... | <interpreter>` pipe in execute_code. Locking the format.
    assert build_shell_env_prefix({"FOO": "bar", "BAZ": "qux"}) == "export FOO=bar BAZ=qux && "


def test_build_shell_env_prefix_quotes_values():
    assert build_shell_env_prefix({"FOO": "$(whoami)"}) == "export FOO='$(whoami)' && "


def test_build_shell_env_prefix_rejects_invalid_names():
    with pytest.raises(ValueError, match="Invalid environment variable name"):
        build_shell_env_prefix({"BAD-KEY": "v"})


def test_build_shell_env_prefix_rejects_trailing_newline_in_key():
    # Regression: a trailing newline in an env key is a shell statement
    # separator. Python's `$` would match before it (unlike JS), so the
    # validator must full-string match to reject `FOO\n` and friends.
    with pytest.raises(ValueError, match="Invalid environment variable name"):
        build_shell_env_prefix({"FOO\n": "v"})
    with pytest.raises(ValueError, match="Invalid environment variable name"):
        validate_env_keys({"FOO\nBAR": "v"})


def test_validate_env_keys_accepts_valid_posix_names():
    validate_env_keys({"FOO": "1", "_bar": "2", "BAZ_99": "3"})  # no raise


# ---- execute_code (via base64 heredoc) ----


@pytest.mark.asyncio
async def test_execute_code_runs_python(sandbox):
    result = await sandbox.execute_code("print(2 + 2)", "python3")
    assert result.exit_code == 0
    assert result.stdout == "4\n"


@pytest.mark.asyncio
async def test_execute_code_handles_double_quotes(sandbox):
    result = await sandbox.execute_code("print('hello \"world\"')", "python3")
    assert result.stdout == 'hello "world"\n'


@pytest.mark.asyncio
async def test_execute_code_handles_single_quotes(sandbox):
    result = await sandbox.execute_code('print("it\'s working")', "python3")
    assert result.stdout == "it's working\n"


@pytest.mark.asyncio
async def test_execute_code_passes_env_to_interpreter(sandbox):
    result = await sandbox.execute_code('import os; print(os.environ["FOO"])', "python3", env={"FOO": "from-env"})
    assert result.exit_code == 0
    assert result.stdout.strip() == "from-env"


@pytest.mark.asyncio
async def test_execute_code_passes_env_literally(sandbox):
    result = await sandbox.execute_code('import os; print(os.environ["FOO"])', "python3", env={"FOO": "$(whoami)"})
    assert result.exit_code == 0
    assert result.stdout.strip() == "$(whoami)"


@pytest.mark.asyncio
async def test_execute_code_handles_shell_metacharacters(sandbox):
    # Code containing shell metacharacters must reach the interpreter verbatim.
    result = await sandbox.execute_code("print('$(rm -rf /) `whoami` && || $HOME')", "python3")
    assert result.exit_code == 0
    assert result.stdout == "$(rm -rf /) `whoami` && || $HOME\n"


# ---- language validation (security) ----


@pytest.mark.asyncio
async def test_language_rejects_path_traversal(sandbox):
    with pytest.raises(ValueError, match="invalid characters"):
        await sandbox.execute_code("x", "../../../bin/sh")


@pytest.mark.asyncio
async def test_language_rejects_shell_metacharacters(sandbox):
    with pytest.raises(ValueError, match="invalid characters"):
        await sandbox.execute_code("x", "python;rm -rf /")


@pytest.mark.asyncio
async def test_language_rejects_spaces(sandbox):
    with pytest.raises(ValueError, match="invalid characters"):
        await sandbox.execute_code("x", "python -c")


@pytest.mark.asyncio
async def test_language_rejects_trailing_newline(sandbox):
    # Regression: Python's `$` matches before a trailing newline, unlike JS's
    # `/^...$/.test()`. The validator must use full-string matching so a
    # trailing newline (a shell statement separator) cannot smuggle a second
    # command past `LANGUAGE_PATTERN`.
    with pytest.raises(ValueError, match="invalid characters"):
        await sandbox.execute_code("x", "python3\n")
    with pytest.raises(ValueError, match="invalid characters"):
        await sandbox.execute_code("x", "python3\nrm -rf /")


@pytest.mark.asyncio
async def test_language_allows_valid_interpreters(sandbox):
    result = await sandbox.execute_code('print("safe")', "python3")
    assert result.exit_code == 0


@pytest.mark.asyncio
async def test_language_allows_dots_and_hyphens(sandbox):
    # Valid pattern, but the binary doesn't exist -> shell returns 127.
    result = await sandbox.execute_code("x", "fake-lang.99")
    assert result.exit_code == 127


# ---- read/write (via base64 encoding over shell) ----


@pytest.mark.asyncio
async def test_text_file_roundtrip(sandbox):
    await sandbox.write_text("test.txt", "hello shell")
    assert await sandbox.read_text("test.txt") == "hello shell"


@pytest.mark.asyncio
async def test_binary_file_roundtrip(sandbox):
    data = bytes([0, 1, 2, 127, 128, 254, 255])
    await sandbox.write_file("binary.bin", data)
    assert await sandbox.read_file("binary.bin") == data


@pytest.mark.asyncio
async def test_all_256_byte_values_roundtrip(sandbox):
    data = bytes(range(256))
    await sandbox.write_file("all-bytes.bin", data)
    assert await sandbox.read_file("all-bytes.bin") == data


@pytest.mark.asyncio
async def test_write_creates_parent_directories(sandbox):
    await sandbox.write_text("deep/nested/file.txt", "deep")
    assert await sandbox.read_text("deep/nested/file.txt") == "deep"


@pytest.mark.asyncio
async def test_handles_unicode_content(sandbox):
    content = "日本語 🚀 émojis"
    await sandbox.write_text("unicode.txt", content)
    assert await sandbox.read_text("unicode.txt") == content


@pytest.mark.asyncio
async def test_backslash_in_filename_is_literal(sandbox):
    # Contract: on POSIX, ``\`` in a path is a legal filename character, not a
    # separator. Containment logic in tools above the sandbox relies on this.
    await sandbox.write_text("weird\\name.txt", "ok")
    assert await sandbox.read_text("weird\\name.txt") == "ok"
    entries = await sandbox.list_files(".")
    assert any(entry.name == "weird\\name.txt" for entry in entries)


@pytest.mark.asyncio
async def test_handles_shell_metacharacters_in_content(sandbox):
    content = "$(rm -rf /) `whoami` && || $HOME"
    await sandbox.write_text("meta.txt", content)
    assert await sandbox.read_text("meta.txt") == content


@pytest.mark.asyncio
async def test_empty_content_roundtrip(sandbox):
    await sandbox.write_file("empty.txt", b"")
    assert await sandbox.read_file("empty.txt") == b""


@pytest.mark.asyncio
async def test_read_nonexistent_file_raises(sandbox):
    with pytest.raises(FileNotFoundError):
        await sandbox.read_file("nope.txt")


@pytest.mark.asyncio
async def test_read_file_invalid_base64_raises_oserror(sandbox, monkeypatch):
    # If the command exits 0 but stdout is not valid base64 (e.g. a shell
    # profile/locale warning prepended text), surface a clear OSError naming the
    # path instead of leaking a cryptic binascii.Error from deep in the stack.
    async def fake_execute(self, command, **kwargs):
        return ExecutionResult(exit_code=0, stdout="not%%valid base64!!", stderr="")

    monkeypatch.setattr(PosixShellSandbox, "execute", fake_execute, raising=True)
    with pytest.raises(OSError, match="Failed to decode base64 contents of file: weird.bin"):
        await sandbox.read_file("weird.bin")


# ---- remove ----


@pytest.mark.asyncio
async def test_remove_file(sandbox):
    await sandbox.write_text("delete-me.txt", "bye")
    await sandbox.remove_file("delete-me.txt")
    with pytest.raises(FileNotFoundError):
        await sandbox.read_file("delete-me.txt")


@pytest.mark.asyncio
async def test_remove_nonexistent_file_raises(sandbox):
    with pytest.raises(FileNotFoundError):
        await sandbox.remove_file("nope.txt")


# ---- list (via ls -1ap parsing) ----


@pytest.mark.asyncio
async def test_list_directory_contents(sandbox):
    await sandbox.write_text("a.txt", "a")
    await sandbox.write_text("b.txt", "b")
    names = [f.name for f in await sandbox.list_files(".")]
    assert "a.txt" in names
    assert "b.txt" in names


@pytest.mark.asyncio
async def test_list_identifies_directories(sandbox):
    await sandbox.execute("mkdir -p subdir")
    files = await sandbox.list_files(".")
    subdir = next((f for f in files if f.name == "subdir"), None)
    assert subdir is not None
    assert subdir.is_dir is True


@pytest.mark.asyncio
async def test_list_excludes_dot_entries(sandbox):
    await sandbox.write_text("file.txt", "")
    names = [f.name for f in await sandbox.list_files(".")]
    assert "." not in names
    assert ".." not in names


@pytest.mark.asyncio
async def test_list_nonexistent_directory_raises(sandbox):
    with pytest.raises(SandboxPathNotFoundError):
        await sandbox.list_files("/tmp/nonexistent-dir-xyz-12345")


@pytest.mark.asyncio
async def test_list_on_file_raises(sandbox):
    await sandbox.write_text("not-a-dir.txt", "hello")
    with pytest.raises(SandboxPathNotFoundError):
        await sandbox.list_files("not-a-dir.txt")


# ---- shell quoting (stdlib shlex.quote) ----
# We delegate shell-escaping to the stdlib `shlex.quote` (tenet #6: embrace
# common standards) instead of a hand-rolled quoter. These pin the security
# properties we rely on: command substitution and embedded quotes are neutralized.


def test_shlex_quote_neutralizes_command_substitution():
    assert shlex.quote("$(whoami)") == "'$(whoami)'"


def test_shlex_quote_escapes_embedded_single_quotes():
    # shlex closes the quote, inserts an escaped quote, and reopens: 'it'"'"'s'.
    # Shell-equivalent to the '\'' idiom; both render the literal string it's.
    assert shlex.quote("it's") == "'it'\"'\"'s'"


@pytest.mark.asyncio
async def test_paths_with_spaces(sandbox):
    await sandbox.execute('mkdir -p "with spaces"')
    await sandbox.write_text("with spaces/file.txt", "spaced")
    assert await sandbox.read_text("with spaces/file.txt") == "spaced"


@pytest.mark.asyncio
async def test_paths_with_single_quotes(sandbox):
    await sandbox.execute('mkdir -p "it\'s"')
    await sandbox.write_text("it's/file.txt", "quoted")
    assert await sandbox.read_text("it's/file.txt") == "quoted"


# ---- timeout ----


@pytest.mark.asyncio
async def test_timeout_kills_process(sandbox):
    loop = asyncio.get_event_loop()
    start = loop.time()
    with pytest.raises(TimeoutError, match="timed out"):
        await sandbox.execute("sleep 60", timeout=0.2)
    assert loop.time() - start < 5


@pytest.mark.asyncio
async def test_timeout_allows_fast_commands(sandbox):
    result = await sandbox.execute("echo fast", timeout=5)
    assert result.exit_code == 0
    assert result.stdout == "fast\n"


# ---- cancellation (Pythonic equivalent of AbortSignal) ----


@pytest.mark.asyncio
async def test_cancellation_kills_process(sandbox):
    task = asyncio.ensure_future(sandbox.execute("sleep 60"))
    await asyncio.sleep(0.1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


# ---- concurrent execution ----


@pytest.mark.asyncio
async def test_concurrent_commands(sandbox):
    results = await asyncio.gather(
        sandbox.execute("echo one"),
        sandbox.execute("echo two"),
        sandbox.execute("echo three"),
    )
    assert sorted(r.stdout.strip() for r in results) == ["one", "three", "two"]


@pytest.mark.asyncio
async def test_concurrent_file_writes(sandbox):
    await asyncio.gather(
        sandbox.write_text("a.txt", "aaa"),
        sandbox.write_text("b.txt", "bbb"),
        sandbox.write_text("c.txt", "ccc"),
    )
    a, b, c = await asyncio.gather(
        sandbox.read_text("a.txt"),
        sandbox.read_text("b.txt"),
        sandbox.read_text("c.txt"),
    )
    assert (a, b, c) == ("aaa", "bbb", "ccc")


# ---- streaming ----


@pytest.mark.asyncio
async def test_streaming_yields_chunks_then_result(sandbox):
    chunks = [chunk async for chunk in sandbox.execute_streaming("echo hello")]
    stream_chunks = [c for c in chunks if isinstance(c, StreamChunk)]
    results = [c for c in chunks if isinstance(c, ExecutionResult)]
    assert len(stream_chunks) > 0
    assert len(results) == 1


@pytest.mark.asyncio
async def test_stream_chunk_carries_stdout_type(sandbox):
    chunks = [chunk async for chunk in sandbox.execute_streaming("echo hi")]
    stdout_chunks = [c for c in chunks if isinstance(c, StreamChunk) and c.stream_type == "stdout"]
    assert any("hi" in c.data for c in stdout_chunks)


# ---- exit codes ----


@pytest.mark.asyncio
async def test_command_not_found_returns_127(sandbox):
    result = await sandbox.execute("nonexistent_binary_xyz_12345")
    assert result.exit_code == 127


@pytest.mark.asyncio
async def test_signal_termination_maps_to_128_plus_signal(sandbox):
    # sh -c 'kill -9 $$' sends SIGKILL (9) to itself -> 128 + 9 = 137.
    result = await sandbox.execute("kill -9 $$")
    assert result.exit_code == 137


@pytest.mark.asyncio
async def test_exit_codes_preserved(sandbox):
    for code in (0, 1, 2, 42, 255):
        result = await sandbox.execute(f"exit {code}")
        assert result.exit_code == code


# ---- convenience method wiring (base.Sandbox) ----


@pytest.mark.asyncio
async def test_execute_returns_first_execution_result():
    class _Fake(PosixShellSandbox):
        async def execute_streaming(self, command, **kwargs):
            yield StreamChunk(data="partial", stream_type="stdout")
            yield ExecutionResult(exit_code=0, stdout="done", stderr="")

    result = await _Fake().execute("noop")
    assert isinstance(result, ExecutionResult)
    assert result.stdout == "done"


@pytest.mark.asyncio
async def test_execute_raises_if_no_execution_result():
    class _Fake(PosixShellSandbox):
        async def execute_streaming(self, command, **kwargs):
            yield StreamChunk(data="only-chunk", stream_type="stdout")

    with pytest.raises(RuntimeError, match="did not yield an ExecutionResult"):
        await _Fake().execute("noop")


def test_file_info_defaults():
    info = FileInfo(name="x")
    assert info.is_dir is None
    assert info.size is None
