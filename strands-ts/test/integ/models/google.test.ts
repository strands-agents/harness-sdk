import { describe, expect, it } from 'vitest'
import { Message, TextBlock, ToolResultBlock, ToolUseBlock } from '@strands-agents/sdk'
import type { ModelStreamEvent, Usage } from '$/sdk/models/streaming.js'

import { collectIterator } from '$/sdk/__fixtures__/model-test-helpers.js'

import { gemini } from '../__fixtures__/model-providers.js'

/**
 * Gemini-specific integration tests.
 *
 * Tests for functionality covered by agent.test.ts (system prompts, conversation context,
 * media content, reasoning, basic agent usage) are intentionally omitted here to avoid duplication.
 * This file focuses on low-level model provider behavior specific to Gemini.
 */
describe.skipIf(gemini.skip)('GoogleModel Integration Tests', () => {
  describe('Streaming', () => {
    describe('Configuration', () => {
      it.concurrent('respects temperature configuration', async () => {
        const provider = gemini.createModel({
          params: { temperature: 0, maxOutputTokens: 50 },
        })

        const messages: Message[] = [
          new Message({
            role: 'user',
            content: [new TextBlock('Say "hello world" exactly.')],
          }),
        ]

        const events1 = await collectIterator<ModelStreamEvent>(provider.stream(messages))
        const events2 = await collectIterator<ModelStreamEvent>(provider.stream(messages))

        let text1 = ''
        let text2 = ''

        for (const event of events1) {
          if (event.type === 'modelContentBlockDeltaEvent' && event.delta.type === 'textDelta') {
            text1 += event.delta.text
          }
        }

        for (const event of events2) {
          if (event.type === 'modelContentBlockDeltaEvent' && event.delta.type === 'textDelta') {
            text2 += event.delta.text
          }
        }

        expect(text1.length).toBeGreaterThan(0)
        expect(text2.length).toBeGreaterThan(0)
        expect(text1.toLowerCase()).toContain('hello')
        expect(text2.toLowerCase()).toContain('hello')
      })
    })

    describe('Error Handling', () => {
      it.concurrent('handles invalid model ID gracefully', async () => {
        const provider = gemini.createModel({
          modelId: 'invalid-model-id-that-does-not-exist-xyz',
        })

        const messages: Message[] = [
          new Message({
            role: 'user',
            content: [new TextBlock('Hello')],
          }),
        ]

        await expect(collectIterator(provider.stream(messages))).rejects.toThrow(/not found/i)
      })
    })

    describe('Content Block Lifecycle', () => {
      it.concurrent('emits complete content block lifecycle events', async () => {
        const provider = gemini.createModel({
          params: { maxOutputTokens: 50 },
        })

        const messages: Message[] = [
          new Message({
            role: 'user',
            content: [new TextBlock('Say hello.')],
          }),
        ]

        const events = await collectIterator<ModelStreamEvent>(provider.stream(messages))

        const startEvents = events.filter((e) => e.type === 'modelContentBlockStartEvent')
        const deltaEvents = events.filter((e) => e.type === 'modelContentBlockDeltaEvent')
        const stopEvents = events.filter((e) => e.type === 'modelContentBlockStopEvent')

        expect(startEvents.length).toBeGreaterThan(0)
        expect(deltaEvents.length).toBeGreaterThan(0)
        expect(stopEvents.length).toBeGreaterThan(0)

        const startIndex = events.findIndex((e) => e.type === 'modelContentBlockStartEvent')
        const firstDeltaIndex = events.findIndex((e) => e.type === 'modelContentBlockDeltaEvent')
        expect(startIndex).toBeLessThan(firstDeltaIndex)

        const stopIndex = events.findIndex((e) => e.type === 'modelContentBlockStopEvent')
        const lastDeltaIndex = events
          .map((e, i) => (e.type === 'modelContentBlockDeltaEvent' ? i : -1))
          .filter((i) => i !== -1)
          .pop()!
        expect(stopIndex).toBeGreaterThan(lastDeltaIndex)
      })
    })

    describe('Stop Reasons', () => {
      it.concurrent('returns endTurn stop reason for natural completion', async () => {
        const provider = gemini.createModel({
          params: { maxOutputTokens: 100 },
        })

        const messages: Message[] = [
          new Message({
            role: 'user',
            content: [new TextBlock('Say hi.')],
          }),
        ]

        const events = await collectIterator<ModelStreamEvent>(provider.stream(messages))

        const messageStopEvent = events.find((e) => e.type === 'modelMessageStopEvent')
        expect(messageStopEvent).toBeDefined()
        expect(messageStopEvent?.stopReason).toBe('endTurn')
      })
    })

    describe('Usage Metadata', () => {
      it.concurrent('reports usage that satisfies the total invariant on a tool-using turn', async () => {
        const provider = gemini.createModel({ params: { maxOutputTokens: 100 } })

        const toolSpecs = [
          {
            name: 'get_weather',
            description: 'Get the current weather for a city',
            inputSchema: { type: 'object' as const, properties: { city: { type: 'string' as const } } },
          },
        ]
        const messages: Message[] = [
          new Message({ role: 'user', content: [new TextBlock('What is the weather in New York?')] }),
          new Message({
            role: 'assistant',
            content: [new ToolUseBlock({ name: 'get_weather', toolUseId: 'weather-1', input: { city: 'New York' } })],
          }),
          new Message({
            role: 'user',
            content: [
              new ToolResultBlock({ toolUseId: 'weather-1', status: 'success', content: [new TextBlock('sunny')] }),
            ],
          }),
        ]

        const events = await collectIterator<ModelStreamEvent>(provider.stream(messages, { toolSpecs }))

        const metadataEvent = events.find((e) => e.type === 'modelMetadataEvent')
        const usage = metadataEvent?.usage
        expect(usage).toBeDefined()
        expect(usage!.inputTokens).toBeGreaterThan(0)
        expect(usage!.outputTokens).toBeGreaterThan(0)
        expect(usage!.totalTokens).toBe(usage!.inputTokens + usage!.outputTokens)
      })
    })
  })

  describe('countTokens', () => {
    const messages = [
      new Message({ role: 'user', content: [new TextBlock('What is the capital of France? Explain in detail.')] }),
    ]
    const toolSpecs = [
      {
        name: 'get_weather',
        description: 'Get the current weather for a location',
        inputSchema: { type: 'object' as const, properties: { location: { type: 'string' as const } } },
      },
    ]

    it.concurrent('should count tokens for messages only', async () => {
      const model = gemini.createModel()
      const result = await model.countTokens(messages)
      expect(typeof result).toBe('number')
      expect(result).toBeGreaterThan(0)
    })

    it.concurrent('should return more tokens with tools and system prompt', async () => {
      const model = gemini.createModel()
      const without = await model.countTokens(messages)
      const withTools = await model.countTokens(messages, { toolSpecs, systemPrompt: 'Be helpful.' })
      expect(withTools).toBeGreaterThan(without)
    })
  })

  describe('Prompt Caching', () => {
    // A system prompt large enough to clear Gemini's minimum cacheable-token threshold for explicit
    // CachedContent; a shorter prefix is declined and silently falls back to implicit caching.
    const cacheableSystemPrompt = [
      'You are a meticulous assistant. Follow these standing guidelines on every turn.',
      ...Array.from(
        { length: 600 },
        (_unused, index) => `Guideline ${index}: be accurate, state any assumptions you make, and keep answers concise.`
      ),
    ].join('\n')

    function usageOf(events: ModelStreamEvent[]): Usage | undefined {
      return events.find((event) => event.type === 'modelMetadataEvent')?.usage
    }

    it('creates a managed cache and reuses it across a fresh model with the same prefix', async () => {
      // A unique cacheKey makes this run own its resource, so reuse is proven, not inherited.
      const cacheConfig = { ttl: '5m', cacheKey: `strands-integ-${globalThis.crypto.randomUUID()}` }
      const messages: Message[] = [
        new Message({ role: 'user', content: [new TextBlock('In one sentence, what do your guidelines ask of you?')] }),
      ]
      // Disable thinking: gemini-2.5-flash is a thinking model, and a small output budget can be spent
      // entirely on thinking, yielding an empty response with no usage to assert against.
      const params = { maxOutputTokens: 50, thinkingConfig: { thinkingBudget: 0 } }

      const creator = gemini.createModel({ cacheConfig, params })
      const creatorEvents = await collectIterator<ModelStreamEvent>(
        creator.stream(messages, { systemPrompt: cacheableSystemPrompt })
      )
      expect(usageOf(creatorEvents)?.cacheReadInputTokens ?? 0).toBeGreaterThan(0)

      // A fresh model instance with the identical prefix reuses the resource created above.
      const reuser = gemini.createModel({ cacheConfig, params })
      const reuserEvents = await collectIterator<ModelStreamEvent>(
        reuser.stream(messages, { systemPrompt: cacheableSystemPrompt })
      )
      expect(usageOf(reuserEvents)?.cacheReadInputTokens ?? 0).toBeGreaterThan(0)
    })
  })
})
