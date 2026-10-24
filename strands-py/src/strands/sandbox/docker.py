"""Docker sandbox -- executes commands in a Docker container via ``docker exec``.

Mirrors ``strands-ts/src/sandbox/docker.ts``.
"""

from collections.abc import AsyncGenerator
from typing import Any

from ..types.tools import AgentTool
from ..vended_tools.edit import make_edit
from ..vended_tools.edit.edit import DEFAULT_EDIT_DESCRIPTION
from ..vended_tools.shell import make_shell
from ..vended_tools.shell.types import SANDBOX_SHELL_DESCRIPTION
from .posix_shell import PosixShellSandbox, validate_env_keys
from .stream_process import _stream_process
from .types import ExecutionResult, StreamChunk


class DockerSandbox(PosixShellSandbox):
    """Execute commands in a Docker container via ``docker exec``.

    A thin :class:`PosixShellSandbox` backend: file and code operations are
    inherited (run as shell commands), and only :meth:`execute_streaming` is
    implemented, building the ``docker exec`` argv.
    """

    def __init__(self, container: str, *, working_dir: str | None = None, user: str | None = None) -> None:
        """Initialize the Docker sandbox.

        Args:
            container: ID or name of a running Docker container.
            working_dir: Working directory for executed commands. If ``None``, no
                ``-w`` flag is set and commands run in the container's configured
                working directory. The path must exist and be writable by the
                effective ``user``.
            user: User to run commands as, in ``"uid"``, ``"uid:gid"``, or
                ``"name"`` form. If ``None``, no ``--user`` flag is set and
                commands run as the container's configured user.
        """
        self.container = container
        self.working_dir = working_dir
        self._user = user

    async def execute_streaming(
        self,
        command: str,
        *,
        timeout: float | None = None,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        **kwargs: Any,
    ) -> AsyncGenerator[StreamChunk | ExecutionResult, None]:
        """Execute a command in the container, streaming output.

        Args:
            command: The shell command to execute.
            timeout: Maximum execution time in seconds. ``None`` means no timeout.
            cwd: Working directory for this command, overriding ``working_dir``.
            env: Environment variables to set, passed as ``docker exec -e`` flags.
            **kwargs: Additional keyword arguments for forward compatibility.

        Yields:
            :class:`StreamChunk` objects for output, then a final
            :class:`ExecutionResult`.

        Raises:
            ValueError: If an environment variable name is invalid.
            SandboxTimeoutError: If execution exceeds ``timeout`` seconds.
        """
        args = ["exec"]

        # An unset user/cwd defers to the container's own configuration.
        if self._user is not None:
            args += ["--user", self._user]

        effective_cwd = cwd if cwd is not None else self.working_dir
        if effective_cwd is not None:
            args += ["-w", effective_cwd]

        if env:
            validate_env_keys(env)
            for key, value in env.items():
                # Values are passed as process argv (not through a shell), so no escaping
                # is needed -- Docker stores them verbatim. This is why values are not
                # shell-quoted here, unlike the SSH backend which builds a shell string.
                args += ["-e", f"{key}={value}"]

        # docker exec requires the container and command after all flags. '--' terminates
        # flag parsing so the container is always treated as a positional argument; without
        # it, a name like '--privileged' would be parsed as a flag and override the options
        # above.
        args += ["--", self.container, "sh", "-c", command]

        async for chunk in _stream_process(
            "docker", args, timeout=timeout, enoent_message="docker is not installed or not on PATH"
        ):
            yield chunk

    def get_tools(self) -> list[AgentTool]:
        """Default sandbox-compatible tools auto-registered with this sandbox.

        Returns:
            The tools bound to this sandbox, with descriptions naming this container.
        """
        cwd = f" Working directory: {self.working_dir}." if self.working_dir else ""
        return [
            make_edit(
                sandbox=self,
                name="sandbox_edit",
                description=f'{DEFAULT_EDIT_DESCRIPTION} Files are in Docker container "{self.container}".',
            ),
            make_shell(
                sandbox=self,
                name="sandbox_shell",
                description=f'{SANDBOX_SHELL_DESCRIPTION} Runs in Docker container "{self.container}".{cwd}',
            ),
        ]
