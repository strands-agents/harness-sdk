"""SSH sandbox -- executes commands on a remote host via OpenSSH.

Mirrors ``strands-ts/src/sandbox/ssh.ts``.
"""

import re
import shlex
from collections.abc import AsyncGenerator
from typing import Any

from ..types.tools import AgentTool
from ..vended_tools.edit import make_edit
from ..vended_tools.edit.edit import DEFAULT_EDIT_DESCRIPTION
from ..vended_tools.shell import make_shell
from ..vended_tools.shell.types import SANDBOX_SHELL_DESCRIPTION
from .posix_shell import PosixShellSandbox, build_shell_env_prefix
from .stream_process import _stream_process
from .types import ExecutionResult, StreamChunk

# Known-safe SSH options. Options that execute commands, tunnel traffic, or load
# external config are excluded. Reviewed and approved by AppSec.
# Full option reference: https://man.openbsd.org/ssh_config
_ALLOWED_SSH_OPTIONS = frozenset(
    {
        "addressfamily",
        "bindaddress",
        "bindinterface",
        "canonicaldomains",
        "canonicalizefallbacklocal",
        "canonicalizehostname",
        "canonicalizemaxdots",
        "canonicalizepermittedcnames",
        "checkhostip",
        "ciphers",
        "compression",
        "connectionattempts",
        "connecttimeout",
        "hostkeyalgorithms",
        "hostname",
        "identitiesonly",
        "ipqos",
        "kbdinteractiveauthentication",
        "kexalgorithms",
        "loglevel",
        "macs",
        "numberofpasswordprompts",
        "passwordauthentication",
        "port",
        "preferredauthentications",
        "pubkeyacceptedalgorithms",
        "pubkeyauthentication",
        "rekeylimit",
        "serveralivecountmax",
        "serveraliveinterval",
        "tcpkeepalive",
        "updatehostkeys",
        "user",
        "verifyhostkeydns",
    }
)

# Splits an SSH option on its first '=' or whitespace to isolate the option name,
# e.g. "ConnectTimeout=10" or 'Match exec "..."' -> the leading token.
_SSH_OPTION_NAME = re.compile(r"[=\s]")


class SshSandbox(PosixShellSandbox):
    """Execute commands on a remote host via SSH.

    A thin :class:`PosixShellSandbox` backend: file and code operations are
    inherited (run as shell commands), and only :meth:`execute_streaming` is
    implemented, building the ``ssh`` argv.

    Stateless -- each :meth:`execute_streaming` call spawns a fresh ``ssh``
    process. All sessions use ``BatchMode=yes``, so interactive prompts are
    disabled and authentication must be key-based.
    """

    def __init__(
        self,
        host: str,
        *,
        working_dir: str,
        identity_file: str | None = None,
        port: int = 22,
        ssh_options: list[str] | None = None,
        allow_unknown_hosts: bool = False,
        allow_unsafe_ssh_options: bool = False,
    ) -> None:
        """Initialize the SSH sandbox.

        Args:
            host: SSH destination (e.g. ``"user@host"``, ``"192.168.1.10"``).
            working_dir: Working directory on the remote host.
            identity_file: Path to an SSH private key file.
            port: SSH port. Defaults to 22.
            ssh_options: Additional SSH options passed as ``-o`` flags.
            allow_unknown_hosts: Allow connections to hosts with unknown or
                changed SSH keys. When ``False`` (default), uses
                ``StrictHostKeyChecking=accept-new`` (trust on first connect,
                reject if the key changes). When ``True``, uses
                ``StrictHostKeyChecking=no`` (host key verification disabled).
            allow_unsafe_ssh_options: Bypass the SSH option allowlist. When
                ``False`` (default), unknown options raise at construction. When
                ``True``, all options pass through without validation.

        Raises:
            ValueError: If ``ssh_options`` contains an option not on the
                allowlist and ``allow_unsafe_ssh_options`` is ``False``.
        """
        self.host = host
        self.working_dir = working_dir
        self._identity_file = identity_file
        self._port = port
        self._allow_unknown_hosts = allow_unknown_hosts
        self._ssh_options = ssh_options or []

        if not allow_unsafe_ssh_options:
            for opt in self._ssh_options:
                name = _SSH_OPTION_NAME.split(opt, maxsplit=1)[0]
                if name.lower() not in _ALLOWED_SSH_OPTIONS:
                    raise ValueError(
                        f'SSH option "{name}" is not allowed. Set allow_unsafe_ssh_options=True to bypass.'
                    )

    async def execute_streaming(
        self,
        command: str,
        *,
        timeout: float | None = None,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        **kwargs: Any,
    ) -> AsyncGenerator[StreamChunk | ExecutionResult, None]:
        """Execute a command on the remote host, streaming output.

        Args:
            command: The shell command to execute.
            timeout: Maximum execution time in seconds. ``None`` means no timeout.
            cwd: Working directory for this command, overriding ``working_dir``.
            env: Environment variables to set, applied via a shell ``export`` prefix.
            **kwargs: Additional keyword arguments for forward compatibility.

        Yields:
            :class:`StreamChunk` objects for output, then a final
            :class:`ExecutionResult`.

        Raises:
            ValueError: If an environment variable name is invalid.
            SandboxTimeoutError: If execution exceeds ``timeout`` seconds.
        """
        effective_cwd = cwd if cwd is not None else self.working_dir
        env_prefix = build_shell_env_prefix(env)
        remote_command = f"cd {shlex.quote(effective_cwd)} && {env_prefix}{command}"

        args = [
            "-o",
            f"StrictHostKeyChecking={'no' if self._allow_unknown_hosts else 'accept-new'}",
            "-o",
            "BatchMode=yes",
            "-p",
            str(self._port),
        ]

        if self._identity_file:
            args += ["-i", self._identity_file]

        for opt in self._ssh_options:
            args += ["-o", opt]

        # ssh requires the hostname and command after all flags. '--' terminates flag
        # parsing so the host is always treated as a positional argument; without it, a
        # host like '-oProxyCommand=evil' would be parsed as a flag, enabling arbitrary
        # command execution on the local machine.
        args += ["--", self.host, remote_command]

        async for chunk in _stream_process(
            "ssh", args, timeout=timeout, enoent_message="ssh is not installed or not on PATH"
        ):
            yield chunk

    def get_tools(self) -> list[AgentTool]:
        """Default sandbox-compatible tools auto-registered with this sandbox.

        Returns:
            The tools bound to this sandbox, with descriptions naming the remote host.
        """
        return [
            make_edit(
                sandbox=self,
                name="sandbox_edit",
                description=f'{DEFAULT_EDIT_DESCRIPTION} Files are on host "{self.host}".',
            ),
            make_shell(
                sandbox=self,
                name="sandbox_shell",
                description=(
                    f'{SANDBOX_SHELL_DESCRIPTION} Runs on host "{self.host}". Working directory: {self.working_dir}.'
                ),
            ),
        ]
