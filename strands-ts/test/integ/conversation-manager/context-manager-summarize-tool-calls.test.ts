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
        const strategy = Offload.summarize('*', { model }).when({ utilization: 0.5, preserveRecent: 2 })

        const acted = await strategy.apply({ messages: agent.messages, agent, utilization: 1 })

        expect(acted).toBe(true)
        expect(streamSpy).toHaveBeenCalledTimes(1)
        expect(agent.messages).toHaveLength(3)
        const [summary] = agent.messages
        expect(summary!.role).toBe('user')
        expect((summary!.content[0] as TextBlock).text).toMatch(/lookup_order|ORD-48213|FX-7731/)
      },
      120_000
    )
  }
)
