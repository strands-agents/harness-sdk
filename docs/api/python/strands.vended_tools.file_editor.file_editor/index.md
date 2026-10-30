Sandbox-routed file editor tool.

.. deprecated:: This tool is deprecated in favor of the focused `read`, `write`, and `edit` vended tools (see :mod:`strands.vended_tools.edit`). It will be removed in a future release.

Provides `view` (with line ranges), `create`, `str_replace`, and `insert` operations, all routed through a :class:`~strands.sandbox.base.Sandbox`: either one bound at creation (as the built-in Docker/SSH sandboxes do when vending tools) or the agent’s configured sandbox read from `tool_context.agent.sandbox` at call time.

#### make\_file\_editor

```python
@deprecated(
    "file_editor is deprecated and will be removed in a future release. "
    "Use the focused edit vended tool instead (strands.vended_tools.edit), "
    "paired with the read and write tools.")
def make_file_editor(
    *,
    sandbox: Sandbox | None = None,
    name: str = "file_editor",
    description: str = DEFAULT_FILE_EDITOR_DESCRIPTION
) -> DecoratedFunctionTool
```

Defined in: [src/strands/vended\_tools/file\_editor/file\_editor.py:55](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_tools/file_editor/file_editor.py#L55)

Create a sandbox-routed file editor tool.

If a `sandbox` is passed, it is bound at creation time. Otherwise the tool reads the sandbox from `tool_context.agent.sandbox` at call time. Used by sandbox implementations in :meth:`~strands.sandbox.base.Sandbox.get_tools` and by users who want a customized file editor.

**Arguments**:

-   `sandbox` - Sandbox to bind at creation. When `None`, the agent’s configured sandbox is used at call time.
-   `name` - Tool name. Defaults to `"file_editor"`.
-   `description` - Tool description shown to the model.

**Returns**:

A decorated tool that performs file operations through the sandbox.