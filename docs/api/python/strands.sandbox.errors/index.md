Error types raised by sandbox execution and file operations.

Mirrors `strands-ts/src/sandbox/errors.ts`. Each error subclasses its stdlib equivalent so existing `except TimeoutError` / `except FileNotFoundError` handlers keep working, while giving callers a sandbox-specific type to branch on.

## SandboxTimeoutError

```python
class SandboxTimeoutError(TimeoutError)
```

Defined in: [src/strands/sandbox/errors.py:9](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/sandbox/errors.py#L9)

Raised by sandbox execution when the configured `timeout` elapses.

`stdout` and `stderr` hold whatever the process wrote before it was killed.

#### \_\_init\_\_

```python
def __init__(seconds: float | None,
             stdout: str = "",
             stderr: str = "") -> None
```

Defined in: [src/strands/sandbox/errors.py:15](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/sandbox/errors.py#L15)

Initialize the error with the timeout duration and the output captured so far.

**Arguments**:

-   `seconds` - The timeout duration, in seconds, that elapsed.
-   `stdout` - Standard output captured before the kill.
-   `stderr` - Standard error captured before the kill.

## SandboxPathNotFoundError

```python
class SandboxPathNotFoundError(FileNotFoundError)
```

Defined in: [src/strands/sandbox/errors.py:28](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/sandbox/errors.py#L28)

Raised by `list_files` and `read_file` when the path does not exist.

Distinguishes genuine absence (a missing path, or a file where a directory was expected) from permission or transport failures, which raise :class:`PermissionError` or plain :class:`OSError`.

#### \_\_init\_\_

```python
def __init__(path: str) -> None
```

Defined in: [src/strands/sandbox/errors.py:36](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/sandbox/errors.py#L36)

Initialize the error with the missing path.

**Arguments**:

-   `path` - The path that does not exist.