Lays down the full content of a text file in one shot — creating it or overwriting whatever is there.

The confirmation returned to the model is of the form `Wrote <N> lines to <path>.`, where `N` is the number of `\n`\-separated entries in the content (so content ending with a newline reports one more entry than text lines, and empty content reports zero).

Security Warning

This tool writes files at arbitrary absolute paths with the full permissions of the process. Only use with trusted input and consider running in a [sandboxed environment](/docs/user-guide/sdk/sandbox/index.md) for production.

**Example:**

(( tab "Python" ))
```python
from strands import Agent
from strands.vended_tools import write

agent = Agent(tools=[write])
agent("Create a file at /tmp/hello.txt with the contents 'Hello, Strands!'.")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { write } from '@strands-agents/sdk/vended-tools/write'

const agent = new Agent({ tools: [write] })
await agent.invoke("Create /tmp/hello.txt containing 'Hello, Strands!'")
```
(( /tab "TypeScript" ))

[Full API reference](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/write/README.md)

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

- [harness-sdk/strands-ts/src/vended-tools/write/write.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/write/write.ts)

### Python

- [harness-sdk/strands-py/src/strands/vended_tools/write/write.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_tools/write/write.py)
