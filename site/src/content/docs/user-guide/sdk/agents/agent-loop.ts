import { Agent, tool } from '@strands-agents/sdk'
import { z } from 'zod'

// --8<-- [start:cancel_timeout]
const agent = new Agent()

// Cancel after 30 seconds
setTimeout(() => agent.cancel(), 30_000)

const result = await agent.invoke('Analyze this large dataset')

if (result.stopReason === 'cancelled') {
  console.log('Agent was cancelled due to timeout')
}
// --8<-- [end:cancel_timeout]

// --8<-- [start:cancel_signal]
const myTool = tool({
  name: 'long_running_task',
  description: 'A task that respects cancellation',
  inputSchema: z.object({ url: z.string() }),
  callback: async (input, context) => {
    // Forward the cancel signal to APIs that accept AbortSignal
    const response = await fetch(input.url, {
      signal: context?.cancelSignal,
    })
    return response.text()
  },
})
// --8<-- [end:cancel_signal]

// --8<-- [start:cancel_external_signal]
// Timeout-based cancellation
const timedResult = await agent.invoke('Analyze this large dataset', {
  cancelSignal: AbortSignal.timeout(5000),
})

// Custom AbortController: call controller.abort() from anywhere to cancel
const controller = new AbortController()
const controllerResult = await agent.invoke('Hello', {
  cancelSignal: controller.signal,
})
// --8<-- [end:cancel_external_signal]

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
