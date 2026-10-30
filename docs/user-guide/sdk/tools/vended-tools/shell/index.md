Lets your agent run shell commands and act on the output. The two SDKs expose different tools here:

-   **TypeScript `bash`** spawns a persistent `bash` process on the host. Shell state (variables, working directory, exported functions) persists across invocations within the same session, so the agent can build up context incrementally. Sessions can be restarted to clear state.
-   **Python `shell`** (and TypeScript’s `makeShell`) routes each command through the agent’s [Sandbox](/docs/user-guide/sdk/sandbox/index.md) and is stateless: every call runs in a fresh shell, so variables and the working directory do not carry over. The sandbox decides the interpreter (`sh` locally and in Docker, the remote login shell over SSH), so use portable POSIX syntax.

*Supported in: Node.js on Unix/Linux/macOS (TypeScript), all platforms (Python).*

Security Warning

These tools execute arbitrary shell commands. Without a [Sandbox](/docs/user-guide/sdk/sandbox/index.md), commands run with the full permissions of the process. Only use with trusted input and consider running in a [sandboxed environment](/docs/user-guide/sdk/sandbox/index.md) for production.

**Example - File Operations:**

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { bash } from '@strands-agents/sdk/vended-tools/bash'

const agent = new Agent({
  tools: [bash],
})

// List files and create a new file
await agent.invoke('List all files in the current directory')
await agent.invoke('Create a new file called notes.txt with "Hello World"')
```
(( /tab "TypeScript" ))

(( tab "Python" ))
```python
from strands import Agent
from strands.vended_tools import shell

agent = Agent(tools=[shell])
agent("List all Python files in the current directory and count them")
```
(( /tab "Python" ))

**Example - Session Persistence (TypeScript):**

```typescript
import { Agent } from '@strands-agents/sdk'
import { bash } from '@strands-agents/sdk/vended-tools/bash'

const agent = new Agent({
  tools: [bash],
})

// Variables persist across invocations within the same session
await agent.invoke('Run: export MY_VAR="hello"')
await agent.invoke('Run: echo $MY_VAR') // Will show "hello"

// Restart session to clear state
await agent.invoke('Restart the bash session')
await agent.invoke('Run: echo $MY_VAR') // Variable will be empty
```

Full API reference: [shell](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/shell/README.md), [bash (TypeScript only)](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/bash/README.md)

## Related pages

- [A2A Client](/docs/user-guide/sdk/tools/vended-tools/a2a-client/index.md) (1 shared tag)
- [Attach and invoke tools](/docs/user-guide/sdk/tools/using-tools/index.md) (1 shared tag)
- [Community tools package](/docs/user-guide/sdk/tools/community-tools-package/index.md) (1 shared tag)
- [Create custom tools](/docs/user-guide/sdk/tools/custom-tools/index.md) (1 shared tag)
- [Edit](/docs/user-guide/sdk/tools/vended-tools/edit/index.md) (1 shared tag)
- [File editor](/docs/user-guide/sdk/tools/vended-tools/file-editor/index.md) (1 shared tag)
- [Graph](/docs/user-guide/sdk/tools/vended-tools/graph/index.md) (1 shared tag)
- [Handoff to User](/docs/user-guide/sdk/tools/vended-tools/handoff-to-user/index.md) (1 shared tag)
- [HTTP request](/docs/user-guide/sdk/tools/vended-tools/http-request/index.md) (1 shared tag)
- [MCP Router](/docs/user-guide/sdk/tools/vended-tools/mcp-router/index.md) (1 shared tag)


## Implementation

### TypeScript

- [harness-sdk/strands-ts/src/vended-tools/bash/bash.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/bash/bash.ts)
- [harness-sdk/strands-ts/src/vended-tools/shell/make-shell.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/shell/make-shell.ts)

### Python

- [harness-sdk/strands-py/src/strands/vended_tools/shell/shell.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_tools/shell/shell.py)
