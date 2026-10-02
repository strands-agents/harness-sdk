import { describe, it, expect } from 'vitest'
import {
  Message,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ReasoningBlock,
  GuardContentBlock,
} from '../../types/messages.js'
import { CitationsBlock } from '../../types/citations.js'
import { TestModelProvider, collectGenerator } from '../../__fixtures__/model-test-helpers.js'
import { MaxTokensError, ModelError } from '../../errors.js'
import { Model } from '../model.js'
import type { BaseModelConfig, StreamOptions } from '../model.js'
import type { ModelStreamEvent } from '../streaming.js'
import { anyTrackingId } from '../../__fixtures__/message-helpers.js'

/**
 * Test model provider that throws an error from stream().
 */
class ErrorThrowingModelProvider extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'test-model' }
  private errorToThrow: Error

  constructor(errorToThrow: Error) {
    super()
    this.errorToThrow = errorToThrow
  }

  updateConfig(modelConfig: BaseModelConfig): void {
    this.config = { ...this.config, ...modelConfig }
  }

  getConfig(): BaseModelConfig {
    return this.config
  }

  // eslint-disable-next-line require-yield
  async *stream(_messages: Message[], _options?: StreamOptions): AsyncGenerator<ModelStreamEvent> {
    throw this.errorToThrow
  }
}

