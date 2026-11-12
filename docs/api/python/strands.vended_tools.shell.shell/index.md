Shell tool for executing commands through a sandbox.

Provides :func:`make_shell` (a factory for a stateless, sandbox-routed shell tool) and :data:`shell` (the default instance that reads the sandbox from the agent at call time). Each call runs in a fresh shell; state such as variables and the working directory does not persist across calls.

The command runs in whichever shell the sandbox provides — `sh` for the Docker and local environments, the remote login shell over SSH — so it must not rely on shell-specific syntax.

#### make\_shell

```python
def make_shell(
        *,
        sandbox: Sandbox | None = None,
        name: str = "shell",
        description: str = SANDBOX_SHELL_DESCRIPTION,
        default_timeout: int = _DEFAULT_TIMEOUT) -> DecoratedFunctionTool
```

Defined in: [src/strands/vended\_tools/shell/shell.py:31](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_tools/shell/shell.py#L31)

Create a stateless, sandbox-routed shell tool.

If a `sandbox` is passed, it is bound at creation time. Otherwise the tool reads the sandbox from `tool_context.agent.sandbox` at call time. Used by sandbox implementations in :meth:`~strands.sandbox.base.Sandbox.get_tools` and by users who want a customized shell tool.

**Arguments**:

-   `sandbox` - Sandbox to bind at creation. When `None`, the agent’s configured sandbox is used at call time.
-   `name` - Tool name. Defaults to `"shell"`.
-   `description` - Tool description shown to the model.
-   `default_timeout` - Timeout in seconds used when the model omits `timeout`. Becomes the schema default the model sees. Defaults to `120`.

**Returns**:

A decorated tool that executes shell commands through the sandbox.

**Raises**:

-   `ValueError` - If `default_timeout` is not a positive finite number.

#### shell

Default shell tool. Reads the sandbox from the agent’s context at call time.