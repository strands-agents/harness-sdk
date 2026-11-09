Base sandbox interface.

Defines the abstract :class:`Sandbox` class that all sandbox implementations must extend. The class provides six abstract operations (command execution, code execution, and file I/O) and convenience wrappers for common patterns.

Mirrors `strands-ts/src/sandbox/base.ts`. The streaming methods (:meth:`Sandbox.execute_streaming`, :meth:`Sandbox.execute_code_streaming`) are the abstract primitives; the non-streaming convenience methods (:meth:`Sandbox.execute`, :meth:`Sandbox.execute_code`) consume the stream and return the final :class:`ExecutionResult`.

Idiomatic divergences from the TypeScript oracle (see PR description):

-   TS’s `ExecuteOptions` *options object* (`timeout`, `cwd`, `signal`, `env`) becomes Python keyword arguments (`timeout`, `cwd`, `env`), matching how the rest of `strands-py` models call options.
-   TS’s `AbortSignal` cancellation maps to asyncio task cancellation — the Pythonic way to cancel an in-flight coroutine/generator — rather than an explicit signal parameter.
-   TS’s discriminated union (`type: 'streamChunk' | 'executionResult'`) is discriminated in Python with `isinstance` checks on the dataclasses.

## Sandbox

```python
class Sandbox(ABC)
```