describe('Model', () => {
  describe('streamAggregated', () => {
    describe('when streaming a simple text message', () => {
      it('yields original events plus aggregated content block and returns final message', async () => {
        const provider = new TestModelProvider(async function* () {
          yield { type: 'modelMessageStartEvent', role: 'assistant' }
          yield { type: 'modelContentBlockStartEvent' }
          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'textDelta', text: 'Hello' },
          }
          yield { type: 'modelContentBlockStopEvent' }
          yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
          yield {
            type: 'modelMetadataEvent',
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          }
        })

        const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

        const { items, result } = await collectGenerator(provider.streamAggregated(messages))

        // Verify all yielded items (events + aggregated content block + metadata)
        expect(items).toEqual([
          { type: 'modelMessageStartEvent', role: 'assistant' },
          { type: 'modelContentBlockStartEvent' },
          {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'textDelta', text: 'Hello' },
          },
          { type: 'modelContentBlockStopEvent' },
          { type: 'textBlock', text: 'Hello' },
          { type: 'modelMessageStopEvent', stopReason: 'endTurn' },
          {
            type: 'modelMetadataEvent',
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          },
        ])

        // Verify the returned result includes metadata
        expect(result).toEqual({
          message: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'textBlock', text: 'Hello' }],
            trackingId: anyTrackingId,
            metadata: {
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            },
          },
          stopReason: 'endTurn',
          metadata: {
            type: 'modelMetadataEvent',
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          },
        })
      })

      it('throws MaxTokenError when stopReason is MaxTokenError', async () => {
        const provider = new TestModelProvider(async function* () {
          yield { type: 'modelMessageStartEvent', role: 'assistant' }
          yield { type: 'modelContentBlockStartEvent' }
          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'textDelta', text: 'Hello' },
          }
          yield { type: 'modelContentBlockStopEvent' }
          yield { type: 'modelMessageStopEvent', stopReason: 'maxTokens' }
          yield {
            type: 'modelMetadataEvent',
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          }
        })

        const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

        await expect(async () => await collectGenerator(provider.streamAggregated(messages))).rejects.toThrow(
          'Model reached maximum token limit. This is an unrecoverable state that requires intervention.'
        )
      })
    })

    describe('when streaming multiple text blocks', () => {
      it('yields all blocks in order', async () => {
        const provider = new TestModelProvider(async function* () {
          yield { type: 'modelMessageStartEvent', role: 'assistant' }
          yield { type: 'modelContentBlockStartEvent' }
          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'textDelta', text: 'First' },
          }
          yield { type: 'modelContentBlockStopEvent' }
          yield { type: 'modelContentBlockStartEvent' }
          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'textDelta', text: 'Second' },
          }
          yield { type: 'modelContentBlockStopEvent' }
          yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
          yield {
            type: 'modelMetadataEvent',
            usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
          }
        })

        const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

        const { items, result } = await collectGenerator(provider.streamAggregated(messages))

        expect(items).toContainEqual({ type: 'textBlock', text: 'First' })
        expect(items).toContainEqual({ type: 'textBlock', text: 'Second' })
        expect(items).toContainEqual({
          type: 'modelMetadataEvent',
          usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
        })

        expect(result).toEqual({
          message: {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'textBlock', text: 'First' },
              { type: 'textBlock', text: 'Second' },
            ],
            trackingId: anyTrackingId,
            metadata: {
              usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
            },
          },
          stopReason: 'endTurn',
          metadata: {
            type: 'modelMetadataEvent',
            usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
          },
        })
      })
    })

    describe('when streaming tool use', () => {
      it('yields complete tool use block', async () => {
        const provider = new TestModelProvider(async function* () {
          yield { type: 'modelMessageStartEvent', role: 'assistant' }
          yield {
            type: 'modelContentBlockStartEvent',
            start: { type: 'toolUseStart', toolUseId: 'tool1', name: 'get_weather' },
          }
          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'toolUseInputDelta', input: '{"location"' },
          }
          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'toolUseInputDelta', input: ': "Paris"}' },
          }
          yield { type: 'modelContentBlockStopEvent' }
          yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' }
          yield {
            type: 'modelMetadataEvent',
            usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
          }
        })

        const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

        const { items, result } = await collectGenerator(provider.streamAggregated(messages))

        expect(items).toContainEqual({
          type: 'toolUseBlock',
          toolUseId: 'tool1',
          name: 'get_weather',
          input: { location: 'Paris' },
        })
        expect(items).toContainEqual({
          type: 'modelMetadataEvent',
          usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
        })

        expect(result).toEqual({
          message: {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'toolUseBlock',
                toolUseId: 'tool1',
                name: 'get_weather',
                input: { location: 'Paris' },
              },
            ],
            trackingId: anyTrackingId,
            metadata: {
              usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
            },
          },
          stopReason: 'toolUse',
          metadata: {
            type: 'modelMetadataEvent',
            usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
          },
        })
      })

      it('yields complete tool use block with empty input', async () => {
        const provider = new TestModelProvider(async function* () {
          yield { type: 'modelMessageStartEvent', role: 'assistant' }
          yield {
            type: 'modelContentBlockStartEvent',
            start: { type: 'toolUseStart', toolUseId: 'tool1', name: 'get_time' },
          }
          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'toolUseInputDelta', input: '' },
          }
          yield { type: 'modelContentBlockStopEvent' }
          yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' }
          yield {
            type: 'modelMetadataEvent',
            usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
          }
        })

        const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

        const { items, result } = await collectGenerator(provider.streamAggregated(messages))

        expect(items).toContainEqual({
          type: 'toolUseBlock',
          toolUseId: 'tool1',
          name: 'get_time',
          input: {},
        })
        expect(items).toContainEqual({
          type: 'modelMetadataEvent',
          usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
        })

        expect(result).toEqual({
          message: {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'toolUseBlock',
                toolUseId: 'tool1',
                name: 'get_time',
                input: {},
              },
            ],
            trackingId: anyTrackingId,
            metadata: {
              usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
            },
          },
          stopReason: 'toolUse',
          metadata: {
            type: 'modelMetadataEvent',
            usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
          },
        })
      })

      it('throws MaxTokenError when stopReason is MaxTokenError and toolUse is partial', async () => {
        const provider = new TestModelProvider(async function* () {
          yield { type: 'modelMessageStartEvent', role: 'assistant' }
          yield {
            type: 'modelContentBlockStartEvent',
            start: { type: 'toolUseStart', toolUseId: 'tool1', name: 'get_weather' },
          }
          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'toolUseInputDelta', input: '{"location"' },
          }
          yield { type: 'modelMessageStopEvent', stopReason: 'maxTokens' }
          yield {
            type: 'modelMetadataEvent',
            usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
          }
        })

        const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

        await expect(async () => await collectGenerator(provider.streamAggregated(messages))).rejects.toThrow(
          MaxTokensError
        )
      })

      it('throws MaxTokensError when contentBlockStop arrives with truncated tool input JSON and stopReason is maxTokens', async () => {
        const provider = new TestModelProvider(async function* () {
          yield { type: 'modelMessageStartEvent', role: 'assistant' }
          yield {
            type: 'modelContentBlockStartEvent',
            start: { type: 'toolUseStart', toolUseId: 't', name: 'tool' },
          }
          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'toolUseInputDelta', input: '{"field": "value"' },
          }
          yield { type: 'modelContentBlockStopEvent' }
          yield { type: 'modelMessageStopEvent', stopReason: 'maxTokens' }
        })

        const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

        await expect(async () => await collectGenerator(provider.streamAggregated(messages))).rejects.toThrow(
          MaxTokensError
        )
      })

      it('surfaces SyntaxError as cause when tool input JSON is malformed and stopReason is not maxTokens', async () => {
        const provider = new TestModelProvider(async function* () {
          yield { type: 'modelMessageStartEvent', role: 'assistant' }
          yield {
            type: 'modelContentBlockStartEvent',
            start: { type: 'toolUseStart', toolUseId: 't', name: 'tool' },
          }
          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'toolUseInputDelta', input: '{invalid json' },
          }
          yield { type: 'modelContentBlockStopEvent' }
          yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' }
        })

        const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

        try {
          await collectGenerator(provider.streamAggregated(messages))
          expect.fail('Expected error to be thrown')
        } catch (error) {
          expect(error).toBeInstanceOf(ModelError)
          expect(error).not.toBeInstanceOf(MaxTokensError)
          expect((error as ModelError).message).toBe('unable to parse tool input JSON')
          expect((error as ModelError).cause).toBeInstanceOf(SyntaxError)
        }
      })

      it('attaches SyntaxError as cause when stream ends without a stop event after malformed tool input', async () => {
        const provider = new TestModelProvider(async function* () {
          yield { type: 'modelMessageStartEvent', role: 'assistant' }
          yield {
            type: 'modelContentBlockStartEvent',
            start: { type: 'toolUseStart', toolUseId: 't', name: 'tool' },
          }
          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'toolUseInputDelta', input: '{invalid json' },
          }
          yield { type: 'modelContentBlockStopEvent' }
        })

        const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

        try {
          await collectGenerator(provider.streamAggregated(messages))
          expect.fail('Expected error to be thrown')
        } catch (error) {
          expect(error).toBeInstanceOf(ModelError)
          expect(error).not.toBeInstanceOf(MaxTokensError)
          expect((error as ModelError).message).toBe('Stream ended without completing a message')
          expect((error as ModelError).cause).toBeInstanceOf(SyntaxError)
        }
      })
    })

    describe('when streaming reasoning content', () => {
      it('yields complete reasoning block', async () => {
        const provider = new TestModelProvider(async function* () {
          yield { type: 'modelMessageStartEvent', role: 'assistant' }
          yield { type: 'modelContentBlockStartEvent' }
          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'reasoningContentDelta', text: 'Thinking about', signature: 'sig1' },
          }
          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'reasoningContentDelta', text: ' the problem' },
          }
          yield { type: 'modelContentBlockStopEvent' }
          yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
          yield {
            type: 'modelMetadataEvent',
            usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
          }
        })

        const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

        const { items, result } = await collectGenerator(provider.streamAggregated(messages))

        expect(items).toContainEqual({
          type: 'reasoningBlock',
          text: 'Thinking about the problem',
          signature: 'sig1',
        })
        expect(items).toContainEqual({
          type: 'modelMetadataEvent',
          usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
        })

        expect(result).toEqual({
          message: {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'reasoningBlock',
                text: 'Thinking about the problem',
                signature: 'sig1',
              },
            ],
            trackingId: anyTrackingId,
            metadata: {
              usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
            },
          },
          stopReason: 'endTurn',
          metadata: {
            type: 'modelMetadataEvent',
            usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
          },
        })
      })

      it('yields redacted content reasoning block', async () => {
        const provider = new TestModelProvider(async function* () {
          yield { type: 'modelMessageStartEvent', role: 'assistant' }
          yield { type: 'modelContentBlockStartEvent' }
          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'reasoningContentDelta', redactedContent: new Uint8Array(0) },
          }
          yield { type: 'modelContentBlockStopEvent' }
          yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
          yield {
            type: 'modelMetadataEvent',
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          }
        })

        const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

        const { items, result } = await collectGenerator(provider.streamAggregated(messages))

        expect(items).toContainEqual({
          type: 'reasoningBlock',
          redactedContent: new Uint8Array(0),
        })
        expect(items).toContainEqual({
          type: 'modelMetadataEvent',
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        })

        expect(result).toEqual({
          message: {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'reasoningBlock',
                redactedContent: new Uint8Array(0),
              },
            ],
            trackingId: anyTrackingId,
            metadata: {
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            },
          },
          stopReason: 'endTurn',
          metadata: {
            type: 'modelMetadataEvent',
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          },
        })
      })

      it('omits signature if not present', async () => {
        const provider = new TestModelProvider(async function* () {
          yield { type: 'modelMessageStartEvent', role: 'assistant' }
          yield { type: 'modelContentBlockStartEvent' }
          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'reasoningContentDelta', text: 'Thinking' },
          }
          yield { type: 'modelContentBlockStopEvent' }
          yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
          yield {
            type: 'modelMetadataEvent',
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          }
        })

        const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

        const { items, result } = await collectGenerator(provider.streamAggregated(messages))

        expect(items).toContainEqual({
          type: 'reasoningBlock',
          text: 'Thinking',
        })
        expect(items).toContainEqual({
          type: 'modelMetadataEvent',
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        })

        expect(result).toEqual({
          message: {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'reasoningBlock',
                text: 'Thinking',
              },
            ],
            trackingId: anyTrackingId,
            metadata: {
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            },
          },
          stopReason: 'endTurn',
          metadata: {
            type: 'modelMetadataEvent',
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          },
        })
      })
    })

    describe('when streaming mixed content blocks', () => {
      it('yields all blocks in correct order', async () => {
        const provider = new TestModelProvider(async function* () {
          yield { type: 'modelMessageStartEvent', role: 'assistant' }
          yield { type: 'modelContentBlockStartEvent' }
          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'textDelta', text: 'Hello' },
          }
          yield { type: 'modelContentBlockStopEvent' }
          yield {
            type: 'modelContentBlockStartEvent',
            start: { type: 'toolUseStart', toolUseId: 'tool1', name: 'get_weather' },
          }
          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'toolUseInputDelta', input: '{"city": "Paris"}' },
          }
          yield { type: 'modelContentBlockStopEvent' }
          yield { type: 'modelContentBlockStartEvent' }
          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'reasoningContentDelta', text: 'Reasoning', signature: 'sig1' },
          }
          yield { type: 'modelContentBlockStopEvent' }
          yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
          yield {
            type: 'modelMetadataEvent',
            usage: { inputTokens: 10, outputTokens: 15, totalTokens: 25 },
          }
        })

        const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

        const { items, result } = await collectGenerator(provider.streamAggregated(messages))

        expect(items).toContainEqual({ type: 'textBlock', text: 'Hello' })
        expect(items).toContainEqual({
          type: 'toolUseBlock',
          toolUseId: 'tool1',
          name: 'get_weather',
          input: { city: 'Paris' },
        })
        expect(items).toContainEqual({ type: 'reasoningBlock', text: 'Reasoning', signature: 'sig1' })
        expect(items).toContainEqual({
          type: 'modelMetadataEvent',
          usage: { inputTokens: 10, outputTokens: 15, totalTokens: 25 },
        })

        expect(result).toEqual({
          message: {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'textBlock', text: 'Hello' },
              { type: 'toolUseBlock', toolUseId: 'tool1', name: 'get_weather', input: { city: 'Paris' } },
              { type: 'reasoningBlock', text: 'Reasoning', signature: 'sig1' },
            ],
            trackingId: anyTrackingId,
            metadata: {
              usage: { inputTokens: 10, outputTokens: 15, totalTokens: 25 },
            },
          },
          stopReason: 'endTurn',
          metadata: {
            type: 'modelMetadataEvent',
            usage: { inputTokens: 10, outputTokens: 15, totalTokens: 25 },
          },
        })
      })
    })

    describe('when a citations delta grounds already-streamed text', () => {
      const citation = {
        location: { type: 'web' as const, url: 'https://a.com' },
        source: 'https://a.com',
        sourceContent: [],
        title: 'A',
      }

      it('falls back to the accumulated text when the delta carries no content', async () => {
        const provider = new TestModelProvider(async function* () {
          yield { type: 'modelMessageStartEvent', role: 'assistant' }
          yield { type: 'modelContentBlockStartEvent' }
          yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'Hello' } }
          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'citationsDelta', citations: [citation], content: [] },
          }
          yield { type: 'modelContentBlockStopEvent' }
          yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
        })

        const { result } = await collectGenerator(
          provider.streamAggregated([new Message({ role: 'user', content: [new TextBlock('Hi')] })])
        )

        expect(result.message.content).toEqual([
          new CitationsBlock({ citations: [citation], content: [{ text: 'Hello' }] }),
        ])
      })

      it('keeps the delta content when it carries some', async () => {
        const provider = new TestModelProvider(async function* () {
          yield { type: 'modelMessageStartEvent', role: 'assistant' }
          yield { type: 'modelContentBlockStartEvent' }
          yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'Hello' } }
          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'citationsDelta', citations: [citation], content: [{ text: 'cited' }] },
          }
          yield { type: 'modelContentBlockStopEvent' }
          yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
        })

        const { result } = await collectGenerator(
          provider.streamAggregated([new Message({ role: 'user', content: [new TextBlock('Hi')] })])
        )

        expect(result.message.content).toEqual([
          new CitationsBlock({ citations: [citation], content: [{ text: 'cited' }] }),
        ])
      })
    })

    describe('when a content block emits no text deltas alongside reasoning and tool use', () => {
      it('drops the resulting empty TextBlock from the aggregated message but still yields it', async () => {
        const provider = new TestModelProvider(async function* () {
          yield { type: 'modelMessageStartEvent', role: 'assistant' }
          yield { type: 'modelContentBlockStartEvent' }
          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'reasoningContentDelta', text: 'Thinking', signature: 'sig1' },
          }
          yield { type: 'modelContentBlockStopEvent' }
          yield { type: 'modelContentBlockStartEvent' }
          yield { type: 'modelContentBlockStopEvent' }
          yield {
            type: 'modelContentBlockStartEvent',
            start: { type: 'toolUseStart', toolUseId: 'tool1', name: 'get_weather' },
          }
          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'toolUseInputDelta', input: '{"city": "Paris"}' },
          }
          yield { type: 'modelContentBlockStopEvent' }
          yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' }
        })

        const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

        const { items, result } = await collectGenerator(provider.streamAggregated(messages))

        expect(items).toContainEqual({ type: 'textBlock', text: '' })
        expect(result.message.content).toEqual([
          { type: 'reasoningBlock', text: 'Thinking', signature: 'sig1' },
          { type: 'toolUseBlock', toolUseId: 'tool1', name: 'get_weather', input: { city: 'Paris' } },
        ])
      })
    })

    describe('when multiple metadata events are emitted', () => {
      it('yields all metadata events but keeps only the last one in return value', async () => {
        const provider = new TestModelProvider(async function* () {
          yield { type: 'modelMessageStartEvent', role: 'assistant' }
          yield { type: 'modelContentBlockStartEvent' }
          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'textDelta', text: 'Hello' },
          }
          yield { type: 'modelContentBlockStopEvent' }
          yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
          yield {
            type: 'modelMetadataEvent',
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          }
          yield {
            type: 'modelMetadataEvent',
            usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
            metrics: { latencyMs: 100 },
          }
        })

        const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

        const { items, result } = await collectGenerator(provider.streamAggregated(messages))

        // Both metadata events should be yielded
        expect(items).toContainEqual({
          type: 'modelMetadataEvent',
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        })
        expect(items).toContainEqual({
          type: 'modelMetadataEvent',
          usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
          metrics: { latencyMs: 100 },
        })

        // Only the last metadata should be in return value
        expect(result).toEqual({
          message: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'textBlock', text: 'Hello' }],
            trackingId: anyTrackingId,
            metadata: {
              usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
              metrics: { latencyMs: 100 },
            },
          },
          stopReason: 'endTurn',
          metadata: {
            type: 'modelMetadataEvent',
            usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
            metrics: { latencyMs: 100 },
          },
        })
      })
    })

    describe('when no metadata events are emitted', () => {
      it('returns result with undefined metadata', async () => {
        const provider = new TestModelProvider(async function* () {
          yield { type: 'modelMessageStartEvent', role: 'assistant' }
          yield { type: 'modelContentBlockStartEvent' }
          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'textDelta', text: 'Hello' },
          }
          yield { type: 'modelContentBlockStopEvent' }
          yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
        })

        const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

        const { items, result } = await collectGenerator(provider.streamAggregated(messages))

        // No metadata event should be in yielded items
        expect(items.filter((item) => item.type === 'modelMetadataEvent')).toHaveLength(0)

        // Metadata should be undefined in return value
        expect(result).toEqual({
          message: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'textBlock', text: 'Hello' }],
            trackingId: anyTrackingId,
          },
          stopReason: 'endTurn',
          metadata: undefined,
        })
      })
    })

    describe('when stream() throws an error', () => {
      it('wraps non-ModelError errors in ModelError with original as cause', async () => {
        const originalError = new Error('API connection failed')
        const provider = new ErrorThrowingModelProvider(originalError)

        const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

        try {
          await collectGenerator(provider.streamAggregated(messages))
          expect.fail('Expected error to be thrown')
        } catch (error) {
          expect(error).toBeInstanceOf(ModelError)
          expect((error as ModelError).message).toBe('API connection failed')
          expect((error as ModelError).cause).toBe(originalError)
        }
      })
    })

    describe('when receiving redact content events', () => {
      it('returns redaction.userMessage when inputRedaction is present', async () => {
        const provider = new TestModelProvider(async function* () {
          yield { type: 'modelMessageStartEvent', role: 'assistant' }
          yield { type: 'modelContentBlockStartEvent' }
          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'textDelta', text: 'Hello' },
          }
          yield { type: 'modelContentBlockStopEvent' }
          yield { type: 'modelMessageStopEvent', stopReason: 'guardrailIntervened' }
          yield {
            type: 'modelMetadataEvent',
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          }
          yield {
            type: 'modelRedactionEvent',
            inputRedaction: { replaceContent: '[User input redacted.]' },
          }
        })

        const messages = [new Message({ role: 'user', content: [new TextBlock('Sensitive content')] })]

        const { result } = await collectGenerator(provider.streamAggregated(messages))

        // Verify redaction.userMessage is returned for agent to handle
        expect(result.redaction?.userMessage).toBe('[User input redacted.]')

        // Messages array should NOT be modified (agent handles this)
        expect(messages[0]!.content).toEqual([{ type: 'textBlock', text: 'Sensitive content' }])
      })

      it('redacts assistant message directly when outputRedaction is present', async () => {
        const provider = new TestModelProvider(async function* () {
          yield { type: 'modelMessageStartEvent', role: 'assistant' }
          yield { type: 'modelContentBlockStartEvent' }
          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'textDelta', text: 'Harmful content' },
          }
          yield { type: 'modelContentBlockStopEvent' }
          yield { type: 'modelMessageStopEvent', stopReason: 'guardrailIntervened' }
          yield {
            type: 'modelMetadataEvent',
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          }
          yield {
            type: 'modelRedactionEvent',
            outputRedaction: { replaceContent: '[Assistant output redacted.]' },
          }
        })

        const messages = [new Message({ role: 'user', content: [new TextBlock('Tell me something')] })]

        const { result } = await collectGenerator(provider.streamAggregated(messages))

        // Assistant message is redacted directly by the model
        expect(result.message.role).toBe('assistant')
        expect(result.message.content).toEqual([{ type: 'textBlock', text: '[Assistant output redacted.]' }])

        // No redaction.userMessage since assistant redaction is handled directly
        expect(result.redaction?.userMessage).toBeUndefined()
      })

      it('returns redactionMessage and redacts assistant when both are present', async () => {
        const provider = new TestModelProvider(async function* () {
          yield { type: 'modelMessageStartEvent', role: 'assistant' }
          yield { type: 'modelContentBlockStartEvent' }
          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'textDelta', text: 'Response' },
          }
          yield { type: 'modelContentBlockStopEvent' }
          yield { type: 'modelMessageStopEvent', stopReason: 'guardrailIntervened' }
          yield {
            type: 'modelMetadataEvent',
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          }
          yield {
            type: 'modelRedactionEvent',
            inputRedaction: { replaceContent: '[User input redacted.]' },
          }
          yield {
            type: 'modelRedactionEvent',
            outputRedaction: { replaceContent: '[Assistant output redacted.]' },
          }
        })

        const messages = [new Message({ role: 'user', content: [new TextBlock('Input')] })]

        const { result } = await collectGenerator(provider.streamAggregated(messages))

        // Verify redaction.userMessage is returned for agent to handle user redaction
        expect(result.redaction?.userMessage).toBe('[User input redacted.]')

        // Assistant message is redacted directly
        expect(result.message.role).toBe('assistant')
        expect(result.message.content).toEqual([{ type: 'textBlock', text: '[Assistant output redacted.]' }])
      })

      it('does not include redaction when no redact events are received', async () => {
        const provider = new TestModelProvider(async function* () {
          yield { type: 'modelMessageStartEvent', role: 'assistant' }
          yield { type: 'modelContentBlockStartEvent' }
          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'textDelta', text: 'Hello' },
          }
          yield { type: 'modelContentBlockStopEvent' }
          yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
          yield {
            type: 'modelMetadataEvent',
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          }
        })

        const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]

        const { result } = await collectGenerator(provider.streamAggregated(messages))

        // Verify redaction.userMessage is undefined
        expect(result.redaction?.userMessage).toBeUndefined()
      })
    })
  })
})

