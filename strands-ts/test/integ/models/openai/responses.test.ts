import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ToolSpec } from '@strands-agents/sdk'
import { Agent, Message, TextBlock, tool } from '@strands-agents/sdk'

import { collectIterator } from '$/sdk/__fixtures__/model-test-helpers.js'

import { openaiResponses } from '../../__fixtures__/model-providers.js'

describe.skipIf(openaiResponses.skip)("OpenAIModel (api: 'responses') Integration Tests", () => {
  describe('Configuration', () => {
    it.concurrent('respects maxTokens configuration', async () => {
      const provider = openaiResponses.createModel({
        modelId: 'gpt-5.4-mini',
        maxTokens: 20,
      })

      const messages: Message[] = [
        new Message({
          role: 'user',
          content: [new TextBlock('Write a long story about dragons.')],
        }),
      ]

      const events = await collectIterator(provider.stream(messages))

      const metadataEvent = events.find((e) => e.type === 'modelMetadataEvent')
      expect(metadataEvent?.usage?.outputTokens).toBeLessThanOrEqual(25)

      const messageStopEvent = events.find((e) => e.type === 'modelMessageStopEvent')
      expect(messageStopEvent?.stopReason).toBe('maxTokens')
    })

    it.concurrent('respects temperature configuration', async () => {
      const provider = openaiResponses.createModel({
        modelId: 'gpt-5.4-mini',
        temperature: 0,
        maxTokens: 50,
      })

      const messages: Message[] = [
        new Message({
          role: 'user',
          content: [new TextBlock('Say "hello world" exactly.')],
        }),
      ]

      const events = await collectIterator(provider.stream(messages))

      let text = ''
      for (const event of events) {
        if (event.type === 'modelContentBlockDeltaEvent' && event.delta.type === 'textDelta') {
          text += event.delta.text
        }
      }

      expect(text.toLowerCase()).toContain('hello')
    })
  })

  describe('Content Block Lifecycle', () => {
    it.concurrent('emits complete content block lifecycle events', async () => {
      const provider = openaiResponses.createModel({
        modelId: 'gpt-5.4-mini',
        maxTokens: 50,
      })

      const messages: Message[] = [
        new Message({
          role: 'user',
          content: [new TextBlock('Say hello.')],
        }),
      ]

      const events = await collectIterator(provider.stream(messages))

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
      const provider = openaiResponses.createModel({
        modelId: 'gpt-5.4-mini',
        maxTokens: 100,
      })

      const messages: Message[] = [
        new Message({
          role: 'user',
          content: [new TextBlock('Say hi.')],
        }),
      ]

      const events = await collectIterator(provider.stream(messages))

      const messageStopEvent = events.find((e) => e.type === 'modelMessageStopEvent')
      expect(messageStopEvent?.stopReason).toBe('endTurn')
    })

    it.concurrent('returns maxTokens stop reason when token limit reached', async () => {
      const provider = openaiResponses.createModel({
        modelId: 'gpt-5.4-mini',
        maxTokens: 16,
      })

      const messages: Message[] = [
        new Message({
          role: 'user',
          content: [new TextBlock('Write a very long story about dragons.')],
        }),
      ]

      const events = await collectIterator(provider.stream(messages))

      const messageStopEvent = events.find((e) => e.type === 'modelMessageStopEvent')
      expect(messageStopEvent?.stopReason).toBe('maxTokens')
    })

    it.concurrent('returns toolUse stop reason when requesting tool use', async () => {
      const provider = openaiResponses.createModel({
        modelId: 'gpt-5.4-mini',
        maxTokens: 200,
      })

      const calculatorTool: ToolSpec = {
        name: 'calculator',
        description: 'Performs basic arithmetic operations. Use this to calculate math expressions.',
        inputSchema: {
          type: 'object',
          properties: {
            expression: { type: 'string', description: 'The math expression to calculate' },
          },
          required: ['expression'],
        },
      }

      const messages: Message[] = [
        new Message({
          role: 'user',
          content: [new TextBlock('Calculate 42 times 7 please.')],
        }),
      ]

      const events = await collectIterator(provider.stream(messages, { toolSpecs: [calculatorTool] }))

      const messageStopEvent = events.find((e) => e.type === 'modelMessageStopEvent')
      expect(messageStopEvent?.stopReason).toBe('toolUse')
    })
  })

  describe('Stateful Conversation', () => {
    it('tracks conversation across turns via server-side state', async () => {
      const model = openaiResponses.createModel({
        modelId: 'gpt-5.4-mini',
        stateful: true,
      })
      const agent = new Agent({
        model,
        printer: false,
        systemPrompt: 'Reply in one short sentence.',
      })

      await agent.invoke('My name is Alice.')
      expect(agent.messages).toHaveLength(0)

      const result = await agent.invoke('What is my name?')
      const text = result.lastMessage.content
        .filter((block) => block.type === 'textBlock')
        .map((block) => block.text)
        .join('')
        .toLowerCase()
      expect(text).toContain('alice')
    })

    it('completes an agent-loop round-trip with a user-defined function tool', async () => {
      // Exercises the stateful + function-tool wire path end-to-end: the agent
      // executes the callback, then sends a second Responses request carrying
      // previous_response_id plus a function_call_output item. Nothing else in
      // this suite covers that follow-up request — the existing toolUse test
      // stops at the first chunk, and the built-in tool tests (web_search /
      // code_interpreter) use a different serialization path. Assertions are
      // purely mechanical to stay deterministic.
      let callCount = 0
      const pingTool = tool({
        name: 'ping',
        description: 'Returns a fixed acknowledgement. Use this when the user asks you to ping.',
        inputSchema: z.object({}),
        callback: async () => {
          callCount++
          return 'pong'
        },
      })

      const model = openaiResponses.createModel({
        modelId: 'gpt-5.4-mini',
        stateful: true,
      })
      const agent = new Agent({
        model,
        printer: false,
        systemPrompt: 'Use the ping tool when asked to ping.',
        tools: [pingTool],
      })

      const result = await agent.invoke('Please ping.')

      expect(result.stopReason).toBe('endTurn')
      expect(callCount).toBeGreaterThanOrEqual(1)
      expect(result.metrics?.toolMetrics['ping']?.successCount).toBeGreaterThanOrEqual(1)
      expect(agent.messages).toEqual([])
      expect(agent.modelState.get('responseId')).toEqual(expect.any(String))
    })
  })

  describe('Built-in Tools', () => {
    it.concurrent('web_search produces text with citations', async () => {
      const model = openaiResponses.createModel({
        modelId: 'gpt-4o',
        params: { tools: [{ type: 'web_search' }] },
      })
      const agent = new Agent({
        model,
        printer: false,
        systemPrompt: 'Answer concisely.',
      })

      const result = await agent.invoke('Search https://strandsagents.com/ and tell me what Strands Agents is.')
      const citationsBlock = result.lastMessage.content.find((block) => block.type === 'citationsBlock')
      expect(citationsBlock).toBeDefined()
    })

    it.concurrent('code_interpreter produces correct results', async () => {
      const model = openaiResponses.createModel({
        modelId: 'gpt-4o',
        params: { tools: [{ type: 'code_interpreter', container: { type: 'auto' } }] },
      })
      const agent = new Agent({
        model,
        printer: false,
        systemPrompt: 'Answer concisely.',
      })

      const result = await agent.invoke("Compute the SHA-256 hash of the string 'strands'. Return only the hex digest.")
      const text = result.lastMessage.content
        .filter((block) => block.type === 'textBlock')
        .map((block) => block.text)
        .join('')
      expect(text).toContain('11e0e34bd35e12185cfacd5e5a256ab4292bfa3616d8d5b74e20eca36feed228')
    })
  })

  describe('Citation Block Switching', () => {
    it.concurrent('text and citations land in separate content blocks', async () => {
      const provider = openaiResponses.createModel({
        modelId: 'gpt-4o',
        params: { tools: [{ type: 'web_search' }] },
      })

      const messages: Message[] = [
        new Message({
          role: 'user',
          content: [new TextBlock('Search the web and tell me what Strands Agents is. Cite your sources.')],
        }),
      ]

      const events = await collectIterator(provider.stream(messages))

      const textDeltas = events.filter((e) => e.type === 'modelContentBlockDeltaEvent' && e.delta.type === 'textDelta')
      const citationDeltas = events.filter(
        (e) => e.type === 'modelContentBlockDeltaEvent' && e.delta.type === 'citationsDelta'
      )

      expect(textDeltas.length).toBeGreaterThan(0)
      expect(citationDeltas.length).toBeGreaterThan(0)

      // Every citation delta must be preceded by a block start (not a text delta in the same block).
      // This verifies the _switchContent('citations', ...) logic closes the text block first.
      for (const citationDelta of citationDeltas) {
        const citationIndex = events.indexOf(citationDelta)
        const precedingEvents = events.slice(0, citationIndex)

        let lastStart = -1
        let lastTextDelta = -1
        for (let i = 0; i < precedingEvents.length; i++) {
          const ev = precedingEvents[i]!
          if (ev.type === 'modelContentBlockStartEvent') lastStart = i
          if (ev.type === 'modelContentBlockDeltaEvent' && ev.delta.type === 'textDelta') lastTextDelta = i
        }

        if (lastTextDelta !== -1) {
          expect(lastStart).toBeGreaterThan(lastTextDelta)
        }
      }
    })
  })

  describe('Error Handling', () => {
    it.concurrent('handles invalid model ID gracefully', async () => {
      const provider = openaiResponses.createModel({
        modelId: 'invalid-model-id-that-does-not-exist-xyz',
      })

      const messages: Message[] = [
        new Message({
          role: 'user',
          content: [new TextBlock('Hello')],
        }),
      ]

      await expect(async () => {
        for await (const _event of provider.stream(messages)) {
          throw Error('Should not get here')
        }
      }).rejects.toThrow()
    })
  })
})
