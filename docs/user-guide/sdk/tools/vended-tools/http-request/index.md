Lets your agent call external APIs and fetch web content. Supports all HTTP methods, custom headers, and request bodies. Default timeout is 30 seconds.

*Supported in: Python; Node.js 22+, modern browsers (TypeScript).*

(( tab "Python" ))
The Python tool delegates all networking to an `httpx.AsyncClient`. Use the `make_http_request` factory to supply a pre-configured client with authentication, timeouts, redirects, proxies, or other transport-level configuration.
(( /tab "Python" ))

**Example:**

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import { httpRequest } from '@strands-agents/sdk/vended-tools/http-request'

const agent = new Agent({
  tools: [httpRequest],
})

// Make API requests
await agent.invoke('Get data from https://api.example.com/users')
await agent.invoke('Post {"name": "John"} to https://api.example.com/users')
```
(( /tab "TypeScript" ))

(( tab "Python" ))
```python
from strands import Agent
from strands.vended_tools import http_request

agent = Agent(tools=[http_request])
agent("Get data from https://api.example.com/data")
```

Custom configuration with a pre-configured client:

```python
import httpx
from strands import Agent
from strands.vended_tools import make_http_request

client = httpx.AsyncClient(
    headers={"Authorization": "Bearer token"},
)
tool = make_http_request(client=client)
agent = Agent(tools=[tool])
```
(( /tab "Python" ))

Full API reference: [TypeScript](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/http-request/README.md), [Python](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_tools/http_request/README.md)

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
- [MCP Router](/docs/user-guide/sdk/tools/vended-tools/mcp-router/index.md) (1 shared tag)


## Implementation

### TypeScript

- [harness-sdk/strands-ts/src/vended-tools/http-request/http-request.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/http-request/http-request.ts)

### Python

- [harness-sdk/strands-py/src/strands/vended_tools/http_request/http_request.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_tools/http_request/http_request.py)
