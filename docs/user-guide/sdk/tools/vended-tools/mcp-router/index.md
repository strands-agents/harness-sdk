Lets your agent connect to Model Context Protocol servers at runtime, list the tools they expose, invoke one, and disconnect. The factory takes a developer-set allowlist of server configurations; the model can only initiate connections to servers on that list.

The tool exposes five commands: `connect` (opens a named connection to an allowlisted server using a `connection_id`), `list_connections` (returns all open connection IDs for the current agent), `list_tools` (returns the tools the server exposes), `call_tool` (invokes a tool by name), and `disconnect` (closes a connection).

Connections are scoped per agent and persist across invocations on the same agent instance. A connection is closed when the model calls `disconnect` explicitly, or when the agent is garbage collected. The connection remains open otherwise.

*Supported in: Node.js (TypeScript); all platforms (Python).*

Security Warning

The allowlist controls which servers the model may connect to. For HTTP servers, treat this like any network request — egress control belongs at the encapsulation layer. For stdio servers, the allowlisted command is spawned as a local process with access to the host filesystem, environment variables, and network. Only allowlist commands you would run directly on the host.

**Example:**

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { makeMcpRouter } from '@strands-agents/sdk/vended-tools/mcp-router'

const mcpRouter = makeMcpRouter({
  servers: {
    files: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
    },
    'my-api': { url: 'https://mcp.example.com/mcp' },
  },
  maxConnections: 5,
})
const agent = new Agent({ tools: [mcpRouter] })
await agent.invoke(
  "Connect to 'files', list its tools, " +
    'call the read_file tool on /tmp/hello.txt, then disconnect.'
)
```
(( /tab "TypeScript" ))

(( tab "Python" ))
```python
from strands import Agent
from strands.vended_tools import make_mcp_router

mcp_router = make_mcp_router(
    servers={
        "files": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]},
        "my-api": {"url": "https://mcp.example.com/mcp"},
    },
    max_connections=5,
)
agent = Agent(tools=[mcp_router])
agent(
    "Connect to 'files', list its tools, "
    "call the read_file tool on /tmp/hello.txt, then disconnect."
)
```
(( /tab "Python" ))

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

- [harness-sdk/strands-ts/src/vended-tools/mcp-router/mcp-router.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/mcp-router/mcp-router.ts)

### Python

- [harness-sdk/strands-py/src/strands/vended_tools/mcp_router/mcp_router.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_tools/mcp_router/mcp_router.py)
