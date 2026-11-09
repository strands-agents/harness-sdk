Shell sandbox with default implementations for file and code operations.

Subclasses only need to implement :meth:`PosixShellSandbox.execute_streaming` — all other operations are implemented by running shell commands through it. Use this for remote environments where only shell access is available (Docker containers, SSH connections, cloud runtimes).

Mirrors `strands-ts/src/sandbox/posix-shell.ts`.

#### validate\_env\_keys

```python
def validate_env_keys(env: dict[str, str]) -> None
```

Defined in: [src/strands/sandbox/posix\_shell.py:28](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/sandbox/posix_shell.py#L28)

Validate environment variable names against :data:`ENV_KEY_PATTERN`.

**Arguments**:

-   `env` - Mapping of environment variable names to values.

**Raises**:

-   `ValueError` - If any key is not a valid POSIX environment variable name.

#### build\_shell\_env\_prefix

```python
def build_shell_env_prefix(env: dict[str, str] | None = None) -> str
```

Defined in: [src/strands/sandbox/posix\_shell.py:42](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/sandbox/posix_shell.py#L42)

Build a shell `export KEY=VALUE && ...` prefix, or `""` when empty.

Keys are validated; values are escaped with :func:`shlex.quote`. Used by shell-string backends (e.g. SSH); backends that set env via native flags (e.g. Docker’s `-e`) call :func:`validate_env_keys` directly.

Uses `export` rather than an `env KEY=VALUE` command wrapper so the variables are set in the shell itself and inherited by every stage of a pipeline. `execute_code` runs `base64 ... | <lang>`, and an `env` wrapper would only bind the left side of the pipe, never reaching the interpreter. The trailing `&&` keeps the surrounding `cd ... && <prefix><command>` chain fail-fast.

**Arguments**:

-   `env` - Mapping of environment variable names to values.

**Returns**:

The shell `export ... &&` prefix, or an empty string when `env` is `None` or empty.

**Raises**:

-   `ValueError` - If any key is not a valid POSIX environment variable name.

## PosixShellSandbox

```python
class PosixShellSandbox(Sandbox, ABC)
```

Defined in: [src/strands/sandbox/posix\_shell.py:78](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/sandbox/posix_shell.py#L78)

Abstract sandbox that provides shell-based defaults for file and code operations.

Assumes a POSIX-compatible shell (sh/bash) on the target.

Subclasses only need to implement :meth:`execute_streaming`. The remaining operations — `execute_code_streaming`, `read_file`, `write_file`, `remove_file`, and `list_files` — are implemented via shell commands piped through :meth:`execute_streaming`.

Subclasses may override any method with a native implementation for better performance or to handle edge cases (e.g., binary-safe file transfer via Docker stdin pipes, or native API calls for cloud backends).

Subclasses are responsible for honoring the execution options in :meth:`execute_streaming`, or they have no effect:

-   `env` — backends that build a shell-command string prepend :func:`build_shell_env_prefix`; backends that set env via process flags (e.g. Docker’s `-e`) call :func:`validate_env_keys` and pass the values directly. An implementation that ignores `env` will silently drop the caller’s variables.
-   `timeout` — the base class does not enforce a timeout; a subclass that does not wire `timeout` into its process supervision will silently run without any time limit.
-   `cwd` — similarly must be applied by the subclass.

#### execute\_code\_streaming

```python
async def execute_code_streaming(
        code: str,
        language: str,
        *,
        timeout: float | None = None,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        **kwargs: Any) -> AsyncGenerator[StreamChunk | ExecutionResult, None]
```

Defined in: [src/strands/sandbox/posix\_shell.py:106](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/sandbox/posix_shell.py#L106)

Execute code by piping it to a language interpreter over the shell.

The code is base64-encoded and decoded inside a quoted heredoc on the target, then piped to the interpreter (`base64 -d << 'EOF' | <lang>`). This transports arbitrary source — including shell metacharacters, quotes, and newlines — without injection risk. The `language` is validated against :data:`LANGUAGE_PATTERN` first.

**Arguments**:

-   `code` - The source code to execute.
-   `language` - The interpreter to use (e.g., `"python3"`, `"node"`).
-   `timeout` - Maximum execution time in seconds. `None` means no timeout.
-   `cwd` - Working directory for execution.
-   `env` - Environment variables to set for this execution.
-   `**kwargs` - Additional keyword arguments for forward compatibility.

**Yields**:

:class:`StreamChunk` objects for output, then a final :class:`ExecutionResult`.

**Raises**:

-   `ValueError` - If `language` contains invalid characters.

#### read\_file

```python
async def read_file(path: str, **kwargs: Any) -> bytes
```

Defined in: [src/strands/sandbox/posix\_shell.py:147](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/sandbox/posix_shell.py#L147)

Read a file as raw bytes via base64 over the shell.

**Arguments**:

-   `path` - Path to the file to read.
-   `**kwargs` - Additional keyword arguments for forward compatibility.

**Returns**:

The file contents as raw bytes.

**Raises**:

-   `SandboxPathNotFoundError` - If the file does not exist.
-   `IsADirectoryError` - If `path` is a directory.
-   `PermissionError` - If the file or its parent directory is not accessible.
-   `OSError` - If the file cannot be read for another reason, or the command succeeds but its output is not valid base64 (e.g. a shell profile or locale warning prepended text to stdout).

#### write\_file

```python
async def write_file(path: str, content: bytes, **kwargs: Any) -> None
```

Defined in: [src/strands/sandbox/posix\_shell.py:188](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/sandbox/posix_shell.py#L188)

Write raw bytes to a file via base64 over the shell.

Parent directories are created via `mkdir -p`. The base64-encoded content is decoded inside a quoted heredoc on the target, preserving arbitrary binary content.

**Arguments**:

-   `path` - Path to the file to write.
-   `content` - The content to write.
-   `**kwargs` - Additional keyword arguments for forward compatibility.

**Raises**:

-   `OSError` - If the file cannot be written.

#### remove\_file

```python
async def remove_file(path: str, **kwargs: Any) -> None
```

Defined in: [src/strands/sandbox/posix\_shell.py:211](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/sandbox/posix_shell.py#L211)

Remove a file via `rm` over the shell.

**Arguments**:

-   `path` - Path to the file to remove.
-   `**kwargs` - Additional keyword arguments for forward compatibility.

**Raises**:

-   `FileNotFoundError` - If the file does not exist.

#### list\_files

```python
async def list_files(path: str, **kwargs: Any) -> list[FileInfo]
```

Defined in: [src/strands/sandbox/posix\_shell.py:225](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/sandbox/posix_shell.py#L225)

List directory contents via `ls -1ap` parsing.

**Arguments**:

-   `path` - Path to the directory to list.
-   `**kwargs` - Additional keyword arguments for forward compatibility.

**Returns**:

A list of :class:`FileInfo` entries (`size` is always `None` for this shell-based listing).

**Raises**:

-   `SandboxPathNotFoundError` - If the directory does not exist (or `path` is not a directory).
-   `OSError` - If the listing fails for another reason.