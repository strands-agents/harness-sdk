"""Integration tests for :class:`~strands.sandbox.ssh.SshSandbox`.

These run real ``ssh`` commands against the shared ``ssh-ec2`` test instance,
reached through an SSM port-forward set up by the session-scoped
:func:`ssh_sandbox` fixture in conftest. The whole module is skipped when the
infrastructure isn't available.
"""

from collections.abc import Callable

import pytest

from strands.sandbox.ssh import SshSandbox
from strands.sandbox.types import StreamChunk

pytestmark = pytest.mark.asyncio


# ---------------------------------------------------------------------------
# Basic execution
# ---------------------------------------------------------------------------


async def test_captures_stdout_stderr_and_exit_code(ssh_sandbox: SshSandbox):
    result = await ssh_sandbox.execute("echo hello && echo err >&2")
    assert result.exit_code == 0
    assert result.stdout == "hello\n"
    assert result.stderr == "err\n"


async def test_returns_nonzero_exit_code(ssh_sandbox: SshSandbox):
    result = await ssh_sandbox.execute("exit 42")
    assert result.exit_code == 42


async def test_handles_empty_output(ssh_sandbox: SshSandbox):
    result = await ssh_sandbox.execute("true")
    assert result.exit_code == 0
    assert result.stdout == ""
    assert result.stderr == ""


# ---------------------------------------------------------------------------
# Streaming
# ---------------------------------------------------------------------------


async def test_execute_streaming_yields_chunks_then_result(ssh_sandbox: SshSandbox):
    chunks: list[StreamChunk] = []
    async for item in ssh_sandbox.execute_streaming("echo line1 && echo line2"):
        if isinstance(item, StreamChunk):
            chunks.append(item)
        else:
            # Final ExecutionResult
            assert item.exit_code == 0
    assert any("line1" in c.data for c in chunks)
    assert any("line2" in c.data for c in chunks)


async def test_streaming_separates_stdout_and_stderr(ssh_sandbox: SshSandbox):
    stdout_chunks: list[str] = []
    stderr_chunks: list[str] = []
    async for item in ssh_sandbox.execute_streaming("echo OUT && echo ERR >&2"):
        if isinstance(item, StreamChunk):
            if item.stream_type == "stdout":
                stdout_chunks.append(item.data)
            else:
                stderr_chunks.append(item.data)
    assert "OUT" in "".join(stdout_chunks)
    assert "ERR" in "".join(stderr_chunks)


# ---------------------------------------------------------------------------
# Code execution
# ---------------------------------------------------------------------------


async def test_execute_code(ssh_sandbox: SshSandbox):
    result = await ssh_sandbox.execute_code("echo $((6 * 7))", "sh")
    assert result.exit_code == 0
    assert result.stdout == "42\n"


async def test_execute_code_with_multiline_script(ssh_sandbox: SshSandbox):
    script = "x=hello\necho $x world"
    result = await ssh_sandbox.execute_code(script, "sh")
    assert result.exit_code == 0
    assert result.stdout == "hello world\n"


# ---------------------------------------------------------------------------
# File operations
# ---------------------------------------------------------------------------


async def test_round_trips_text_files(ssh_sandbox: SshSandbox):
    await ssh_sandbox.write_text("greeting.txt", "hello ssh")
    assert await ssh_sandbox.read_text("greeting.txt") == "hello ssh"


async def test_round_trips_binary_files(ssh_sandbox: SshSandbox):
    data = bytes(range(256))
    await ssh_sandbox.write_file("binary.bin", data)
    assert await ssh_sandbox.read_file("binary.bin") == data


async def test_lists_files(ssh_sandbox: SshSandbox):
    await ssh_sandbox.write_text("a.txt", "a")
    await ssh_sandbox.write_text("b.txt", "b")
    names = [f.name for f in await ssh_sandbox.list_files(".")]
    assert "a.txt" in names
    assert "b.txt" in names


async def test_removes_files(ssh_sandbox: SshSandbox):
    await ssh_sandbox.write_text("to_remove.txt", "bye")
    await ssh_sandbox.remove_file("to_remove.txt")
    with pytest.raises(FileNotFoundError):
        await ssh_sandbox.read_file("to_remove.txt")


# ---------------------------------------------------------------------------
# Working directory and cwd override
# ---------------------------------------------------------------------------


async def test_respects_working_dir(ssh_sandbox: SshSandbox):
    result = await ssh_sandbox.execute("pwd")
    assert result.stdout.strip() == ssh_sandbox.working_dir


async def test_respects_per_command_cwd_override(ssh_sandbox: SshSandbox):
    result = await ssh_sandbox.execute("pwd", cwd="/tmp")
    assert result.stdout.strip() == "/tmp"


# ---------------------------------------------------------------------------
# Environment variables
# ---------------------------------------------------------------------------


async def test_passes_env_vars(ssh_sandbox: SshSandbox):
    result = await ssh_sandbox.execute("echo $MY_VAR", env={"MY_VAR": "hello-from-env"})
    assert result.stdout.strip() == "hello-from-env"


async def test_env_values_with_shell_metacharacters_are_literal(ssh_sandbox: SshSandbox):
    value = "$(whoami) $HOME `id`"
    result = await ssh_sandbox.execute("printenv MY_VAR", env={"MY_VAR": value})
    assert result.exit_code == 0
    assert result.stdout.strip() == value


# ---------------------------------------------------------------------------
# Timeout
# ---------------------------------------------------------------------------


async def test_kills_command_on_timeout(ssh_sandbox: SshSandbox):
    with pytest.raises(TimeoutError, match="timed out"):
        await ssh_sandbox.execute("sleep 60", timeout=1.0)


# ---------------------------------------------------------------------------
# Statelessness (each command is a fresh SSH process)
# ---------------------------------------------------------------------------


async def test_stateless_between_commands(ssh_sandbox: SshSandbox):
    await ssh_sandbox.execute("export EPHEMERAL=1234")
    result = await ssh_sandbox.execute("echo ${EPHEMERAL:-unset}")
    assert result.stdout.strip() == "unset"


# ---------------------------------------------------------------------------
# get_tools()
# ---------------------------------------------------------------------------


async def test_get_tools_returns_sandbox_shell_and_file_editor(ssh_sandbox: SshSandbox):
    tools = ssh_sandbox.get_tools()
    names = {t.tool_name for t in tools}
    assert "sandbox_shell" in names
    assert "sandbox_file_editor" in names


async def test_get_tools_descriptions_reference_host(ssh_sandbox: SshSandbox):
    tools = ssh_sandbox.get_tools()
    for t in tools:
        spec = t.tool_spec
        assert ssh_sandbox.host in spec["description"]


# ---------------------------------------------------------------------------
# SSH options (passthrough, not the validation — that's unit-tested)
# ---------------------------------------------------------------------------


async def test_ssh_options_are_applied(ssh_sandbox_factory: Callable[..., SshSandbox]):
    """ServerAliveInterval is a safe option; verify it doesn't break the connection."""
    custom = ssh_sandbox_factory(ssh_options=["ServerAliveInterval=5"])
    result = await custom.execute("echo options_ok")
    assert result.exit_code == 0
    assert result.stdout.strip() == "options_ok"
