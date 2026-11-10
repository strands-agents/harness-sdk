"""Tests for :class:`~strands.sandbox.docker.DockerSandbox`.

Mirrors ``strands-ts/src/sandbox/__tests__/docker.test.node.ts``. These tests
assert the ``docker exec`` argv the sandbox builds; the process pump
(``_stream_process``) is mocked, so no Docker daemon is required.
"""

import unittest.mock

import pytest

from strands.sandbox.docker import DockerSandbox
from strands.sandbox.types import ExecutionResult
from strands.vended_tools.shell.types import SANDBOX_SHELL_DESCRIPTION


@pytest.fixture
def mock_stream_process(agenerator):
    """Patch ``_stream_process`` in the docker module, returning a no-op result.

    Yields the mock so tests can inspect the ``(program, args, kwargs)`` it was
    called with via ``mock.call_args``.
    """
    with unittest.mock.patch("strands.sandbox.docker._stream_process") as mock:
        mock.return_value = agenerator([ExecutionResult(exit_code=0, stdout="", stderr="")])
        yield mock


def _args(mock_stream_process) -> list[str]:
    """The argv passed to ``_stream_process`` (its second positional argument)."""
    return mock_stream_process.call_args.args[1]


@pytest.mark.asyncio
async def test_terminates_flags_with_double_dash(mock_stream_process):
    # A dash-prefixed container must be positional after '--', not parsed as a flag.
    await DockerSandbox("--privileged").execute("echo hi")
    assert _args(mock_stream_process)[-5:] == ["--", "--privileged", "sh", "-c", "echo hi"]


@pytest.mark.asyncio
async def test_omits_user_and_workdir_when_unset(mock_stream_process):
    await DockerSandbox("my-container").execute("echo hi")
    assert _args(mock_stream_process) == ["exec", "--", "my-container", "sh", "-c", "echo hi"]


@pytest.mark.asyncio
async def test_uses_custom_user_and_working_dir(mock_stream_process):
    await DockerSandbox("my-container", user="root", working_dir="/app").execute("ls")
    assert _args(mock_stream_process) == [
        "exec",
        "--user",
        "root",
        "-w",
        "/app",
        "--",
        "my-container",
        "sh",
        "-c",
        "ls",
    ]


@pytest.mark.asyncio
async def test_cwd_option_overrides_working_dir(mock_stream_process):
    await DockerSandbox("my-container", working_dir="/app").execute("pwd", cwd="/override")
    assert _args(mock_stream_process) == ["exec", "-w", "/override", "--", "my-container", "sh", "-c", "pwd"]


@pytest.mark.asyncio
async def test_passes_env_as_e_flags_before_container(mock_stream_process):
    await DockerSandbox("my-container").execute("echo $FOO", env={"FOO": "bar", "BAZ": "qux"})
    assert _args(mock_stream_process) == [
        "exec",
        "-e",
        "FOO=bar",
        "-e",
        "BAZ=qux",
        "--",
        "my-container",
        "sh",
        "-c",
        "echo $FOO",
    ]


@pytest.mark.asyncio
async def test_forwards_timeout_and_enoent_message(mock_stream_process):
    await DockerSandbox("my-container").execute("sleep 10", timeout=5)
    assert mock_stream_process.call_args.kwargs == {
        "timeout": 5,
        "enoent_message": "docker is not installed or not on PATH",
    }


@pytest.mark.asyncio
async def test_rejects_invalid_env_var_names(mock_stream_process):
    with pytest.raises(ValueError, match="Invalid environment variable name"):
        await DockerSandbox("my-container").execute("cmd", env={"FOO=bar BAZ": "val"})


def test_get_tools_vends_file_editor_and_shell():
    tools = DockerSandbox("my-container").get_tools()
    assert [t.tool_name for t in tools] == ["sandbox_file_editor", "sandbox_shell"]


def test_get_tools_shell_description_names_container():
    tools = DockerSandbox("my-container").get_tools()
    shell_tool = next(t for t in tools if t.tool_name == "sandbox_shell")
    assert SANDBOX_SHELL_DESCRIPTION in shell_tool.tool_spec["description"]
    assert "my-container" in shell_tool.tool_spec["description"]
