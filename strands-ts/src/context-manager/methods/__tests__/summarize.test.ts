import { afterEach, describe, it, expect, vi } from 'vitest'
import { flattenMessagesToContent, summarizeContent } from '../summarize.js'
import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'
import { logger } from '../../../logging/logger.js'
import { ImageBlock } from '../../../types/media.js'
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

    it('renders tool calls and their results as labeled text', () => {
      expect(flattenMessagesToContent(history)).toEqual([
        new TextBlock('\n---\n[user]'),
        new TextBlock('fix the build'),
        new TextBlock('\n---\n[assistant]'),
        new TextBlock('[tool call: shell] {"command":"ls"}'),
        new TextBlock('\n---\n[user]'),
        new TextBlock('[tool result: shell]'),
        new TextBlock('a.ts b.ts'),
      ])
    })

    it('labels error results and results without a matching call', () => {
      const messages = [
        new Message({
          role: 'user',
          content: [
            new ToolResultBlock({ toolUseId: 'call_2', status: 'error', content: [new TextBlock('not found')] }),
            new ToolResultBlock({ toolUseId: 'call_3', status: 'success', content: [new TextBlock('ok')] }),
          ],
        }),
        new Message({
          role: 'assistant',
          content: [new ToolUseBlock({ name: 'shell', toolUseId: 'call_1', input: { command: 'ls' } })],
        }),
        new Message({
          role: 'user',
          content: [new ToolResultBlock({ toolUseId: 'call_1', status: 'error', content: [new TextBlock('denied')] })],
        }),
      ]

      expect(flattenMessagesToContent(messages)).toEqual([
        new TextBlock('\n---\n[user]'),
        new TextBlock('[tool result (error)]'),
        new TextBlock('not found'),
        new TextBlock('[tool result]'),
        new TextBlock('ok'),
        new TextBlock('\n---\n[assistant]'),
        new TextBlock('[tool call: shell] {"command":"ls"}'),
        new TextBlock('\n---\n[user]'),
        new TextBlock('[tool result: shell (error)]'),
        new TextBlock('denied'),
      ])
    })
  })
})

describe('summarizeContent', () => {
  const content = [new TextBlock('notes'), new ImageBlock({ format: 'png', source: { bytes: new Uint8Array([1]) } })]

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not warn when the text-only retry succeeds', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const model = new MockMessageModel()
      .addTurn(new Error('images unsupported'))
      .addTurn({ type: 'textBlock', text: 'summary' })

    expect(await summarizeContent(content, model)).toBe('summary')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('warns when the text-only retry also fails', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const model = new MockMessageModel().addTurn(new Error('images unsupported')).addTurn(new Error('unavailable'))

    expect(await summarizeContent(content, model)).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith('summarization failed after text-only retry')
  })

  it('warns when text-only content fails', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const model = new MockMessageModel().addTurn(new Error('unavailable'))

    expect(await summarizeContent([new TextBlock('notes')], model)).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith('summarization failed')
  })
})
