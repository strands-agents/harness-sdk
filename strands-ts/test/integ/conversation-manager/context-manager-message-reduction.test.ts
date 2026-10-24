import { describe, it, expect } from 'vitest'
import { Agent, Message, Offload, TextBlock, tool } from '@strands-agents/sdk'
import { z } from 'zod'
import { bedrock } from '../__fixtures__/model-providers.js'

// Regression tests for https://github.com/strands-agents/harness-sdk/issues/4685: repeated reduction
// keeps a pinned message 0 verbatim, and every reduced history it sends is one Bedrock accepts. A small
// contextWindowLimit makes each model call run the reduction strategies.

const TASK = 'You help with arithmetic. Always use the calculator tool.'

const calculator = tool({
  name: 'calculator',
  description: 'Add two numbers',
  inputSchema: z.object({ a: z.number(), b: z.number() }),
  callback: ({ a, b }) => `${a + b}`,
})

const strategies = {
  drop: () => Offload.drop('*').when({ utilization: 0.5 }),
  truncate: () => Offload.truncate('*', { previewTokens: 50 }).when({ utilization: 0.5 }),
  summarize: () => Offload.summarize('*').when({ utilization: 0.5, preserveRecent: 2 }),
}

describe.skipIf(bedrock.skip)('message-level context reduction', () => {
  describe.each([
    ['no-thinking', bedrock.models.default],
    ['thinking', bedrock.models.reasoning],
  ])('%s', (_, modelOptions) => {
    it.each(Object.entries(strategies))(
      '%s keeps message 0 verbatim and every reduced history valid',
      async (_, makeStrategy) => {
        const agent = new Agent({
          model: bedrock.createModel({ ...modelOptions, maxTokens: 2048, contextWindowLimit: 400 }),
          contextManager: { strategies: [makeStrategy()] },
          tools: [calculator],
          messages: [
            new Message({ role: 'user', content: [new TextBlock(TASK)], metadata: { custom: { pinned: true } } }),
            new Message({ role: 'assistant', content: [new TextBlock('Understood.')] }),
          ],
          printer: false,
        })

        for (let index = 0; index < 4; index++) {
          const result = await agent.invoke(`Use the calculator to add ${index} and ${index + 10}.`)
          expect(result.stopReason).toBe('endTurn')
        }

        expect(agent.messages[0]!.role).toBe('user')
        expect(agent.messages[0]!.content).toEqual([new TextBlock(TASK)])
        expect(agent.messages.length).toBeLessThan(10)
      },
      300_000
    )
  })
})
