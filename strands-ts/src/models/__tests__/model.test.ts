import { describe, it, expect, vi } from 'vitest'
import {
  Message,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ReasoningBlock,
  GuardContentBlock,
  InjectedBlock,
  SummaryBlock,
  CachePointBlock,
  type StopReason,
} from '../../types/messages.js'
import { CitationsBlock } from '../../types/citations.js'
import { TestModelProvider, collectGenerator } from '../../__fixtures__/model-test-helpers.js'
import { MaxTokensError, ModelError } from '../../errors.js'
import { Model } from '../model.js'
import { mergeModelInfo, type ModelInfo } from '../model-info.js'
import type { BaseModelConfig, StreamOptions } from '../model.js'
import { isModelStreamEvent, type ModelStreamEvent, type Usage } from '../streaming.js'
import { DEFAULT_SUMMARIZE_INSTRUCTIONS, SUMMARIZE_GUARD } from '../summarize.js'
import { logger } from '../../logging/logger.js'
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

    // Guards against https://github.com/strands-agents/harness-sdk/issues/5763 and
    // https://github.com/strands-agents/harness-sdk/issues/3189: a stream without a message start
    // still completes as an assistant message.
    describe('when the stream has no message start event', () => {
      it('completes a message with streamed text and tool use as the assistant', async () => {
        const provider = new TestModelProvider(async function* () {
          yield { type: 'modelContentBlockStartEvent' }
          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'textDelta', text: 'Checking' },
          }
          yield { type: 'modelContentBlockStopEvent' }
          yield {
            type: 'modelContentBlockStartEvent',
            start: { type: 'toolUseStart', toolUseId: 'tool1', name: 'get_weather' },
          }
          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'toolUseInputDelta', input: '{"location": "Paris"}' },
          }
          yield { type: 'modelContentBlockStopEvent' }
          yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' }
        })

        const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

        const { result } = await collectGenerator(provider.streamAggregated(messages))

        expect(result).toEqual({
          message: {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'textBlock', text: 'Checking' },
              {
                type: 'toolUseBlock',
                toolUseId: 'tool1',
                name: 'get_weather',
                input: { location: 'Paris' },
              },
            ],
            trackingId: anyTrackingId,
          },
          stopReason: 'toolUse',
        })
      })

      it('returns an empty assistant message when the turn is empty', async () => {
        const provider = new TestModelProvider(async function* () {
          yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
          yield {
            type: 'modelMetadataEvent',
            usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
          }
        })

        const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

        const { result } = await collectGenerator(provider.streamAggregated(messages))

        expect(result).toEqual({
          message: {
            type: 'message',
            role: 'assistant',
            content: [],
            trackingId: anyTrackingId,
            metadata: {
              usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
            },
          },
          stopReason: 'endTurn',
          metadata: {
            type: 'modelMetadataEvent',
            usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
          },
        })
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

    describe('when content blocks have no start events', () => {
      it('keeps text and citations scoped to each completed block', async () => {
        const citation = {
          location: { type: 'documentChunk' as const, documentIndex: 0, start: 0, end: 1 },
          source: '',
          sourceContent: [{ text: 'Project Atlas automates invoice processing.' }],
          title: 'doc1',
        }
        const provider = new TestModelProvider(async function* () {
          yield { type: 'modelMessageStartEvent', role: 'assistant' }

          yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'From the document: ' } }
          yield { type: 'modelContentBlockStopEvent' }

          yield {
            type: 'modelContentBlockDeltaEvent',
            delta: { type: 'citationsDelta', citations: [citation], content: [] },
          }
          yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'Atlas ' } }
          yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'automates invoices.' } }
          yield { type: 'modelContentBlockStopEvent' }

          yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: ' That is the summary.' } }
          yield { type: 'modelContentBlockStopEvent' }

          yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
        })

        const { items, result } = await collectGenerator(
          provider.streamAggregated([new Message({ role: 'user', content: [new TextBlock('What is Atlas?')] })])
        )

        const expectedContent = [
          new TextBlock('From the document: '),
          new CitationsBlock({ citations: [citation], content: [{ text: 'Atlas automates invoices.' }] }),
          new TextBlock(' That is the summary.'),
        ]
        expect(items.filter((item) => !isModelStreamEvent(item))).toEqual(expectedContent)
        expect(result.message.content).toEqual(expectedContent)
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

