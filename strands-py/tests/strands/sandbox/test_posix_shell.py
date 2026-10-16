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
import contextlib
import http.server
import os
import re
import shlex
import shutil
import sys
import threading
import urllib.parse
from collections.abc import AsyncGenerator
from typing import Any

import pytest

from strands.sandbox import (
    ExecutionResult,
    FileInfo,
    PosixShellSandbox,
    StreamChunk,
)
from strands.sandbox.errors import SandboxHttpError, SandboxPathNotFoundError
from strands.sandbox.posix_shell import (
    _URL_MARKER,
    _parse_status_and_headers,
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


class _MockHttpSandbox:
    """Mock implementing execute + read_file + write_file for request() tests."""

    def __init__(
        self,
        *,
        stdout="https://example.com",
        stderr="",
        exit_code=0,
        headers=None,
        body=None,
        rc="0",
        err=f"{_URL_MARKER}https://example.com",
    ):
        self._result = ExecutionResult(exit_code=exit_code, stdout=stdout, stderr=stderr)
        default_headers = b"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\r\n"
        self._headers = default_headers if headers is None else headers
        self._body = b"<html><body>Hello</body></html>" if body is None else body
        self._rc = rc
        self._err = err
        self.commands: list[str] = []
        self.written: dict[str, bytes] = {}

    async def execute(self, command, **kwargs):
        self.commands.append(command)
        if command.startswith("rm "):
            return ExecutionResult(exit_code=0, stdout="", stderr="")
        return self._result

    async def read_file(self, path, **kwargs):
        if path.endswith(".headers"):
            return self._headers
        if path.endswith(".rc"):
            return self._rc.encode()
        if path.endswith(".err"):
            return self._err.encode()
        if "/tmp/strands-http-" in path:
            return self._body
        raise FileNotFoundError(path)

    async def write_file(self, path, content, **kwargs):
        self.written[path] = content


class TestRequest:
    """Command-shape and validation unit tests against a canned mock.

    The behavioral contract (status/headers/body/resolved_url, raise-vs-return)
    is proven against a real curl + HTTP server in :class:`TestRequestLive`;
    these only pin the curl invocation and the input validation that happens
    before any process runs.
    """

    @pytest.mark.asyncio
    async def test_non_capped_curl_command_shape(self):
        sb = _MockHttpSandbox()
        await PosixShellSandbox.request(sb, "GET", "https://example.com", headers={"X-Key": "val"})
        cmd = sb.commands[0]
        # Hardened flags; no --fail (error statuses are reported, not raised).
        assert "curl -sSL -g " in cmd
        assert "--fail" not in cmd
        assert "--proto '=http,https' --proto-redir '=http,https'" in cmd
        assert "-D " in cmd and "-o " in cmd
        assert "-H 'X-Key: val'" in cmd
        # No cap → no download pipe.
        assert "head -c" not in cmd
        # curl omits the -o file for a bodyless 304, so it is pre-created.
        body_file = re.search(r"/tmp/strands-http-[0-9a-f]+\b", cmd).group(0)
        assert cmd.startswith(f": > {body_file} && ")
        assert f"-o {body_file}" in cmd
        assert sb.commands[-1].startswith("rm -f")  # temp files cleaned up

    @pytest.mark.asyncio
    async def test_capped_curl_command_shape(self):
        sb = _MockHttpSandbox()
        await PosixShellSandbox.request(sb, "GET", "https://example.com", max_bytes=1024, timeout=15)
        cmd = sb.commands[0]
        assert "--max-time 15" in cmd
        assert "--max-filesize" not in cmd  # unused: would miss chunked responses
        # Body piped through `head -c` (bounds the transfer); curl writes to
        # stdout, its exit code is captured, and the URL is tagged onto stderr.
        assert "-o -" in cmd
        assert "| head -c 1025 >" in cmd  # cap + 1 byte, so an overshoot is caught by length
        assert "echo $? >" in cmd
        assert f"%{{stderr}}{_URL_MARKER}%{{url_effective}}" in cmd

    @pytest.mark.asyncio
    async def test_body_written_to_file_not_command_line(self):
        sb = _MockHttpSandbox()
        await PosixShellSandbox.request(sb, "PUT", "https://example.com", body=b"\x00\x01\x02")
        data_path = next(p for p in sb.written if p.endswith(".data"))
        assert sb.written[data_path] == b"\x00\x01\x02"  # bytes sent as-is
        assert f"--data-binary @{shlex.quote(data_path)}" in sb.commands[0]
        # No body → no data file, no --data-binary.
        sb2 = _MockHttpSandbox()
        await PosixShellSandbox.request(sb2, "GET", "https://example.com")
        assert sb2.written == {}
        assert "--data-binary" not in sb2.commands[0]

    @pytest.mark.asyncio
    async def test_method_opt_lets_curl_infer_where_it_can(self):
        # -X POST + -L replays a bodiless POST through 302/303 redirects (curl
        # keeps the method but drops the body). Omit -X where curl infers it:
        # GET (default) and a body-carrying POST. HEAD uses --head, never -X.
        async def token(method, **kw):
            sb = _MockHttpSandbox()
            await PosixShellSandbox.request(sb, method, "https://example.com", **kw)
            return sb.commands[0]

        assert "-X" not in await token("GET")
        assert "-X" not in await token("POST", body="payload")
        assert "-X POST" in await token("POST")  # bodiless POST must stay a POST
        assert "-X PUT" in await token("PUT", body="payload")
        assert "-X DELETE" in await token("DELETE")
        head_cmd = await token("HEAD")
        assert "--head" in head_cmd and "-X" not in head_cmd and "-o /dev/null" in head_cmd
        assert "head -c" not in head_cmd  # HEAD is never capped
        assert not head_cmd.startswith(": >")  # /dev/null, no body file to pre-create

    @pytest.mark.asyncio
    async def test_method_is_normalized_and_validated(self):
        sb = _MockHttpSandbox()
        await PosixShellSandbox.request(sb, "  patch  ", "https://example.com")
        assert "-X PATCH" in sb.commands[0]
        for method in ["GET;rm -rf /", "GET POST", "", "G-E-T", "POST!"]:
            with pytest.raises(SandboxHttpError, match="method"):
                await PosixShellSandbox.request(_MockHttpSandbox(), method, "https://example.com")

    @pytest.mark.asyncio
    async def test_rejects_header_injection(self):
        # CRLF/NUL in a value, or a non-token name, must not reach the wire.
        for headers in [
            {"X-Evil": "val\r\nX-Injected: 1"},
            {"X-Evil": "val\x00"},
            {"Bad Name": "val"},
            {"X:Colon": "val"},
            {"": "val"},
        ]:
            with pytest.raises(SandboxHttpError, match="invalid header"):
                await PosixShellSandbox.request(_MockHttpSandbox(), "GET", "https://example.com", headers=headers)
        # An empty value is valid and uses curl's `name;` form (not `name:`,
        # which curl would drop).
        sb = _MockHttpSandbox()
        await PosixShellSandbox.request(sb, "GET", "https://example.com", headers={"X-Empty": ""})
        assert "-H 'X-Empty;'" in sb.commands[0]

    @pytest.mark.asyncio
    async def test_rejects_bad_urls(self):
        bad = [
            "https://example.com/path with spaces",  # RFC 3986 allowlist
            "https://example.com/café",
            "https://example.com/`id`",
            "https://example.com/path\nnewline",
            "",
            "ftp://example.com",  # non-http(s) scheme
            "file:///etc/passwd",
            "http://",  # no host
        ]
        for url in bad:
            with pytest.raises(SandboxHttpError):
                await PosixShellSandbox.request(_MockHttpSandbox(), "GET", url)

    @pytest.mark.asyncio
    async def test_capped_outcome_from_curl_exit_and_marker(self):
        # Overflow: head closes the pipe at the cap → curl exit 23.
        sb = _MockHttpSandbox(rc="23", err=f"{_URL_MARKER}https://example.com")
        with pytest.raises(SandboxHttpError, match="exceeded max_bytes"):
            await PosixShellSandbox.request(sb, "GET", "https://example.com", max_bytes=100)
        # Transport error: surfaced with the URL marker stripped from the message.
        sb = _MockHttpSandbox(rc="7", err=f"curl: (7) Failed to connect{_URL_MARKER}https://example.com")
        with pytest.raises(SandboxHttpError, match="Failed to connect") as exc:
            await PosixShellSandbox.request(sb, "GET", "https://example.com", max_bytes=1024)
        assert _URL_MARKER not in str(exc.value)
        # Success: resolved URL recovered from the stderr marker.
        sb = _MockHttpSandbox(rc="0", err=f"{_URL_MARKER}https://example.com/final")
        result = await PosixShellSandbox.request(sb, "GET", "https://example.com", max_bytes=1024)
        assert result.resolved_url == "https://example.com/final"

    @pytest.mark.asyncio
    async def test_cleanup_runs_on_failure(self):
        sb = _MockHttpSandbox(exit_code=1, stderr="fail")
        with pytest.raises(SandboxHttpError):
            await PosixShellSandbox.request(sb, "GET", "https://example.com")
        assert sb.commands[-1].startswith("rm -f")


class TestParseStatusAndHeaders:
    def test_basic_headers(self):
        raw = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nX-Custom: value\r\n\r\n"
        status, status_text, headers = _parse_status_and_headers(raw)
        assert status == 200
        assert status_text == "OK"
        assert headers == {"content-type": "text/html", "x-custom": "value"}

    def test_status_without_reason_phrase(self):
        # HTTP/2 responses have no reason phrase.
        status, status_text, headers = _parse_status_and_headers("HTTP/2 204\r\n\r\n")
        assert status == 204
        assert status_text == ""

    def test_multi_word_reason_phrase(self):
        status, status_text, _ = _parse_status_and_headers("HTTP/1.1 404 Not Found\r\n\r\n")
        assert status == 404
        assert status_text == "Not Found"

    def test_repeated_headers_are_preserved(self):
        raw = "HTTP/1.1 200 OK\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\n\r\n"
        _, _, headers = _parse_status_and_headers(raw)
        assert headers["set-cookie"] == "a=1\nb=2"

    def test_redirect_chain_uses_final_response_only(self):
        raw = (
            "HTTP/1.1 301 Moved\r\nContent-Type: text/html\r\n\r\n"
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n"
        )
        status, status_text, headers = _parse_status_and_headers(raw)
        assert status == 200
        assert status_text == "OK"
        assert headers["content-type"] == "application/json"

    def test_redirect_header_does_not_leak_when_final_omits_it(self):
        # 302 with Content-Type → 200 without Content-Type.
        # The final response has no Content-Type, so it must not appear.
        raw = (
            "HTTP/1.1 302 Found\r\nContent-Type: text/html\r\nLocation: /new\r\n\r\n"
            "HTTP/1.1 200 OK\r\nX-Request-Id: abc\r\n\r\n"
        )
        _, _, headers = _parse_status_and_headers(raw)
        assert "content-type" not in headers
        assert headers["x-request-id"] == "abc"

    def test_lowercases_keys_preserves_values(self):
        raw = "HTTP/1.1 200 OK\r\nContent-TYPE: Text/HTML; charset=UTF-8\r\n"
        _, _, headers = _parse_status_and_headers(raw)
        assert "content-type" in headers
        assert headers["content-type"] == "Text/HTML; charset=UTF-8"

    def test_colon_in_value(self):
        raw = "HTTP/1.1 200 OK\r\nLocation: https://example.com:8080/path\r\n"
        _, _, headers = _parse_status_and_headers(raw)
        assert headers["location"] == "https://example.com:8080/path"

    def test_empty_input(self):
        status, status_text, headers = _parse_status_and_headers("")
        assert status == 0
        assert status_text == ""
        assert headers == {}

    def test_lf_only(self):
        raw = "HTTP/1.1 200 OK\nContent-Type: text/html\n"
        status, _, headers = _parse_status_and_headers(raw)
        assert status == 200
        assert headers == {"content-type": "text/html"}


# ---- request() against a real HTTP server (end-to-end through sh + curl) ----
#
# The command-shape assertions above pin the curl invocation, but can't prove the
# contract (status/headers/body/resolved_url, raise-vs-return). These drive
# request() through _ShellTestSandbox (real `sh -c`) against a stdlib HTTP server,
# so an actual curl parses an actual response. Skipped if curl is missing.

_CURL_AVAILABLE = shutil.which("curl") is not None


class _RequestHandler(http.server.BaseHTTPRequestHandler):
    """Routes used by the live request() tests. See the ``do_*`` dispatch below."""

    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # noqa: D102 - silence per-request stderr logging
        pass

    def _handle(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        length = int(self.headers.get("content-length", 0))
        body = self.rfile.read(length) if length else b""

        if path == "/hello":
            payload = b"<html><body>Hello</body></html>"
            self.send_response(200)
            self.send_header("content-type", "text/html; charset=utf-8")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        elif path == "/echo":
            # Report what the server actually received, so the test can assert
            # the method and body survived (e.g. across a redirect).
            payload = f"{self.command}|{body.decode('utf-8', 'replace')}".encode()
            self.send_response(200)
            self.send_header("content-type", "text/plain")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        elif path == "/redirect-303":
            # A 303 forces curl to decide method handling on redirect.
            self.send_response(303)
            self.send_header("location", "/echo")
            self.send_header("content-length", "0")
            self.end_headers()
        elif path == "/set-cookie":
            self.send_response(200)
            self.send_header("set-cookie", "a=1")
            self.send_header("set-cookie", "b=2")
            self.send_header("content-length", "2")
            self.end_headers()
            self.wfile.write(b"ok")
        elif path == "/not-found":
            self.send_response(404)
            self.send_header("content-type", "text/plain")
            self.send_header("content-length", "3")
            self.end_headers()
            self.wfile.write(b"no!")
        elif path == "/not-modified":
            # 304 carries no body and no content-length; curl omits the -o file.
            self.send_response(304)
            self.end_headers()
        elif path == "/sized":
            # Fixed-size body with Content-Length: curl delivers it in one read
            # and exits 0, so an overshoot can't rely on curl's exit-23 fast path.
            n = int(urllib.parse.parse_qs(parsed.query).get("n", ["0"])[0])
            payload = b"A" * n
            self.send_response(200)
            self.send_header("content-type", "text/plain")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        elif path == "/big":
            # Chunked (no content-length) so --max-filesize can't pre-reject it.
            # curl closes the socket once head -c hits the cap; stop writing on
            # the resulting broken pipe instead of blocking the server thread.
            self.send_response(200)
            self.send_header("content-type", "application/octet-stream")
            self.end_headers()
            with contextlib.suppress(BrokenPipeError, ConnectionResetError):
                for _ in range(64):
                    self.wfile.write(b"x" * 1024)
                    self.wfile.flush()
        else:
            self.send_response(404)
            self.send_header("content-length", "0")
            self.end_headers()

    do_GET = _handle
    do_POST = _handle
    do_PUT = _handle
    do_DELETE = _handle
    do_HEAD = _handle


@pytest.fixture
def http_server():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _RequestHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        host, port = server.server_address
        yield f"http://{host}:{port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@pytest.mark.skipif(not _CURL_AVAILABLE, reason="curl not available")
class TestRequestLive:
    @pytest.mark.asyncio
    async def test_get_returns_status_headers_body(self, sandbox, http_server):
        result = await PosixShellSandbox.request(sandbox, "GET", f"{http_server}/hello")
        assert result.status == 200
        assert result.status_text == "OK"
        assert result.body == b"<html><body>Hello</body></html>"
        assert result.headers["content-type"] == "text/html; charset=utf-8"
        assert result.resolved_url == f"{http_server}/hello"

    @pytest.mark.asyncio
    async def test_post_body_reaches_server(self, sandbox, http_server):
        result = await PosixShellSandbox.request(sandbox, "POST", f"{http_server}/echo", body="payload")
        assert result.status == 200
        assert result.body == b"POST|payload"

    @pytest.mark.asyncio
    async def test_post_body_switches_to_get_on_303_redirect(self, sandbox, http_server):
        # Regression: `-X POST -L` replayed a bodiless POST; omitting -X lets curl
        # switch to GET on a 303 the way browsers/httpx do.
        result = await PosixShellSandbox.request(sandbox, "POST", f"{http_server}/redirect-303", body="payload")
        assert result.status == 200
        assert result.body == b"GET|"
        assert result.resolved_url == f"{http_server}/echo"

    @pytest.mark.asyncio
    async def test_error_status_is_returned_not_raised(self, sandbox, http_server):
        result = await PosixShellSandbox.request(sandbox, "GET", f"{http_server}/not-found")
        assert result.status == 404
        assert result.status_text == "Not Found"
        assert result.body == b"no!"

    @pytest.mark.asyncio
    async def test_repeated_response_headers_are_preserved(self, sandbox, http_server):
        result = await PosixShellSandbox.request(sandbox, "GET", f"{http_server}/set-cookie")
        assert result.headers["set-cookie"] == "a=1\nb=2"

    @pytest.mark.asyncio
    async def test_304_returns_empty_body_not_filenotfound(self, sandbox, http_server):
        # Regression: curl omits the -o file for a 304, which used to surface as
        # a bare FileNotFoundError on read-back.
        result = await PosixShellSandbox.request(sandbox, "GET", f"{http_server}/not-modified")
        assert result.status == 304
        assert result.body == b""

    @pytest.mark.asyncio
    async def test_max_bytes_bounds_chunked_download(self, sandbox, http_server):
        # A chunked response (no content-length) exceeding the cap must raise,
        # not silently truncate or buffer the whole 64 KiB; one within the cap
        # succeeds.
        with pytest.raises(SandboxHttpError, match="exceeded max_bytes"):
            await PosixShellSandbox.request(sandbox, "GET", f"{http_server}/big", max_bytes=100)
        result = await PosixShellSandbox.request(sandbox, "GET", f"{http_server}/hello", max_bytes=1_000_000)
        assert result.body == b"<html><body>Hello</body></html>"

    @pytest.mark.asyncio
    async def test_max_bytes_catches_small_overshoot_and_allows_exact(self, sandbox, http_server):
        # A body one byte over the cap (with Content-Length) arrives in curl's
        # first read, so curl exits 0 and the exit-23 fast path never fires — the
        # post-read length check must still raise. A body exactly at the cap is
        # not an overshoot and comes back intact.
        with pytest.raises(SandboxHttpError, match="exceeded max_bytes"):
            await PosixShellSandbox.request(sandbox, "GET", f"{http_server}/sized?n=101", max_bytes=100)
        result = await PosixShellSandbox.request(sandbox, "GET", f"{http_server}/sized?n=100", max_bytes=100)
        assert result.status == 200
        assert result.body == b"A" * 100

    @pytest.mark.asyncio
    async def test_crlf_header_value_is_rejected_before_the_wire(self, sandbox, http_server):
        with pytest.raises(SandboxHttpError, match="invalid header"):
            await PosixShellSandbox.request(
                sandbox, "GET", f"{http_server}/hello", headers={"X-Evil": "v\r\nX-Injected: 1"}
            )

    @pytest.mark.asyncio
    async def test_head_returns_headers_without_body(self, sandbox, http_server):
        result = await PosixShellSandbox.request(sandbox, "HEAD", f"{http_server}/hello")
        assert result.status == 200
        assert result.body == b""
        assert result.headers["content-type"] == "text/html; charset=utf-8"

    @pytest.mark.asyncio
    async def test_connection_refused_raises(self, sandbox):
        # Nothing is listening on this port → genuine transport failure.
        with pytest.raises(SandboxHttpError):
            await PosixShellSandbox.request(sandbox, "GET", "http://127.0.0.1:1/nope", timeout=5)
