import { describe, it, expect } from 'vitest'
import {
  Agent,
  ContextWindowOverflowError,
  Message,
  SummarizingConversationManager,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
  tool,
} from '@strands-agents/sdk'
import { z } from 'zod'
import { bedrock } from '../__fixtures__/model-providers.js'

function textMsg(role: 'user' | 'assistant', text: string): Message {
  return new Message({ role, content: [new TextBlock(text)] })
}

const calculatorTool = tool({
  name: 'calculator',
  description: 'Performs basic arithmetic operations',
  inputSchema: z.object({
    operation: z.enum(['add', 'subtract', 'multiply', 'divide']),
    a: z.number(),
    b: z.number(),
  }),
  callback: async ({ operation, a, b }) => {
    const ops = { add: a + b, subtract: a - b, multiply: a * b, divide: a / b }
    return `Result: ${ops[operation]}`
  },
})

describe.skipIf(bedrock.skip)('SummarizingConversationManager Integration', () => {
  it('summarizes older messages and agent remains functional after summarization', async () => {
    const model = bedrock.createModel({ maxTokens: 1024 })
    const messages: Message[] = [
      textMsg('user', 'Hello, I am testing a conversation manager.'),
      textMsg('assistant', 'Hello! I am here to help you test the conversation manager.'),
      textMsg('user', 'Can you tell me about the history of computers?'),
      textMsg(
        'assistant',
        'The history of computers spans many centuries, from the abacus to modern machines. Key milestones include the Pascaline (1642), ENIAC (1945), and the personal computer revolution of the 1980s.'
      ),
      textMsg('user', 'What were the first computers like?'),
      textMsg(
        'assistant',
        'Early computers like ENIAC were enormous room-filling machines weighing about 30 tons, using thousands of vacuum tubes that generated tremendous heat and frequently failed.'
      ),
    ]
    const lastTwo = messages.slice(-2)

    const manager = new SummarizingConversationManager({
      summaryRatio: 0.5,
      preserveRecentMessages: 2,
    })
    const agent = new Agent({
      model,
      conversationManager: manager,
      printer: false,
      messages,
    })

    const result = await manager.reduce({
      agent,
      model,
      error: new ContextWindowOverflowError('overflow'),
    })

    expect(result).toBe(true)
    // 6 messages, 50% ratio, preserve 2 → summarize 3, keep 3 → 1 summary + 3 = 4
    expect(agent.messages).toHaveLength(4)

    // First message should be the summary
    const summary = agent.messages[0]!
    expect(summary.role).toBe('user')
    const summaryText = summary.content.find((b) => b.type === 'textBlock') as TextBlock
    expect(summaryText).toBeDefined()
    expect(summaryText.text.length).toBeGreaterThan(50)

    // Recent messages preserved
    expect(agent.messages.slice(-2)).toEqual(lastTwo)

    // Agent should still be functional
    const invokeResult = await agent.invoke('Thanks for the overview!')
    expect(invokeResult.stopReason).toBe('endTurn')
    expect(invokeResult.lastMessage.role).toBe('assistant')
  })

  it('keeps tool use/result pairs balanced after summarization', async () => {
    const model = bedrock.createModel({ maxTokens: 1024 })
    // Messages indexed 0-13. With ratio 0.6 the initial split lands at index 8
    // (a toolResult for calc-1). The split-point adjuster walks forward past orphaned
    // tool results to index 9 (plain text "25 + 37 = 62"), so indices 0-8 are summarized.
    // The remaining messages (indices 9-13) include exactly one tool use/result pair
    // (the weather tool at indices 11-12).
    const messages: Message[] = [
      /* 0  */ textMsg('user', 'Hello, can you help me with some calculations?'),
      /* 1  */ textMsg('assistant', 'Of course! I can help with calculations.'),
      /* 2  */ textMsg('user', 'What is the current time?'),
      /* 3  */ new Message({
        role: 'assistant',
        content: [new ToolUseBlock({ name: 'get_time', toolUseId: 'time-1', input: {} })],
      }),
      /* 4  */ new Message({
        role: 'user',
        content: [
          new ToolResultBlock({
            toolUseId: 'time-1',
            status: 'success',
            content: [new TextBlock('2024-01-15 14:30:00')],
          }),
        ],
      }),
      /* 5  */ textMsg('assistant', 'The current time is 2024-01-15 14:30:00.'),
      /* 6  */ textMsg('user', 'What is 25 + 37?'),
      /* 7  */ new Message({
        role: 'assistant',
        content: [
          new ToolUseBlock({ name: 'calculator', toolUseId: 'calc-1', input: { operation: 'add', a: 25, b: 37 } }),
        ],
      }),
      /* 8  */ new Message({
        role: 'user',
        content: [
          new ToolResultBlock({
            toolUseId: 'calc-1',
            status: 'success',
            content: [new TextBlock('62')],
          }),
        ],
      }),
      /* 9  */ textMsg('assistant', '25 + 37 = 62'),
      /* 10 */ textMsg('user', 'What is the weather in San Francisco?'),
      /* 11 */ new Message({
        role: 'assistant',
        content: [new ToolUseBlock({ name: 'get_weather', toolUseId: 'weather-1', input: { city: 'San Francisco' } })],
      }),
      /* 12 */ new Message({
        role: 'user',
        content: [
          new ToolResultBlock({
            toolUseId: 'weather-1',
            status: 'success',
            content: [new TextBlock('Sunny and 72°F in San Francisco')],
          }),
        ],
      }),
      /* 13 */ textMsg('assistant', 'The weather in San Francisco is sunny and 72°F.'),
    ]

    const manager = new SummarizingConversationManager({
      summaryRatio: 0.6,
      preserveRecentMessages: 3,
    })
    const agent = new Agent({
      model,
      conversationManager: manager,
      tools: [calculatorTool],
      printer: false,
      messages,
    })

    const result = await manager.reduce({
      agent,
      model,
      error: new ContextWindowOverflowError('overflow'),
    })

    expect(result).toBe(true)
    // 9 summarized → 1 summary + 5 remaining = 6
    expect(agent.messages).toHaveLength(6)

    // Only the weather tool pair (indices 11-12) survives — time and calculator pairs were summarized
    let toolUseCount = 0
    let toolResultCount = 0
    for (const msg of agent.messages) {
      for (const block of msg.content) {
        if (block.type === 'toolUseBlock') toolUseCount++
        if (block.type === 'toolResultBlock') toolResultCount++
      }
    }
    expect(toolUseCount).toBe(1)
    expect(toolResultCount).toBe(1)

    // Agent should still work with tools
    const invokeResult = await agent.invoke('Calculate 15 + 28 for me.')
    expect(invokeResult.stopReason).toBe('endTurn')

    // Verify calculator tool was used
    const hasCalcUse = agent.messages.some((msg) =>
      msg.content.some((block) => block.type === 'toolUseBlock' && block.name === 'calculator')
    )
    expect(hasCalcUse).toBe(true)
  })
})
