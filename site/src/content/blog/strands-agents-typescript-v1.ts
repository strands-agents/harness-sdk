import { Agent, tool, McpClient } from '@strands-agents/sdk'
import { BedrockModel } from '@strands-agents/sdk/models/bedrock'
import { Graph, Swarm } from '@strands-agents/sdk/multiagent'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { z } from 'zod'
import type { Plugin, LocalAgent } from '@strands-agents/sdk'
import { BeforeToolCallEvent, AfterToolCallEvent } from '@strands-agents/sdk'

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
    model: new BedrockModel({
      modelId: 'global.anthropic.claude-opus-4-7',
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

  const agent = new Agent({ tools: [calculator] })
  // --8<-- [end:tool_definition]
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

async function pluginsExample() {
  // --8<-- [start:plugins]
  class LoggingPlugin implements Plugin {
    get name() {
      return 'logging'
    }

    initAgent(agent: LocalAgent) {
      agent.addHook(BeforeToolCallEvent, (event) => {
        console.log(`Calling tool: ${event.toolUse.name}`)
      })
      agent.addHook(AfterToolCallEvent, (event) => {
        console.log(`Tool ${event.toolUse.name} completed`)
      })
    }
  }

  const agent = new Agent({
    plugins: [new LoggingPlugin()],
  })
  // --8<-- [end:plugins]
}

async function agentAsToolExample() {
  // --8<-- [start:agent_as_tool]
  const researcher = new Agent({
    name: 'researcher',
    description: 'Finds information on a topic',
    systemPrompt: 'You are a research assistant. Find accurate information.',
  })

  const writer = new Agent({
    tools: [researcher],
    systemPrompt: 'You are a writer. Use the researcher to gather facts, then write a polished draft.',
  })

  const result = await writer.invoke('Write a short article about AI agents')
  // --8<-- [end:agent_as_tool]
}

async function graphExample() {
  // --8<-- [start:graph]
  const graph = new Graph({
    nodes: [
      new Agent({
        id: 'researcher',
        systemPrompt: 'Research the topic.',
      }),
      new Agent({
        id: 'writer',
        systemPrompt: 'Write a polished draft.',
      }),
      new Agent({
        id: 'reviewer',
        systemPrompt: 'Review the draft.',
      }),
    ],
    edges: [
      ['researcher', 'writer'],
      ['writer', 'reviewer'],
    ],
  })

  const result = await graph.invoke('Write a blog post about AI agents')
  // --8<-- [end:graph]
}

async function swarmExample() {
  // --8<-- [start:swarm]
  const swarm = new Swarm({
    nodes: [
      new Agent({
        id: 'triage',
        systemPrompt: 'Route the request to the right specialist.',
      }),
      new Agent({
        id: 'billing',
        systemPrompt: 'Handle billing questions.',
      }),
      new Agent({
        id: 'technical',
        systemPrompt: 'Handle technical support.',
      }),
    ],
    start: 'triage',
  })

  const result = await swarm.invoke('I need help with my invoice')
  // --8<-- [end:swarm]
}
