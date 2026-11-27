// @ts-nocheck
// NOTE: Type-checking is disabled because the examples reference remote services not available at build time.

import { Agent, tool, SessionManager, FileStorage } from '@strands-agents/sdk'
import { A2AAgent } from '@strands-agents/sdk/a2a'
import { A2AExpressServer } from '@strands-agents/sdk/a2a/express'
import { z } from 'zod'

async function basicUsageExample() {
  // --8<-- [start:basic_usage]
  // Create an A2AAgent pointing to a remote A2A server
  const a2aAgent = new A2AAgent({ url: 'http://localhost:9000' })

  // Invoke it just like a regular Agent
  const result = await a2aAgent.invoke('Show me 10 ^ 6')
  console.log(result.lastMessage.content)
  // --8<-- [end:basic_usage]
}

async function streamingExample() {
  // --8<-- [start:streaming]
  const remoteAgent = new A2AAgent({ url: 'http://localhost:9000' })

  // stream() yields A2AStreamUpdateEvent for each protocol event,
  // then an AgentResultEvent with the final result
  const stream = remoteAgent.stream('Explain quantum computing')
  let next = await stream.next()
  while (!next.done) {
    console.log(next.value)
    next = await stream.next()
  }
  // Final result
  console.log(next.value)
  // --8<-- [end:streaming]
}

async function asToolExample() {
  // --8<-- [start:as_tool]
  const calculatorAgent = new A2AAgent({
    url: 'http://calculator-service:9000',
  })

  const calculate = tool({
    name: 'calculate',
    description: 'Perform a mathematical calculation.',
    inputSchema: z.object({
      expression: z.string().describe('The math expression to evaluate'),
    }),
    callback: async (input) => {
      const calcResult = await calculatorAgent.invoke(input.expression)
      return String(calcResult.lastMessage.content[0])
    },
  })

  const orchestrator = new Agent({
    systemPrompt: 'You are a helpful assistant. Use the calculate tool for math.',
    tools: [calculate],
  })
  // --8<-- [end:as_tool]
}

async function basicServerExample() {
  // --8<-- [start:basic_server]
  // Build a fresh agent for each A2A context so callers stay isolated
  const server = new A2AExpressServer({
    agentFactory: (contextId) =>
      new Agent({
        systemPrompt: 'You are a calculator agent that can perform basic arithmetic.',
      }),
    name: 'Calculator Agent',
    description: 'A calculator agent that can perform basic arithmetic operations.',
  })

  await server.serve()
  // --8<-- [end:basic_server]
}

async function factoryServerExample() {
  // --8<-- [start:factory_server]
  // The factory runs once per contextId and returns a dedicated agent, so each conversation
  // is isolated. Wire an optional sessionManager here to persist that conversation's history,
  // scoped to the contextId.
  const storage = new FileStorage('./sessions')

  const server = new A2AExpressServer({
    agentFactory: (contextId) =>
      new Agent({
        name: 'Calculator Agent',
        description: 'A calculator agent.',
        sessionManager: new SessionManager({
          sessionId: contextId,
          storage: { snapshot: storage },
        }),
      }),
    name: 'Calculator Agent',
    maxContexts: 1000,
  })

  await server.serve()
  // --8<-- [end:factory_server]
}

void basicUsageExample()
void streamingExample()
void asToolExample()
void basicServerExample()
void factoryServerExample()
