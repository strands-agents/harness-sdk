import { describe, it, expect } from 'vitest'
import { AgentResult } from '../agent.js'
import { AgentMetrics } from '../../telemetry/meter.js'
import { AgentTrace } from '../../telemetry/tracer.js'
import { Message } from '../messages.js'
import { TextBlock, ReasoningBlock, ToolUseBlock, ToolResultBlock, CachePointBlock } from '../messages.js'
import { CitationsBlock } from '../citations.js'
import { Interrupt } from '../../interrupt.js'
import { Checkpoint, CHECKPOINT_SCHEMA_VERSION } from '../../experimental/checkpoint.js'

describe('AgentResult', () => {
  describe('toString', () => {
    describe('when content is empty', () => {
      it('returns empty string', () => {
        const message = new Message({
          role: 'assistant',
          content: [],
        })

        const result = new AgentResult({
          stopReason: 'endTurn',
          lastMessage: message,
          metrics: new AgentMetrics(),
          invocationState: {},
        })

        expect(result.toString()).toBe('')
      })
    })

    describe('when content has single TextBlock', () => {
      it('returns the text content', () => {
        const message = new Message({
          role: 'assistant',
          content: [new TextBlock('Hello, world!')],
        })

        const result = new AgentResult({
          stopReason: 'endTurn',
          lastMessage: message,
          metrics: new AgentMetrics(),
          invocationState: {},
        })

        expect(result.toString()).toBe('Hello, world!')
      })
    })

    describe('when content has multiple TextBlocks', () => {
      it('returns all text joined with newlines', () => {
        const message = new Message({
          role: 'assistant',
          content: [new TextBlock('First line'), new TextBlock('Second line'), new TextBlock('Third line')],
        })

        const result = new AgentResult({
          stopReason: 'endTurn',
          lastMessage: message,
          metrics: new AgentMetrics(),
          invocationState: {},
        })

        expect(result.toString()).toBe('First line\nSecond line\nThird line')
      })
    })

    describe('when content has ReasoningBlock with text', () => {
      it('returns the reasoning text with prefix', () => {
        const message = new Message({
          role: 'assistant',
          content: [new ReasoningBlock({ text: 'Let me think about this...' })],
        })

        const result = new AgentResult({
          stopReason: 'endTurn',
          lastMessage: message,
          metrics: new AgentMetrics(),
          invocationState: {},
        })

        expect(result.toString()).toBe('💭 Reasoning:\n   Let me think about this...')
      })
    })

    describe('when content has ReasoningBlock without text', () => {
      it('returns empty string (reasoning block is skipped)', () => {
        const message = new Message({
          role: 'assistant',
          content: [new ReasoningBlock({ signature: 'abc123' })],
        })

        const result = new AgentResult({
          stopReason: 'endTurn',
          lastMessage: message,
          metrics: new AgentMetrics(),
          invocationState: {},
        })

        expect(result.toString()).toBe('')
      })
    })

    describe('when content has mixed TextBlock and ReasoningBlock', () => {
      it('returns all text joined with newlines', () => {
        const message = new Message({
          role: 'assistant',
          content: [
            new TextBlock('Here is my response.'),
            new ReasoningBlock({ text: 'I reasoned carefully.' }),
            new TextBlock('Additional context.'),
          ],
        })

        const result = new AgentResult({
          stopReason: 'endTurn',
          lastMessage: message,
          metrics: new AgentMetrics(),
          invocationState: {},
        })

        expect(result.toString()).toBe(
          'Here is my response.\n💭 Reasoning:\n   I reasoned carefully.\nAdditional context.'
        )
      })
    })

    describe('when content has only non-text blocks', () => {
      it('returns empty string', () => {
        const message = new Message({
          role: 'assistant',
          content: [
            new ToolUseBlock({ name: 'calc', toolUseId: 'id-1', input: { a: 1, b: 2 } }),
            new ToolResultBlock({
              toolUseId: 'id-1',
              status: 'success',
              content: [new TextBlock('3')],
            }),
            new CachePointBlock({ cacheType: 'default' }),
          ],
        })

        const result = new AgentResult({
          stopReason: 'toolUse',
          lastMessage: message,
          metrics: new AgentMetrics(),
          invocationState: {},
        })

        expect(result.toString()).toBe('')
      })
    })

    describe('when content has mixed text and non-text blocks', () => {
      it('returns only text from TextBlock and ReasoningBlock', () => {
        const message = new Message({
          role: 'assistant',
          content: [
            new TextBlock('Before tool'),
            new ToolUseBlock({ name: 'calc', toolUseId: 'id-1', input: { a: 1, b: 2 } }),
            new ReasoningBlock({ text: 'Thinking...' }),
            new CachePointBlock({ cacheType: 'default' }),
            new TextBlock('After tool'),
          ],
        })

        const result = new AgentResult({
          stopReason: 'toolUse',
          lastMessage: message,
          metrics: new AgentMetrics(),
          invocationState: {},
        })

        expect(result.toString()).toBe('Before tool\n💭 Reasoning:\n   Thinking...\nAfter tool')
      })
    })

    describe('when interrupts are present', () => {
      it('returns JSON-stringified interrupts, taking priority over text content', () => {
        const message = new Message({
          role: 'assistant',
          content: [new TextBlock('ignored')],
        })

        const interrupt = new Interrupt({ id: 'i-1', name: 'confirm', reason: 'ok?' })

        const result = new AgentResult({
          stopReason: 'interrupt',
          lastMessage: message,
          metrics: new AgentMetrics(),
          invocationState: {},
          interrupts: [interrupt],
        })

        expect(result.toString()).toBe(JSON.stringify([interrupt]))
      })

      it('falls through when interrupts array is empty', () => {
        const message = new Message({
          role: 'assistant',
          content: [new TextBlock('Hello')],
        })

        const result = new AgentResult({
          stopReason: 'endTurn',
          lastMessage: message,
          metrics: new AgentMetrics(),
          invocationState: {},
          interrupts: [],
        })

        expect(result.toString()).toBe('Hello')
      })
    })

    describe('when structuredOutput is present', () => {
      it('returns JSON-stringified structured output, taking priority over text content', () => {
        const message = new Message({
          role: 'assistant',
          content: [new TextBlock('ignored')],
        })

        const structuredOutput = { answer: 42, note: 'hello' }

        const result = new AgentResult({
          stopReason: 'endTurn',
          lastMessage: message,
          metrics: new AgentMetrics(),
          invocationState: {},
          structuredOutput,
        })

        expect(result.toString()).toBe(JSON.stringify(structuredOutput))
      })
    })

    describe('when interrupts and structuredOutput are both present', () => {
      it('returns interrupts, taking priority over structuredOutput', () => {
        const message = new Message({
          role: 'assistant',
          content: [new TextBlock('ignored')],
        })

        const interrupt = new Interrupt({ id: 'i-1', name: 'confirm' })
        const structuredOutput = { answer: 42 }

        const result = new AgentResult({
          stopReason: 'interrupt',
          lastMessage: message,
          metrics: new AgentMetrics(),
          invocationState: {},
          interrupts: [interrupt],
          structuredOutput,
        })

        expect(result.toString()).toBe(JSON.stringify([interrupt]))
      })
    })

    describe('when content has CitationsBlock', () => {
      it('concatenates generated content text from citations', () => {
        const message = new Message({
          role: 'assistant',
          content: [
            new TextBlock('Here is a citation:'),
            new CitationsBlock({
              citations: [
                {
                  location: { type: 'documentChar', documentIndex: 0, start: 0, end: 5 },
                  source: 'doc',
                  sourceContent: [{ text: 'source text' }],
                  title: 'Doc',
                },
              ],
              content: [{ text: 'cited fragment' }],
            }),
          ],
        })

        const result = new AgentResult({
          stopReason: 'endTurn',
          lastMessage: message,
          metrics: new AgentMetrics(),
          invocationState: {},
        })

        expect(result.toString()).toBe('Here is a citation:\ncited fragment')
      })
    })

    describe('when called implicitly', () => {
      it('works with String() conversion', () => {
        const message = new Message({
          role: 'assistant',
          content: [new TextBlock('Hello')],
        })

        const result = new AgentResult({
          stopReason: 'endTurn',
          lastMessage: message,
          metrics: new AgentMetrics(),
          invocationState: {},
        })

        expect(String(result)).toBe('Hello')
      })

      it('works with template literals', () => {
        const message = new Message({
          role: 'assistant',
          content: [new TextBlock('World')],
        })

        const result = new AgentResult({
          stopReason: 'endTurn',
          lastMessage: message,
          metrics: new AgentMetrics(),
          invocationState: {},
        })

        expect(`Response: ${result}`).toBe('Response: World')
      })
    })
  })

  describe('contextSize', () => {
    it('returns latestContextSize from metrics', () => {
      const message = new Message({
        role: 'assistant',
        content: [new TextBlock('Hello')],
      })

      const metrics = new AgentMetrics({ latestContextSize: 500 })

      const result = new AgentResult({
        stopReason: 'endTurn',
        lastMessage: message,
        metrics,
        invocationState: {},
      })

      expect(result.contextSize).toBe(500)
    })

    it('returns undefined when metrics has no latestContextSize', () => {
      const message = new Message({
        role: 'assistant',
        content: [new TextBlock('Hello')],
      })

      const result = new AgentResult({
        stopReason: 'endTurn',
        lastMessage: message,
        metrics: new AgentMetrics(),
        invocationState: {},
      })

      expect(result.contextSize).toBeUndefined()
    })

    it('returns undefined when no metrics are available', () => {
      const message = new Message({
        role: 'assistant',
        content: [new TextBlock('Hello')],
      })

      const result = new AgentResult({
        stopReason: 'endTurn',
        lastMessage: message,
        invocationState: {},
      })

      expect(result.contextSize).toBeUndefined()
    })
  })

  describe('projectedContextSize', () => {
    it('returns projectedContextSize from metrics', () => {
      const message = new Message({
        role: 'assistant',
        content: [new TextBlock('Hello')],
      })

      const metrics = new AgentMetrics({ projectedContextSize: 750 })

      const result = new AgentResult({
        stopReason: 'endTurn',
        lastMessage: message,
        metrics,
        invocationState: {},
      })

      expect(result.projectedContextSize).toBe(750)
    })

    it('returns undefined when metrics has no projectedContextSize', () => {
      const message = new Message({
        role: 'assistant',
        content: [new TextBlock('Hello')],
      })

      const result = new AgentResult({
        stopReason: 'endTurn',
        lastMessage: message,
        metrics: new AgentMetrics(),
        invocationState: {},
      })

      expect(result.projectedContextSize).toBeUndefined()
    })
  })

  describe('toJSON', () => {
    it('excludes traces and metrics from serialization', () => {
      const message = new Message({
        role: 'assistant',
        content: [new TextBlock('Hello')],
      })

      const traces = [new AgentTrace('Cycle 1')]
      const metrics = new AgentMetrics()

      const result = new AgentResult({
        stopReason: 'endTurn',
        lastMessage: message,
        traces,
        metrics,
        invocationState: {},
      })

      const json = result.toJSON()

      expect(json).toEqual({
        type: 'agentResult',
        stopReason: 'endTurn',
        lastMessage: message,
      })
    })

    it('includes structuredOutput when present', () => {
      const message = new Message({
        role: 'assistant',
        content: [new TextBlock('Response')],
      })

      const structuredOutput = { field: 'value' }

      const result = new AgentResult({
        stopReason: 'endTurn',
        lastMessage: message,
        structuredOutput,
        invocationState: {},
      })

      const json = result.toJSON()

      expect(json).toHaveProperty('structuredOutput', structuredOutput)
    })

    it('excludes structuredOutput when not present', () => {
      const message = new Message({
        role: 'assistant',
        content: [new TextBlock('Response')],
      })

      const result = new AgentResult({
        stopReason: 'endTurn',
        lastMessage: message,
        invocationState: {},
      })

      const json = result.toJSON()

      expect(json).not.toHaveProperty('structuredOutput')
    })

    it('is automatically used by JSON.stringify()', () => {
      const message = new Message({
        role: 'assistant',
        content: [new TextBlock('Hello')],
      })

      const traces = [new AgentTrace('Cycle 1')]
      const metrics = new AgentMetrics()

      const result = new AgentResult({
        stopReason: 'endTurn',
        lastMessage: message,
        traces,
        metrics,
        invocationState: {},
      })

      const jsonString = JSON.stringify(result)
      const parsed = JSON.parse(jsonString)

      expect(parsed).toEqual({
        type: 'agentResult',
        stopReason: 'endTurn',
        lastMessage: expect.objectContaining({
          role: 'assistant',
          content: expect.any(Array),
        }),
      })
    })

    it('preserves traces and metrics as accessible properties', () => {
      const message = new Message({
        role: 'assistant',
        content: [new TextBlock('Hello')],
      })

      const traces = [new AgentTrace('Cycle 1')]
      const metrics = new AgentMetrics()

      const result = new AgentResult({
        stopReason: 'endTurn',
        lastMessage: message,
        traces,
        metrics,
        invocationState: {},
      })

      // Properties are still accessible
      expect({ traces: result.traces, metrics: result.metrics }).toEqual({
        traces,
        metrics,
      })

      // But not in JSON
      const json = result.toJSON()
      expect(json).toEqual({
        type: 'agentResult',
        stopReason: 'endTurn',
        lastMessage: message,
      })
    })

    it('prevents bloated API responses when forwarding result directly', () => {
      const message = new Message({
        role: 'assistant',
        content: [new TextBlock('Response text')],
      })

      // Simulate large traces and metrics from real agent execution
      const traces = [new AgentTrace('Cycle 1'), new AgentTrace('Cycle 2'), new AgentTrace('Cycle 3')]
      const metrics = new AgentMetrics()

      const result = new AgentResult({
        stopReason: 'endTurn',
        lastMessage: message,
        traces,
        metrics,
        invocationState: {},
      })

      // Simulate what happens in Express/Next.js: res.json(result)
      const apiResponse = JSON.parse(JSON.stringify(result))

      // Verify API response is lean - no traces/metrics bloat
      expect(apiResponse).toEqual({
        type: 'agentResult',
        stopReason: 'endTurn',
        lastMessage: expect.objectContaining({
          role: 'assistant',
          content: expect.any(Array),
        }),
      })
      expect(apiResponse).not.toHaveProperty('traces')
      expect(apiResponse).not.toHaveProperty('metrics')
    })
  })

  describe('checkpoint', () => {
    const toolUseMessage = new Message({
      role: 'assistant',
      content: [new ToolUseBlock({ toolUseId: '1', name: 't', input: {} })],
    })

    it('defaults checkpoint to undefined', () => {
      const result = new AgentResult({
        stopReason: 'endTurn',
        lastMessage: new Message({ role: 'assistant', content: [new TextBlock('hi')] }),
        metrics: new AgentMetrics(),
        invocationState: {},
      })
      expect(result.checkpoint).toBeUndefined()
    })

    it('accepts a checkpoint', () => {
      const checkpoint = new Checkpoint({ position: 'afterModel', cycleIndex: 0 })
      const result = new AgentResult({
        stopReason: 'checkpoint',
        lastMessage: toolUseMessage,
        metrics: new AgentMetrics(),
        invocationState: {},
        checkpoint,
      })
      expect(result.checkpoint).toBe(checkpoint)
      expect(result.checkpoint?.position).toBe('afterModel')
    })

    it('includes the serialized checkpoint in toJSON when present', () => {
      const result = new AgentResult({
        stopReason: 'checkpoint',
        lastMessage: toolUseMessage,
        metrics: new AgentMetrics(),
        invocationState: {},
        checkpoint: new Checkpoint({ position: 'afterTools', cycleIndex: 3 }),
      })
      const json = result.toJSON() as { checkpoint?: unknown }
      expect(json.checkpoint).toEqual({
        position: 'afterTools',
        cycleIndex: 3,
        schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      })
    })

    it('omits checkpoint from toJSON when absent', () => {
      const result = new AgentResult({
        stopReason: 'endTurn',
        lastMessage: new Message({ role: 'assistant', content: [new TextBlock('hi')] }),
        metrics: new AgentMetrics(),
        invocationState: {},
      })
      expect(result.toJSON()).not.toHaveProperty('checkpoint')
    })
  })
})