/** Replies with `reply` texts and `stopReason`, recording each stream call. */
class RecordingModel extends TestModelProvider {
  readonly calls: { messages: Message[]; options: StreamOptions | undefined }[] = []

  constructor(
    private readonly _reply: string[] = ['the summary'],
    private readonly _stopReason: StopReason = 'endTurn',
    private readonly _error?: Error,
    private readonly _usage?: Usage
  ) {
    super()
  }

  override async *stream(messages: Message[], options?: StreamOptions): AsyncGenerator<ModelStreamEvent> {
    this.calls.push({ messages, options })
    if (this._error) throw this._error
    yield { type: 'modelMessageStartEvent', role: 'assistant' }
    for (const text of this._reply) {
      yield { type: 'modelContentBlockStartEvent' }
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text } }
      yield { type: 'modelContentBlockStopEvent' }
    }
    if (this._usage) yield { type: 'modelMetadataEvent', usage: this._usage }
    yield { type: 'modelMessageStopEvent', stopReason: this._stopReason }
  }
}

describe('summarize', () => {
  const history = (): Message[] => [
    new Message({ role: 'user', content: [new TextBlock('task')] }),
    new Message({
      role: 'assistant',
      content: [new ToolUseBlock({ toolUseId: 't1', name: 'lookup', input: { q: 'x' } })],
    }),
    new Message({
      role: 'user',
      content: [new ToolResultBlock({ toolUseId: 't1', status: 'success', content: [new TextBlock('42')] })],
    }),
  ]
  const hi = (): Message[] => [new Message({ role: 'user', content: [new TextBlock('hi')] })]
  const zeroUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  const turns = (messages: Message[]): { role: string; content: unknown[] }[] =>
    messages.map(({ role, content }) => ({ role, content }))

  it('replays the request with the instructions closing it', async () => {
    const model = new RecordingModel(['first', 'second'])
    const messages = history()
    const toolSpecs = [{ name: 'lookup', description: 'Look up', inputSchema: { type: 'object' as const } }]
    const systemPrompt = [new TextBlock('live prompt'), new CachePointBlock({ cacheType: 'default' })]

    const result = await model.summarize(messages, { toolSpecs, systemPrompt, instructions: 'Summarize briefly.' })

    expect(result).toEqual({ content: [new SummaryBlock({ text: 'first\nsecond' })], usage: zeroUsage })
    expect(model.calls).toHaveLength(1)
    const call = model.calls[0]!
    expect(turns(call.messages)).toEqual(
      turns([
        ...history().slice(0, 2),
        new Message({
          role: 'user',
          content: [...history()[2]!.content, new TextBlock(`${SUMMARIZE_GUARD}\n\nSummarize briefly.`)],
        }),
      ])
    )
    expect(call.options).toEqual({ toolSpecs, systemPrompt })
    expect(turns(messages)).toEqual(turns(history()))
  })

  it('sends the agent metadata', async () => {
    const model = new RecordingModel()
    const agentMetadata = { sessionId: 'session' }

    await model.summarize(history().slice(0, 2), { agentMetadata })

    expect(model.calls).toHaveLength(1)
    expect(turns(model.calls[0]!.messages)).toEqual(
      turns([
        ...history().slice(0, 2),
        new Message({
          role: 'user',
          content: [new TextBlock(`${SUMMARIZE_GUARD}\n\n${DEFAULT_SUMMARIZE_INSTRUCTIONS}`)],
        }),
      ])
    )
    expect(model.calls[0]!.options).toEqual({ agentMetadata })
  })

  it('adds a user turn after an assistant turn', async () => {
    const model = new RecordingModel()

    await model.summarize(history().slice(0, 2), { instructions: 'Summarize briefly.' })

    expect(turns(model.calls[0]!.messages)).toEqual(
      turns([
        ...history().slice(0, 2),
        new Message({ role: 'user', content: [new TextBlock(`${SUMMARIZE_GUARD}\n\nSummarize briefly.`)] }),
      ])
    )
  })

  it.each([{ instructions: undefined }, { instructions: '' }])(
    'sends no system prompt and the default instructions for instructions=$instructions',
    async ({ instructions }) => {
      const model = new RecordingModel()

      await model.summarize(hi(), { ...(instructions !== undefined && { instructions }) })

      expect(model.calls[0]!.options?.systemPrompt).toBeUndefined()
      expect(model.calls[0]!.messages.at(-1)!.content.at(-1)).toEqual(
        new TextBlock(`${SUMMARIZE_GUARD}\n\n${DEFAULT_SUMMARIZE_INSTRUCTIONS}`)
      )
    }
  )

  it.each<StopReason>(['toolUse', 'guardrailIntervened', 'contentFiltered'])(
    'returns an empty summary for an unfinished reply: %s',
    async (stopReason) => {
      const usage = { inputTokens: 10, outputTokens: 1, totalTokens: 11 }
      const model = new RecordingModel(['canned'], stopReason, undefined, usage)
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

      const result = await model.summarize(hi())

      expect(result).toEqual({ content: [], usage })
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`stop_reason=<${stopReason}> | summary reply did not finish`)
      )
      warnSpy.mockRestore()
    }
  )

  it('returns an empty summary when cancelled mid-stream', async () => {
    const controller = new AbortController()
    const model = new TestModelProvider(async function* () {
      yield { type: 'modelMessageStartEvent', role: 'assistant' }
      yield { type: 'modelContentBlockStartEvent' }
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'partial' } }
      controller.abort()
      yield { type: 'modelContentBlockStopEvent' }
      yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
    })
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    const result = await model.summarize(hi(), { cancelSignal: controller.signal })

    expect(result.content).toEqual([])
    warnSpy.mockRestore()
  })

  it.each<StopReason>(['maxTokens', 'stopSequence'])(
    'keeps a reply that stopped at a limit: %s',
    async (stopReason) => {
      const model = new RecordingModel(['partial'], stopReason)

      const result = await model.summarize(hi())

      expect(result).toEqual({ content: [new SummaryBlock({ text: 'partial' })], usage: zeroUsage })
    }
  )

  it('returns an empty summary when the reply holds no text', async () => {
    const usage = { inputTokens: 10, outputTokens: 1, totalTokens: 11 }
    const model = new RecordingModel(['  '], 'endTurn', undefined, usage)

    const result = await model.summarize(hi())

    expect(result).toEqual({ content: [], usage })
  })

  it('returns its usage', async () => {
    const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
    const model = new RecordingModel(['the summary'], 'endTurn', undefined, usage)

    const result = await model.summarize(hi())

    expect(result.usage).toEqual(usage)
  })

  it('forwards the cancel signal', async () => {
    const model = new RecordingModel()
    const cancelSignal = new AbortController().signal

    await model.summarize(hi(), { cancelSignal })

    expect(model.calls[0]!.options?.cancelSignal).toBe(cancelSignal)
  })

  it('propagates stream errors', async () => {
    const model = new RecordingModel(['the summary'], 'endTurn', new Error('images unsupported'))

    await expect(model.summarize(hi())).rejects.toThrow('images unsupported')
    expect(model.calls).toHaveLength(1)
  })
})

