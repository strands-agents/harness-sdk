Lets your agent discover and communicate with remote [A2A (Agent-to-Agent) protocol](https://google.github.io/A2A/) agents. Two operations are available:

-   **`discover`** — fetches the agent card from a remote A2A endpoint and returns its capabilities, name, description, and skills.
-   **`send_message`** — sends a text message to a remote A2A agent and returns the response.

The tool is stateless: a fresh `A2AAgent` is created on every call using the per-endpoint configuration. Use `make_a2a_client` / `makeA2AClient` to control which endpoints the model may contact, with per-endpoint authentication, and to tune size limits.

*Supported in: Python, TypeScript (Node.js, browsers).*

Install required

(( tab "Python" ))
`a2a_client` requires the optional `a2a` extra:

```bash
pip install 'strands-agents[a2a]'
```
(( /tab "Python" ))

(( tab "TypeScript" ))
Requires the optional `@a2a-js/sdk` peer dependency:

```bash
npm install @a2a-js/sdk
```
(( /tab "TypeScript" ))

Endpoint security

`allowed_endpoints` / `allowedEndpoints` is required and checked before any network connection is made, but it only gates the agent-card fetch. `send_message` is delivered to the `url` in that card, which may point to a different host, and HTTP redirects are not checked either. For full egress control, enforce it at the network layer.

**Example:**

(( tab "TypeScript" ))
```typescript
import { Agent } from '@strands-agents/sdk'
import {
  ClientFactory,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
  createAuthenticatingFetchWithRetry,
} from '@a2a-js/sdk/client'
import { makeA2AClient } from '@strands-agents/sdk/vended-tools/a2a-client'

const authFetch = createAuthenticatingFetchWithRetry(fetch, {
  headers: async () => ({ Authorization: 'Bearer your-token' }),
  shouldRetryWithHeaders: async () => undefined,
})

const a2aClient = makeA2AClient({
  allowedEndpoints: [
    // No auth needed
    'https://agent.example.com',
    // Custom ClientFactory for authenticated requests
    [
      'https://researcher.example.com',
      new ClientFactory({
        transports: [
          new JsonRpcTransportFactory({ fetchImpl: authFetch }),
          new RestTransportFactory({ fetchImpl: authFetch }),
        ],
        cardResolver: new DefaultAgentCardResolver({ fetchImpl: authFetch }),
      }),
    ],
  ],
})

const agent = new Agent({ tools: [a2aClient] })
await agent.invoke('What has the research agent found recently?')
```
(( /tab "TypeScript" ))

(( tab "Python" ))
```python
import httpx
from a2a.client import ClientConfig
from strands import Agent
from strands.vended_tools import make_a2a_client

a2a_client = make_a2a_client(
    allowed_endpoints=[
        "https://agent.example.com",
        ("https://researcher.example.com", ClientConfig(
            httpx_client=httpx.AsyncClient(
                headers={"Authorization": "Bearer your-token"},
                timeout=60.0,
            ),
        )),
    ],
)
agent = Agent(tools=[a2a_client])
agent("What has the research agent found recently?")
```
(( /tab "Python" ))

Full API reference: [TypeScript](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/a2a-client/README.md)

## Related pages

- [Attach and invoke tools](/docs/user-guide/sdk/tools/using-tools/index.md) (1 shared tag)
- [Bash / shell](/docs/user-guide/sdk/tools/vended-tools/shell/index.md) (1 shared tag)
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

- [harness-sdk/strands-ts/src/vended-tools/a2a-client/a2a-client.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-tools/a2a-client/a2a-client.ts)

### Python

- [harness-sdk/strands-py/src/strands/vended_tools/a2a_client/a2a_client.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_tools/a2a_client/a2a_client.py)
