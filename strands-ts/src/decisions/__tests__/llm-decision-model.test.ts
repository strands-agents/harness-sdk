import { describe, expect, it } from 'vitest'

import { TestModelProvider } from '../../__fixtures__/model-test-helpers.js'
import { Model } from '../../models/model.js'
import { STRUCTURED_OUTPUT_TOOL_NAME } from '../../tools/structured-output-tool.js'
import { Message, TextBlock } from '../../types/messages.js'
import { LLMDecisionModel } from '../llm-decision-model.js'
import { Uncertain } from '../types.js'
import type { StreamOptions } from '../../models/model.js'
import type { ModelStreamEvent, Usage } from '../../models/streaming.js'
import type { Question } from '../../decisions/types.js'

const DEFAULT_USAGE: Usage = { inputTokens: 3, outputTokens: 2, totalTokens: 5 }

class RecordingModel extends TestModelProvider {
  readonly requests: Message[][] = []
  readonly options: (StreamOptions | undefined)[] = []

  override async *stream(messages: Message[], options?: StreamOptions): AsyncGenerator<ModelStreamEvent> {
    this.requests.push(messages)
    this.options.push(options)
    yield* super.stream(messages, options)
  }
}

/**
 * Build a {@link RecordingModel} that replays a single tool-use turn plus a
 * metadata event carrying usage and latency.
 *
 * `input` entries may be bare strings (shorthand for `{ answer }`) or
 * full `{ answer, reason? }` objects.
 */
function toolUseModel(
  input: Record<string, string | { answer: string; reason?: string }>,
  options: { usage?: Usage | null; latencyMs?: number | null } = {}
): RecordingModel {
  const normalized: Record<string, { answer: string; reason?: string }> = {}
  for (const [id, value] of Object.entries(input)) {
    normalized[id] = typeof value === 'string' ? { answer: value } : value
  }
  const usage = options.usage === undefined ? DEFAULT_USAGE : options.usage
  const latencyMs = options.latencyMs === undefined ? 42 : options.latencyMs

  const model = new RecordingModel()
  model.setEventGenerator(async function* () {
    yield { type: 'modelMessageStartEvent', role: 'assistant' }
    yield {
      type: 'modelContentBlockStartEvent',
      start: { type: 'toolUseStart', name: STRUCTURED_OUTPUT_TOOL_NAME, toolUseId: 'decision-1' },
    }
    yield {
      type: 'modelContentBlockDeltaEvent',
      delta: { type: 'toolUseInputDelta', input: JSON.stringify(normalized) },
    }
    yield { type: 'modelContentBlockStopEvent' }
    yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' }

    const metadata: ModelStreamEvent = { type: 'modelMetadataEvent' }
    if (usage !== null) metadata.usage = usage
    if (latencyMs !== null) metadata.metrics = { latencyMs }
    if (usage !== null || latencyMs !== null) yield metadata
  })
  return model
}

/** A model that returns a plain text message instead of a tool call. */
function textModel(text: string): RecordingModel {
  const model = new RecordingModel()
  model.setEventGenerator(async function* () {
    yield { type: 'modelMessageStartEvent', role: 'assistant' }
    yield { type: 'modelContentBlockStartEvent' }
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text } }
    yield { type: 'modelContentBlockStopEvent' }
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
    yield { type: 'modelMetadataEvent', usage: DEFAULT_USAGE, metrics: { latencyMs: 1 } }
  })
  return model
}

