import { describe, expect, it, vi } from 'vitest'
import type OpenAI from 'openai'
import { Message, TextBlock, ToolResultBlock, ToolUseBlock } from '../../../types/messages.js'
import { ImageBlock } from '../../../types/media.js'
import { formatResponsesRequest } from '../responses-adapter.js'
import { OpenAIModel } from '../model.js'
import type { OpenAIResponsesConfig } from '../types.js'
import type { CacheConfig, StreamOptions } from '../../model.js'
import type { ModelInfo } from '../../model-info.js'
import { logger } from '../../../logging/logger.js'

const marker = { mode: 'explicit' }
const config: OpenAIResponsesConfig = { modelId: 'gpt-6-sol', cacheConfig: {} }
const user = (...texts: string[]): Message => new Message({ role: 'user', content: texts.map((t) => new TextBlock(t)) })

/** Formats a request with the model info the provider resolves for `modelConfig`. */
function format(modelConfig: OpenAIResponsesConfig, messages: Message[], options?: StreamOptions): object {
  const { modelInfo } = new OpenAIModel({ ...modelConfig, api: 'responses', client: {} as OpenAI })
  return formatResponsesRequest(modelConfig, messages, options, false, modelInfo)
}

function request(messages: Message[], options?: StreamOptions, overrides?: OpenAIResponsesConfig): object {
  return format({ ...config, ...overrides }, messages, options)
}

function input(messages: Message[], options?: StreamOptions): unknown {
  return (request(messages, options) as { input: unknown }).input
}

/** Expected input for a one-text user message, with `checkpoint` as its breakpoint when given. */
function textInput(text: string, checkpoint?: object): unknown[] {
  const part = { type: 'input_text', text, ...(checkpoint && { prompt_cache_breakpoint: checkpoint }) }
  return [{ role: 'user', content: [part] }]
}

