Sandbox-routed write tool.

Creates or overwrites a text file through a :class:`~strands.sandbox.base.Sandbox`: either one bound at creation (as the built-in Docker/SSH sandboxes do when vending tools) or the agent’s configured sandbox read from `tool_context.agent.sandbox` at call time.

Pairs with the companion `read` and `edit` vended tools.

#### make\_write

```python
def make_write(
        *,
        sandbox: Sandbox | None = None,
        name: str = "write",
        description: str = DEFAULT_WRITE_DESCRIPTION) -> DecoratedFunctionTool
```

Defined in: [src/strands/vended\_tools/write/write.py:28](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_tools/write/write.py#L28)

Create a sandbox-routed write tool.

If a `sandbox` is passed, it is bound at creation time. Otherwise the tool reads the sandbox from `tool_context.agent.sandbox` at call time. Used by sandbox implementations in :meth:`~strands.sandbox.base.Sandbox.get_tools` and by users who want a customized write tool.

**Arguments**:

-   `sandbox` - Sandbox to bind at creation. When `None`, the agent’s configured sandbox is used at call time.
-   `name` - Tool name. Defaults to `"write"`.
-   `description` - Tool description shown to the model.

**Returns**:

A decorated tool that writes files through the sandbox.

**Raises**:

-   `ValueError` - When `path` is not absolute or contains `..` segments (raised by the returned tool at call time).

#### write

Default sandbox-routed write tool. Reads the sandbox from the agent’s context at call time.