import { describe, it, expect, vi } from 'vitest'
import { Agent, Message, TextBlock, tool } from '@strands-agents/sdk'
import { z } from 'zod'
import { bedrock } from '../__fixtures__/model-providers.js'

describe.skipIf(bedrock.skip)('Agentic Context Manager Integration', () => {
  describe('basic functionality', () => {
    it('agent responds normally with contextManager agentic enabled', async () => {
      const model = bedrock.createModel({ maxTokens: 1024 })
      const agent = new Agent({
        model,
        contextManager: 'agentic',
        printer: false,
      })

      const result = await agent.invoke('What is 2 + 2? Reply with just the number.')

      expect(result.stopReason).toBe('endTurn')
      expect(result.lastMessage.role).toBe('assistant')
      const text = result.lastMessage.content.find((b) => b.type === 'textBlock') as TextBlock
      expect(text).toBeDefined()
      expect(text.text).toContain('4')
    })

    it('works alongside user-defined tools', async () => {
      const calculator = tool({
        name: 'calculator',
        description: 'Add two numbers',
        inputSchema: z.object({ a: z.number(), b: z.number() }),
        callback: ({ a, b }) => `${a + b}`,
      })

      const model = bedrock.createModel({ maxTokens: 1024 })
      const agent = new Agent({
        model,
        contextManager: 'agentic',
        tools: [calculator],
        printer: false,
      })

      const result = await agent.invoke('Use the calculator tool to add 17 and 25.')

      expect(result.stopReason).toBe('endTurn')
      const hasCalcCall = agent.messages.some((msg) =>
        msg.content.some((block) => block.type === 'toolUseBlock' && block.name === 'calculator')
      )
      expect(hasCalcCall).toBe(true)
    })
  })

  describe('middleware context injection', () => {
    it('context-status XML is present in messages sent to model', async () => {
      const model = bedrock.createModel({ maxTokens: 1024 })
      const streamSpy = vi.spyOn(model, 'stream')

      const agent = new Agent({
        model,
        contextManager: 'agentic',
        printer: false,
      })

      await agent.invoke('Say hi.')

      const hasContextStatus = streamSpy.mock.calls.some((call) => {
        const messages = call[0] as Message[]
        const lastMsg = messages[messages.length - 1]
        if (!lastMsg) return false
        return lastMsg.content.some(
          (block) => block.type === 'textBlock' && (block as TextBlock).text.includes('<context-status>')
        )
      })
      expect(hasContextStatus).toBe(true)
    })

    it('context-status contains token usage and remaining capacity', async () => {
      const model = bedrock.createModel({ maxTokens: 1024 })
      const streamSpy = vi.spyOn(model, 'stream')

      const agent = new Agent({
        model,
        contextManager: 'agentic',
        printer: false,
      })

      await agent.invoke('Hello.')

      let statusText = ''
      for (const call of streamSpy.mock.calls) {
        const messages = call[0] as Message[]
        const lastMsg = messages[messages.length - 1]
        if (!lastMsg) continue
        for (const block of lastMsg.content) {
          if (block.type === 'textBlock' && (block as TextBlock).text.includes('<context-status>')) {
            statusText = (block as TextBlock).text
            break
          }
        }
        if (statusText) break
      }

      expect(statusText).toContain('<used>')
      expect(statusText).toContain('<remaining>')
      expect(statusText).toContain('</context-status>')
    })

    it('context-status is NOT injected when contextManager is not agentic', async () => {
      const model = bedrock.createModel({ maxTokens: 1024 })
      const streamSpy = vi.spyOn(model, 'stream')

      const agent = new Agent({
        model,
        printer: false,
      })

      await agent.invoke('Say hi.')

      const hasContextStatus = streamSpy.mock.calls.some((call) => {
        const messages = call[0] as Message[]
        const lastMsg = messages[messages.length - 1]
        if (!lastMsg) return false
        return lastMsg.content.some(
          (block) => block.type === 'textBlock' && (block as TextBlock).text.includes('<context-status>')
        )
      })
      expect(hasContextStatus).toBe(false)
    })
  })

  describe('context status accuracy', () => {
    it('token usage in message metadata grows across turns', async () => {
      const model = bedrock.createModel({ maxTokens: 1024 })
      const agent = new Agent({
        model,
        contextManager: 'agentic',
        printer: false,
      })

      await agent.invoke('Say hello in one word.')
      const firstAssistant = agent.messages.find((m) => m.role === 'assistant' && m.metadata?.usage)
      const firstInputTokens = firstAssistant?.metadata?.usage?.inputTokens ?? 0

      await agent.invoke('Now count from 1 to 10.')
      const assistants = agent.messages.filter((m) => m.role === 'assistant' && m.metadata?.usage)
      const lastAssistant = assistants[assistants.length - 1]
      const secondInputTokens = lastAssistant?.metadata?.usage?.inputTokens ?? 0

      expect(secondInputTokens).toBeGreaterThan(firstInputTokens)
    })
  })

  describe('tool invocation behavior', () => {
    it('model uses summarize_context when explicitly asked', async () => {
      const model = bedrock.createModel({ maxTokens: 2048 })
      const agent = new Agent({
        model,
        contextManager: 'agentic',
        printer: false,
        systemPrompt:
          'You are a helpful assistant. When the user asks you to compress or summarize context, use your summarize_context tool.',
      })

      await agent.invoke('Tell me about the solar system in 2 sentences.')
      await agent.invoke('Tell me about the ocean in 2 sentences.')
      await agent.invoke('Tell me about mountains in 2 sentences.')
      await agent.invoke('Please use summarize_context to compress the older parts of our conversation.')

      const hasSummarizeCall = agent.messages.some((msg) =>
        msg.content.some((block) => block.type === 'toolUseBlock' && block.name === 'summarize_context')
      )
      expect(hasSummarizeCall).toBe(true)
    })

    it('summarize_context actually replaces older messages with a summary', async () => {
      const model = bedrock.createModel({ maxTokens: 2048 })
      const agent = new Agent({
        model,
        contextManager: 'agentic',
        printer: false,
        systemPrompt:
          'When asked to compress, call summarize_context with keepRecent=2 and summaryRatio=0.6, then stop. Keep responses to 1 sentence.',
      })

      await agent.invoke('The sky is blue.')
      await agent.invoke('Grass is green.')
      await agent.invoke('Water is wet.')
      await agent.invoke('Fire is hot.')
      await agent.invoke('Ice is cold.')
      await agent.invoke('Snow is white.')

      await agent.invoke('Compress context using summarize_context with keepRecent=2 and summaryRatio=0.6.')

      const hasOriginalGrassMsg = agent.messages.some(
        (msg) =>
          msg.role === 'user' &&
          msg.content.some((block) => block.type === 'textBlock' && (block as TextBlock).text === 'Grass is green.')
      )
      expect(hasOriginalGrassMsg).toBe(false)
    }, 60_000)

    it('truncate_context actually drops messages', async () => {
      const model = bedrock.createModel({ maxTokens: 2048 })
      const agent = new Agent({
        model,
        contextManager: 'agentic',
        printer: false,
        systemPrompt:
          'When asked to truncate, call truncate_context with keepRecent=4 then stop. Keep responses to 1 sentence.',
      })

      await agent.invoke('Message one.')
      await agent.invoke('Message two.')
      await agent.invoke('Message three.')
      await agent.invoke('Message four.')

      const messageCountBefore = agent.messages.length

      await agent.invoke('Truncate context, keep only recent 4 messages.')

      expect(agent.messages.length).toBeLessThan(messageCountBefore)
    }, 60_000)

    it('pin protects messages from truncation', async () => {
      const model = bedrock.createModel({ maxTokens: 2048 })
      const agent = new Agent({
        model,
        contextManager: 'agentic',
        printer: false,
        systemPrompt:
          'When asked to pin, use the pin tool. When asked to truncate, use truncate_context. Keep responses to 1 sentence.',
      })

      await agent.invoke('IMPORTANT: The secret code is ZEBRA-9.')
      await agent.invoke('Pin the first message using indices [0].')
      await agent.invoke('Some filler conversation.')
      await agent.invoke('More filler conversation.')
      await agent.invoke('Truncate context, keep only recent 2 messages.')

      const hasSecret = agent.messages.some((msg) =>
        msg.content.some((block) => block.type === 'textBlock' && (block as TextBlock).text.includes('ZEBRA-9'))
      )
      expect(hasSecret).toBe(true)
    }, 90_000)
  })

  describe('end-to-end behavior', () => {
    it('agent remains coherent after summarization', async () => {
      const model = bedrock.createModel({ maxTokens: 2048 })
      const agent = new Agent({
        model,
        contextManager: 'agentic',
        printer: false,
        systemPrompt: 'You are a helpful assistant. When asked to summarize context, use summarize_context.',
      })

      await agent.invoke('My name is Alice and I live in Portland.')
      await agent.invoke('I have a dog named Biscuit.')
      await agent.invoke('My favorite food is pizza.')
      await agent.invoke('Please use summarize_context to compress our conversation history.')

      const result = await agent.invoke('What is my name?')
      const text = result.lastMessage.content.find((b) => b.type === 'textBlock') as TextBlock
      expect(text.text.toLowerCase()).toContain('alice')
    })
  })
})
