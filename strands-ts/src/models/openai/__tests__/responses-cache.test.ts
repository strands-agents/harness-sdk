import { describe, expect, it } from 'vitest'
import { Message, TextBlock, ToolResultBlock, ToolUseBlock } from '../../../types/messages.js'
import { ImageBlock } from '../../../types/media.js'
import { formatResponsesRequest } from '../responses-adapter.js'
import type { OpenAIResponsesConfig } from '../types.js'
import type { StreamOptions } from '../../model.js'

const marker = { mode: 'explicit' }
const config: OpenAIResponsesConfig = { modelId: 'gpt-6-sol', cacheConfig: {} }
const user = (...texts: string[]): Message => new Message({ role: 'user', content: texts.map((t) => new TextBlock(t)) })

function request(messages: Message[], options?: StreamOptions, overrides?: OpenAIResponsesConfig): object {
  return formatResponsesRequest({ ...config, ...overrides }, messages, options, false)
}

function input(messages: Message[], options?: StreamOptions): unknown {
  return formatResponsesRequest(config, messages, options, false).input
}

describe('Responses durable prompt caching', () => {
  it('checkpoints stable user content before the injected tail without mutating history', () => {
    const messages = [user('question', 'temporary')]
    const before = messages.map((m) => m.toJSON())
    expect(request(messages, { dynamicTrailingBlocks: 1 })).toMatchObject({
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
    expect(req).toHaveProperty('prompt_cache_options.mode', 'explicit')
    expect(req).toHaveProperty('input.0.content.0.prompt_cache_breakpoint', marker)
  })

  it('keeps implicit caching when no durable input part exists', () => {
    const req = request([new Message({ role: 'assistant', content: [new TextBlock('hello')] })])
    expect(req).not.toHaveProperty('prompt_cache_options')
    expect(JSON.stringify(req)).not.toContain('prompt_cache_breakpoint')
  })

  it('joins a multi-text tool result into one checkpointed block', () => {
    const result = new ToolResultBlock({
      toolUseId: 'a',
      status: 'success',
      content: [new TextBlock('one'), new TextBlock('two')],
    })
    expect(input([new Message({ role: 'user', content: [result] })])).toEqual([
      {
        type: 'function_call_output',
        call_id: 'a',
        output: [{ type: 'input_text', text: 'one\ntwo', prompt_cache_breakpoint: marker }],
      },
    ])
  })

  it('uses the array tool-output form for a tool result in the temporary tail', () => {
    const result = new ToolResultBlock({ toolUseId: 'a', status: 'success', content: [new TextBlock('out')] })
    const msg = new Message({ role: 'user', content: [new TextBlock('durable'), result] })
    expect(input([msg], { dynamicTrailingBlocks: 1 })).toContainEqual({
      type: 'function_call_output',
      call_id: 'a',
      output: [{ type: 'input_text', text: 'out' }],
    })
  })

  it('keeps an empty tool result as a string output', () => {
    const result = new ToolResultBlock({ toolUseId: 'a', status: 'success', content: [] })
    const msg = new Message({ role: 'user', content: [result, new TextBlock('next')] })
    expect(input([msg])).toContainEqual({ type: 'function_call_output', call_id: 'a', output: '' })
  })

  it('avoids implicit writes when the only text is a temporary suffix', () => {
    const req = request([user('temporary')], { dynamicTrailingBlocks: 1 })
    expect(req).toHaveProperty('prompt_cache_options.mode', 'explicit')
    expect(JSON.stringify(req)).not.toContain('prompt_cache_breakpoint')
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

  it.each(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-sol', 'gpt-6.1-sol'])('supports checkpoints for %s', (modelId) => {
    expect(request([user('question')], undefined, { modelId })).toHaveProperty('prompt_cache_options.mode', 'explicit')
  })

  it.each(['gpt-5.5', 'gpt-5.4', 'gpt-4o', 'gpt-oss-120b', 'custom-model'])(
    'preserves legacy behavior for %s',
    (modelId) => {
      const req = request([user('question', 'temporary')], { dynamicTrailingBlocks: 1 }, { modelId })
      expect(req).not.toHaveProperty('prompt_cache_options')
      expect(JSON.stringify(req)).not.toContain('prompt_cache_breakpoint')
    }
  )

  it.each([{ strategy: 'auto' as const }, { strategy: 'anthropic' as const }])(
    'places checkpoints with cacheConfig=%j',
    (cacheConfig) => {
      const req = formatResponsesRequest({ modelId: 'gpt-6-sol', cacheConfig }, [user('question')], undefined, false)
      expect(req).toHaveProperty('prompt_cache_options.mode', 'explicit')
      expect(req).toHaveProperty('input.0.content.0.prompt_cache_breakpoint', marker)
    }
  )

  it.each([undefined, { messagesTTL: false }])('does not opt in with cacheConfig=%j', (cacheConfig) => {
    const modelConfig: OpenAIResponsesConfig = { modelId: 'gpt-6-sol', ...(cacheConfig ? { cacheConfig } : {}) }
    const req = formatResponsesRequest(modelConfig, [user('question')], undefined, false)
    expect(req).not.toHaveProperty('prompt_cache_options')
    expect(JSON.stringify(req)).not.toContain('prompt_cache_breakpoint')
  })

  it('merges a native TTL without losing explicit mode', () => {
    const req = request([user('question')], undefined, { params: { prompt_cache_options: { ttl: '12h' } } })
    expect(req).toHaveProperty('prompt_cache_options', { mode: 'explicit', ttl: '12h' })
  })

  it('preserves native options including implicit mode and TTL', () => {
    const req = request([user('question')], undefined, {
      params: { prompt_cache_options: { mode: 'implicit', ttl: '12h' } },
    })
    expect(req).toHaveProperty('prompt_cache_options', { mode: 'implicit', ttl: '12h' })
  })
})
