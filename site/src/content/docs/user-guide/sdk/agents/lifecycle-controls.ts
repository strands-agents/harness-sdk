import { Agent, BedrockModel, tool } from '@strands-agents/sdk'
import { z } from 'zod'

async function limitsExample() {
  // --8<-- [start:limits_basic]
  const agent = new Agent()

  const result = await agent.invoke('Summarize this document', {
    limits: {
      turns: 5,
      outputTokens: 2000,
      totalTokens: 10000,
    },
  })

  if (result.stopReason === 'limitTurns') {
    console.log('Hit turn budget')
  } else if (result.stopReason === 'limitTotalTokens') {
    console.log('Hit token budget')
  }
  // --8<-- [end:limits_basic]
}

async function cancelTimeoutExample() {
  // --8<-- [start:cancel_timeout]
  const agent = new Agent()

  // Cancel from a timer after 30 seconds
  setTimeout(() => agent.cancel(), 30_000)

  const result = await agent.invoke('Analyze this large dataset')

  if (result.stopReason === 'cancelled') {
    console.log('Agent was cancelled due to timeout')
  }
  // --8<-- [end:cancel_timeout]
}

async function cancelExternalExample() {
  // --8<-- [start:cancel_external]
  const agent = new Agent()

  // Cancel the invocation if it runs past a 20-second deadline
  const result = await agent.invoke('Analyze this large dataset', {
    cancelSignal: AbortSignal.timeout(20_000),
  })

  if (result.stopReason === 'cancelled') {
    console.log('Agent hit its deadline')
  }
  // --8<-- [end:cancel_external]
}

function cancelInToolExample() {
  // --8<-- [start:cancel_in_tool]
  const fetchResource = tool({
    name: 'fetch_resource',
    description: 'Fetch a large resource, respecting cancellation',
    inputSchema: z.object({ url: z.string() }),
    callback: async (input, context) => {
      // Forward the signal so the request aborts when the agent is cancelled
      const response = await fetch(input.url, { signal: context?.cancelSignal })
      return response.text()
    },
  })
  // --8<-- [end:cancel_in_tool]
}

// --8<-- [start:worked_example]
const MODEL_ID = 'global.anthropic.claude-sonnet-5'

type Outcome = 'completed' | 'budgetExceeded' | 'timedOut'

function classify(stopReason: string): Outcome {
  if (stopReason === 'cancelled') return 'timedOut'
  if (
    stopReason === 'limitTurns' ||
    stopReason === 'limitTotalTokens' ||
    stopReason === 'limitOutputTokens'
  ) {
    return 'budgetExceeded'
  }
  return 'completed'
}

async function handleRequest(prompt: string, deadlineMs = 20_000) {
  // A fresh agent per request keeps concurrent calls from sharing history
  const agent = new Agent({ model: new BedrockModel({ modelId: MODEL_ID }) })

  const result = await agent.invoke(prompt, {
    limits: { turns: 6, totalTokens: 20_000 },
    cancelSignal: AbortSignal.timeout(deadlineMs),
  })

  return { outcome: classify(result.stopReason), message: result.lastMessage }
}
// --8<-- [end:worked_example]
