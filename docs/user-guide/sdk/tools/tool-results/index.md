A tool returns a result that the agent adds to the conversation and sends back to the model. When a [custom tool](/docs/user-guide/sdk/tools/custom-tools/index.md) returns a plain value, the SDK wraps it in this structure automatically. Construct the structure yourself when a tool needs to return typed content, mixed content blocks, or an explicit error status. This page documents that structure, the content types it carries, and the conversion rules the SDK applies to return values.

## Tool Result Structure

(( tab "Python" ))
The [`ToolResult`](/docs/api/python/strands.types.tools#ToolResult) dictionary has three fields:

```python
{
    "toolUseId": str,       # ID of the tool use request. Matches the incoming request.
    "status": str,          # Either "success" or "error"
    "content": list[dict],  # Content items, each in one of the supported formats
}
```

The `toolUseId` is optional in a value returned from a decorated function: the [`@tool`](/docs/api/python/strands.tools.decorator#tool) decorator fills it in from the originating request.
(( /tab "Python" ))

(( tab "TypeScript" ))
The `ToolResultBlock` schema:

```typescript
{
  type: 'toolResultBlock'
  toolUseId: string
  status: 'success' | 'error'
  content: Array<ToolResultContent>
  error?: Error
}
```
(( /tab "TypeScript" ))

## Content Types

The `content` field is a list of content blocks. Each block carries one type of output:

-   `text`: a string of text output
-   `json`: any JSON-serializable data structure

Both SDKs also accept `image` and `document` blocks; TypeScript additionally accepts `video`. A single result can mix block types, for example a text summary alongside a JSON payload.

## Response Examples

(( tab "Python" ))
A success response carries a `"success"` status and one or more content blocks:

```python
{
    "toolUseId": "tool-123",
    "status": "success",
    "content": [
        {"text": "Operation completed successfully"},
        {"json": {"results": [1, 2, 3], "total": 3}}
    ]
}
```

An error response carries an `"error"` status and describes what failed:

```python
{
    "toolUseId": "tool-123",
    "status": "error",
    "content": [
        {"text": "Error: Unable to process request due to invalid parameters"}
    ]
}
```
(( /tab "Python" ))

(( tab "TypeScript" ))
A success response carries a `'success'` status and one or more content blocks:

```typescript
{
    "type": "toolResultBlock",
    "toolUseId": "tooluse_xq6vYsQ-QcGZOPcIx0yM3A",
    "status": "success",
    "content": [
        {
            "type": "jsonBlock",
            "json": {
                "result": "The letter 'r' appears 3 time(s) in 'strawberry'"
            }
        }
    ]
}
```

An error response carries an `'error'` status and an optional [`Error`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error):

```typescript
{
    "type": "toolResultBlock",
    "toolUseId": "tooluse_rFoPosVKQ7WfYRfw_min8Q",
    "status": "error",
    "content": [
        {
            "type": "textBlock",
            "text": "Error: Test error"
        }
    ],
    "error": Error
}
```
(( /tab "TypeScript" ))

## How Return Values Become Tool Results

(( tab "Python" ))
The [`@tool`](/docs/api/python/strands.tools.decorator#tool) decorator converts a function’s return value into a [`ToolResult`](/docs/api/python/strands.types.tools#ToolResult):

1.  A string or other simple value is wrapped as `{"text": str(result)}`.
2.  A dictionary that already has the [`ToolResult`](/docs/api/python/strands.types.tools#ToolResult) structure is used directly.
3.  A raised exception is converted to an error response.
(( /tab "Python" ))

(( tab "TypeScript" ))
The `tool()` function converts a callback’s return value into a `ToolResultBlock`:

1.  A value of type `string | number | boolean | null | { [key: string]: JSONValue } | JSONValue[]` is converted to a `ToolResultBlock`.
2.  A thrown exception is caught and converted to an error response.
(( /tab "TypeScript" ))

## Related pages

- [A2A Client](/docs/user-guide/sdk/tools/vended-tools/a2a-client/index.md) (1 shared tag)
- [Attach and invoke tools](/docs/user-guide/sdk/tools/using-tools/index.md) (1 shared tag)
- [Bash / shell](/docs/user-guide/sdk/tools/vended-tools/shell/index.md) (1 shared tag)
- [Community tools package](/docs/user-guide/sdk/tools/community-tools-package/index.md) (1 shared tag)
- [Create custom tools](/docs/user-guide/sdk/tools/custom-tools/index.md) (1 shared tag)
- [Edit](/docs/user-guide/sdk/tools/vended-tools/edit/index.md) (1 shared tag)
- [File editor](/docs/user-guide/sdk/tools/vended-tools/file-editor/index.md) (1 shared tag)
- [Graph](/docs/user-guide/sdk/tools/vended-tools/graph/index.md) (1 shared tag)
- [Handoff to User](/docs/user-guide/sdk/tools/vended-tools/handoff-to-user/index.md) (1 shared tag)
- [HTTP request](/docs/user-guide/sdk/tools/vended-tools/http-request/index.md) (1 shared tag)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/types/tools.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/types/tools.py)
- [harness-sdk/strands-py/src/strands/tools/decorator.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/decorator.py)

### TypeScript

- [harness-sdk/strands-ts/src/types/messages.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts)
- [harness-sdk/strands-ts/src/tools/tool-factory.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/tools/tool-factory.ts)
