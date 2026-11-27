"""Tests for :func:`~strands.sandbox.stream_process.stream_process`.

The shared process pump behind the Docker and SSH backends. Its timeout,
cancellation, and signal-to-exit-code handling diverge from the TypeScript
oracle (asyncio cancellation, wall-clock timeout, negative ``returncode``), so
it is exercised directly here. These tests spawn ``sh`` and require a POSIX
shell, so they are skipped on Windows.
"""

import asyncio
import os
import sys
import threading
import unittest.mock

import pytest

from strands.sandbox.errors import SandboxAbortError, SandboxTimeoutError
from strands.sandbox.stream_process import _stream_process
from strands.sandbox.types import ExecutionResult, StreamChunk

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="POSIX shell required")


async def _collect(gen) -> tuple[list[StreamChunk], ExecutionResult | None]:
    """Drain a stream_process generator into (stream_chunks, final_result)."""
    chunks: list[StreamChunk] = []
    result: ExecutionResult | None = None
    async for item in gen:
        if isinstance(item, ExecutionResult):
            result = item
        else:
            chunks.append(item)
    return chunks, result


@pytest.mark.asyncio
async def test_captures_stdout_stderr_and_exit_code():
    chunks, result = await _collect(_stream_process("sh", ["-c", "echo out; echo err >&2; exit 3"]))
    assert result == ExecutionResult(exit_code=3, stdout="out\n", stderr="err\n")
    # Output is also delivered incrementally as typed chunks.
    assert any(c.stream_type == "stdout" and "out" in c.data for c in chunks)
    assert any(c.stream_type == "stderr" and "err" in c.data for c in chunks)


@pytest.mark.asyncio
@pytest.mark.parametrize("code", [0, 1, 2, 42, 255])
async def test_exit_codes_preserved(code):
    _, result = await _collect(_stream_process("sh", ["-c", f"exit {code}"]))
    assert result.exit_code == code


@pytest.mark.asyncio
async def test_signal_termination_maps_to_128_plus_signal():
    # The shell kills itself with SIGKILL (9); Python reports returncode -9 -> 137.
    _, result = await _collect(_stream_process("sh", ["-c", "kill -9 $$"]))
    assert result.exit_code == 137


@pytest.mark.asyncio
async def test_timeout_is_wall_clock_even_with_steady_output():
    # A command that emits output continuously must still be killed at the deadline:
    # the timeout is measured from spawn, not reset per chunk.
    loop = asyncio.get_event_loop()
    start = loop.time()
    with pytest.raises(SandboxTimeoutError, match="timed out after 0.3 seconds"):
        await _collect(_stream_process("sh", ["-c", "while true; do echo x; sleep 0.02; done"], timeout=0.3))
    assert loop.time() - start < 3


@pytest.mark.asyncio
async def test_timeout_kills_child_processes_that_outlive_the_parent():
    # Regression: "sh -c 'echo hi; sleep 60'" spawns a child (sleep) that inherits the
    # pipe fds. If we only kill the parent sh, the child holds the write-end open, the
    # pipe readers never see EOF, and the generator hangs. The fix is to kill the whole
    # process group.
    loop = asyncio.get_event_loop()
    start = loop.time()
    with pytest.raises(SandboxTimeoutError, match="timed out after 0.5 seconds"):
        await _collect(_stream_process("sh", ["-c", "echo hi; sleep 60"], timeout=0.5))
    assert loop.time() - start < 3


@pytest.mark.asyncio
async def test_timeout_error_carries_output_captured_before_the_kill():
    with pytest.raises(SandboxTimeoutError) as exc_info:
        await _collect(_stream_process("sh", ["-c", "echo partial; echo warn >&2; sleep 5"], timeout=0.3))
    assert exc_info.value.stdout == "partial\n"
    assert exc_info.value.stderr == "warn\n"


@pytest.mark.asyncio
async def test_fast_command_completes_under_timeout():
    _, result = await _collect(_stream_process("sh", ["-c", "echo fast"], timeout=5))
    assert result.exit_code == 0
    assert result.stdout == "fast\n"


@pytest.mark.asyncio
async def test_enoent_with_message_returns_127():
    _, result = await _collect(
        _stream_process("definitely_not_a_real_binary_xyz", [], enoent_message="nope not installed")
    )
    assert result.exit_code == 127
    assert result.stderr == "nope not installed"


@pytest.mark.asyncio
async def test_enoent_without_message_propagates():
    with pytest.raises(FileNotFoundError):
        await _collect(_stream_process("definitely_not_a_real_binary_xyz", []))


