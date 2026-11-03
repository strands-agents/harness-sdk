import { describe, it, expect } from 'vitest'
import { flattenMessagesToContent } from '../summarize.js'
import { AudioBlock, ImageBlock, VideoBlock } from '../../types/media.js'
import { CitationsBlock } from '../../types/citations.js'
import {
  CachePointBlock,
  GuardContentBlock,
  JsonBlock,
  Message,
  ReasoningBlock,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from '../../types/messages.js'

describe('flattenMessagesToContent', () => {
  it('renders tool result JSON as text and video as a placeholder, and passes text and images through', () => {
    const bytes = new Uint8Array([1])
    const image = new ImageBlock({ format: 'png', source: { bytes } })
    const content = [
      new TextBlock('out'),
      new JsonBlock({ json: { ok: true } }),
      new VideoBlock({ format: 'mp4', source: { bytes } }),
      image,
    ]
    const messages = [
      new Message({ role: 'user', content: [new ToolResultBlock({ toolUseId: 't1', status: 'success', content })] }),
    ]

    expect(flattenMessagesToContent(messages)).toEqual([
      new TextBlock('\n---\n[user]'),
      new TextBlock('[tool result]'),
      new TextBlock('out'),
      new TextBlock(JSON.stringify({ ok: true }, null, 2)),
      new TextBlock('[video omitted]'),
      image,
    ])
  })

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

  it('passes only text, images, and documents through and renders other blocks as text', () => {
    const bytes = new Uint8Array([1])
    const image = new ImageBlock({ format: 'png', source: { bytes } })
    const messages = [
      new Message({
        role: 'user',
        content: [
          new GuardContentBlock({ text: { text: 'guarded text', qualifiers: [] } }),
          new VideoBlock({ format: 'mp4', source: { bytes } }),
          new AudioBlock({ format: 'mp3', source: { bytes } }),
          image,
          new CachePointBlock({ cacheType: 'default' }),
          new ToolResultBlock({
            toolUseId: 'call_1',
            status: 'success',
            content: [new JsonBlock({ json: { ok: true } }), new VideoBlock({ format: 'mp4', source: { bytes } })],
          }),
        ],
      }),
      new Message({
        role: 'assistant',
        content: [new CitationsBlock({ citations: [], content: [{ text: 'cited answer' }] })],
      }),
    ]

    expect(flattenMessagesToContent(messages)).toEqual([
      new TextBlock('\n---\n[user]'),
      new TextBlock('guarded text'),
      new TextBlock('[video omitted]'),
      new TextBlock('[audio omitted]'),
      image,
      new TextBlock('[tool result]'),
      new TextBlock(JSON.stringify({ ok: true }, null, 2)),
      new TextBlock('[video omitted]'),
      new TextBlock('\n---\n[assistant]'),
      new TextBlock('cited answer'),
    ])
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
