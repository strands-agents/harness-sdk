import { Agent } from '@strands-agents/sdk'
import { makeMcpRouter } from '@strands-agents/sdk/vended-tools/mcp-router'

// MCP router example
async function mcpRouterExample() {
  // --8<-- [start:mcp_router_example]
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
  // --8<-- [end:mcp_router_example]
}
