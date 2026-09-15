import { Agent, McpClient } from '@strands-agents/sdk'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { ElicitResult } from '@modelcontextprotocol/sdk/types.js'

// --8<-- [start:quick_start]
// Create MCP client with stdio transport
const mcpClient = new McpClient({
  transport: new StdioClientTransport({
    command: 'uvx',
    args: ['awslabs.aws-documentation-mcp-server@latest'],
  }),
})

// Pass MCP client directly to agent
const agent = new Agent({
  tools: [mcpClient],
})

await agent.invoke('What is AWS Lambda?')
// --8<-- [end:quick_start]

// --8<-- [start:direct_integration]
const mcpClientDirect = new McpClient({
  transport: new StdioClientTransport({
    command: 'uvx',
    args: ['awslabs.aws-documentation-mcp-server@latest'],
  }),
})

// MCP client passed directly - connects on first tool use
const agentDirect = new Agent({
  tools: [mcpClientDirect],
})

await agentDirect.invoke('What is AWS Lambda?')
// --8<-- [end:direct_integration]

// --8<-- [start:explicit_tools]
// Explicit tool listing
const tools = await mcpClient.listTools()
const agentExplicit = new Agent({ tools })
// --8<-- [end:explicit_tools]

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

// --8<-- [start:multiple_servers]
const localClient = new McpClient({
  transport: new StdioClientTransport({
    command: 'uvx',
    args: ['awslabs.aws-documentation-mcp-server@latest'],
  }),
})

const remoteClient = new McpClient({
  transport: new StreamableHTTPClientTransport(
    new URL('https://api.example.com/mcp/')
  ) as Transport,
})

// Pass multiple MCP clients to the agent
const agentMultiple = new Agent({
  tools: [localClient, remoteClient],
})
// --8<-- [end:multiple_servers]

{
  // --8<-- [start:tool_filtering]
  // String matching - loads only specified tools
  const filteredClient = new McpClient({
    transport: new StdioClientTransport({
      command: 'uvx',
      args: ['awslabs.aws-documentation-mcp-server@latest'],
    }),
    toolFilters: { allowed: ['search_documentation', 'read_documentation'] },
  })

  // Regex patterns
  const regexClient = new McpClient({
    transport: new StdioClientTransport({
      command: 'uvx',
      args: ['awslabs.aws-documentation-mcp-server@latest'],
    }),
    toolFilters: { allowed: [/^search_.*/] },
  })

  // Callbacks receive the tool itself
  const callbackClient = new McpClient({
    transport: new StdioClientTransport({
      command: 'uvx',
      args: ['awslabs.aws-documentation-mcp-server@latest'],
    }),
    toolFilters: { rejected: [(tool) => tool.name.endsWith('_internal')] },
  })

  // Combined filters - applies allowed first, then rejected
  const combinedClient = new McpClient({
    transport: new StdioClientTransport({
      command: 'uvx',
      args: ['awslabs.aws-documentation-mcp-server@latest'],
    }),
    toolFilters: {
      allowed: [/.*documentation$/],
      rejected: ['read_documentation'],
    },
  })
  // --8<-- [end:tool_filtering]
  void filteredClient
  void regexClient
  void callbackClient
  void combinedClient
}

{
  // --8<-- [start:tool_prefixing]
  const awsDocsClient = new McpClient({
    transport: new StdioClientTransport({
      command: 'uvx',
      args: ['awslabs.aws-documentation-mcp-server@latest'],
    }),
    prefix: 'aws_docs',
  })

  const otherClient = new McpClient({
    transport: new StdioClientTransport({
      command: 'uvx',
      args: ['other-mcp-server@latest'],
    }),
    prefix: 'other',
  })

  // Tools will be named: aws_docs_search_documentation, other_search, etc.
  const agent = new Agent({ tools: [awsDocsClient, otherClient] })
  // --8<-- [end:tool_prefixing]
  void agent
}

async function promptsAndResources() {
  // --8<-- [start:prompts_resources]
  await using mcpClient = new McpClient({
    transport: new StdioClientTransport({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-everything'],
    }),
  })

  let promptPage = await mcpClient.listPrompts()
  const prompts = [...promptPage.prompts]
  while (promptPage.nextCursor !== undefined) {
    promptPage = await mcpClient.listPrompts(promptPage.nextCursor)
    prompts.push(...promptPage.prompts)
  }

  const prompt = await mcpClient.getPrompt('args-prompt', {
    city: 'Seattle',
    state: 'Washington',
  })
  const resources = await mcpClient.listResources()
  const resourceUri = 'demo://resource/static/document/architecture.md'
  const resource = await mcpClient.readResource(resourceUri, { timeout: 10_000 })
  const templates = await mcpClient.listResourceTemplates()

  console.log({
    prompts,
    prompt: prompt.messages,
    resources: resources.resources,
    resource: resource.contents,
    templates: templates.resourceTemplates,
  })
  // --8<-- [end:prompts_resources]
}

// --8<-- [start:mcp_server]
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({
  name: 'Calculator Server',
  version: '1.0.0',
})

server.tool(
  'calculator',
  'Calculator tool which performs calculations',
  {
    x: z.number(),
    y: z.number(),
  },
  async ({ x, y }) => {
    return {
      content: [{ type: 'text', text: String(x + y) }],
    }
  }
)

const transport = new StdioServerTransport()
await server.connect(transport)
// --8<-- [end:mcp_server]

async function elicitationExample() {
  // --8<-- [start:elicitation]
  const client = new McpClient({
    transport: new StdioClientTransport({
      command: 'python',
      args: ['/path/to/server.py'],
    }),
    elicitationCallback: async (_context, params): Promise<ElicitResult> => {
      console.log(`ELICITATION: ${params.message}`)
      // Get user confirmation...
      return {
        action: 'accept',
        content: { username: 'myname' },
      }
    },
  })

  const agent = new Agent({ tools: [client] })
  await agent.invoke("Delete 'a/b/c.txt' and share the name of the approver")
  // --8<-- [end:elicitation]
}
void elicitationExample

// --8<-- [start:tools_overview_example]
// Create MCP client with stdio transport
const mcpClientOverview = new McpClient({
  transport: new StdioClientTransport({
    command: 'uvx',
    args: ['awslabs.aws-documentation-mcp-server@latest'],
  }),
})

// Pass MCP client directly to agent
const agentOverview = new Agent({
  tools: [mcpClientOverview],
})

await agentOverview.invoke('Calculate the square root of 144')
// --8<-- [end:tools_overview_example]
