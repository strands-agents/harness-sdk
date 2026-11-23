Host execution environment used as the default when no sandbox is configured.

:class:`NotASandboxLocalEnvironment` runs commands, code, and file operations directly on the host with **no isolation**. The deliberately blunt name (mirrored from `strands-ts/src/sandbox/not-a-sandbox-local-environment.ts`) is a warning: this is the fallback an :class:`~strands.agent.agent.Agent` uses when no sandbox is passed, not a security boundary.

Mirroring the TypeScript oracle, this extends :class:`~strands.sandbox.base.Sandbox` directly: file operations use **native** :mod:`pathlib`/:mod:`os` calls (avoiding a shell and reporting real `size` metadata), while command and code execution spawn a local `sh`.

## NotASandboxLocalEnvironment

```python
class NotASandboxLocalEnvironment(Sandbox)
```

Defined in: [src/strands/sandbox/not\_a\_sandbox\_local\_environment.py:66](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/sandbox/not_a_sandbox_local_environment.py#L66)

Run commands, code, and file operations on the host with no isolation.

Used as the default execution environment when an :class:`Agent` is created without a `sandbox`. Command and code execution spawn a local `sh`; file operations use the host filesystem directly.

.. warning:: This provides **no isolation**. Commands run with the full privileges of the host process. Pass an explicit sandbox (e.g. :class:`~strands.sandbox.docker.DockerSandbox`) when isolation matters.

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

Defined in: [src/strands/sandbox/not\_a\_sandbox\_local\_environment.py:84](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/sandbox/not_a_sandbox_local_environment.py#L84)

Execute a command on the host in its shell (`sh -c`; PowerShell on Windows), streaming output.

**Arguments**:

-   `command` - The shell command to execute.
-   `timeout` - Maximum execution time in seconds. `None` means no timeout.
-   `cwd` - Working directory for this command. Defaults to the process’s current working directory.
-   `env` - Environment variables to set on top of the host environment.
-   `cancel_signal` - Aborts the execution when set by killing the process.
-   `**kwargs` - Additional keyword arguments for forward compatibility.

**Yields**:

:class:`StreamChunk` objects for output, then a final :class:`ExecutionResult`.

**Raises**:

-   `ValueError` - If an environment variable name is invalid.
-   `SandboxTimeoutError` - If execution exceeds `timeout` seconds.
-   `SandboxAbortError` - If `cancel_signal` is set before the process exits.

#### execute\_code\_streaming

```python
async def execute_code_streaming(
        code: str,
        language: str,
        *,
        timeout: float | None = None,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        cancel_signal: threading.Event | None = None,
        **kwargs: Any) -> AsyncGenerator[StreamChunk | ExecutionResult, None]
```

Defined in: [src/strands/sandbox/not\_a\_sandbox\_local\_environment.py:138](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/sandbox/not_a_sandbox_local_environment.py#L138)

Execute code on the host by feeding it to a language interpreter on stdin.

On POSIX the code is base64-encoded and decoded inside a quoted heredoc, then piped to the interpreter (`base64 -d << 'EOF' | <lang>`), so arbitrary source — including shell metacharacters, quotes, and newlines — reaches the interpreter without injection risk. On Windows the interpreter is spawned directly with the code on stdin. `language` is validated against :data:`~strands.sandbox.constants.LANGUAGE_PATTERN` first.

**Arguments**:

-   `code` - The source code to execute.
-   `language` - The interpreter to use (e.g., `"python3"`, `"node"`).
-   `timeout` - Maximum execution time in seconds. `None` means no timeout.
-   `cwd` - Working directory for execution. Defaults to the process’s current working directory.
-   `env` - Environment variables to set on top of the host environment.
-   `cancel_signal` - Aborts the execution when set by killing the process.
-   `**kwargs` - Additional keyword arguments for forward compatibility.

**Yields**:

:class:`StreamChunk` objects for output, then a final :class:`ExecutionResult`.

**Raises**:

-   `ValueError` - If `language` contains invalid characters or an environment variable name is invalid.
-   `SandboxTimeoutError` - If execution exceeds `timeout` seconds.
-   `SandboxAbortError` - If `cancel_signal` is set before the process exits.

#### read\_file

```python
async def read_file(path: str, **kwargs: Any) -> bytes
```

Defined in: [src/strands/sandbox/not\_a\_sandbox\_local\_environment.py:203](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/sandbox/not_a_sandbox_local_environment.py#L203)

Read a file from the host filesystem as raw bytes.

**Arguments**:

-   `path` - Path to the file. Relative paths resolve against the current working directory.
-   `**kwargs` - Additional keyword arguments for forward compatibility.

**Returns**:

The file contents as raw bytes.

**Raises**:

-   `FileNotFoundError` - If the file does not exist.
-   `OSError` - If the file cannot be read.

#### write\_file

```python
async def write_file(path: str, content: bytes, **kwargs: Any) -> None
```

Defined in: [src/strands/sandbox/not\_a\_sandbox\_local\_environment.py:220](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/sandbox/not_a_sandbox_local_environment.py#L220)

Write raw bytes to a file on the host, creating parent directories.

**Arguments**:

-   `path` - Path to the file. Relative paths resolve against the current working directory.
-   `content` - The content to write.
-   `**kwargs` - Additional keyword arguments for forward compatibility.

**Raises**:

-   `OSError` - If the file cannot be written.

#### remove\_file

```python
async def remove_file(path: str, **kwargs: Any) -> None
```

Defined in: [src/strands/sandbox/not\_a\_sandbox\_local\_environment.py:236](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/sandbox/not_a_sandbox_local_environment.py#L236)

Remove a file from the host filesystem.

**Arguments**:

-   `path` - Path to the file. Relative paths resolve against the current working directory.
-   `**kwargs` - Additional keyword arguments for forward compatibility.

**Raises**:

-   `FileNotFoundError` - If the file does not exist.

#### list\_files

```python
async def list_files(path: str, **kwargs: Any) -> list[FileInfo]
```

Defined in: [src/strands/sandbox/not\_a\_sandbox\_local\_environment.py:249](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/sandbox/not_a_sandbox_local_environment.py#L249)

List directory contents from the host filesystem, sorted by name.

Unlike the shell-based base implementation, this reports native `is_dir` and `size` metadata. If an entry’s metadata cannot be read, it is still listed with `is_dir`/`size` left as `None`.

**Arguments**:

-   `path` - Path to the directory. Relative paths resolve against the current working directory.
-   `**kwargs` - Additional keyword arguments for forward compatibility.

**Returns**:

A list of :class:`FileInfo` entries for the directory contents.

**Raises**:

-   `SandboxPathNotFoundError` - If the directory does not exist or `path` is not a directory. Permission and other errors propagate so callers can surface them.