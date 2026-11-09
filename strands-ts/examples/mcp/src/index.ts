import { Agent, McpClient } from '@strands-agents/sdk'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

async function runInvoke(title: string, agent: Agent, prompt: string) {
  console.log(`--- ${title} ---\nUser: ${prompt}`)
  const result = await agent.invoke(prompt)
  console.log(`\n\n::Invocation complete; stop reason was ${result.stopReason}\n`)
}

async function main() {
  if (!process.env.STRANDS_EXAMPLE_MCP_DEMO) {
    console.warn(
      'Skipping MCP client example; STRANDS_EXAMPLE_MCP_DEMO environment variable not set. If you are comfortable with these tools performing side effects than you can set it and re-run the example.'
    )
    return
  }

  const documentationTools = new McpClient({
    transport: new StdioClientTransport({
      command: 'uvx',
      args: ['awslabs.aws-documentation-mcp-server@latest'],
    }),
  })

  const agentWithMcpClient = new Agent({
    systemPrompt:
      'You are a helpful assistant that uses the aws-documentation-mcp-server server as a demonstration of mcp functionality. You must only use tools without side effects.',
    tools: [documentationTools],
  })

  await runInvoke('1: Invocation with MCP client', agentWithMcpClient, 'Use a random tool from the MCP server.')

  // Set the following environment variable to run the GitHub MCP client example.
  //
  // STRANDS_EXAMPLE_GITHUB_PAT=<your_personal_access_token>
  //
  // Though unlikely in practice, this can perform side effects when using certain tools.
  if (!process.env.STRANDS_EXAMPLE_GITHUB_PAT) {
    console.warn(
      'Skipping GitHub MCP client example; STRANDS_EXAMPLE_GITHUB_PAT environment variable not set. Though prompted not to, this can perform side effects when using certain tools.'
    )
    await documentationTools.disconnect()
    return
  }

  // Optional client configuration
  const applicationConfig = {
    applicationName: 'First Agent Example',
    applicationVersion: '0.0.0',
  }

  // Create a remote MCP client
  const githubMcpClient = new McpClient({
    ...applicationConfig,
    transport: new StreamableHTTPClientTransport(new URL('https://api.githubcopilot.com/mcp/'), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${process.env.STRANDS_EXAMPLE_GITHUB_PAT}`,
        },
      },
    }),
  })

  const agentWithGithubMcpClient = new Agent({
    systemPrompt:
      'You are a helpful assistant that uses the github_mcp server as a demonstration of mcp functionality. You must only use tools without side effects.',
    tools: [githubMcpClient],
  })

  await runInvoke(
    '2: Invocation with GitHub MCP client',
    agentWithGithubMcpClient,
    'Use a random tool from the GitHub MCP server to illustrate that they work.'
  )

  await Promise.all([documentationTools.disconnect(), githubMcpClient.disconnect()])
}

await main().catch(console.error)
