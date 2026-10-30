Sandbox-routed edit tool.

Replaces an exact, unique string in a text file through a :class:`~strands.sandbox.base.Sandbox`: either one bound at creation (as the built-in Docker/SSH sandboxes do when vending tools) or the agent’s configured sandbox read from `tool_context.agent.sandbox` at call time.

Pairs with the companion `read` and `write` vended tools.

#### make\_edit

```python
def make_edit(
        *,
        sandbox: Sandbox | None = None,
        name: str = "edit",
        description: str = DEFAULT_EDIT_DESCRIPTION) -> DecoratedFunctionTool
```

Defined in: [src/strands/vended\_tools/edit/edit.py:29](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_tools/edit/edit.py#L29)

Create a sandbox-routed edit tool.

If a `sandbox` is passed, it is bound at creation time. Otherwise the tool reads the sandbox from `tool_context.agent.sandbox` at call time. Used by sandbox implementations in :meth:`~strands.sandbox.base.Sandbox.get_tools` and by users who want a customized edit tool.

**Arguments**:

-   `sandbox` - Sandbox to bind at creation. When `None`, the agent’s configured sandbox is used at call time.
-   `name` - Tool name. Defaults to `"edit"`.
-   `description` - Tool description shown to the model.

**Returns**:

A decorated tool that performs the edit through the sandbox.

#### edit

Default sandbox-routed edit tool. Reads the sandbox from the agent’s context at call time.