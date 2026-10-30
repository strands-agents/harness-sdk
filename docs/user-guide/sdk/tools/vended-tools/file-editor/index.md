Deprecated

`file_editor` / `fileEditor` is deprecated in favor of the focused `edit`, `read`, and `write` tools. It will be removed in a future release. Calling `make_file_editor` emits a `DeprecationWarning` in Python; `makeFileEditor` and `fileEditor` are marked `@deprecated` in TypeScript. Docker and SSH sandboxes still vend `file_editor` as `sandbox_file_editor` for continuity.

Lets your agent read and modify files on disk: useful for coding agents, config management, or any workflow where the agent inspects output and makes targeted edits.

Security Warning

This tool reads and writes files at arbitrary absolute paths with the full permissions of the process. Only use with trusted input and consider running in a [sandboxed environment](/docs/user-guide/sdk/sandbox/index.md) for production.

**Example:**

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { fileEditor } from '@strands-agents/sdk/vended-tools/file-editor'

const agent = new Agent({
  tools: [fileEditor],
})

// Create, view, and edit files
await agent.invoke('Create a file /tmp/config.json with {"debug": false}')
await agent.invoke('Replace "debug": false with "debug": true in /tmp/config.json')
await agent.invoke('View lines 1-10 of /tmp/config.json')
```
(( /tab "TypeScript" ))

(( tab "Python" ))
```python
from strands import Agent
from strands.vended_tools import file_editor

agent = Agent(tools=[file_editor])
agent("Create a file at /tmp/hello.txt with the contents 'Hello, world!'")
```
(( /tab "Python" ))

[Full API reference](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/file-editor/README.md)

## Related pages

- [A2A Client](/docs/user-guide/sdk/tools/vended-tools/a2a-client/index.md) (1 shared tag)
- [Attach and invoke tools](/docs/user-guide/sdk/tools/using-tools/index.md) (1 shared tag)
- [Bash / shell](/docs/user-guide/sdk/tools/vended-tools/shell/index.md) (1 shared tag)
- [Community tools package](/docs/user-guide/sdk/tools/community-tools-package/index.md) (1 shared tag)
- [Create custom tools](/docs/user-guide/sdk/tools/custom-tools/index.md) (1 shared tag)
- [Edit](/docs/user-guide/sdk/tools/vended-tools/edit/index.md) (1 shared tag)
- [Graph](/docs/user-guide/sdk/tools/vended-tools/graph/index.md) (1 shared tag)
- [Handoff to User](/docs/user-guide/sdk/tools/vended-tools/handoff-to-user/index.md) (1 shared tag)
- [HTTP request](/docs/user-guide/sdk/tools/vended-tools/http-request/index.md) (1 shared tag)
- [MCP Router](/docs/user-guide/sdk/tools/vended-tools/mcp-router/index.md) (1 shared tag)


## Implementation

### TypeScript

- [harness-sdk/strands-ts/src/vended-tools/file-editor/file-editor.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/file-editor/file-editor.ts)

### Python

- [harness-sdk/strands-py/src/strands/vended_tools/file_editor/file_editor.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_tools/file_editor/file_editor.py)
