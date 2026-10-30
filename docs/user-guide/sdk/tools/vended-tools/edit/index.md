Lets your agent make surgical, in-place changes to a text file by replacing an exact, unique string (`old_str` must appear in the file exactly once).

The `edit` tool pairs with the `read` and `write` vended tools and supersedes `file_editor`.

Security Warning

This tool writes files at arbitrary absolute paths with the full permissions of the process. Only use with trusted input and consider running in a [sandboxed environment](/docs/user-guide/sdk/sandbox/index.md) for production.

**Example:**

(( tab "Python" ))
```python
from strands import Agent
from strands.vended_tools import edit

agent = Agent(tools=[edit])
agent("In /tmp/hello.txt, replace 'world' with 'Strands'.")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { edit } from '@strands-agents/sdk/vended-tools/edit'

const agent = new Agent({
  tools: [edit],
})

await agent.invoke("In /tmp/hello.txt, replace 'world' with 'Strands'.")
```
(( /tab "TypeScript" ))

## Related pages

- [A2A Client](/docs/user-guide/sdk/tools/vended-tools/a2a-client/index.md) (1 shared tag)
- [Attach and invoke tools](/docs/user-guide/sdk/tools/using-tools/index.md) (1 shared tag)
- [Bash / shell](/docs/user-guide/sdk/tools/vended-tools/shell/index.md) (1 shared tag)
- [Community tools package](/docs/user-guide/sdk/tools/community-tools-package/index.md) (1 shared tag)
- [Create custom tools](/docs/user-guide/sdk/tools/custom-tools/index.md) (1 shared tag)
- [File editor](/docs/user-guide/sdk/tools/vended-tools/file-editor/index.md) (1 shared tag)
- [Graph](/docs/user-guide/sdk/tools/vended-tools/graph/index.md) (1 shared tag)
- [Handoff to User](/docs/user-guide/sdk/tools/vended-tools/handoff-to-user/index.md) (1 shared tag)
- [HTTP request](/docs/user-guide/sdk/tools/vended-tools/http-request/index.md) (1 shared tag)
- [MCP Router](/docs/user-guide/sdk/tools/vended-tools/mcp-router/index.md) (1 shared tag)


## Implementation

### TypeScript

- [harness-sdk/strands-ts/src/vended-tools/edit/edit.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/edit/edit.ts)

### Python

- [harness-sdk/strands-py/src/strands/vended_tools/edit/edit.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_tools/edit/edit.py)
