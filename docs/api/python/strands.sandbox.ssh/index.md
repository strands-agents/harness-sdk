SSH sandbox — executes commands on a remote host via OpenSSH.

Mirrors `strands-ts/src/sandbox/ssh.ts`.

## SshSandbox

```python
class SshSandbox(PosixShellSandbox)
```

Defined in: [src/strands/sandbox/ssh.py:68](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/sandbox/ssh.py#L68)

Execute commands on a remote host via SSH.

A thin :class:`PosixShellSandbox` backend: file and code operations are inherited (run as shell commands), and only :meth:`execute_streaming` is implemented, building the `ssh` argv.

Stateless — each :meth:`execute_streaming` call spawns a fresh `ssh` process. All sessions use `BatchMode=yes`, so interactive prompts are disabled and authentication must be key-based.

#### \_\_init\_\_

```python
def __init__(host: str,
             *,
             working_dir: str,
             identity_file: str | None = None,
             port: int = 22,
             ssh_options: list[str] | None = None,
             allow_unknown_hosts: bool = False,
             allow_unsafe_ssh_options: bool = False) -> None
```

Defined in: [src/strands/sandbox/ssh.py:80](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/sandbox/ssh.py#L80)

Initialize the SSH sandbox.

**Arguments**:

-   `host` - SSH destination (e.g. `"user@host"`, `"192.168.1.10"`).
-   `working_dir` - Working directory on the remote host.
-   `identity_file` - Path to an SSH private key file.
-   `port` - SSH port. Defaults to 22.
-   `ssh_options` - Additional SSH options passed as `-o` flags.
-   `allow_unknown_hosts` - Allow connections to hosts with unknown or changed SSH keys. When `False` (default), uses `StrictHostKeyChecking=accept-new` (trust on first connect, reject if the key changes). When `True`, uses `StrictHostKeyChecking=no` (host key verification disabled).
-   `allow_unsafe_ssh_options` - Bypass the SSH option allowlist. When `False` (default), unknown options raise at construction. When `True`, all options pass through without validation.

**Raises**:

-   `ValueError` - If `ssh_options` contains an option not on the allowlist and `allow_unsafe_ssh_options` is `False`.

#### execute\_streaming

```python
async def execute_streaming(
        command: str,
        *,
        timeout: float | None = None,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        **kwargs: Any) -> AsyncGenerator[StreamChunk | ExecutionResult, None]
```

Defined in: [src/strands/sandbox/ssh.py:127](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/sandbox/ssh.py#L127)

Execute a command on the remote host, streaming output.

**Arguments**:

-   `command` - The shell command to execute.
-   `timeout` - Maximum execution time in seconds. `None` means no timeout.
-   `cwd` - Working directory for this command, overriding `working_dir`.
-   `env` - Environment variables to set, applied via a shell `export` prefix.
-   `**kwargs` - Additional keyword arguments for forward compatibility.

**Yields**:

:class:`StreamChunk` objects for output, then a final :class:`ExecutionResult`.

**Raises**:

-   `ValueError` - If an environment variable name is invalid.
-   `SandboxTimeoutError` - If execution exceeds `timeout` seconds.

#### get\_tools

```python
def get_tools() -> list[AgentTool]
```

Defined in: [src/strands/sandbox/ssh.py:183](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/sandbox/ssh.py#L183)

Default sandbox-compatible tools auto-registered with this sandbox.

**Returns**:

The tools bound to this sandbox, with descriptions naming the remote host.