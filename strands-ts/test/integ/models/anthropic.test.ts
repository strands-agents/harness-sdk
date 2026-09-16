import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Agent, Message, ImageBlock, TextBlock, CachePointBlock, tool } from '@strands-agents/sdk'
import type { SystemContentBlock } from '@strands-agents/sdk'
import { collectIterator } from '$/sdk/__fixtures__/model-test-helpers.js'
import { loadFixture } from '../__fixtures__/test-helpers.js'
import { anthropic } from '../__fixtures__/model-providers.js'

import yellowPngUrl from '../__resources__/yellow.png?url'

describe.skipIf(anthropic.skip)('AnthropicModel Integration Tests', () => {
  describe('Configuration', () => {
    it.concurrent('respects maxTokens configuration', async () => {
      const provider = anthropic.createModel({ maxTokens: 20 })
      const messages = [
        new Message({
          role: 'user',
          content: [new TextBlock('Write a very long story about space exploration.')],
        }),
      ]

      const events = await collectIterator(provider.stream(messages))

      const metadataEvent = events.find((e) => e.type === 'modelMetadataEvent')
      expect(metadataEvent?.usage?.outputTokens).toBeLessThanOrEqual(20)

      const messageStopEvent = events.find((e) => e.type === 'modelMessageStopEvent')
      expect(messageStopEvent?.stopReason).toBe('maxTokens')
    })
  })

  describe('Prompt Caching', () => {
    it('uses system prompt cache on subsequent requests', async () => {
      const provider = anthropic.createModel({ maxTokens: 100 })

      const largeContext = `Context information: ${'repeat '.repeat(5000)} [${Date.now()}]`

      const cachedSystemPrompt: SystemContentBlock[] = [
        new TextBlock('You are a helpful assistant.'),
        new TextBlock(largeContext),
        new CachePointBlock({ cacheType: 'default' }),
      ]

      const events1 = await collectIterator(
        provider.stream([new Message({ role: 'user', content: [new TextBlock('Hello')] })], {
          systemPrompt: cachedSystemPrompt,
        })
      )

      const metadata1 = events1.find((e) => e.type === 'modelMetadataEvent')
      const writeTokens = metadata1?.usage?.cacheWriteInputTokens
      if (writeTokens !== undefined) {
        expect(writeTokens).toBeGreaterThan(0)
      }

      const events2 = await collectIterator(
        provider.stream([new Message({ role: 'user', content: [new TextBlock('Hi again')] })], {
          systemPrompt: cachedSystemPrompt,
        })
      )

      const metadata2 = events2.find((e) => e.type === 'modelMetadataEvent')
      const readTokens = metadata2?.usage?.cacheReadInputTokens
      if (readTokens !== undefined) {
        expect(readTokens).toBeGreaterThanOrEqual(0)
      }
    })

    it('uses message cache points on subsequent requests', async () => {
      const provider = anthropic.createModel({ maxTokens: 100 })
      const largeContext = `Context information: ${'repeat '.repeat(5000)} [${Date.now()}]`

      const messagesWithCache = (text: string): Message[] => [
        new Message({
          role: 'user',
          content: [new TextBlock(largeContext), new CachePointBlock({ cacheType: 'default' }), new TextBlock(text)],
        }),
      ]

      const events1 = await collectIterator(provider.stream(messagesWithCache('Question 1')))
      const metadata1 = events1.find((e) => e.type === 'modelMetadataEvent')
      const writeTokens = metadata1?.usage?.cacheWriteInputTokens
      if (writeTokens !== undefined) {
        expect(writeTokens).toBeGreaterThan(0)
      }

      const events2 = await collectIterator(provider.stream(messagesWithCache('Question 2')))
      const metadata2 = events2.find((e) => e.type === 'modelMetadataEvent')
      const readTokens = metadata2?.usage?.cacheReadInputTokens
      if (readTokens !== undefined) {
        expect(readTokens).toBeGreaterThanOrEqual(0)
      }
    })

    it('cacheConfig auto placement earns a read on the second turn', async () => {
      const provider = anthropic.createModel({ maxTokens: 100, cacheConfig: { strategy: 'auto' } })
      const prefix = `Dossier ${Date.now()}-${Math.random()}. ${'The subject prefers concise answers. '.repeat(400)}`
      const messages = [new Message({ role: 'user', content: [new TextBlock(prefix)] })]

      const first = await collectIterator(provider.stream(messages))
      const usage1 = first.find((event) => event.type === 'modelMetadataEvent')?.usage
      expect(usage1?.cacheWriteInputTokens).toBeGreaterThan(0)

      const second = await collectIterator(provider.stream(messages))
      const usage2 = second.find((event) => event.type === 'modelMetadataEvent')?.usage
      expect(usage2?.cacheReadInputTokens).toBeGreaterThan(0)
    })

    it('cacheConfig toolsTTL earns a read on the second turn', async () => {
      const provider = anthropic.createModel({
        maxTokens: 100,
        cacheConfig: { strategy: 'auto', toolsTTL: '5m', messagesTTL: false },
      })
      const toolSpecs = [
        {
          name: 'lookupReference',
          description: `Look up a reference entry ${Date.now()}-${Math.random()}. ${'The catalog is stable across requests. '.repeat(400)}`,
          inputSchema: { type: 'object' as const, properties: { topic: { type: 'string' as const } } },
        },
      ]
      const messages = (text: string): Message[] => [new Message({ role: 'user', content: [new TextBlock(text)] })]

      const first = await collectIterator(
        provider.stream(messages('Reply ALPHA. Do not call any tool.'), { toolSpecs })
      )
      const usage1 = first.find((event) => event.type === 'modelMetadataEvent')?.usage
      expect(usage1?.cacheWriteInputTokens).toBeGreaterThan(0)

      const second = await collectIterator(
        provider.stream(messages('Reply BETA. Do not call any tool.'), { toolSpecs })
      )
      const usage2 = second.find((event) => event.type === 'modelMetadataEvent')?.usage
      expect(usage2?.cacheReadInputTokens).toBeGreaterThan(0)
    })
  })

  describe('Media Support', () => {
    it('processes image input correctly', async () => {
      const provider = anthropic.createModel({ maxTokens: 100 })

      const imageBytes = await loadFixture(yellowPngUrl)

      const messages = [
        new Message({
          role: 'user',
          content: [
            new ImageBlock({
              format: 'png',
              source: { bytes: imageBytes },
            }),
            new TextBlock('What color is this image? Reply with just the color name.'),
          ],
        }),
      ]

      const events = await collectIterator(provider.stream(messages))

      const stopEvent = events.find((e) => e.type === 'modelMessageStopEvent')
      expect(stopEvent?.stopReason).toBe('endTurn')

      let fullText = ''
      for (const event of events) {
        if (event.type === 'modelContentBlockDeltaEvent' && event.delta.type === 'textDelta') {
          fullText += event.delta.text
        }
      }

      expect(fullText.toLowerCase()).toContain('yellow')
    })
  })

  describe('Thinking Mode', () => {
    it('emits thinking blocks when enabled', async () => {
      const provider = anthropic.createModel({
        maxTokens: 4000,
        params: {
          thinking: {
            type: 'enabled',
            budget_tokens: 2048,
          },
        },
      })

      const messages = [
        new Message({
          role: 'user',
          content: [new TextBlock('Explain the theory of relativity step-by-step.')],
        }),
      ]

      const events = await collectIterator(provider.stream(messages))

      const thinkingEvents = events.filter(
        (e) => e.type === 'modelContentBlockDeltaEvent' && e.delta.type === 'reasoningContentDelta'
      )

      if (thinkingEvents.length > 0) {
        expect(thinkingEvents[0]!.type).toBe('modelContentBlockDeltaEvent')
        const firstThinking = thinkingEvents[0] as any
        expect(firstThinking.delta.text).toBeDefined()
      }
    })
  })

  describe('Built-in Tools', () => {
    it('web_search runs alongside function tools and its citations round-trip', async () => {
      const weather = tool({
        name: 'tool_weather',
        description: 'Get the current weather.',
        inputSchema: z.object({}),
        callback: () => 'sunny',
      })
      const model = anthropic.createModel({
        maxTokens: 1024,
        // "direct" so citations are attached; the dynamic-filtering default runs the search inside code execution
        anthropicTools: [{ type: 'web_search_20260318', name: 'web_search', max_uses: 2, allowed_callers: ['direct'] }],
      })
      const agent = new Agent({ model, tools: [weather], printer: false })

      const first = await agent.invoke(
        'Call tool_weather, then use web_search to find the current Python release. Answer in one sentence.'
      )
      expect(first.stopReason).toBe('endTurn')
      const toolUses = agent.messages.flatMap((m) => m.content).filter((b) => b.type === 'toolUseBlock')
      expect(toolUses.map((b) => b.name)).toContain('tool_weather')
      const citationsBlock = first.lastMessage.content.find((b) => b.type === 'citationsBlock')
      expect(citationsBlock).toBeDefined()
      expect(citationsBlock?.citations[0]?.location).toMatchObject({ type: 'web', url: expect.stringMatching(/^http/) })

      const second = await agent.invoke('Reply DONE.')
      expect(String(second)).toContain('DONE')
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
      const model = anthropic.createModel()
      const result = await model.countTokens(messages)
      expect(typeof result).toBe('number')
      expect(result).toBeGreaterThan(0)
    })

    it.concurrent('should return more tokens with tools and system prompt', async () => {
      const model = anthropic.createModel()
      const without = await model.countTokens(messages)
      const withTools = await model.countTokens(messages, { toolSpecs, systemPrompt: 'Be helpful.' })
      expect(withTools).toBeGreaterThan(without)
    })
  })
})
