import { describe, expect, it, vi } from 'vitest'
import { AnthropicModel } from '../anthropic.js'
import { ModelThrottledError } from '../../errors.js'
import { Message, TextBlock, ToolResultBlock, ToolUseBlock } from '../../types/messages.js'
import type { ToolSpec } from '../../tools/types.js'
import { logger } from '../../logging/logger.js'
import { AnthropicWire } from '../../__fixtures__/anthropic-wire.js'
import { collectIterator } from '../../__fixtures__/model-test-helpers.js'

const SYSTEM = 'You plan releases.'
const TOOLS: ToolSpec[] = [
  { name: 'lookup', description: 'Look up.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
]
const RETURNED = { type: 'compaction', content: 'Summary: the user plans a release.', signature: 'EuYBCkQY-opaque' }
const COMPACTED = {
  content: [RETURNED],
  stopReason: 'compaction',
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    iterations: [{ type: 'compaction', input_tokens: 144, output_tokens: 276 }],
  },
}
const SUMMARY_TEXT = { content: [{ type: 'text', text: 'BASE SUMMARY' }] }

const body = (): Message[] => [
  new Message({ role: 'user', content: [new TextBlock('TASK: plan the release')] }),
  new Message({
    role: 'assistant',
    content: [new TextBlock('checking'), new ToolUseBlock({ name: 'lookup', toolUseId: 't1', input: { q: 'x' } })],
  }),
  new Message({
    role: 'user',
    content: [new ToolResultBlock({ toolUseId: 't1', status: 'success', content: [new TextBlock('found')] })],
  }),
]

function model(wire: AnthropicWire, config: Record<string, unknown> = {}, compacts = true): AnthropicModel {
  return new AnthropicModel({
    client: wire.client(),
    modelId: 'claude-sonnet-5-5',
    maxTokens: 4096,
    ...(compacts && { modelInfo: { capabilities: { serverSideCompaction: true } } }),
    ...config,
  })
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_, inner: unknown) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([left], [right]) => left.localeCompare(right)))
      : inner
  )
}

describe('AnthropicModel.summarize', () => {
  it('uses the base summary when the capability is not set, as before', async () => {
    const wire = new AnthropicWire().reply(SUMMARY_TEXT)
    const result = await model(wire, {}, false).summarize(body(), { systemPrompt: SYSTEM, toolSpecs: TOOLS })
    expect(wire.bodies[0]).not.toHaveProperty('compaction')
    expect(wire.bodies[0]).not.toHaveProperty('tools')
    expect(wire.requests[0]!.headers['anthropic-beta']).toBeUndefined()
    expect(result.content).toStrictEqual([new TextBlock('BASE SUMMARY')])
  })

  it('compacts with the beta and the live system prompt and tools unchanged', async () => {
    const wire = new AnthropicWire().reply(COMPACTED, { content: [{ type: 'text', text: 'ok' }] })
    const anthropic = model(wire)
    await anthropic.summarize(body(), { systemPrompt: SYSTEM, toolSpecs: TOOLS, instructions: 'Keep the task.' })
    await collectIterator(anthropic.stream(body(), { systemPrompt: SYSTEM, toolSpecs: TOOLS }))

    const [compaction, conversation] = wire.bodies
    expect(wire.requests[0]!.path).toBe('/v1/messages?beta=true')
    expect(wire.requests[0]!.headers['anthropic-beta']).toBe('compact-2026-09-04')
    expect(compaction!.compaction).toStrictEqual({ type: 'summarize', instructions: 'Keep the task.' })
    expect(JSON.stringify(compaction!.system)).toBe(JSON.stringify(conversation!.system))
    expect(JSON.stringify(compaction!.tools)).toBe(JSON.stringify(conversation!.tools))
    expect(JSON.stringify(compaction!.messages)).toBe(JSON.stringify(conversation!.messages))
  })

  it('keeps client betas and leaves out parameters a compaction request rejects', async () => {
    const wire = new AnthropicWire().reply(COMPACTED)
    const defaultHeaders = { 'anthropic-beta': 'context-1m-2025-08-07' }
    await new AnthropicModel({
      client: wire.client(defaultHeaders),
      clientConfig: { defaultHeaders },
      modelId: 'claude-sonnet-5-5',
      maxTokens: 4096,
      stopSequences: ['STOP'],
      modelInfo: { capabilities: { serverSideCompaction: true } },
      params: { context_management: { edits: [] }, output_config: { task_budget: { total: 9, remaining: 4 } } },
    }).summarize(body())
    const [compaction] = wire.bodies
    expect(wire.requests[0]!.headers['anthropic-beta']).toBe('context-1m-2025-08-07,compact-2026-09-04')
    expect(compaction!).not.toHaveProperty('stop_sequences')
    expect(compaction!).not.toHaveProperty('context_management')
    expect(compaction!.output_config).toStrictEqual({ task_budget: { total: 9 } })
  })

  it('returns the summary text with the returned block as provider data, and the compaction usage', async () => {
    const wire = new AnthropicWire().reply(COMPACTED)
    expect(await model(wire).summarize(body())).toStrictEqual({
      content: [
        new TextBlock(RETURNED.content, { metadata: { providerData: { provider: 'anthropic', data: RETURNED } } }),
      ],
      usage: { inputTokens: 144, outputTokens: 276, totalTokens: 420 },
    })
  })

  it('returns an empty summary, which leaves the history unchanged, when compaction writes none', async () => {
    const warn = vi.spyOn(logger, 'warn')
    const wire = new AnthropicWire().reply({ content: [], stopReason: 'max_tokens' })
    expect((await model(wire).summarize(body())).content).toStrictEqual([])
    expect(warn).toHaveBeenCalledWith(
      'model_id=<claude-sonnet-5-5>, stop_reason=<max_tokens> | compaction returned no summary'
    )
  })

  it('throws provider errors', async () => {
    const throttled = new AnthropicWire().reply({ status: 429, error: { type: 'rate_limit_error', message: 'slow' } })
    await expect(model(throttled).summarize(body())).rejects.toThrow(ModelThrottledError)
  })

  it('sends the stored block first, unchanged and in place of the messages before it, after serialization', async () => {
    const wire = new AnthropicWire().reply(COMPACTED, { content: [{ type: 'text', text: 'ok' }] })
    const anthropic = model(wire)
    const [block] = (await anthropic.summarize(body())).content as TextBlock[]
    const placeholder = new TextBlock(`[Summarized: earlier messages]\n\n${block!.text}`, {
      metadata: block!.metadata!,
    })
    const history = [
      body()[0]!,
      new Message({ role: 'assistant', content: [placeholder] }),
      new Message({ role: 'user', content: [new TextBlock('next')] }),
    ]
    const restored = history.map((message) => Message.fromMessageData(JSON.parse(JSON.stringify(message))))
    await collectIterator(anthropic.stream(restored))
    const sent = wire.bodies[1]!.messages as { role: string; content: unknown[] }[]
    expect(sent.map((message) => message.role)).toStrictEqual(['assistant', 'user'])
    const replayed = sent[0]!.content
    expect(replayed).toStrictEqual([RETURNED])
    expect(canonical(replayed[0])).toBe(canonical(RETURNED))
    expect(wire.requests[1]!.headers['anthropic-beta']).toBe('compact-2026-09-04')
  })
})
