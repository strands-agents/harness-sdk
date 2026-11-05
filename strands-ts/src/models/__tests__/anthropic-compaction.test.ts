import { describe, it, expect, vi } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { AnthropicModel } from '../anthropic.js'
import { Message, TextBlock } from '../../types/messages.js'
import { collectIterator } from '../../__fixtures__/model-test-helpers.js'
import { logger } from '../../logging/logger.js'

const compaction = (text: string, signature = 'sig'): TextBlock =>
  new TextBlock(text, { metadata: { serverSideSummary: { provider: 'anthropic', signature } } })

function createClient(finalMessage: unknown = {}) {
  const stream = vi.fn(() =>
    (async function* () {
      yield { type: 'message_start', message: { role: 'assistant', usage: {} } }
    })()
  )
  const betaStream = vi.fn(() => ({ finalMessage: async () => finalMessage }))
  const client = { messages: { stream }, beta: { messages: { stream: betaStream } } } as unknown as Anthropic
  return { client, stream, betaStream }
}

function createModel(client: Anthropic, serverSideSummary = true): AnthropicModel {
  return new AnthropicModel({
    client,
    modelId: 'm1',
    maxTokens: 1,
    params: { stop_sequences: ['STOP'] },
    modelInfo: { capabilities: { serverSideSummary } },
  })
}

describe('AnthropicModel server-side summary', () => {
  it('summarize sends a compaction request and stores the block as text', async () => {
    const { client, betaStream } = createClient({
      stop_reason: 'compaction',
      content: [{ type: 'compaction', content: 'the summary', signature: 's1' }],
    })
    const messages = [
      new Message({ role: 'user', content: [new TextBlock('hi')] }),
      new Message({ role: 'assistant', content: [new TextBlock('yo')] }),
    ]

    const block = await createModel(client).summarize(messages, { systemPrompt: 'sys', instructions: 'keep ids' })

    const [params, options] = betaStream.mock.calls[0] as unknown as [Record<string, unknown>, Anthropic.RequestOptions]
    expect(params.compaction).toStrictEqual({ type: 'summarize', instructions: 'keep ids' })
    expect(params.stop_sequences).toBeUndefined()
    expect(params.messages).toHaveLength(2)
    expect(options.headers).toStrictEqual({ 'anthropic-beta': 'compact-2026-09-04' })
    expect(block).toStrictEqual(compaction('the summary', 's1'))
  })

  it('summarize returns undefined when the response holds no compaction block', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const { client } = createClient({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'x' }] })

    const block = await createModel(client).summarize([new Message({ role: 'user', content: [new TextBlock('hi')] })])

    expect(block).toBeUndefined()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('compaction returned no summary'))
  })

  it('sends requests from the last compaction block, rebuilt as such', async () => {
    const { client, stream } = createClient()
    const messages = [
      new Message({ role: 'user', content: [new TextBlock('first')] }),
      new Message({ role: 'assistant', content: [compaction('old')] }),
      new Message({ role: 'user', content: [new TextBlock('more')] }),
      new Message({ role: 'assistant', content: [compaction('new', 's2'), new TextBlock('after')] }),
      new Message({ role: 'user', content: [new TextBlock('next')] }),
    ]

    await collectIterator(createModel(client).stream(messages))

    const [request, options] = stream.mock.calls[0] as unknown as [
      Anthropic.MessageStreamParams,
      Anthropic.RequestOptions,
    ]
    expect(request.messages).toStrictEqual([
      {
        role: 'assistant',
        content: [
          { type: 'compaction', content: 'new', signature: 's2' },
          { type: 'text', text: 'after' },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'next' }] },
    ])
    expect(options.headers).toStrictEqual({ 'anthropic-beta': 'compact-2026-09-04' })
  })

  it('sends the text of a compaction block without the capability', async () => {
    const { client, stream } = createClient()
    const messages = [
      new Message({ role: 'user', content: [new TextBlock('first')] }),
      new Message({ role: 'assistant', content: [compaction('old')] }),
    ]

    await collectIterator(createModel(client, false).stream(messages))

    const [request] = stream.mock.calls[0] as unknown as [Anthropic.MessageStreamParams]
    expect(request.messages[1]!.content).toStrictEqual([{ type: 'text', text: 'old' }])
  })

  it('round-trips the metadata through JSON', () => {
    const block = compaction('summary')
    expect(TextBlock.fromJSON(JSON.parse(JSON.stringify(block)))).toStrictEqual(block)
  })
})
