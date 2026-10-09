"""Tests for :class:`~strands.experimental.sandbox.StrandsShellSandbox`.

These run against the real ``strands_shell`` native extension (the ``strands-shell``
extra) and are skipped when it is not installed.
"""

import asyncio
import gc
import threading

import pytest

from strands.experimental.sandbox import StrandsShellSandbox
from strands.experimental.sandbox.strands_shell import STRANDS_SHELL_TOOL_DESCRIPTION
from strands.sandbox.errors import SandboxPathNotFoundError
from strands.sandbox.types import ExecutionResult, FileInfo, StreamChunk

strands_shell = pytest.importorskip("strands_shell")


@pytest.fixture
def host_dir(tmp_path):
    (tmp_path / "hello.txt").write_text("hello from host")
    return tmp_path


@pytest.fixture
def sandbox(host_dir) -> StrandsShellSandbox:
    return StrandsShellSandbox(binds=[strands_shell.Bind(str(host_dir), "/ws")], timeout=5)


# ---- execute ----


@pytest.mark.asyncio
async def test_execute_runs_a_command(sandbox):
    result = await sandbox.execute("echo hello")
    assert result == ExecutionResult(exit_code=0, stdout="hello\n", stderr="")


@pytest.mark.asyncio
async def test_execute_reports_nonzero_exit_and_stderr(sandbox):
    result = await sandbox.execute("echo oops >&2; exit 3")
    assert result.exit_code == 3
    assert result.stderr == "oops\n"


@pytest.mark.asyncio
async def test_execute_streaming_yields_chunks_then_result(sandbox):
    chunks = [chunk async for chunk in sandbox.execute_streaming("echo out; echo err >&2")]
    assert chunks == [
        StreamChunk(data="out\n", stream_type="stdout"),
        StreamChunk(data="err\n", stream_type="stderr"),
        ExecutionResult(exit_code=0, stdout="out\n", stderr="err\n"),
    ]


@pytest.mark.asyncio
async def test_execute_cwd_option_applies_to_that_call_only(sandbox):
    home = (await sandbox.execute("pwd")).stdout
    assert (await sandbox.execute("pwd", cwd="/ws")).stdout == "/ws\n"
    assert (await sandbox.execute("pwd")).stdout == home


@pytest.mark.asyncio
async def test_execute_cwd_option_restores_after_failure(sandbox):
    home = (await sandbox.execute("pwd")).stdout
    assert (await sandbox.execute("false", cwd="/ws")).exit_code == 1
    assert (await sandbox.execute("pwd")).stdout == home


@pytest.mark.asyncio
async def test_execute_env_option_applies_to_that_call_only(sandbox):
    await sandbox.execute("export KEEP=original")
    result = await sandbox.execute("echo $GREETING $KEEP", env={"GREETING": "hi 'there'", "KEEP": "override"})
    assert result.stdout == "hi 'there' override\n"
    assert (await sandbox.execute("echo GREETING=$GREETING KEEP=$KEEP")).stdout == "GREETING= KEEP=original\n"


@pytest.mark.asyncio
async def test_execute_rejects_invalid_env_key(sandbox):
    with pytest.raises(ValueError, match="Invalid environment variable name"):
        await sandbox.execute("true", env={"BAD-KEY": "x"})


@pytest.mark.asyncio
async def test_session_state_persists_between_calls(sandbox):
    await sandbox.execute("cd /ws; FOO=1; greet() { echo hello $1; }")
    result = await sandbox.execute("pwd; echo FOO=$FOO; greet world")
    assert result.stdout == "/ws\nFOO=1\nhello world\n"


@pytest.mark.asyncio
async def test_execute_heredoc_writes_file(sandbox):
    # Regression: a subshell wrapper around the command broke here-docs in strands-shell 0.3.3.
    result = await sandbox.execute("cat > /tmp/notes.txt << 'EOF'\nline one\nline two\nEOF")
    assert result.exit_code == 0
    assert await sandbox.read_text("/tmp/notes.txt") == "line one\nline two\n"


@pytest.mark.asyncio
async def test_execute_empty_command_succeeds(sandbox):
    assert (await sandbox.execute("")).exit_code == 0


@pytest.mark.asyncio
async def test_execute_timeout_is_reported_in_result():
    sandbox = StrandsShellSandbox(timeout=0.2)
    result = await sandbox.execute("sleep 2; echo done", timeout=60)
    assert result.exit_code != 0
    assert "timeout" in result.stderr
    assert result.stdout == ""


@pytest.mark.asyncio
async def test_execute_only_reaches_bound_host_paths(sandbox, host_dir):
    assert (await sandbox.execute("cat /ws/hello.txt")).stdout == "hello from host"
    assert (await sandbox.execute(f"cat {host_dir}/hello.txt")).exit_code != 0


# ---- execute_code ----


@pytest.mark.asyncio
async def test_execute_code_runs_lua(sandbox):
    result = await sandbox.execute_code("print(2 + 2)", "lua")
    assert result == ExecutionResult(exit_code=0, stdout="4\n", stderr="")


@pytest.mark.asyncio
async def test_execute_code_removes_script_file(sandbox):
    before = await sandbox.list_files("/tmp")
    await sandbox.execute_code("print('x')", "lua")
    assert await sandbox.list_files("/tmp") == before


