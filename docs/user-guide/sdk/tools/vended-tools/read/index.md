Reads a file through the agent’s sandbox. Text files return `cat -n` style numbered lines so the model can cite `path:line`, with `offset` and `limit` for paging through large files. Images (png/jpg/jpeg/gif/webp) and binary documents (pdf/doc/docx/xls/xlsx) return as media content blocks when the model accepts media; otherwise `make_read(media=False)` / `makeRead({ media: false })` returns a short text placeholder describing the file.

*Supported in: Python, TypeScript (Node.js).*

Security Warning

This tool reads files at arbitrary absolute paths with the full permissions of the process. Only use with trusted input and consider running in a [sandboxed environment](/docs/user-guide/sdk/sandbox/index.md) for production.

**Example:**

(( tab "Python" ))
```python
from strands import Agent
from strands.vended_tools import read

agent = Agent(tools=[read])
agent("Read /etc/hosts and summarize what it maps.")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { read } from '@strands-agents/sdk/vended-tools/read'

const agent = new Agent({ tools: [read] })
await agent.invoke('Read /etc/hosts and summarize what it maps.')
```
(( /tab "TypeScript" ))

[Full API reference](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/read/README.md)

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

### TypeScript

- [harness-sdk/strands-ts/src/vended-tools/read/read.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/read/read.ts)

### Python

- [harness-sdk/strands-py/src/strands/vended_tools/read/read.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_tools/read/read.py)
