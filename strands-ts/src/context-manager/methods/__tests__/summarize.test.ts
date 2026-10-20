import { describe, it, expect } from 'vitest'
import { flattenMessagesToContent } from '../summarize.js'
import { formatResponsesRequest } from '../../../models/openai/responses-adapter.js'
import { Message, ReasoningBlock, TextBlock, ToolResultBlock, ToolUseBlock } from '../../../types/messages.js'

describe('flattenMessagesToContent', () => {
  it('excludes reasoning blocks', () => {
    const messages = [
      new Message({
        role: 'assistant',
        content: [new ReasoningBlock({ text: 'plan', signature: 'sig' }), new TextBlock('hi')],
      }),
    ]

    expect(flattenMessagesToContent(messages)).toEqual([new TextBlock('\n---\n[assistant]'), new TextBlock('hi')])
  })
  it('skips the role marker for a message with only reasoning', () => {
    const messages = [
      new Message({ role: 'assistant', content: [new ReasoningBlock({ text: 'plan', signature: 'sig' })] }),
      new Message({ role: 'user', content: [new TextBlock('next')] }),
    ]

    expect(flattenMessagesToContent(messages)).toEqual([new TextBlock('\n---\n[user]'), new TextBlock('next')])
  })

  describe('with tool calls', () => {
    // guards against tool-use blocks reaching the summarizer in a user turn (#5291)
    const history = [
      new Message({ role: 'user', content: [new TextBlock('fix the build')] }),
      new Message({
        role: 'assistant',
        content: [new ToolUseBlock({ name: 'shell', toolUseId: 'call_1', input: { command: 'ls' } })],
      }),
      new Message({
        role: 'user',
        content: [
          new ToolResultBlock({ toolUseId: 'call_1', status: 'success', content: [new TextBlock('a.ts b.ts')] }),
        ],
      }),
    ]

    it('renders tool calls as text with the tool name and input', () => {
      expect(flattenMessagesToContent(history)).toEqual([
        new TextBlock('\n---\n[user]'),
        new TextBlock('fix the build'),
        new TextBlock('\n---\n[assistant]'),
        new TextBlock('[tool call: shell] {"command":"ls"}'),
        new TextBlock('\n---\n[user]'),
        new TextBlock('a.ts b.ts'),
      ])
    })

    it('builds a responses api request with no function_call items', () => {
      const summarizerInput = new Message({
        role: 'user',
        content: [new TextBlock('<content>'), ...flattenMessagesToContent(history), new TextBlock('</content>')],
      })

      const request = formatResponsesRequest({ modelId: 'x' }, [summarizerInput], { systemPrompt: 'summarize' }, false)

      expect(request.input).toEqual([
        {
          role: 'user',
          content: [
            { type: 'input_text', text: '<content>' },
            { type: 'input_text', text: '\n---\n[user]' },
            { type: 'input_text', text: 'fix the build' },
            { type: 'input_text', text: '\n---\n[assistant]' },
            { type: 'input_text', text: '[tool call: shell] {"command":"ls"}' },
            { type: 'input_text', text: '\n---\n[user]' },
            { type: 'input_text', text: 'a.ts b.ts' },
            { type: 'input_text', text: '</content>' },
          ],
        },
      ])
    })
  })
})