Defined in: [src/strands/sandbox/base.py:36](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/sandbox/base.py#L36)

Abstract execution environment.

A Sandbox provides the runtime context where tools execute code, run commands, and interact with a filesystem. Multiple tools share the same Sandbox instance, giving them a common working directory and filesystem.

Streaming methods (:meth:`execute_streaming`, :meth:`execute_code_streaming`) are the abstract primitives. Non-streaming convenience methods (:meth:`execute`, :meth:`execute_code`) consume the stream and return the final result.

All abstract methods accept `**kwargs` for forward compatibility — new parameters with defaults can be added in future versions without breaking existing implementations.

**Example**:

Non-streaming (common case)::

result = await sandbox.execute(“echo hello”) print(result.stdout)

Streaming with stdout/stderr distinction::

async for chunk in sandbox.execute\_streaming(“echo hello”): if isinstance(chunk, StreamChunk): print(f”\[{chunk.stream\_type}\] {chunk.data}”, end="") elif isinstance(chunk, ExecutionResult): print(f”Exit code: {chunk.exit\_code}”)

#### execute\_streaming

```python
@abstractmethod
async def execute_streaming(
        command: str,
        *,
        timeout: float | None = None,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        **kwargs: Any) -> AsyncGenerator[StreamChunk | ExecutionResult, None]
```

Defined in: [src/strands/sandbox/base.py:70](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/sandbox/base.py#L70)

Execute a shell command, streaming output.

Yields :class:`StreamChunk` objects for stdout and stderr as output arrives. The final yield is an :class:`ExecutionResult` with the exit code and complete output.

**Arguments**:

-   `command` - The shell command to execute.
-   `timeout` - Maximum execution time in seconds. `None` means no timeout.
-   `cwd` - Working directory for execution. `None` means use the sandbox default.
-   `env` - Environment variables to set for this command. Built-in sandboxes always apply these, though the mechanism differs; custom implementations must handle `env` explicitly or it has no effect.
-   `**kwargs` - Additional keyword arguments for forward compatibility.

**Yields**:

:class:`StreamChunk` objects for output, then a final :class:`ExecutionResult`.

#### execute\_code\_streaming

```python
@abstractmethod
async def execute_code_streaming(
        code: str,
        language: str,
        *,
        timeout: float | None = None,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        **kwargs: Any) -> AsyncGenerator[StreamChunk | ExecutionResult, None]
```

Defined in: [src/strands/sandbox/base.py:106](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/sandbox/base.py#L106)

Execute source code via a language interpreter, streaming output.

**Arguments**:

-   `code` - The source code to execute.
-   `language` - The interpreter to use (e.g., `"python3"`, `"node"`).
-   `timeout` - Maximum execution time in seconds. `None` means no timeout.
-   `cwd` - Working directory for execution. `None` means use the sandbox default.
-   `env` - Environment variables to set for this execution.
-   `**kwargs` - Additional keyword arguments for forward compatibility.

**Yields**:

:class:`StreamChunk` objects for output, then a final :class:`ExecutionResult`.

#### read\_file

```python
@abstractmethod
async def read_file(path: str, **kwargs: Any) -> bytes
```

Defined in: [src/strands/sandbox/base.py:135](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/sandbox/base.py#L135)

Read a file from the sandbox filesystem as raw bytes.

Returns `bytes` to support both text and binary files. Use :meth:`read_text` for a convenience wrapper that decodes to a string.

**Arguments**:

-   `path` - Path to the file to read.
-   `**kwargs` - Additional keyword arguments for forward compatibility.

**Returns**:

The file contents as raw bytes.

**Raises**:

-   `FileNotFoundError` - If the file does not exist.
-   `IsADirectoryError` - If `path` is a directory.
-   `PermissionError` - If the file is not accessible.
-   `OSError` - If the file cannot be read for another reason.

#### write\_file

```python
@abstractmethod
async def write_file(path: str, content: bytes, **kwargs: Any) -> None
```

Defined in: [src/strands/sandbox/base.py:157](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/sandbox/base.py#L157)

Write raw bytes to a file in the sandbox filesystem.

Implementations should create parent directories if they do not exist. Use :meth:`write_text` for a convenience wrapper that encodes a string.

**Arguments**:

-   `path` - Path to the file to write.
-   `content` - The content to write.
-   `**kwargs` - Additional keyword arguments for forward compatibility.

**Raises**:

-   `OSError` - If the file cannot be written.

#### remove\_file

```python
@abstractmethod
async def remove_file(path: str, **kwargs: Any) -> None
```

Defined in: [src/strands/sandbox/base.py:174](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/sandbox/base.py#L174)

Remove a file from the sandbox filesystem.

**Arguments**:

-   `path` - Path to the file to remove.
-   `**kwargs` - Additional keyword arguments for forward compatibility.

**Raises**:

-   `FileNotFoundError` - If the file does not exist.

#### list\_files

```python
@abstractmethod
async def list_files(path: str, **kwargs: Any) -> list[FileInfo]
```

Defined in: [src/strands/sandbox/base.py:187](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/sandbox/base.py#L187)

List files in a sandbox directory.

Returns :class:`FileInfo` entries with name, `is_dir`, and `size` metadata. Fields `is_dir` and `size` may be `None` if the backend cannot determine them.

**Arguments**:

-   `path` - Path to the directory to list.
-   `**kwargs` - Additional keyword arguments for forward compatibility.

**Returns**:

A list of :class:`FileInfo` entries for the directory contents.

**Raises**:

-   `FileNotFoundError` - If the directory does not exist.

#### get\_tools

```python
def get_tools() -> list[AgentTool]
```

Defined in: [src/strands/sandbox/base.py:208](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/sandbox/base.py#L208)

Tools this sandbox vends to an agent.

Returned tools are registered when the agent initializes; a tool is skipped if the user already registered one with the same name. The base implementation vends nothing; concrete sandboxes override this.

**Returns**:

The tools to register, or an empty list.

#### execute

```python
async def execute(command: str,
                  *,
                  timeout: float | None = None,
                  cwd: str | None = None,
                  env: dict[str, str] | None = None,
                  **kwargs: Any) -> ExecutionResult
```

Defined in: [src/strands/sandbox/base.py:222](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/sandbox/base.py#L222)

Execute a shell command and return the result.

Consumes :meth:`execute_streaming` and returns the final :class:`ExecutionResult`. Use :meth:`execute_streaming` when you need to process output as it arrives.

**Arguments**:

-   `command` - The shell command to execute.
-   `timeout` - Maximum execution time in seconds. `None` means no timeout.
-   `cwd` - Working directory for execution. `None` means use the sandbox default.
-   `env` - Environment variables to set for this command.
-   `**kwargs` - Additional keyword arguments for forward compatibility.

**Returns**:

The execution result with exit code and output.

**Raises**:

-   `RuntimeError` - If `execute_streaming` did not yield an :class:`ExecutionResult`.

#### execute\_code

```python
async def execute_code(code: str,
                       language: str,
                       *,
                       timeout: float | None = None,
                       cwd: str | None = None,
                       env: dict[str, str] | None = None,
                       **kwargs: Any) -> ExecutionResult
```

Defined in: [src/strands/sandbox/base.py:257](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/sandbox/base.py#L257)

Execute source code and return the result.

Consumes :meth:`execute_code_streaming` and returns the final :class:`ExecutionResult`. Use :meth:`execute_code_streaming` when you need to process output as it arrives.

**Arguments**:

-   `code` - The source code to execute.
-   `language` - The interpreter to use.
-   `timeout` - Maximum execution time in seconds. `None` means no timeout.
-   `cwd` - Working directory for execution. `None` means use the sandbox default.
-   `env` - Environment variables to set for this execution.
-   `**kwargs` - Additional keyword arguments for forward compatibility.

**Returns**:

The execution result with exit code and output.

**Raises**:

-   `RuntimeError` - If `execute_code_streaming` did not yield an :class:`ExecutionResult`.

#### read\_text

```python
async def read_text(path: str, encoding: str = "utf-8", **kwargs: Any) -> str
```

Defined in: [src/strands/sandbox/base.py:296](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/sandbox/base.py#L296)

Read a text file from the sandbox filesystem.

Convenience wrapper over :meth:`read_file` that decodes bytes as UTF-8 (by default). For other encodings, call :meth:`read_file` and decode manually.

**Arguments**:

-   `path` - Path to the file to read.
-   `encoding` - Text encoding to use. Defaults to UTF-8.
-   `**kwargs` - Additional keyword arguments passed to :meth:`read_file`.

**Returns**:

The file contents decoded as a string.

#### write\_text

```python
async def write_text(path: str,
                     content: str,
                     encoding: str = "utf-8",
                     **kwargs: Any) -> None
```

Defined in: [src/strands/sandbox/base.py:313](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/sandbox/base.py#L313)

Write a text file to the sandbox filesystem.

Convenience wrapper over :meth:`write_file` that encodes a string as UTF-8 (by default). For other encodings, encode manually and call :meth:`write_file`.

**Arguments**:

-   `path` - Path to the file to write.
-   `content` - The text content to write.
-   `encoding` - Text encoding to use. Defaults to UTF-8.
-   `**kwargs` - Additional keyword arguments passed to :meth:`write_file`.