@pytest.mark.asyncio
async def test_execute_code_rejects_invalid_language(sandbox):
    with pytest.raises(ValueError, match="invalid characters"):
        await sandbox.execute_code("print(1)", "lua; rm -rf /")


# ---- file operations ----


@pytest.mark.asyncio
async def test_read_file_from_bind(sandbox):
    assert await sandbox.read_file("/ws/hello.txt") == b"hello from host"


@pytest.mark.asyncio
async def test_write_file_round_trips_through_bind(sandbox, host_dir):
    await sandbox.write_file("/ws/new.bin", b"\x00\x01binary")
    assert (host_dir / "new.bin").read_bytes() == b"\x00\x01binary"
    assert await sandbox.read_file("/ws/new.bin") == b"\x00\x01binary"


@pytest.mark.asyncio
async def test_remove_file(sandbox, host_dir):
    await sandbox.remove_file("/ws/hello.txt")
    assert not (host_dir / "hello.txt").exists()


@pytest.mark.asyncio
async def test_list_files_reports_metadata(sandbox):
    await sandbox.execute("mkdir /ws/sub")
    await sandbox.write_file("/ws/a.txt", b"")
    assert await sandbox.list_files("/ws") == [
        FileInfo(name="a.txt", is_dir=False, size=0),
        FileInfo(name="hello.txt", is_dir=False, size=15),
        FileInfo(name="sub", is_dir=True, size=None),
    ]


@pytest.mark.asyncio
async def test_read_missing_file_raises_file_not_found(sandbox):
    with pytest.raises(FileNotFoundError):
        await sandbox.read_file("/ws/nope.txt")


@pytest.mark.asyncio
async def test_remove_missing_file_raises_file_not_found(sandbox):
    with pytest.raises(FileNotFoundError):
        await sandbox.remove_file("/ws/nope.txt")


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["/ws", "/tmp"])
async def test_read_directory_raises_os_error(sandbox, path):
    with pytest.raises(OSError):
        await sandbox.read_file(path)


@pytest.mark.asyncio
async def test_write_to_readonly_bind_raises_os_error(host_dir):
    sandbox = StrandsShellSandbox(binds=[strands_shell.Bind(str(host_dir), "/ro", readonly=True)])
    with pytest.raises(OSError):
        await sandbox.write_file("/ro/x.txt", b"x")


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["/nope", "/ws/missing", "/ws/hello.txt", "/tmp/missing"])
async def test_list_files_missing_or_not_directory_raises_path_not_found(sandbox, path):
    await sandbox.write_file("/tmp/file", b"")
    with pytest.raises(SandboxPathNotFoundError):
        await sandbox.list_files(path)


# ---- threading ----


@pytest.mark.asyncio
async def test_usable_from_multiple_threads(sandbox):
    # Agent.__call__ runs the event loop on a worker thread; the pyo3 Shell is thread-bound.
    await sandbox.execute("echo main")
    results: list[ExecutionResult] = []
    thread = threading.Thread(target=lambda: results.append(asyncio.run(sandbox.execute("echo other"))))
    thread.start()
    thread.join()
    assert results[0].stdout == "other\n"


@pytest.mark.asyncio
async def test_concurrent_first_use_from_many_threads_starts_one_worker(sandbox):
    def workers() -> set[threading.Thread]:
        return {thread for thread in threading.enumerate() if thread.name == "strands-shell"}

    workers_before = workers()
    results: list[ExecutionResult] = []
    threads = [
        threading.Thread(target=lambda: results.append(asyncio.run(sandbox.execute("echo $$")))) for _ in range(8)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert len(results) == 8
    assert len(workers() - workers_before) == 1


@pytest.mark.asyncio
async def test_shell_construction_failure_raises_on_every_call():
    sandbox = StrandsShellSandbox(binds=[strands_shell.Bind("/definitely/not/here", "/ws")])
    for _ in range(2):
        with pytest.raises(RuntimeError, match="not found"):
            await sandbox.execute("echo hi")


@pytest.mark.asyncio
async def test_cancelled_call_does_not_break_the_sandbox():
    sandbox = StrandsShellSandbox(timeout=5)
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(sandbox.execute("sleep 1"), timeout=0.1)
    assert (await sandbox.execute("echo again")).stdout == "again\n"


@pytest.mark.asyncio
async def test_worker_thread_exits_when_sandbox_is_collected():
    sandbox = StrandsShellSandbox()
    # Drain the generator fully; a suspended one would hold a reference to the sandbox.
    assert [chunk async for chunk in sandbox.execute_streaming("true")]
    worker = sandbox._worker
    del sandbox
    gc.collect()
    worker.join(timeout=5)
    assert not worker.is_alive()


# ---- missing extra ----


def test_import_error_when_extra_missing(monkeypatch):
    monkeypatch.setitem(__import__("sys").modules, "strands_shell", None)
    with pytest.raises(ImportError, match="strands-shell"):
        StrandsShellSandbox()


# ---- tools ----


def test_get_tools_vends_sandbox_tools(sandbox, host_dir):
    tools = {tool.tool_name: tool for tool in sandbox.get_tools()}
    assert set(tools) == {"sandbox_file_editor", "sandbox_shell"}
    description = tools["sandbox_shell"].tool_spec["description"]
    assert description.startswith(STRANDS_SHELL_TOOL_DESCRIPTION)
    assert f"{host_dir} -> /ws" in description
