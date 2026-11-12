import { describe, it, expect, vi } from 'vitest'
import { ModelProxy } from '../model-proxy.js'
import type { ToolSpec } from '../../tools/types.js'
import type { StreamAggregatedResult } from '../model.js'
import { type ModelStreamEvent } from '../streaming.js'
import { InvocationContextImpl } from '../../agent/invocation-context.js'
import { anyTrackingId } from '../../__fixtures__/message-helpers.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import {
  InjectedBlock,
  Message,
  SummaryBlock,
  TextBlock,
  ToolReferenceBlock,
  ToolResultBlock,
  UnknownBlock,
  type ContentBlock,
} from '../../types/messages.js'

function userMessage(text: string): Message {
  return new Message({ role: 'user', content: [new TextBlock(text)] })
}

/** Drains a streamAggregated generator, collecting every yielded event and its final result. */
async function drain(
  stream: AsyncGenerator<ModelStreamEvent | ContentBlock, StreamAggregatedResult, undefined>
): Promise<{ events: Array<ModelStreamEvent | ContentBlock>; result: StreamAggregatedResult }> {
  const events: Array<ModelStreamEvent | ContentBlock> = []
  let next = await stream.next()
  while (!next.done) {
    events.push(next.value)
    next = await stream.next()
  }
  return { events, result: next.value }
}

