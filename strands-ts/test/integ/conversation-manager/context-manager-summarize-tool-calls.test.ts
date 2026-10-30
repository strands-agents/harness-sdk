import { describe, it, expect, vi } from 'vitest'
import { Agent, Message, Offload, TextBlock, ToolResultBlock, ToolUseBlock } from '@strands-agents/sdk'
import { anthropic, bedrock, openai, openaiResponses } from '../__fixtures__/model-providers.js'

// Regression tests for https://github.com/strands-agents/harness-sdk/issues/5291: summarizing a history that
// holds a tool call takes a single summarizer request on every provider, and the summary reflects the call.

const ORDER_ID = 'ORD-48213'

function toolCallHistory(): Message[] {
  return [
    new Message({ role: 'user', content: [new TextBlock('Where is my order?')] }),
    new Message({
      role: 'assistant',
      content: [new ToolUseBlock({ name: 'lookup_order', toolUseId: 'call_1', input: { orderId: ORDER_ID } })],
    }),
    new Message({
      role: 'user',
      content: [
        new ToolResultBlock({
          toolUseId: 'call_1',
          status: 'success',
          content: [new TextBlock('Shipped via FedEx, tracking FX-7731, arriving Thursday.')],
        }),
      ],
    }),
    new Message({ role: 'assistant', content: [new TextBlock('Your order shipped and arrives Thursday.')] }),
    new Message({ role: 'user', content: [new TextBlock('Thanks. Can I change the delivery address?')] }),
  ]
}

describe.each([openaiResponses, openai, bedrock, anthropic])(
  'summarizing a tool-call history with $name',
  ({ skip, createModel }) => {
    it.skipIf(skip)(
      'summarizes the tool call in a single summarizer request',
      async () => {
        const model = createModel()
        const streamSpy = vi.spyOn(model, 'stream')
        const agent = new Agent({ model, printer: false, messages: toolCallHistory() })
        const strategy = Offload.summarize('*', { model }).when({ contextUtilization: '50%', preserveRecent: 2 })

        const acted = await strategy.apply({ messages: agent.messages, agent, utilization: 1 })

        expect(acted).toBe(true)
        expect(streamSpy).toHaveBeenCalledTimes(1)
        const summaries = agent.messages
          .flatMap((message) => message.content)
          .filter((block) => block instanceof TextBlock && block.metadata?.offloaded?.removedMessages === 2)
        expect(summaries).toHaveLength(1)
        expect((summaries[0] as TextBlock).text).toMatch(/lookup_order|ORD-48213/)
      },
      120_000
    )
  }
)
