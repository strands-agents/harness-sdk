import { Agent, tool, McpClient } from '@strands-agents/sdk'
import { OpenAIModel } from '@strands-agents/sdk/models/openai'
import { Graph } from '@strands-agents/sdk/multiagent'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { z } from 'zod'

async function helloWorldExample() {
  // --8<-- [start:hello_world]
  const agent = new Agent({
    systemPrompt: 'You are a helpful assistant.',
  })

  const result = await agent.invoke('What makes TypeScript great for building agents?')
  console.log(result)
  // --8<-- [end:hello_world]
}

async function modelProviderExample() {
  // --8<-- [start:model_provider]
  const agent = new Agent({
    model: new OpenAIModel({
      api: 'chat',
      modelId: 'gpt-4o',
    }),
  })
  // --8<-- [end:model_provider]
}

async function toolDefinitionExample() {
  // --8<-- [start:tool_definition]
  const calculator = tool({
    name: 'calculate',
    description: 'Evaluate a math expression.',
    inputSchema: z.object({
      expression: z.string().describe('The math expression to evaluate'),
    }),
    callback: (input) => String(eval(input.expression)),
  })
  // --8<-- [end:tool_definition]
}

async function streamingExample() {
  const agent = new Agent()
  // --8<-- [start:streaming]
  for await (const event of agent.stream('Tell me a story')) {
    if (event.type === 'modelStreamUpdateEvent') {
      // Handle each chunk as it arrives
    }
  }
  // --8<-- [end:streaming]
}

async function mcpExample() {
  // --8<-- [start:mcp]
  const mcpClient = new McpClient({
    transport: new StdioClientTransport({
      command: 'uvx',
      args: ['awslabs.aws-documentation-mcp-server@latest'],
    }),
  })

  const agent = new Agent({ tools: [mcpClient] })
  // --8<-- [end:mcp]
}

async function multiAgentExample() {
  // --8<-- [start:multi_agent]
  const researcher = new Agent({
    id: 'researcher',
    systemPrompt: 'Research the topic.',
  })
  const writer = new Agent({
    id: 'writer',
    systemPrompt: 'Write a polished draft.',
  })
  const reviewer = new Agent({
    id: 'reviewer',
    systemPrompt: 'Review the draft.',
  })

  const graph = new Graph({
    nodes: [researcher, writer, reviewer],
    edges: [
      ['researcher', 'writer'],
      ['writer', 'reviewer'],
    ],
  })

  const result = await graph.invoke('Write a blog post about AI agents')
  // --8<-- [end:multi_agent]
}
