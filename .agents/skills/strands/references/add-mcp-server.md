# Add an MCP server

Distinguish between two requests:

- Connecting Claude Code to the Strands documentation MCP server helps the coding assistant use current Strands APIs. The directory plugin supplies this as `strands-docs`.
- Connecting a Strands application to an MCP server gives the application's agent access to that server's tools. Use the SDK patterns below.

## Python

Use `MCPClient` as a tool provider. The managed form handles the connection lifecycle:

```python
from mcp import StdioServerParameters, stdio_client
from strands import Agent
from strands.tools.mcp import MCPClient

mcp_client = MCPClient(
    lambda: stdio_client(
        StdioServerParameters(
            command="uvx",
            args=["awslabs.aws-documentation-mcp-server@latest"],
        )
    )
)

agent = Agent(tools=[mcp_client])
result = agent("What is AWS Lambda?")
print(result)
```

Use explicit context management only when the application needs direct control of connection lifetime or explicit tool listing.

## TypeScript

Install `@modelcontextprotocol/client`, then use `McpClient` with the transport required by the server:

```typescript
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { Agent, McpClient } from '@strands-agents/sdk'

const mcpClient = new McpClient({
  transport: new StdioClientTransport({
    command: 'uvx',
    args: ['awslabs.aws-documentation-mcp-server@latest'],
  }),
})

const agent = new Agent({ tools: [mcpClient] })
const result = await agent.invoke('What is AWS Lambda?')
console.log(result.lastMessage)
```

For remote servers, use the current Streamable HTTP transport. Use SSE only for servers that still require the older transport.

## Safety and verification

1. Inspect the server command, URL, environment variables, and exposed tools before enabling it.
2. Do not place tokens in committed MCP configuration. Use environment-variable expansion supported by the client.
3. Apply tool filtering or name prefixes when the server exposes more tools than the agent needs or names collide.
4. Test initialization and list the tools before relying on model-driven invocation.
5. Do not install or launch an untrusted MCP server without the user's approval.