describe('LLMDecisionModel', () => {
  describe('ask', () => {
    it('narrows string and bool answers from a successful tool call', async () => {
      const model = toolUseModel({ color: 'red', isFruit: 'true' })
      const decision = new LLMDecisionModel(model)

      const result = await decision.ask('The fruit is an apple', {
        color: { instructions: 'What color is the fruit?', choices: ['red', 'green', 'blue'] as const },
        isFruit: {
          instructions: 'Is the thing talked about a fruit?',
          choices: 'boolean',
          uncertainOptions: { allow: false },
        },
      })

      expect(Object.keys(result.answers)).toEqual(['color', 'isFruit'])
      expect(result.answers.color).toEqual('red')
      expect(result.answers.isFruit).toEqual(true)
      expect(result.usage).toEqual(DEFAULT_USAGE)
      expect(result.metadata.latencyMs).toBe(42)
    })

    it('throws when the model omits latency metrics', async () => {
      const model = toolUseModel({ q: 'true' }, { latencyMs: null })
      const decision = new LLMDecisionModel(model)

      await expect(decision.ask('x', { q: { instructions: 'ok?', choices: 'boolean' } })).rejects.toThrow(
        /no latency information/
      )
    })

    it('returns Uncertain when the model picks the uncertain option', async () => {
      const model = toolUseModel({ color: 'uncertain' })
      const decision = new LLMDecisionModel(model)

      const result = await decision.ask('ambiguous', {
        color: { instructions: 'color?', choices: ['red', 'green'] as const },
      })

      expect(result.answers.color).toBeInstanceOf(Uncertain)
    })

    it('returns Uncertain carrying the model-supplied reason', async () => {
      const model = toolUseModel({ color: { answer: 'uncertain', reason: 'the input mentioned no color' } })
      const decision = new LLMDecisionModel(model)

      const result = await decision.ask('ambiguous', {
        color: { instructions: 'color?', choices: ['red', 'green'] as const },
      })

      const answer = result.answers.color
      expect(answer).toBeInstanceOf(Uncertain)
      expect((answer as Uncertain).reason).toBe('the input mentioned no color')
    })

    it('omits uncertain from the enum when a question opts out', async () => {
      const model = toolUseModel({ q: 'yes' })
      const decision = new LLMDecisionModel(model)

      await decision.ask('state', {
        q: { instructions: 'ok?', choices: ['yes', 'no'] as const, uncertainOptions: { allow: false } },
      })

      const toolSpec = model.options[0]?.toolSpecs?.[0]
      const schema = toolSpec?.inputSchema as {
        properties?: Record<string, { properties?: { answer?: { enum?: string[] } } }>
      }
      expect(schema.properties?.['q']?.properties?.answer?.enum).toEqual(['yes', 'no'])
    })

    it('appends uncertain to the enum by default', async () => {
      const model = toolUseModel({ q: 'uncertain' })
      const decision = new LLMDecisionModel(model)

      await decision.ask('state', { q: { instructions: 'ok?', choices: ['yes', 'no'] as const } })

      const toolSpec = model.options[0]?.toolSpecs?.[0]
      const schema = toolSpec?.inputSchema as {
        properties?: Record<string, { properties?: { answer?: { enum?: string[] } } }>
      }
      expect(schema.properties?.['q']?.properties?.answer?.enum).toEqual(['yes', 'no', 'uncertain'])
    })

    it('forces the structured-output tool', async () => {
      const model = toolUseModel({ q: 'true' })
      const decision = new LLMDecisionModel(model)

      await decision.ask('x', { q: { instructions: 'ok?', choices: 'boolean' } })

      expect(model.options[0]?.toolChoice).toEqual({ tool: { name: STRUCTURED_OUTPUT_TOOL_NAME } })
    })

    it('wraps a plain string state as a single user message', async () => {
      const model = toolUseModel({ q: 'true' })
      const decision = new LLMDecisionModel(model)

      await decision.ask('the state', { q: { instructions: 'is this a string?', choices: 'boolean' } })

      const sent = model.requests[0]!
      expect(sent).toHaveLength(1)
      expect(sent[0]?.role).toBe('user')
      expect(sent[0]?.content[0]).toBeInstanceOf(TextBlock)
    })

    it('wraps a content array as a single user message', async () => {
      const model = toolUseModel({ q: 'true' })
      const decision = new LLMDecisionModel(model)

      await decision.ask([new TextBlock('hello')], { q: { instructions: 'greeting?', choices: 'boolean' } })

      const sent = model.requests[0]!
      expect(sent).toHaveLength(1)
      expect(sent[0]?.role).toBe('user')
    })

    it('passes a message history straight through', async () => {
      const model = toolUseModel({ q: 'true' })
      const decision = new LLMDecisionModel(model)

      const history: Message[] = [
        new Message({ role: 'user', content: [new TextBlock('earlier')] }),
        new Message({ role: 'assistant', content: [new TextBlock('ack')] }),
        new Message({ role: 'user', content: [new TextBlock('the real question')] }),
      ]

      await decision.ask(history, { q: { instructions: 'conversation?', choices: 'boolean' } })

      expect(model.requests[0]).toBe(history)
    })

    it('includes the untrusted-state defense in the system prompt', async () => {
      const model = toolUseModel({ q: 'true' })
      const decision = new LLMDecisionModel(model)

      await decision.ask('x', { q: { instructions: 'ok?', choices: 'boolean' } })

      expect(model.options[0]?.systemPrompt).toContain('MANDATORY RULES')
    })

    it('throws when the model returns a non-tool-use stop', async () => {
      const model = textModel('I refuse')
      const decision = new LLMDecisionModel(model)

      await expect(decision.ask('x', { q: { instructions: 'bool?', choices: 'boolean' } })).rejects.toThrow(
        /no structured answers/
      )
    })

    it('rejects an empty question map before calling the model', async () => {
      const model = toolUseModel({})
      const decision = new LLMDecisionModel(model)

      await expect(decision.ask('x', {} as Record<string, Question>)).rejects.toThrow(/at least one question/)
      expect(model.requests).toHaveLength(0)
    })

    it('rejects out-of-range thresholds', async () => {
      const model = toolUseModel({})
      const decision = new LLMDecisionModel(model)

      await expect(
        decision.ask('x', {
          q: { instructions: 'bool?', choices: 'boolean', uncertainOptions: { allow: true, threshold: 1.5 } },
        })
      ).rejects.toThrow(/threshold/)
      expect(model.requests).toHaveLength(0)
    })

    it('rejects duplicate option values', async () => {
      const model = toolUseModel({})
      const decision = new LLMDecisionModel(model)

      await expect(decision.ask('x', { q: { instructions: 'pick', choices: ['a', 'a'] as const } })).rejects.toThrow(
        /unique/
      )
      expect(model.requests).toHaveLength(0)
    })

    it('throws when the model omits usage metadata', async () => {
      const model = toolUseModel({ q: 'true' }, { usage: null })
      const decision = new LLMDecisionModel(model)

      await expect(decision.ask('x', { q: { instructions: 'ok?', choices: 'boolean' } })).rejects.toThrow(
        /no usage information/
      )
    })

    it('throws when the model returns an unknown option', async () => {
      const model = toolUseModel({ color: 'purple' })
      const decision = new LLMDecisionModel(model)

      await expect(
        decision.ask('x', { color: { instructions: 'c?', choices: ['red', 'green'] as const } })
      ).rejects.toThrow(/invalid answer set/)
    })
  })

  describe('construction', () => {
    it('rejects a non-Model argument', () => {
      expect(() => new LLMDecisionModel({} as unknown as Model)).toThrow(TypeError)
    })
  })
})