describe('ModelProxy', () => {
  describe('usage recording', () => {
    it('accumulates a clean call usage into the invocation context total', async () => {
      const model = new MockMessageModel().addTurn(
        { type: 'textBlock', text: 'hi' },
        { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }
      )
      const invocationContext = new InvocationContextImpl()

      await drain(new ModelProxy(model).streamAggregated([userMessage('go')], undefined, invocationContext))

      expect(invocationContext.usage).toEqual({ turnsTaken: 0, inputTokens: 10, outputTokens: 5, totalTokens: 15 })
    })

    it('accumulates across calls that share one invocation context', async () => {
      const invocationContext = new InvocationContextImpl()
      const first = new MockMessageModel().addTurn(
        { type: 'textBlock', text: 'one' },
        { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }
      )
      const second = new MockMessageModel().addTurn(
        { type: 'textBlock', text: 'two' },
        { usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } }
      )

      await drain(new ModelProxy(first).streamAggregated([userMessage('go')], undefined, invocationContext))
      await drain(new ModelProxy(second).streamAggregated([userMessage('again')], undefined, invocationContext))

      expect(invocationContext.usage).toEqual({ turnsTaken: 0, inputTokens: 30, outputTokens: 15, totalTokens: 45 })
    })

    it('records nothing when the model call throws', async () => {
      const model = new MockMessageModel().addTurn(new Error('boom'))
      const invocationContext = new InvocationContextImpl()

      await expect(
        drain(new ModelProxy(model).streamAggregated([userMessage('go')], undefined, invocationContext))
      ).rejects.toThrow('boom')

      expect(invocationContext.usage).toEqual(new InvocationContextImpl().usage)
    })

    it('records nothing when the model reports no usage', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'hi' })
      const invocationContext = new InvocationContextImpl()

      await drain(new ModelProxy(model).streamAggregated([userMessage('go')], undefined, invocationContext))

      expect(invocationContext.usage).toEqual(new InvocationContextImpl().usage)
    })

    it('is a no-op when called without an invocation context', async () => {
      const model = new MockMessageModel().addTurn(
        { type: 'textBlock', text: 'hi' },
        { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }
      )

      const { result } = await drain(new ModelProxy(model).streamAggregated([userMessage('go')]))

      expect(result.metadata?.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })
    })
  })

  describe('pass-through', () => {
    it('yields the same events as the underlying model', async () => {
      const build = (): MockMessageModel =>
        new MockMessageModel().addTurn(
          { type: 'textBlock', text: 'hello' },
          { usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } }
        )

      const direct = await drain(build().streamAggregated([userMessage('go')]))
      const proxied = await drain(
        new ModelProxy(build()).streamAggregated([userMessage('go')], undefined, new InvocationContextImpl())
      )

      expect(proxied.events).toEqual(direct.events)
      expect(proxied.result).toEqual({
        ...direct.result,
        message: { ...direct.result.message, trackingId: anyTrackingId },
      })
    })
  })

  describe('unknown blocks', () => {
    it('gives a tool result whose content is all unknown a placeholder text', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'ok' })
      const streamSpy = vi.spyOn(model, 'stream')
      const unknown = new UnknownBlock({ futureBlock: { name: 'shell' } })
      const kept = new ToolResultBlock({
        toolUseId: 't-2',
        status: 'success',
        content: [new TextBlock('done'), unknown],
      })
      const messages = [
        new Message({
          role: 'user',
          content: [new ToolResultBlock({ toolUseId: 't-1', status: 'success', content: [unknown, unknown] }), kept],
          trackingId: 'msg-1',
        }),
      ]

      await drain(new ModelProxy(model).streamAggregated(messages))

      expect(streamSpy.mock.calls[0]![0]).toEqual([
        new Message({
          role: 'user',
          content: [
            new ToolResultBlock({
              toolUseId: 't-1',
              status: 'success',
              content: [new TextBlock('[unsupported content omitted]')],
            }),
            kept,
          ],
          trackingId: 'msg-1',
        }),
      ])
      expect(messages[0]!.content[0]).toEqual(
        new ToolResultBlock({ toolUseId: 't-1', status: 'success', content: [unknown, unknown] })
      )
    })
  })

  describe('injected blocks', () => {
    /** Sends the messages through the proxy and returns the messages the model received. */
    async function sent(messages: Message[]): Promise<Message[]> {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'ok' })
      const streamSpy = vi.spyOn(model, 'stream')
      await drain(new ModelProxy(model).streamAggregated(messages))
      return streamSpy.mock.calls[0]![0]
    }

    it.each([
      ['a prompt', [new TextBlock('Refactor the tokenizer.')], 'reminder', '\n\nreminder'],
      [
        'a tool result turn',
        [new ToolResultBlock({ toolUseId: 'tool-1', status: 'success', content: [new TextBlock('done')] })],
        'reminder',
        '\n\nreminder',
      ],
      ['an empty user message', [], 'reminder', 'reminder'],
      ['text that starts with a newline', [new TextBlock('Refactor the tokenizer.')], '\nreminder', '\nreminder'],
    ])(
      'sends the text apart from the content before it, for %s',
      async (_name, content: ContentBlock[], text, sentText) => {
        const messages = [
          new Message({
            role: 'user',
            content: [...content, new InjectedBlock({ text, source: 'test' })],
            trackingId: 'msg-1',
          }),
        ]
        expect(await sent(messages)).toEqual([
          new Message({ role: 'user', content: [...content, new TextBlock(sentText)], trackingId: 'msg-1' }),
        ])
      }
    )

    it('sends each of several injected blocks as its own text block, in place', async () => {
      const messages = [
        new Message({
          role: 'user',
          content: [
            new TextBlock('Refactor the tokenizer.'),
            new InjectedBlock({ text: 'one', source: 'test' }),
            new InjectedBlock({ text: 'two', source: 'test' }),
          ],
          trackingId: 'msg-1',
          metadata: { custom: { source: 'test' } },
        }),
      ]

      expect(await sent(messages)).toEqual([
        new Message({
          role: 'user',
          content: [new TextBlock('Refactor the tokenizer.'), new TextBlock('\n\none'), new TextBlock('\n\ntwo')],
          trackingId: 'msg-1',
          metadata: { custom: { source: 'test' } },
        }),
      ])
    })

    it('leaves out the injected blocks of earlier user messages', async () => {
      const answer = new Message({ role: 'assistant', content: [new TextBlock('Done.')], trackingId: 'msg-2' })
      const latest = userMessage('Now the docs.')
      const messages = [
        new Message({
          role: 'user',
          content: [new TextBlock('Refactor.'), new InjectedBlock({ text: 'reminder', source: 'test' })],
          trackingId: 'msg-1',
        }),
        answer,
        latest,
      ]

      expect(await sent(messages)).toEqual([
        new Message({ role: 'user', content: [new TextBlock('Refactor.')], trackingId: 'msg-1' }),
        answer,
        latest,
      ])
    })

    it('keeps the cache point ahead of the latest injected text, also when an assistant message follows', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'ok' })
      const streamSpy = vi.spyOn(model, 'stream')
      const messages = [
        new Message({
          role: 'user',
          content: [
            new TextBlock('Refactor.'),
            new InjectedBlock({ text: 'reminder', source: 'test' }),
            new TextBlock('\n\nper-call text'),
          ],
        }),
      ]
      const proxy = new ModelProxy(model)

      await drain(proxy.streamAggregated(messages, { dynamicTrailingBlocks: 1 }))
      await drain(
        proxy.streamAggregated([...messages, new Message({ role: 'assistant', content: [new TextBlock('Sure')] })])
      )

      expect(streamSpy.mock.calls.map((call) => call[1])).toStrictEqual([
        { dynamicTrailingBlocks: 2 },
        { dynamicTrailingBlocks: 2 },
      ])
    })

    it('sends text to a custom provider serving a model that takes temporary messages', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'ok' })
      model.updateConfig({ modelId: 'claude-opus-5-5' })
      const streamSpy = vi.spyOn(model, 'stream')
      const messages = [
        new Message({
          role: 'user',
          content: [new TextBlock('Refactor.'), new InjectedBlock({ text: 'reminder', source: 'test' })],
          trackingId: 'msg-1',
        }),
      ]

      await drain(new ModelProxy(model).streamAggregated(messages))

      expect(streamSpy.mock.calls[0]![0]).toEqual([
        new Message({
          role: 'user',
          content: [new TextBlock('Refactor.'), new TextBlock('\n\nreminder')],
          trackingId: 'msg-1',
        }),
      ])
    })

    it('passes injected blocks through to a model that takes temporary messages', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'ok' })
      model.updateConfig({ modelInfo: { capabilities: { temporaryMessages: true } } })
      const streamSpy = vi.spyOn(model, 'stream')
      const messages = [
        new Message({
          role: 'user',
          content: [new TextBlock('Refactor.'), new InjectedBlock({ text: 'reminder', source: 'test' })],
        }),
        new Message({ role: 'assistant', content: [new TextBlock('Done.')] }),
        userMessage('Now the docs.'),
      ]

      await drain(new ModelProxy(model).streamAggregated(messages))

      expect(streamSpy.mock.calls[0]![0]).toBe(messages)
    })

    it('counts the messages it would send', async () => {
      const model = new MockMessageModel()
      const countSpy = vi.spyOn(model, 'countTokens')
      const messages = [
        new Message({
          role: 'user',
          content: [new TextBlock('Refactor.'), new InjectedBlock({ text: 'reminder', source: 'test' })],
          trackingId: 'msg-1',
        }),
      ]

      await new ModelProxy(model).countTokens(messages, { systemPrompt: 'Be brief.' })

      expect(countSpy.mock.calls[0]).toEqual([
        [
          new Message({
            role: 'user',
            content: [new TextBlock('Refactor.'), new TextBlock('\n\nreminder')],
            trackingId: 'msg-1',
          }),
        ],
        { systemPrompt: 'Be brief.' },
      ])
    })

    it('leaves out an injected block outside a user message', async () => {
      const prompt = userMessage('go')
      const messages = [
        prompt,
        new Message({
          role: 'assistant',
          content: [new TextBlock('Hi'), new InjectedBlock({ text: 'reminder', source: 'test' }), new TextBlock('Bye')],
          trackingId: 'msg-2',
        }),
      ]

      expect(await sent(messages)).toEqual([
        prompt,
        new Message({ role: 'assistant', content: [new TextBlock('Hi'), new TextBlock('Bye')], trackingId: 'msg-2' }),
      ])
    })

    it('does not change the messages it was given', async () => {
      const messages = [
        new Message({
          role: 'user',
          content: [new TextBlock('Refactor the tokenizer.'), new InjectedBlock({ text: 'reminder', source: 'test' })],
        }),
      ]

      await sent(messages)

      expect(messages[0]!.content).toEqual([
        new TextBlock('Refactor the tokenizer.'),
        new InjectedBlock({ text: 'reminder', source: 'test' }),
      ])
    })

    it('passes messages without an injected block through as they are', async () => {
      const messages = [userMessage('go')]

      expect(await sent(messages)).toBe(messages)
    })
  })

  describe('deferred tools', () => {
    const definition = {
      name: 'shell',
      description: 'Run a command',
      inputSchema: { type: 'object' as const, properties: { command: { type: 'string' as const } } },
    }
    const history = (): Message[] => [
      new Message({
        role: 'user',
        content: [
          new ToolResultBlock({
            toolUseId: 't-1',
            status: 'success',
            content: [new ToolReferenceBlock({ name: 'shell' })],
          }),
        ],
        trackingId: 'msg-1',
      }),
    ]

    /** Sends the history through the proxy and returns the tool result content the model received. */
    async function sentContent(
      deferredTools?: 'native' | 'stubs' | 'unsupported',
      toolSpecs: ToolSpec[] = [definition]
    ): Promise<ToolResultBlock['content']> {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'ok' })
      model.updateConfig({ modelInfo: { capabilities: { deferredTools } } })
      const streamSpy = vi.spyOn(model, 'stream')
      await drain(new ModelProxy(model).streamAggregated(history(), { toolSpecs }))
      return (streamSpy.mock.calls[0]![0][0]!.content[0] as ToolResultBlock).content
    }

    /** Sends one deferred spec and one pinned spec through the proxy and returns the specs the model received. */
    async function sentToolSpecs(deferredTools?: 'native' | 'stubs' | 'unsupported'): Promise<ToolSpec[] | undefined> {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'ok' })
      model.updateConfig({ modelInfo: { capabilities: { deferredTools } } })
      const streamSpy = vi.spyOn(model, 'stream')
      await drain(
        new ModelProxy(model).streamAggregated([userMessage('go')], {
          toolSpecs: [{ ...definition, deferLoading: true }, pinned],
        })
      )
      return streamSpy.mock.calls[0]![1]?.toolSpecs
    }
    const pinned = { name: 'strands_load_tools', description: 'Load tools.', inputSchema: { type: 'object' as const } }

    it('sends a deferred spec as a stub with an open schema to a model that takes stubs', async () => {
      expect(await sentToolSpecs('stubs')).toEqual([
        {
          name: 'shell',
          description: 'Run a command Call strands_load_tools with this name for its parameters first.',
          inputSchema: { type: 'object' },
        },
        pinned,
      ])
    })

    it.each([
      ['a model that defers natively', 'native' as const],
      ['a model without deferred tools', 'unsupported' as const],
    ])('sends the deferred spec as it is to %s', async (_name, deferredTools) => {
      expect(await sentToolSpecs(deferredTools)).toEqual([{ ...definition, deferLoading: true }, pinned])
    })

    it('passes the reference to a model that defers tools natively, whose provider sends it', async () => {
      expect(await sentContent('native')).toEqual([new ToolReferenceBlock({ name: 'shell' })])
    })

    it.each([
      ['a model that takes stubs', 'stubs' as const],
      ['a model without deferred tools', 'unsupported' as const],
    ])("sends the call's parameters for the tool as text to %s", async (_name, deferredTools) => {
      const changed = { ...definition, inputSchema: { type: 'object' as const, properties: {} } }

      expect(await sentContent(deferredTools, [changed])).toEqual([
        new TextBlock(`shell parameters: ${JSON.stringify(changed.inputSchema)}`),
      ])
    })

    it('names the tool when the call does not include it', async () => {
      expect(await sentContent(undefined, [])).toEqual([
        new TextBlock("Loaded tool shell, which this request doesn't include."),
      ])
    })
  })

  describe('summary blocks', () => {
    const summaryHistory = (): Message[] => [
      new Message({
        role: 'assistant',
        content: [
          new SummaryBlock({ provider: 'anthropic', signature: 'SIG', text: 'SUMMARY' }),
          new TextBlock('next'),
        ],
      }),
      userMessage('go'),
    ]

    it.each([undefined, false])(
      'sends the summary text to a model with serverSideSummary %s',
      async (serverSideSummary) => {
        const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'ok' })
        model.updateConfig({ modelInfo: { capabilities: { serverSideSummary } } })
        const streamSpy = vi.spyOn(model, 'stream')
        const messages = summaryHistory()

        await drain(new ModelProxy(model).streamAggregated(messages))

        const sent = streamSpy.mock.calls[0]![0]
        expect(sent[0]!.content).toEqual([new TextBlock('SUMMARY'), new TextBlock('next')])
        expect(messages[0]!.content[0]).toEqual(summaryHistory()[0]!.content[0])
        expect(messages[0]!.content[0]).toBeInstanceOf(SummaryBlock)
      }
    )

    it('keeps the summary block for a model with server-side summary', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'ok' })
      model.updateConfig({ modelInfo: { capabilities: { serverSideSummary: true } } })
      const streamSpy = vi.spyOn(model, 'stream')
      const messages = summaryHistory()

      await drain(new ModelProxy(model).streamAggregated(messages))

      expect(streamSpy.mock.calls[0]![0]).toBe(messages)
    })
  })
})