describe('countTokens', () => {
  it('counts summary text like a text block', async () => {
    const provider = new TestModelProvider()
    const text = 'x'.repeat(400)

    const summary = await provider.countTokens([
      new Message({ role: 'assistant', content: [new SummaryBlock({ text })] }),
    ])

    expect(summary).toBe(
      await provider.countTokens([new Message({ role: 'assistant', content: [new TextBlock(text)] })])
    )
  })

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

  it('estimates injected block tokens', async () => {
    const provider = new TestModelProvider()
    const messages = [
      new Message({ role: 'user', content: [new InjectedBlock({ text: 'cwd: /repo, date: today', source: 'test' })] }),
    ]

    const result = await provider.countTokens(messages)

    expect(result).toBe(Math.ceil('cwd: /repo, date: today'.length / 4))
  })

  it('counts only the injected blocks of the latest user message', async () => {
    const provider = new TestModelProvider()
    const messages = [
      new Message({ role: 'user', content: [new InjectedBlock({ text: 'x'.repeat(400), source: 'test' })] }),
      new Message({ role: 'assistant', content: [new TextBlock('ok')] }),
      new Message({ role: 'user', content: [new InjectedBlock({ text: 'cwd: /repo', source: 'test' })] }),
    ]
    const result = await provider.countTokens(messages)
    expect(result).toBe(Math.ceil('ok'.length / 4) + Math.ceil('cwd: /repo'.length / 4))
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

describe('info', () => {
  it('knows only that temporary messages and server-side summary are off for a provider with no model id, and unknown stateful reads as false', () => {
    const provider = new TestModelProvider()
    expect(provider.modelInfo).toEqual({ capabilities: { temporaryMessages: false, serverSideSummary: false } })
    expect(provider.stateful).toBe(false)
  })

  it('resolves facts from the shared model info for any provider by modelId', () => {
    const provider = new TestModelProvider()
    provider.updateConfig({ modelId: 'us.anthropic.claude-sonnet-4-6' })

    expect(provider.modelInfo.limits?.contextWindow).toBe(1_000_000)
    expect(provider.modelInfo.capabilities?.promptCaching).toBe('cachePoints')
  })

  it('leaves temporary messages off for a model the shared data says takes them', () => {
    const provider = new TestModelProvider()
    provider.updateConfig({ modelId: 'vertex.claude-opus-5-5' })
    expect(provider.modelInfo.capabilities?.temporaryMessages).toBe(false)
  })

  it('lets a provider put its facts over the shared model info, with the user override over both', () => {
    class GatewayProvider extends TestModelProvider {
      override get modelInfo(): ModelInfo {
        return mergeModelInfo(
          super.modelInfo,
          { capabilities: { promptCaching: 'unsupported' } },
          this.getConfig().modelInfo
        )
      }
    }
    const provider = new GatewayProvider()
    provider.updateConfig({ modelId: 'claude-sonnet-4-6', contextWindowLimit: 8_000 })
    expect(provider.modelInfo.capabilities?.promptCaching).toBe('unsupported') // shared file says cachePoints
    expect(provider.modelInfo.limits?.contextWindow).toBe(8_000)
    expect(Object.isFrozen(provider.modelInfo)).toBe(true)

    provider.updateConfig({ modelInfo: { capabilities: { promptCaching: 'cachePoints' } } })
    expect(provider.modelInfo.capabilities?.promptCaching).toBe('cachePoints')
  })

  it('lets the info override set stateful, and the stateful getter reads it', () => {
    const provider = new TestModelProvider()
    expect(provider.stateful).toBe(false)

    provider.updateConfig({ modelInfo: { capabilities: { stateful: true } } })

    expect(provider.modelInfo.capabilities?.stateful).toBe(true)
    expect(provider.stateful).toBe(true)
  })

  it('lets the info override win over contextWindowLimit', () => {
    const provider = new TestModelProvider()
    provider.updateConfig({ contextWindowLimit: 50_000, modelInfo: { limits: { contextWindow: 10_000 } } })

    expect(provider.modelInfo.limits?.contextWindow).toBe(10_000)
  })

  it('takes the context window from the config', () => {
    const provider = new TestModelProvider()
    provider.updateConfig({ contextWindowLimit: 50_000 })

    expect(provider.modelInfo.limits?.contextWindow).toBe(50_000)
  })

  it('reads stateful from what a provider puts in the record', () => {
    class StatefulProvider extends TestModelProvider {
      override get modelInfo(): ModelInfo {
        return mergeModelInfo(super.modelInfo, { capabilities: { stateful: true } }, this.getConfig().modelInfo)
      }
    }
    const provider = new StatefulProvider()
    expect(provider.stateful).toBe(true)

    provider.updateConfig({ modelInfo: { capabilities: { stateful: false } } })
    expect(provider.stateful).toBe(false)
  })

  it('reflects config changes on the next read', () => {
    const provider = new TestModelProvider()
    expect(provider.modelInfo.limits?.contextWindow).toBeUndefined()

    provider.updateConfig({ contextWindowLimit: 4_096 })

    expect(provider.modelInfo.limits?.contextWindow).toBe(4_096)
  })
})

describe('estimateUtilization', () => {
  it('uses the context window from info, including an info override', () => {
    const provider = new TestModelProvider()
    provider.updateConfig({ modelInfo: { limits: { contextWindow: 10_000 } } })

    expect(provider.estimateUtilization(5_000)).toBe(0.5)
  })

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