describe('Model.modelId', () => {
  it('returns modelId from model config', () => {
    const provider = new TestModelProvider()
    provider.updateConfig({ modelId: 'my-model' })

    expect(provider.modelId).toBe('my-model')
  })
})

describe('countTokens', () => {
  it('estimates text block tokens using chars/4 heuristic', async () => {
    const provider = new TestModelProvider()
    const messages = [new Message({ role: 'user', content: [new TextBlock('Hello world')] })]

    const result = await provider.countTokens(messages)

    expect(result).toBe(3)
  })

  it('estimates toolUse block tokens (name + JSON input)', async () => {
    const provider = new TestModelProvider()
    const messages = [
      new Message({
        role: 'assistant',
        content: [new ToolUseBlock({ name: 'get_weather', toolUseId: 'id1', input: { city: 'Seattle' } })],
      }),
    ]

    const result = await provider.countTokens(messages)

    expect(result).toBe(3 + 9)
  })

  it('estimates toolResult block tokens (text items only)', async () => {
    const provider = new TestModelProvider()
    const messages = [
      new Message({
        role: 'user',
        content: [
          new ToolResultBlock({
            toolUseId: 'id1',
            status: 'success',
            content: [new TextBlock('72°F and sunny')],
          }),
        ],
      }),
    ]

    const result = await provider.countTokens(messages)

    expect(result).toBe(Math.ceil('72°F and sunny'.length / 4))
  })

  it('estimates reasoning block tokens', async () => {
    const provider = new TestModelProvider()
    const messages = [
      new Message({
        role: 'assistant',
        content: [new ReasoningBlock({ text: 'Let me think about this step by step' })],
      }),
    ]

    const result = await provider.countTokens(messages)

    expect(result).toBe(Math.ceil('Let me think about this step by step'.length / 4))
  })

  it('estimates guardContent block tokens', async () => {
    const provider = new TestModelProvider()
    const messages = [
      new Message({
        role: 'user',
        content: [
          new GuardContentBlock({
            text: { qualifiers: ['query'], text: 'Is this safe?' },
          }),
        ],
      }),
    ]

    const result = await provider.countTokens(messages)

    expect(result).toBe(Math.ceil('Is this safe?'.length / 4))
  })

  it('estimates citations block tokens', async () => {
    const provider = new TestModelProvider()
    const messages = [
      new Message({
        role: 'assistant',
        content: [
          new CitationsBlock({
            citations: [],
            content: [{ text: 'cited text here' }],
          }),
        ],
      }),
    ]

    const result = await provider.countTokens(messages)

    expect(result).toBe(Math.ceil('cited text here'.length / 4))
  })

  it('estimates string system prompt tokens', async () => {
    const provider = new TestModelProvider()
    const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

    const result = await provider.countTokens(messages, {
      systemPrompt: 'You are a helpful assistant',
    })

    expect(result).toBe(Math.ceil('You are a helpful assistant'.length / 4) + Math.ceil('Hi'.length / 4))
  })

  it('estimates array system prompt tokens', async () => {
    const provider = new TestModelProvider()
    const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

    const result = await provider.countTokens(messages, {
      systemPrompt: [new TextBlock('System instructions')],
    })

    expect(result).toBe(Math.ceil('System instructions'.length / 4) + Math.ceil('Hi'.length / 4))
  })

  it('estimates tool spec tokens', async () => {
    const provider = new TestModelProvider()
    const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]
    const toolSpecs = [{ name: 'get_weather', description: 'Get weather for a city' }]

    const result = await provider.countTokens(messages, { toolSpecs })

    const specJson = JSON.stringify(toolSpecs[0])
    expect(result).toBe(Math.ceil('Hi'.length / 4) + Math.ceil(specJson.length / 2))
  })

  it('returns 0 for empty messages', async () => {
    const provider = new TestModelProvider()

    const result = await provider.countTokens([])

    expect(result).toBe(0)
  })

  it('skips reasoning blocks without text', async () => {
    const provider = new TestModelProvider()
    const messages = [
      new Message({
        role: 'assistant',
        content: [new ReasoningBlock({ signature: 'sig123' })],
      }),
    ]

    const result = await provider.countTokens(messages)

    expect(result).toBe(0)
  })

  it('estimates guardContent in array system prompt', async () => {
    const provider = new TestModelProvider()
    const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

    const result = await provider.countTokens(messages, {
      systemPrompt: [new GuardContentBlock({ text: { qualifiers: ['query'], text: 'Guard text here' } })],
    })

    expect(result).toBe(Math.ceil('Guard text here'.length / 4) + Math.ceil('Hi'.length / 4))
  })

  it('accumulates tokens across multiple messages with mixed content', async () => {
    const provider = new TestModelProvider()
    const messages = [
      new Message({ role: 'user', content: [new TextBlock('What is the weather?')] }),
      new Message({
        role: 'assistant',
        content: [new ToolUseBlock({ name: 'get_weather', toolUseId: 'id1', input: { city: 'Seattle' } })],
      }),
      new Message({
        role: 'user',
        content: [new ToolResultBlock({ toolUseId: 'id1', status: 'success', content: [new TextBlock('72F')] })],
      }),
    ]

    const result = await provider.countTokens(messages, { systemPrompt: 'You are helpful' })

    const expected =
      Math.ceil('You are helpful'.length / 4) +
      Math.ceil('What is the weather?'.length / 4) +
      Math.ceil('get_weather'.length / 4) +
      Math.ceil(JSON.stringify({ city: 'Seattle' }).length / 2) +
      Math.ceil('72F'.length / 4)
    expect(result).toBe(expected)
  })
})

describe('estimateUtilization', () => {
  it('returns ratio of inputTokens to contextWindowLimit', () => {
    const provider = new TestModelProvider()
    provider.updateConfig({ contextWindowLimit: 100_000 })

    expect(provider.estimateUtilization(50_000)).toBe(0.5)
  })

  it('uses DEFAULT_CONTEXT_WINDOW_LIMIT when contextWindowLimit is not set', () => {
    const provider = new TestModelProvider()

    expect(provider.estimateUtilization(100_000)).toBe(100_000 / 200_000)
  })

  it('returns value above 1.0 when tokens exceed limit', () => {
    const provider = new TestModelProvider()
    provider.updateConfig({ contextWindowLimit: 1000 })

    expect(provider.estimateUtilization(1500)).toBeGreaterThan(1.0)
  })

  it('returns 0 for zero tokens', () => {
    const provider = new TestModelProvider()
    provider.updateConfig({ contextWindowLimit: 100_000 })

    expect(provider.estimateUtilization(0)).toBe(0)
  })
})