describe('Responses durable prompt caching', () => {
  it('checkpoints stable user content before the injected tail without mutating history', () => {
    const messages = [user('question', 'temporary')]
    const before = messages.map((m) => m.toJSON())
    expect(request(messages, { dynamicTrailingBlocks: 1 })).toStrictEqual({
      model: 'gpt-6-sol',
      stream: true,
      store: false,
      prompt_cache_options: { mode: 'explicit' },
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'question', prompt_cache_breakpoint: marker },
            { type: 'input_text', text: 'temporary' },
          ],
        },
      ],
    })
    expect(messages.map((m) => m.toJSON())).toEqual(before)
  })

  it('retains the previous checkpoint after the old injection disappears and history grows', () => {
    const previous = input([user('first', 'old context')], { dynamicTrailingBlocks: 1 })
    const next = input(
      [
        user('first'),
        new Message({ role: 'assistant', content: [new TextBlock('answer')] }),
        user('second', 'new context'),
      ],
      { dynamicTrailingBlocks: 1 }
    )
    expect(previous).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'first', prompt_cache_breakpoint: marker },
          { type: 'input_text', text: 'old context' },
        ],
      },
    ])
    expect(next).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'first', prompt_cache_breakpoint: marker }] },
      { role: 'assistant', content: 'answer' },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'second', prompt_cache_breakpoint: marker },
          { type: 'input_text', text: 'new context' },
        ],
      },
    ])
  })

  it('excludes multiple temporary blocks and marks an earlier message when the latest is all dynamic', () => {
    expect(input([user('stable', 'memory', 'todo')], { dynamicTrailingBlocks: 2 })).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'stable', prompt_cache_breakpoint: marker },
          { type: 'input_text', text: 'memory' },
          { type: 'input_text', text: 'todo' },
        ],
      },
    ])
    expect(input([user('earlier'), user('only dynamic')], { dynamicTrailingBlocks: 1 })).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'earlier', prompt_cache_breakpoint: marker }] },
      { role: 'user', content: [{ type: 'input_text', text: 'only dynamic' }] },
    ])
  })

  it('puts temporary context after all parallel tool outputs and keeps replay serialization stable', () => {
    const results = [
      new ToolResultBlock({ toolUseId: 'a', status: 'success', content: [new TextBlock('one')] }),
      new ToolResultBlock({ toolUseId: 'b', status: 'success', content: [new TextBlock('two')] }),
    ]
    const toolMessage = new Message({ role: 'user', content: results })
    const injected = new Message({ role: 'user', content: [...results, new TextBlock('temporary')] })
    const expected = [
      { type: 'function_call_output', call_id: 'a', output: [{ type: 'input_text', text: 'one' }] },
      {
        type: 'function_call_output',
        call_id: 'b',
        output: [{ type: 'input_text', text: 'two', prompt_cache_breakpoint: marker }],
      },
    ]
    expect(input([injected], { dynamicTrailingBlocks: 1 })).toEqual([
      ...expected,
      { role: 'user', content: [{ type: 'input_text', text: 'temporary' }] },
    ])
    expect(input([toolMessage])).toEqual(expected)
  })

  it('preserves tool calls and checkpoints stable input when injection is skipped on a tool continuation', () => {
    const call = new Message({
      role: 'assistant',
      content: [new ToolUseBlock({ toolUseId: 'a', name: 'lookup', input: {} })],
    })
    expect(input([user('question'), call])).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'question', prompt_cache_breakpoint: marker }] },
      { type: 'function_call', call_id: 'a', name: 'lookup', arguments: '{}' },
    ])
  })

  it('marks trailing durable media as the checkpoint', () => {
    const image = new ImageBlock({ format: 'png', source: { bytes: new Uint8Array([1, 2, 3]) } })
    const msg = new Message({ role: 'user', content: [new TextBlock('stable'), image, new TextBlock('temporary')] })
    expect(input([msg], { dynamicTrailingBlocks: 1 })).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'stable' },
          { type: 'input_image', image_url: 'data:image/png;base64,AQID', prompt_cache_breakpoint: marker },
          { type: 'input_text', text: 'temporary' },
        ],
      },
    ])
  })

  it('checkpoints durable image-only input', () => {
    const image = new ImageBlock({ format: 'png', source: { bytes: new Uint8Array([1, 2, 3]) } })
    const req = request([new Message({ role: 'user', content: [image] })])
    expect(req).toHaveProperty('prompt_cache_options', { mode: 'explicit' })
    expect(req).toHaveProperty('input', [
      {
        role: 'user',
        content: [{ type: 'input_image', image_url: 'data:image/png;base64,AQID', prompt_cache_breakpoint: marker }],
      },
    ])
  })

  it('keeps implicit caching when no durable input part exists', () => {
    const req = request([new Message({ role: 'assistant', content: [new TextBlock('hello')] })])
    expect(req).not.toHaveProperty('prompt_cache_options')
    expect(JSON.stringify(req)).not.toContain('prompt_cache_breakpoint')
  })

  it.each([
    // Durable text outputs join into one checkpointed block.
    {
      texts: ['one', 'two'],
      dynamicTrailingBlocks: 0,
      output: [{ type: 'input_text', text: 'one\ntwo', prompt_cache_breakpoint: marker }],
    },
    // A temporary tool output uses the same array form, without a checkpoint.
    { texts: ['out'], dynamicTrailingBlocks: 1, output: [{ type: 'input_text', text: 'out' }] },
    // An empty output stays a string: an empty text block would be a meaningless checkpoint.
    { texts: [], dynamicTrailingBlocks: 0, output: '' },
  ])(
    'formats tool output for texts=$texts, dynamicTrailingBlocks=$dynamicTrailingBlocks',
    ({ texts, dynamicTrailingBlocks, output }) => {
      const content = texts.map((t) => new TextBlock(t))
      const result = new ToolResultBlock({ toolUseId: 'a', status: 'success', content })
      const blocks = dynamicTrailingBlocks ? [new TextBlock('durable'), result] : [result]
      const items = input([new Message({ role: 'user', content: blocks })], { dynamicTrailingBlocks }) as unknown[]
      expect(items.at(-1)).toEqual({ type: 'function_call_output', call_id: 'a', output })
    }
  )

  it('avoids implicit writes when the only text is a temporary suffix', () => {
    const req = request([user('temporary')], { dynamicTrailingBlocks: 1 })
    expect(req).toHaveProperty('prompt_cache_options', { mode: 'explicit' })
    expect(req).toHaveProperty('input', textInput('temporary'))
  })

  it('retains historical lookup boundaries independently of the provider write limit', () => {
    const messages = Array.from({ length: 8 }, (_, i) => user(`turn ${i}`))
    const serialized = JSON.stringify(input(messages))
    expect(serialized.match(/prompt_cache_breakpoint/g)).toHaveLength(8)
    expect(input(messages)).toEqual(
      messages.map((_, i) => ({
        role: 'user',
        content: [{ type: 'input_text', text: `turn ${i}`, prompt_cache_breakpoint: marker }],
      }))
    )
  })

  it.each<[string, NonNullable<ModelInfo['capabilities']>['promptCaching'], boolean]>([
    // Listed with promptCaching 'cachePoints'.
    ['gpt-5.6', undefined, true],
    ['gpt-6.1-terra', undefined, true],
    ['openai.gpt-6.1-sol', undefined, true],
    // Listed without cache points, or not listed at all: no id-based inference.
    ['gpt-5.5', undefined, false],
    ['openai.gpt-6.1-terra', undefined, false],
    ['gpt-7-nova', undefined, false],
    // A modelInfo override wins over the data.
    ['gpt-6-sol', 'auto', false],
    ['gpt-6-sol', 'unsupported', false],
    ['my-finetune', 'cachePoints', true],
  ])('follows model info for %s (override promptCaching=%s)', (modelId, promptCaching, enabled) => {
    const overrides = { modelId, ...(promptCaching && { modelInfo: { capabilities: { promptCaching } } }) }
    const req = request([user('question')], undefined, overrides)
    expect(req).toStrictEqual({
      model: modelId,
      input: textInput('question', enabled ? marker : undefined),
      stream: true,
      store: false,
      ...(enabled && { prompt_cache_options: { mode: 'explicit' } }),
    })
  })

  it.each<CacheConfig>([
    {},
    // 'anthropic' means SDK-placed cache points, the same mechanism as these checkpoints.
    { strategy: 'anthropic' },
    { messagesTTL: true },
    { cacheKey: false },
  ])('places checkpoints with cacheConfig=%j', (cacheConfig) => {
    const req = format({ modelId: 'gpt-6-sol', cacheConfig }, [user('question')])
    expect(req).toHaveProperty('prompt_cache_options', { mode: 'explicit' })
    expect(req).toHaveProperty('input', textInput('question', marker))
  })

  it.each([undefined, { messagesTTL: false }])('does not opt in with cacheConfig=%j', (cacheConfig) => {
    const modelConfig: OpenAIResponsesConfig = { modelId: 'gpt-6-sol', ...(cacheConfig ? { cacheConfig } : {}) }
    const req = format(modelConfig, [user('question')])
    expect(req).toStrictEqual({ model: 'gpt-6-sol', input: textInput('question'), stream: true, store: false })
  })

  it('does not opt in when the call passes cacheMessages: false', () => {
    const req = format({ modelId: 'gpt-6-sol', cacheConfig: {} }, [user('question')], { cacheMessages: false })
    expect(req).toStrictEqual({ model: 'gpt-6-sol', input: textInput('question'), stream: true, store: false })
  })

  it.each<[CacheConfig, Record<string, unknown>, object, object]>([
    [{ messagesTTL: '12h' }, {}, { mode: 'explicit', ttl: '12h' }, { mode: 'explicit' }],
    [{ ttl: '12h' }, {}, marker, { mode: 'explicit', ttl: '12h' }],
    [{ ttl: '12h', messagesTTL: '30m' }, {}, { mode: 'explicit', ttl: '30m' }, { mode: 'explicit', ttl: '12h' }],
    // A caller-supplied lifetime wins over the configured one.
    [{ ttl: '12h' }, { prompt_cache_options: { ttl: '30m' } }, marker, { mode: 'explicit', ttl: '30m' }],
  ])('maps cache lifetimes for cacheConfig=%j params=%j', (cacheConfig, params, checkpoint, options) => {
    const warnSpy = vi.spyOn(logger, 'warn')
    const req = format({ modelId: 'gpt-6-sol', cacheConfig, params }, [user('question')])
    expect(req).toStrictEqual({
      model: 'gpt-6-sol',
      input: textInput('question', checkpoint),
      stream: true,
      store: false,
      prompt_cache_options: options,
    })
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('applies a cache lifetime ttl without checkpoints', () => {
    const req = format({ modelId: 'gpt-6-sol', cacheConfig: { ttl: '12h', messagesTTL: false } }, [user('question')])
    expect(req).toStrictEqual({
      model: 'gpt-6-sol',
      input: textInput('question'),
      stream: true,
      store: false,
      prompt_cache_options: { ttl: '12h' },
    })
  })

  it('ignores an invalid messagesTTL and warns', () => {
    const warnSpy = vi.spyOn(logger, 'warn')
    const req = format({ modelId: 'gpt-6-sol', cacheConfig: { messagesTTL: '1h' } }, [user('question')])
    expect(req).toHaveProperty('input', textInput('question', marker))
    expect(req).toHaveProperty('prompt_cache_options', { mode: 'explicit' })
    expect(warnSpy).toHaveBeenCalledWith(
      'messages_ttl=<1h> | cacheConfig.messagesTTL is not an openai cache lifetime, ignoring'
    )
  })

  it('keeps a retention literal ttl on models that take cache points', () => {
    const req = format({ modelId: 'gpt-6-sol', cacheConfig: { ttl: '24h' } }, [user('question')])
    expect(req).toHaveProperty('prompt_cache_retention', '24h')
    expect(req).toHaveProperty('prompt_cache_options', { mode: 'explicit' })
  })

  it('does not map cache lifetimes on models without cache points', () => {
    const req = format({ modelId: 'gpt-5.5', cacheConfig: { ttl: '12h', messagesTTL: '12h' } }, [user('question')])
    expect(req).toStrictEqual({ model: 'gpt-5.5', input: textInput('question'), stream: true, store: false })
  })

  it.each([{ mode: 'implicit', ttl: '30m' }, { mode: 'explicit' }, { ttl: '30m' }])(
    'lets native prompt_cache_options=%j win over the explicit default',
    (options) => {
      const req = request([user('question')], undefined, { params: { prompt_cache_options: options } })
      expect(req).toHaveProperty('prompt_cache_options', { mode: 'explicit', ...options })
    }
  )
})
