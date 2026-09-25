# A2A Client Tool

Communicates with remote A2A (Agent-to-Agent) protocol agents. Exposes `discover` (fetch agent card) and `send_message` (send text, receive response) operations behind an endpoint allowlist.

## ⚠️ Security Warning

**This tool makes network requests to remote A2A agent endpoints.**

- Only allow endpoints you trust — the allowlist is enforced before any network connection is made
- Requests execute with the network access of the host process
- For production deployments, consider running in a sandboxed environment (containers, VMs, etc.)
- Never expose this tool to untrusted users or untrusted prompt input without additional security measures

## Usage

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
  allowedEndpoints: {
    // No auth needed
    'https://agent.example.com': undefined,
    // Custom ClientFactory for authenticated requests
    'https://secure-agent.example.com': new ClientFactory({
      transports: [
        new JsonRpcTransportFactory({ fetchImpl: authFetch }),
        new RestTransportFactory({ fetchImpl: authFetch }),
      ],
      cardResolver: new DefaultAgentCardResolver({ fetchImpl: authFetch }),
    }),
  },
})

const agent = new Agent({
  model,
  tools: [a2aClient],
  systemPrompt: 'You can talk to remote agents. Discover them first, then send messages.',
})

const result = await agent.invoke('Ask the agent at https://agent.example.com to summarize the news')
```

## Input schema

| Field       | Type                           | Required           | Description                                         |
| ----------- | ------------------------------ | ------------------ | --------------------------------------------------- |
| `operation` | `'discover' \| 'send_message'` | Yes                | Action to perform                                   |
| `endpoint`  | `string`                       | Yes                | Base URL of the target agent (must be in allowlist) |
| `message`   | `string \| null`               | For `send_message` | Text to send                                        |

## How it works

- **Discover** connects to the endpoint and returns the agent card as a plain JSON object.
- **Send message** calls the A2A agent and returns the serialized response message.

Both operations enforce the endpoint allowlist before making any network connection and reject results whose JSON-serialized size exceeds `maxBytes` (default 5 MiB).

## Limitations

- **Text only.** Binary parts, images, and other modalities are not supported.
- **Stateless.** Each call creates a fresh connection with no session continuity.
- **No streaming.** The tool waits for the full response before returning.
