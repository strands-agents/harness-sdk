import { describe, expect, it } from 'vitest'
import { Agent, tool } from '@strands-agents/sdk'
import { z } from 'zod'

import { allProviders } from './__fixtures__/model-providers.js'

describe.each(allProviders)('Cancellation with $name', ({ name, skip, createModel, supports }) => {
  describe.skipIf(skip)(`${name} Cancellation`, () => {
    it('cancels during model streaming', async () => {
      const agent = new Agent({
        model: createModel(),
        printer: false,
        systemPrompt: 'Write a very long story about a dragon.',
      })

      let streamEventsReceived = 0
      for await (const event of agent.stream('Begin')) {
        if (event.type === 'modelStreamUpdateEvent') {
          streamEventsReceived++
          if (streamEventsReceived === 1) {
            agent.cancel()
          }
        }
      }

      expect(streamEventsReceived).toBeGreaterThanOrEqual(1)

      // Messages should be in a valid, reinvokable state
      const lastMessage = agent.messages[agent.messages.length - 1]!
      expect(lastMessage.role).toBe('assistant')
    })

    it.skipIf(!supports.tools)('cancels before tool execution', async () => {
      let toolExecuted = false
      const trackedCalculator = tool({
        name: 'calculator',
        description: 'Performs basic arithmetic operations. Always use this tool for math.',
        inputSchema: z.object({
          operation: z.enum(['add', 'subtract', 'multiply', 'divide']),
          a: z.number(),
          b: z.number(),
        }),
        callback: async ({ operation, a, b }) => {
          toolExecuted = true
          const ops = { add: a + b, subtract: a - b, multiply: a * b, divide: a / b }
          return `Result: ${ops[operation]}`
        },
      })

      const agent = new Agent({
        model: createModel(),
        printer: false,
        systemPrompt: 'Use the calculator tool for all math. Do not attempt mental math.',
        tools: [trackedCalculator],
      })

      for await (const event of agent.stream('What is 999 * 111?')) {
        if (event.type === 'modelMessageEvent' && event.stopReason === 'toolUse') {
          agent.cancel()
        }
      }

      expect(toolExecuted).toBe(false)

      // Messages should include the assistant's tool use and cancellation tool results
      const toolUseMsg = agent.messages.find((m) => m.content.some((b) => b.type === 'toolUseBlock'))
      expect(toolUseMsg).toBeDefined()
      const toolResultMsg = agent.messages.find((m) =>
        m.content.some((b) => b.type === 'toolResultBlock' && b.status === 'error')
      )
      expect(toolResultMsg).toBeDefined()
    })

    it('cancels from a timer using agent.cancel()', async () => {
      const agent = new Agent({
        model: createModel(),
        printer: false,
        systemPrompt: 'Write an extremely long and detailed story. Never stop writing.',
      })

      // Cancel after a short delay — simulates a timeout or external trigger
      globalThis.setTimeout(() => agent.cancel(), 500)

      const result = await agent.invoke('Write a 10000 word story')

      expect(result.stopReason).toBe('cancelled')
    })

    it('cancels via AbortSignal.timeout()', async () => {
      const agent = new Agent({
        model: createModel(),
        printer: false,
        systemPrompt: 'Write an extremely long and detailed story. Never stop writing.',
      })

      const result = await agent.invoke('Write a 10000 word story', {
        cancelSignal: AbortSignal.timeout(500),
      })

      expect(result.stopReason).toBe('cancelled')
    })

    it('allows reuse after cancellation', async () => {
      const agent = new Agent({
        model: createModel(),
        printer: false,
      })

      // First invocation: cancel during streaming
      for await (const event of agent.stream('Write a very long story')) {
        if (event.type === 'modelStreamUpdateEvent') {
          agent.cancel()
          break
        }
      }

      const lastMessage = agent.messages[agent.messages.length - 1]!
      expect(lastMessage.role).toBe('assistant')

      // Second invocation: should succeed normally
      const result = await agent.invoke('Say the word "pineapple"')
      expect(result.stopReason).toBe('endTurn')
    })
  })
})
