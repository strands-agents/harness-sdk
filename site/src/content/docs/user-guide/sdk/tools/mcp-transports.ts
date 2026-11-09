import { Agent, McpClient } from '@strands-agents/sdk'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

// --8<-- [start:stdio_transport]
const stdioClient = new McpClient({
  transport: new StdioClientTransport({
    command: 'uvx',
    args: ['awslabs.aws-documentation-mcp-server@latest'],
  }),
})

const agentStdio = new Agent({
  tools: [stdioClient],
})

await agentStdio.invoke('What is AWS Lambda?')
// --8<-- [end:stdio_transport]

// --8<-- [start:streamable_http]
const httpClient = new McpClient({
  transport: new StreamableHTTPClientTransport(
    new URL('http://localhost:8000/mcp')
  ) as Transport,
})

const agentHttp = new Agent({
  tools: [httpClient],
})

// With authentication
const githubMcpClient = new McpClient({
  transport: new StreamableHTTPClientTransport(
    new URL('https://api.githubcopilot.com/mcp/'),
    {
      requestInit: {
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_PAT}`,
        },
      },
    }
  ) as Transport,
})
// --8<-- [end:streamable_http]

// --8<-- [start:sse_transport]
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'

const sseClient = new McpClient({
  transport: new SSEClientTransport(new URL('http://localhost:8000/sse')),
})

const agentSse = new Agent({
  tools: [sseClient],
})
// --8<-- [end:sse_transport]
