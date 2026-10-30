Sandbox-routed read tool.

Reads a file through a :class:`~strands.sandbox.base.Sandbox`: either one bound at creation via :func:`make_read` or the agent’s configured sandbox read from `tool_context.agent.sandbox` at call time. Text files return `cat -n` style numbered lines so the model can cite `path:line`; images (png/jpg/jpeg/gif/webp) and binary documents (pdf/doc/docx/xls/xlsx) return as media content blocks when `media` is on.

#### make\_read

```python
def make_read(
        *,
        media: bool = True,
        sandbox: Sandbox | None = None,
        name: str = "read",
        description: str | None = None,
        max_bytes: int = _READ_MAX_BYTES,
        max_media_bytes: int = _READ_MAX_MEDIA_BYTES) -> DecoratedFunctionTool
```

Defined in: [src/strands/vended\_tools/read/read.py:67](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_tools/read/read.py#L67)

Create a sandbox-routed `read` tool.

If a `sandbox` is passed, it is bound at creation time. Otherwise the tool reads the sandbox from `tool_context.agent.sandbox` at call time.

**Arguments**:

-   `media` - Return images and binary documents as viewable media. Set to `False` for a model that rejects media blocks, and `read` describes those files in text instead.
-   `sandbox` - Sandbox to bind at creation. When `None`, the agent’s configured sandbox is used at call time.
-   `name` - Tool name. Defaults to `"read"`.
-   `description` - Tool description shown to the model.
-   `max_bytes` - Maximum size of the returned text window. A 1MB default keeps a 1-line minified JSON file from exhausting the model’s context; raise it when the agent needs to read bigger single-line payloads.
-   `max_media_bytes` - Maximum byte size for image and document reads. Defaults to 10MB, above Anthropic’s 5MB image and Bedrock’s 4.5MB document limits.

**Returns**:

A decorated tool that reads files through the sandbox.

#### read

Default sandbox-routed `read` tool. Reads the sandbox from the agent’s context at call time.