@pytest.mark.asyncio
async def test_cancellation_kills_the_process():
    # Print the child PID, then cancel the consuming task and confirm the OS process is reaped.
    pid_box: dict[str, int] = {}

    async def consume() -> None:
        async for item in _stream_process("sh", ["-c", "echo $$; sleep 60"]):
            if isinstance(item, StreamChunk) and item.data.strip().isdigit():
                pid_box["pid"] = int(item.data.strip())

    task = asyncio.ensure_future(consume())
    while "pid" not in pid_box:
        await asyncio.sleep(0.02)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    # Give the finally-block kill a moment to land, then assert the PID is gone.
    for _ in range(50):
        try:
            os.kill(pid_box["pid"], 0)
        except ProcessLookupError:
            break
        await asyncio.sleep(0.02)
    else:
        pytest.fail("process survived cancellation")


async def _assert_child_was_killed(marker) -> None:
    """The backgrounded child touches ``marker`` after 0.5s unless it was killed first."""
    await asyncio.sleep(0.8)
    assert not marker.exists()


@pytest.mark.asyncio
# Without ``wait`` the shell exits at once and only the backgrounded child keeps the pipes open.
@pytest.mark.parametrize("tail", ["; wait", ""])
async def test_cancel_signal_kills_the_process_tree_and_raises_abort(tmp_path, tail):
    cancel_signal = threading.Event()
    marker = tmp_path / "ran"
    command = f"(sleep 0.5; touch {marker}) & echo started{tail}"

    with pytest.raises(SandboxAbortError, match="Execution aborted") as exc_info:
        async for _ in _stream_process("sh", ["-c", command], timeout=30, cancel_signal=cancel_signal):
            cancel_signal.set()

    assert (exc_info.value.stdout, exc_info.value.stderr) == ("started\n", "")
    await _assert_child_was_killed(marker)


@pytest.mark.asyncio
async def test_timeout_fires_when_only_a_backgrounded_child_is_left(tmp_path):
    marker = tmp_path / "ran"
    with pytest.raises(SandboxTimeoutError):
        await _collect(_stream_process("sh", ["-c", f"(sleep 0.5; touch {marker}) & echo started"], timeout=0.1))
    await _assert_child_was_killed(marker)


@pytest.mark.asyncio
async def test_closing_the_generator_kills_a_backgrounded_child(tmp_path):
    marker = tmp_path / "ran"
    gen = _stream_process("sh", ["-c", f"(sleep 0.5; touch {marker}) & echo started"])
    async for _ in gen:
        break
    await asyncio.sleep(0.2)  # let the shell itself exit, leaving only the child
    await gen.aclose()
    await _assert_child_was_killed(marker)


@pytest.mark.asyncio
async def test_cancel_signal_already_set_does_not_spawn():
    cancel_signal = threading.Event()
    cancel_signal.set()

    with unittest.mock.patch("asyncio.create_subprocess_exec", side_effect=AssertionError("spawned")):
        with pytest.raises(SandboxAbortError):
            await _collect(_stream_process("sh", ["-c", "echo hi"], cancel_signal=cancel_signal))


@pytest.mark.asyncio
async def test_unset_cancel_signal_leaves_the_result_alone():
    _, result = await _collect(_stream_process("sh", ["-c", "echo done"], cancel_signal=threading.Event()))
    assert result == ExecutionResult(exit_code=0, stdout="done\n", stderr="")


@pytest.mark.asyncio
async def test_timeout_still_raises_timeout_when_cancel_signal_is_unset():
    with pytest.raises(SandboxTimeoutError):
        await _collect(_stream_process("sh", ["-c", "sleep 60"], timeout=0.2, cancel_signal=threading.Event()))


@pytest.mark.asyncio
async def test_cwd_option_runs_the_child_there(tmp_path):
    _, result = await _collect(_stream_process("sh", ["-c", "pwd"], cwd=str(tmp_path)))
    assert result is not None and os.path.realpath(result.stdout.strip()) == os.path.realpath(str(tmp_path))


@pytest.mark.asyncio
async def test_env_option_replaces_the_environment():
    env = {"GREETING": "hi", "PATH": os.environ["PATH"]}
    _, result = await _collect(_stream_process("sh", ["-c", 'echo "$GREETING:$HOME"'], env=env))
    assert result is not None and result.stdout == "hi:\n"


@pytest.mark.asyncio
async def test_input_is_fed_to_stdin_and_closed():
    _, result = await _collect(_stream_process("cat", [], input="hello from stdin"))
    assert result == ExecutionResult(exit_code=0, stdout="hello from stdin", stderr="")


@pytest.mark.asyncio
async def test_input_to_a_child_that_exits_early_does_not_hang_or_raise():
    _, result = await _collect(_stream_process("sh", ["-c", "exit 0"], timeout=5, input="x" * 1_000_000))
    assert result is not None and result.exit_code == 0
