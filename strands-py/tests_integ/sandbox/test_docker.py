"""Integration tests for :class:`~strands.sandbox.DockerSandbox`.

Mirrors ``strands-ts/test/integ/sandbox/docker.test.node.ts``. These run real
``docker exec`` commands against a throwaway ``alpine`` container, so they are
skipped unless a working Docker daemon is reachable.
"""

import secrets
import subprocess
import sys
from collections.abc import Iterator

import pytest

from strands.sandbox.docker import DockerSandbox


def _docker_available() -> bool:
    if sys.platform == "win32":
        return False
    try:
        return subprocess.run(["docker", "info"], capture_output=True).returncode == 0
    except FileNotFoundError:
        return False


pytestmark = [
    pytest.mark.skipif(not _docker_available(), reason="Docker daemon not available"),
    pytest.mark.asyncio,
]

# Unique suffix so concurrent runs (CI matrix, or local + CI) don't collide on the name.
CONTAINER_NAME = f"strands-integ-docker-sandbox-{secrets.token_hex(3)}"


@pytest.fixture(scope="module")
def container() -> Iterator[str]:
    """Start a throwaway alpine container for the module, removing it afterward.

    alpine (busybox) is tiny and ships ``sh`` + ``base64``, which is all these
    tests need; ``execute_code`` runs via ``sh``.
    """
    subprocess.run(["docker", "rm", "-f", CONTAINER_NAME], capture_output=True)
    subprocess.run(
        ["docker", "run", "-d", "--name", CONTAINER_NAME, "alpine:latest", "tail", "-f", "/dev/null"],
        check=True,
        capture_output=True,
    )
    try:
        yield CONTAINER_NAME
    finally:
        subprocess.run(["docker", "rm", "-f", CONTAINER_NAME], capture_output=True)


async def test_runs_commands_capturing_stdout_stderr_and_exit_code(container):
    sandbox = DockerSandbox(container)

    result = await sandbox.execute("echo hello && echo err >&2")
    assert result.exit_code == 0
    assert result.stdout == "hello\n"
    assert result.stderr == "err\n"

    failed = await sandbox.execute("exit 42")
    assert failed.exit_code == 42


async def test_runs_code_via_execute_code(container):
    result = await DockerSandbox(container).execute_code("echo $((6 * 7))", "sh")
    assert result.exit_code == 0
    assert result.stdout == "42\n"


async def test_round_trips_text_and_binary_files(container):
    sandbox = DockerSandbox(container)

    await sandbox.write_text("greeting.txt", "hello docker")
    assert await sandbox.read_text("greeting.txt") == "hello docker"

    data = bytes([0, 1, 2, 127, 128, 254, 255])
    await sandbox.write_file("binary.bin", data)
    assert await sandbox.read_file("binary.bin") == data


async def test_lists_and_removes_files(container):
    sandbox = DockerSandbox(container)

    await sandbox.write_text("a.txt", "a")
    await sandbox.write_text("b.txt", "b")

    names = [f.name for f in await sandbox.list_files(".")]
    assert "a.txt" in names
    assert "b.txt" in names

    await sandbox.remove_file("a.txt")
    with pytest.raises(FileNotFoundError):
        await sandbox.read_file("a.txt")


async def test_respects_custom_working_dir(container):
    result = await DockerSandbox(container, working_dir="/opt").execute("pwd")
    assert result.stdout.strip() == "/opt"


async def test_respects_per_command_cwd_override(container):
    result = await DockerSandbox(container).execute("pwd", cwd="/usr")
    assert result.stdout.strip() == "/usr"


async def test_kills_command_on_timeout(container):
    with pytest.raises(TimeoutError, match="timed out"):
        await DockerSandbox(container).execute("sleep 60", timeout=0.5)


async def test_passes_env_vars_to_the_command(container):
    result = await DockerSandbox(container).execute("echo $MY_VAR", env={"MY_VAR": "hello-from-env"})
    assert result.stdout.strip() == "hello-from-env"


async def test_passes_env_values_with_metacharacters_literally(container):
    # '-e KEY=VALUE' is argv, not shell input, so Docker stores the value verbatim.
    # printenv reads it without a shell touching the value: any expansion here is a bug.
    value = "$(whoami) $HOME `id`"
    result = await DockerSandbox(container).execute("printenv MY_VAR", env={"MY_VAR": value})
    assert result.exit_code == 0
    assert result.stdout.strip() == value


async def test_returns_error_for_nonexistent_container():
    result = await DockerSandbox("nonexistent123").execute("echo hi")
    assert result.exit_code != 0
    assert "No such container" in result.stderr
