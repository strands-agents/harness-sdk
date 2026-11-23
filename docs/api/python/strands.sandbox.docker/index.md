Docker sandbox — executes commands in a Docker container via `docker exec`.

Mirrors `strands-ts/src/sandbox/docker.ts`.

## DockerSandbox

```python
class DockerSandbox(PosixShellSandbox)
```

Defined in: [src/strands/sandbox/docker.py:21](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/sandbox/docker.py#L21)

Execute commands in a Docker container via `docker exec`.

A thin :class:`PosixShellSandbox` backend: file and code operations are inherited (run as shell commands), and only :meth:`execute_streaming` is implemented, building the `docker exec` argv.

#### \_\_init\_\_

```python
def __init__(container: str,
             *,
             working_dir: str | None = None,
             user: str | None = None) -> None
```

Defined in: [src/strands/sandbox/docker.py:29](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/sandbox/docker.py#L29)

Initialize the Docker sandbox.

**Arguments**:

-   `container` - ID or name of a running Docker container.
-   `working_dir` - Working directory for executed commands. If `None`, no `-w` flag is set and commands run in the container’s configured working directory. The path must exist and be writable by the effective `user`.
-   `user` - User to run commands as, in `"uid"`, `"uid:gid"`, or `"name"` form. If `None`, no `--user` flag is set and commands run as the container’s configured user.

#### execute\_streaming

```python
async def execute_streaming(
        command: str,
        *,
        timeout: float | None = None,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        cancel_signal: threading.Event | None = None,
        **kwargs: Any) -> AsyncGenerator[StreamChunk | ExecutionResult, None]
```

Defined in: [src/strands/sandbox/docker.py:46](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/sandbox/docker.py#L46)

Execute a command in the container, streaming output.

**Arguments**:

-   `command` - The shell command to execute.
-   `timeout` - Maximum execution time in seconds. `None` means no timeout.
-   `cwd` - Working directory for this command, overriding `working_dir`.
-   `env` - Environment variables to set, passed as `docker exec -e` flags.
-   `cancel_signal` - Aborts the call when set by killing the local `docker exec` client. As with `timeout`, the command may keep running in the container.
-   `**kwargs` - Additional keyword arguments for forward compatibility.

**Yields**:

:class:`StreamChunk` objects for output, then a final :class:`ExecutionResult`.

**Raises**:

-   `ValueError` - If an environment variable name is invalid.
-   `SandboxTimeoutError` - If execution exceeds `timeout` seconds.
-   `SandboxAbortError` - If `cancel_signal` is set before the command exits.

#### get\_tools

```python
def get_tools() -> list[AgentTool]
```

Defined in: [src/strands/sandbox/docker.py:109](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/sandbox/docker.py#L109)

Default sandbox-compatible tools auto-registered with this sandbox.

**Returns**:

The tools bound to this sandbox, with descriptions naming this container.