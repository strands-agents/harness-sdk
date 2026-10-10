import { Agent } from '@strands-agents/sdk'
import { BeforeModelCallEvent } from '@strands-agents/sdk'
import { tool } from '@strands-agents/sdk'
import { Graph, BeforeNodeCallEvent } from '@strands-agents/sdk/multiagent'
import { z } from 'zod'

async function invocationStateGraphExample() {
  // --8<-- [start:invocation_state_graph]
  const researcher = new Agent({
    id: 'researcher',
    systemPrompt: 'You are a research specialist.',
  })
  const writer = new Agent({
    id: 'writer',
    systemPrompt: 'You are a writing specialist.',
  })

  const graph = new Graph({
    nodes: [researcher, writer],
    edges: [['researcher', 'writer']],
  })

  // Pass invocation state to the orchestrator
  await graph.invoke('Analyze customer data', {
    invocationState: {
      userId: 'user123',
      sessionId: 'sess456',
      debugMode: true,
    },
  })
  // --8<-- [end:invocation_state_graph]
}

async function invocationStateToolExample() {
  // --8<-- [start:invocation_state_tool]
  const queryDataTool = tool({
    name: 'query_data',
    description: 'Query data with user context',
    inputSchema: z.object({
      query: z.string(),
    }),
    callback: (input, context) => {
      const userId = context?.invocationState.userId
      const debugMode = context?.invocationState.debugMode
      // Use context for personalized queries...
      return `Results for ${userId}`
    },
  })
  // --8<-- [end:invocation_state_tool]
}

async function multiAgentStateExample() {
  const researcher = new Agent({ id: 'researcher' })
  const writer = new Agent({ id: 'writer' })

  // --8<-- [start:multi_agent_state]
  const graph = new Graph({
    nodes: [researcher, writer],
    edges: [['researcher', 'writer']],
  })

  graph.addHook(BeforeNodeCallEvent, (event) => {
    // Read execution progress
    console.log(`Step ${event.state.steps}, node ${event.nodeId} starting`)

    // Check a previous node's status
    const researcherState = event.state.node('researcher')
    if (researcherState) {
      console.log(`Researcher status: ${researcherState.status}`)
    }

    // Read/write custom shared state
    event.state.app.set('requestId', 'req-123')
    const requestId = event.state.app.get('requestId')
  })
  // --8<-- [end:multi_agent_state]
}

async function agentsAsToolsHubExample() {
  // --8<-- [start:agents_as_tools_hub]
  // A specialized agent, passed directly to an orchestrator's tools
  const weatherAgent = new Agent({
    name: 'weather_agent',
    description: 'Answers questions about the weather.',
    systemPrompt: 'You are a weather specialist.',
    printer: false,
  })

  // The orchestrator calls the specialist when the query fits
  const orchestrator = new Agent({
    systemPrompt: 'Route weather questions to weather_agent; answer the rest yourself.',
    tools: [weatherAgent],
  })

  await orchestrator.invoke('What should I pack for Seattle this weekend?')
  // --8<-- [end:agents_as_tools_hub]
}

void invocationStateGraphExample
void invocationStateToolExample
void multiAgentStateExample
void agentsAsToolsHubExample
