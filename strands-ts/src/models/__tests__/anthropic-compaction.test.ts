import { describe, expect, it, vi } from 'vitest'
import { AnthropicModel } from '../anthropic.js'
import { Model } from '../model.js'
import { ContextWindowOverflowError, ModelThrottledError } from '../../errors.js'
import { Message, TextBlock, ToolResultBlock, ToolUseBlock } from '../../types/messages.js'
import type { ToolSpec } from '../../tools/types.js'
import { logger } from '../../logging/logger.js'
import { AnthropicWire } from '../../__fixtures__/anthropic-wire.js'
import { collectIterator } from '../../__fixtures__/model-test-helpers.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'

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
    iterations: [{ type: 'compaction', input_tokens: 144, output_tokens: 276, cache_read_input_tokens: 10 }],
  },
}

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

function model(wire: AnthropicWire, config: Record<string, unknown> = {}): AnthropicModel {
  return new AnthropicModel({ client: wire.client(), modelId: 'claude-sonnet-5-5', maxTokens: 4096, ...config })
}

/** JSON with keys sorted at every level, so payloads compare by value whatever their key order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_, inner: unknown) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([left], [right]) => left.localeCompare(right)))
      : inner
  )
}

describe('Model.compact', () => {
  it('returns undefined by default', async () => {
    expect(await new MockMessageModel().compact({ messages: body() })).toBeUndefined()
    expect(Model.prototype.compact).toBeDefined()
  })
})

describe('AnthropicModel.compact', () => {
  describe('request', () => {
    it('sends on-demand compaction with the beta and the live system prompt and tools unchanged', async () => {
      const wire = new AnthropicWire().reply(COMPACTED, { content: [{ type: 'text', text: 'ok' }] })
      const anthropic = model(wire)
      await anthropic.compact({
        messages: body(),
        systemPrompt: SYSTEM,
        toolSpecs: TOOLS,
        instructions: 'Keep the task.',
      })
      await collectIterator(anthropic.stream(body(), { systemPrompt: SYSTEM, toolSpecs: TOOLS }))

      const [compaction, conversation] = wire.bodies
      expect(wire.requests[0]!.path).toBe('/v1/messages?beta=true')
      expect(wire.requests[0]!.headers['anthropic-beta']).toBe('compact-2026-09-04')
      expect(compaction!.compaction).toStrictEqual({ type: 'summarize', instructions: 'Keep the task.' })
      expect(JSON.stringify(compaction!.system)).toBe(JSON.stringify(conversation!.system))
      expect(JSON.stringify(compaction!.tools)).toBe(JSON.stringify(conversation!.tools))
      expect(JSON.stringify(compaction!.messages)).toBe(JSON.stringify(conversation!.messages))
      expect(compaction!.max_tokens).toBe(4096)
    })

    it('sends the configured thinking and leaves out parameters a compaction request rejects', async () => {
      const wire = new AnthropicWire().reply(COMPACTED)
      const thinking = { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'error' } }
      await model(wire, {
        stopSequences: ['STOP'],
        params: { thinking },
        betas: ['thinking-binding-controls-2026-08-01'],
      }).compact({ messages: body() })

      const [compaction] = wire.bodies
      expect(compaction!.thinking).toStrictEqual(thinking)
      expect(compaction!).not.toHaveProperty('stop_sequences')
      expect(compaction!).not.toHaveProperty('tool_choice')
      expect(compaction!.compaction).toStrictEqual({ type: 'summarize' })
      expect(wire.requests[0]!.headers['anthropic-beta']).toBe(
        'thinking-binding-controls-2026-08-01,compact-2026-09-04'
      )
    })

    it('keeps betas set on the client, as conversation requests do', async () => {
      const wire = new AnthropicWire().reply(COMPACTED, { content: [{ type: 'text', text: 'ok' }] })
      const defaultHeaders = { 'anthropic-beta': 'context-1m-2025-08-07' }
      const anthropic = new AnthropicModel({
        client: wire.client(defaultHeaders),
        clientConfig: { defaultHeaders },
        modelId: 'claude-sonnet-5-5',
        maxTokens: 4096,
      })
      await anthropic.compact({ messages: body() })
      await collectIterator(anthropic.stream(body()))

      expect(wire.requests[0]!.headers['anthropic-beta']).toBe('context-1m-2025-08-07,compact-2026-09-04')
      expect(wire.requests[1]!.headers['anthropic-beta']).toBe('context-1m-2025-08-07')
    })

    it("leaves out context_management and a task budget's remaining tokens", async () => {
      const wire = new AnthropicWire().reply(COMPACTED)
      await model(wire, {
        params: {
          context_management: { edits: [{ type: 'clear_thinking_20251015' }] },
          output_config: { effort: 'high', task_budget: { type: 'tokens', total: 1000, remaining: 400 } },
        },
      }).compact({ messages: body() })

      const [compaction] = wire.bodies
      expect(compaction!).not.toHaveProperty('context_management')
      expect(compaction!.output_config).toStrictEqual({ effort: 'high', task_budget: { type: 'tokens', total: 1000 } })
    })

    it('sends an earlier compaction block first, exactly as returned', async () => {
      const wire = new AnthropicWire().reply(COMPACTED, COMPACTED)
      const anthropic = model(wire)
      const first = await anthropic.compact({ messages: body() })
      const later = [new Message({ role: 'assistant', content: [first!.block] }), ...body().slice(1)]
      await anthropic.compact({ messages: later })

      const sent = (wire.bodies[1]!.messages as { content: unknown[] }[])[0]!.content[0]
      expect(sent).toStrictEqual(RETURNED)
      expect(canonical(sent)).toBe(canonical(RETURNED))
    })
  })

  describe('response', () => {
    it('stores the block as summary text plus every other returned field, with the compaction usage', async () => {
      const wire = new AnthropicWire().reply(COMPACTED)
      expect(await model(wire).compact({ messages: body() })).toStrictEqual({
        block: new TextBlock(RETURNED.content, {
          providerData: { provider: 'anthropic', data: { type: 'compaction', signature: RETURNED.signature } },
        }),
        usage: { inputTokens: 144, outputTokens: 276, totalTokens: 420, cacheReadInputTokens: 10 },
      })
    })

    it.each(['max_tokens', 'model_context_window_exceeded', 'tool_use', 'refusal', 'end_turn'])(
      'returns undefined and warns for stop_reason %s',
      async (stopReason) => {
        const warn = vi.spyOn(logger, 'warn')
        const wire = new AnthropicWire().reply({ content: [], stopReason })
        expect(await model(wire).compact({ messages: body() })).toBeUndefined()
        expect(warn).toHaveBeenCalledWith(
          `model_id=<claude-sonnet-5-5>, stop_reason=<${stopReason}> | compaction returned no summary`
        )
      }
    )

    it('throws provider errors instead of treating them as unavailable', async () => {
      const rejected = new AnthropicWire().reply({
        status: 400,
        error: { type: 'invalid_request_error', message: 'compaction_block_misplaced' },
      })
      await expect(model(rejected).compact({ messages: body() })).rejects.toThrow('compaction_block_misplaced')

      const throttled = new AnthropicWire().reply({ status: 429, error: { type: 'rate_limit_error', message: 'slow' } })
      await expect(model(throttled).compact({ messages: body() })).rejects.toThrow(ModelThrottledError)

      const overflow = new AnthropicWire().reply({
        status: 400,
        error: { type: 'invalid_request_error', message: 'prompt is too long: 300000 tokens > 200000 maximum' },
      })
      await expect(model(overflow).compact({ messages: body() })).rejects.toThrow(ContextWindowOverflowError)
    })

    it('aborts with the cancel signal', async () => {
      const wire = new AnthropicWire().reply(COMPACTED)
      const controller = new AbortController()
      controller.abort()
      await expect(model(wire).compact({ messages: body(), cancelSignal: controller.signal })).rejects.toThrow()
    })
  })

  describe('replay', () => {
    it('sends the stored block back first, unchanged, after session serialization', async () => {
      const wire = new AnthropicWire().reply(COMPACTED, { content: [{ type: 'text', text: 'ok' }] })
      const anthropic = model(wire)
      const { block } = (await anthropic.compact({ messages: body() }))!
      const restored = Message.fromMessageData(
        JSON.parse(JSON.stringify(new Message({ role: 'assistant', content: [block] })))
      )
      await collectIterator(anthropic.stream([restored, new Message({ role: 'user', content: [new TextBlock('go')] })]))

      const replayed = (wire.bodies[1]!.messages as { content: unknown[] }[])[0]!.content
      expect(replayed).toStrictEqual([RETURNED])
      expect(canonical(replayed[0])).toBe(canonical(RETURNED))
      expect(wire.requests[1]!.headers['anthropic-beta']).toBe('compact-2026-09-04')
    })
  })
})
