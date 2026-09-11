import { describe, expect, it } from 'vitest'
import {
  Agent,
  CitationsBlock,
  DocumentBlock,
  ImageBlock,
  Message,
  TextBlock,
  ToolUseBlock,
  VideoBlock,
  tool,
} from '@strands-agents/sdk'
import { notebook } from '@strands-agents/sdk/vended-tools/notebook'
import { httpRequest } from '@strands-agents/sdk/vended-tools/http-request'
import { z } from 'zod'

import { collectGenerator } from '$/sdk/__fixtures__/model-test-helpers.js'
import { loadFixture } from './__fixtures__/test-helpers.js'
// Import fixtures using Vite's ?url suffix
import yellowMp4Url from './__resources__/yellow.mp4?url'
import yellowPngUrl from './__resources__/yellow.png?url'
import letterPdfUrl from './__resources__/letter.pdf?url'
import { allProviders } from './__fixtures__/model-providers.js'

// Calculator tool using Zod schema
const calculatorTool = tool({
  name: 'calculator',
  description: 'Performs basic arithmetic operations',
  inputSchema: z.object({
    operation: z.enum(['add', 'subtract', 'multiply', 'divide']),
    a: z.number(),
    b: z.number(),
  }),
  callback: async ({ operation, a, b }) => {
    const ops = {
      add: a + b,
      subtract: a - b,
      multiply: a * b,
      divide: a / b,
    }
    return `Result: ${ops[operation]}`
  },
})

// Calculator tool using JSON schema
const jsonCalculatorTool = tool({
  name: 'calculator',
  description: 'Performs basic arithmetic operations',
  inputSchema: {
    type: 'object',
    properties: {
      operation: { type: 'string', enum: ['add', 'subtract', 'multiply', 'divide'] },
      a: { type: 'number' },
      b: { type: 'number' },
    },
    required: ['operation', 'a', 'b'],
  },
  callback: async (input) => {
    const { operation, a, b } = input as { operation: 'add' | 'subtract' | 'multiply' | 'divide'; a: number; b: number }
    const ops = {
      add: a + b,
      subtract: a - b,
      multiply: a * b,
      divide: a / b,
    }
    return `Result: ${ops[operation]}`
  },
})

describe.each(allProviders)('Agent with $name', ({ name, skip, createModel, models, supports }) => {
  describe.skipIf(skip)(`${name} Integration Tests`, () => {
    describe('Basic Functionality', () => {
      it.skipIf(!supports.tools)('handles invocation, streaming, system prompts, and tool use', async () => {
        // Test basic invocation with system prompt and tool
        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt: 'Use the calculator tool to solve math problems. Respond with only the numeric result.',
          tools: [calculatorTool],
        })

        // Test streaming with event collection
        const { items, result } = await collectGenerator(agent.stream('What is 123 * 456?'))

        // Verify high-level agent events are yielded
        expect(items.some((item) => item.type === 'beforeInvocationEvent')).toBe(true)

        // Verify result structure and stop reason
        expect(result.stopReason).toBe('endTurn')
        expect(result.lastMessage.role).toBe('assistant')
        expect(result.lastMessage.content.length).toBeGreaterThan(0)

        // Verify tool was used by checking message history
        const toolUseMessage = agent.messages.find((msg) => msg.content.some((block) => block.type === 'toolUseBlock'))
        expect(toolUseMessage).toBeDefined()

        // Verify final response contains the result (123 * 456 = 56088)
        const textContent = result.lastMessage.content.find((block) => block.type === 'textBlock')
        expect(textContent).toBeDefined()
        expect(textContent?.text).toMatch(/56088/)

        // Validate multi-turn works after tool use
        await collectGenerator(agent.stream('What was the result?'))
      })

      it.skipIf(!supports.tools)('handles tool use with JSON schema tool', async () => {
        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt: 'Use the calculator tool to solve math problems. Respond with only the numeric result.',
          tools: [jsonCalculatorTool],
        })

        const result = await agent.invoke('What is 25 * 48?')

        expect(result.stopReason).toBe('endTurn')

        const toolUseMessage = agent.messages.find((msg) => msg.content.some((block) => block.type === 'toolUseBlock'))
        expect(toolUseMessage).toBeDefined()

        const textContent = result.lastMessage.content.find((block) => block.type === 'textBlock')
        expect(textContent).toBeDefined()
        expect(textContent?.text).toMatch(/1200/)
      })

      it('yields metadata events through the agent stream', async () => {
        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt: 'Respond with a brief greeting.',
        })

        // Test streaming with event collection
        const { items, result } = await collectGenerator(agent.stream('Say hello'))

        // Verify metadata event is yielded through the agent (wrapped in ModelStreamUpdateEvent)
        const updateEvent = items.find(
          (item) => item.type === 'modelStreamUpdateEvent' && item.event.type === 'modelMetadataEvent'
        )
        expect(updateEvent).toBeDefined()
        if (updateEvent?.type !== 'modelStreamUpdateEvent' || updateEvent.event.type !== 'modelMetadataEvent') {
          throw new Error('Expected modelStreamUpdateEvent wrapping modelMetadataEvent')
        }
        const metadataEvent = updateEvent.event
        expect(metadataEvent.usage).toBeDefined()
        expect(metadataEvent.usage?.inputTokens).toBeGreaterThan(0)
        expect(metadataEvent.usage?.outputTokens).toBeGreaterThan(0)

        // Bedrock includes latencyMs in metrics, OpenAI does not
        if (name === 'BedrockModel') {
          expect(metadataEvent.metrics?.latencyMs).toBeGreaterThan(0)
        }

        // Verify result structure
        expect(result.stopReason).toBe('endTurn')
        expect(result.lastMessage.role).toBe('assistant')
        expect(result.lastMessage.content.length).toBeGreaterThan(0)
      })
    })

    describe('Multi-turn Conversations', () => {
      it('maintains message history and conversation context', async () => {
        const agent = new Agent({ model: createModel(), printer: false })

        // First turn
        await agent.invoke('My name is Alice')
        expect(agent.messages).toHaveLength(2) // user + assistant

        // Second turn
        await agent.invoke('What is my name?')
        expect(agent.messages).toHaveLength(4) // 2 user + 2 assistant

        // Verify message ordering
        expect(agent.messages[0]?.role).toBe('user')
        expect(agent.messages[1]?.role).toBe('assistant')
        expect(agent.messages[2]?.role).toBe('user')
        expect(agent.messages[3]?.role).toBe('assistant')

        // Verify conversation context is preserved
        const lastMessage = agent.messages[agent.messages.length - 1]
        const textContent = lastMessage?.content.find((block) => block.type === 'textBlock')
        expect(textContent?.text).toMatch(/Alice/i)
      })
    })

    describe.skipIf(!supports.images || !supports.documents)('Media Blocks', () => {
      it('handles multiple media blocks in single request', async () => {
        // Create document block
        const docBlock = new DocumentBlock({
          name: 'test-document',
          format: 'txt',
          source: { text: 'The animal described here is a ZEBRA.' },
        })

        // Create image block
        const imageBytes = await loadFixture(yellowPngUrl)
        const imageBlock = new ImageBlock({
          format: 'png',
          source: { bytes: imageBytes },
        })

        // Initialize agent with messages array containing Message instance
        // Note: Bedrock requires a text block when using documents
        const agent = new Agent({
          model: createModel(),
          messages: [
            new Message({
              role: 'user',
              content: [
                docBlock,
                imageBlock,
                new TextBlock(
                  'What animal is named in the text I shared, and what color is the image? Answer briefly.'
                ),
              ],
            }),
          ],
          printer: false,
        })

        const result = await agent.invoke([])

        expect(result.stopReason).toBe('endTurn')
        expect(result.lastMessage.role).toBe('assistant')

        // Response should reference both the document content and image color
        const textContent = result.lastMessage.content.find((block) => block.type === 'textBlock')
        expect(textContent).toBeDefined()
        expect(textContent?.text).toMatch(/zebra/i)
      })

      it('processes PDF document input correctly', async () => {
        const pdfBytes = await loadFixture(letterPdfUrl)

        const agent = new Agent({
          model: createModel(),
          messages: [
            new Message({
              role: 'user',
              content: [
                new DocumentBlock({
                  name: 'letter',
                  format: 'pdf',
                  source: { bytes: pdfBytes },
                }),
                new TextBlock('Summarize this document briefly.'),
              ],
            }),
          ],
          printer: false,
        })

        const result = await agent.invoke([])

        expect(result.stopReason).toBe('endTurn')
        expect(result.lastMessage.role).toBe('assistant')

        const textContent = result.lastMessage.content.find((block) => block.type === 'textBlock')
        expect(textContent).toBeDefined()
        expect(textContent?.text.length).toBeGreaterThan(10)
      })
    })

    it.skipIf(!supports.documents)('handles document input', async () => {
      const docBlock = new DocumentBlock({
        name: 'test-document',
        format: 'txt',
        source: { text: 'The secret code word is ELEPHANT.' },
      })

      const agent = new Agent({
        model: createModel(),
        printer: false,
      })

      const result = await agent.invoke([new TextBlock('What is the secret code word? Answer in one word.'), docBlock])

      expect(result.stopReason).toBe('endTurn')
      const textContent = result.lastMessage.content.find((block) => block.type === 'textBlock')
      expect(textContent).toBeDefined()
      expect(textContent?.text).toMatch(/elephant/i)
    })

    it.skipIf(!supports.video)('handles video input', async () => {
      const videoBytes = await loadFixture(yellowMp4Url)
      const videoBlock = new VideoBlock({
        format: 'mp4',
        source: { bytes: videoBytes },
      })

      const agent = new Agent({
        model: createModel(models.video),
        printer: false,
      })

      const result = await agent.invoke([
        new TextBlock('What color is shown in this video? Answer in one word.'),
        videoBlock,
      ])

      expect(result.stopReason).toBe('endTurn')
      const textContent = result.lastMessage.content.find((block) => block.type === 'textBlock')
      expect(textContent).toBeDefined()
    })

    describe.skipIf(!supports.citations)('Citations', () => {
      const documentText = [
        'France is a country in Western Europe. Its capital is Paris, which is known as the City of Light.',
        'Paris has a population of approximately 2.1 million people in the city proper.',
        'The Eiffel Tower, built in 1889, is the most visited paid monument in the world.',
        'France is the most visited country in the world, with over 89 million tourists annually.',
        'The French Revolution of 1789 was a pivotal event in world history.',
      ].join(' ')

      const textDocBlock = new DocumentBlock({
        name: 'test-document',
        format: 'txt',
        source: { content: [{ text: documentText }] },
        citations: { enabled: true },
      })

      const textDocPrompt = new TextBlock(
        'Using the document, what is the capital of France and what is it known for? Cite specific details.'
      )

      it('returns documentChunk citations from text document', async () => {
        const agent = new Agent({
          model: createModel({ stream: false }),
          printer: false,
        })

        const result = await agent.invoke([textDocBlock, textDocPrompt])

        expect(result.stopReason).toBe('endTurn')

        const citationsBlock = result.lastMessage.content.find(
          (block): block is CitationsBlock => block.type === 'citationsBlock'
        )
        expect(citationsBlock).toBeDefined()
        expect(citationsBlock!.citations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              location: expect.objectContaining({ type: 'documentChunk' }),
              source: expect.any(String),
              title: expect.any(String),
              sourceContent: expect.arrayContaining([expect.objectContaining({ text: expect.any(String) })]),
            }),
          ])
        )
        expect(citationsBlock!.content).toEqual(
          expect.arrayContaining([expect.objectContaining({ text: expect.any(String) })])
        )
      })

      it('returns documentPage citations from PDF document and preserves them in multi-turn', async () => {
        const pdfBytes = await loadFixture(letterPdfUrl)

        const agent = new Agent({
          model: createModel({ stream: false }),
          printer: false,
        })

        const result = await agent.invoke([
          new DocumentBlock({
            name: 'letter',
            format: 'pdf',
            source: { bytes: pdfBytes },
            citations: { enabled: true },
          }),
          new TextBlock('Summarize this document briefly.'),
        ])

        expect(result.stopReason).toBe('endTurn')

        const citationsBlock = result.lastMessage.content.find(
          (block): block is CitationsBlock => block.type === 'citationsBlock'
        )
        expect(citationsBlock).toBeDefined()
        expect(citationsBlock!.citations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              location: expect.objectContaining({ type: 'documentPage' }),
              source: expect.any(String),
              title: expect.any(String),
              sourceContent: expect.arrayContaining([expect.objectContaining({ text: expect.any(String) })]),
            }),
          ])
        )
        expect(citationsBlock!.content).toEqual(
          expect.arrayContaining([expect.objectContaining({ text: expect.any(String) })])
        )

        // Second turn: verify citations survive in conversation history
        const followUp = await agent.invoke('What else can you tell me about this document?')
        expect(followUp.stopReason).toBe('endTurn')
        expect(followUp.lastMessage.role).toBe('assistant')
        expect(followUp.lastMessage.content.length).toBeGreaterThan(0)
      })

      it.each([
        { mode: 'non-streaming', stream: false as const },
        { mode: 'streaming', stream: true as const },
      ])('emits citationsDelta events in $mode mode', async ({ stream }) => {
        const agent = new Agent({
          model: createModel({ stream }),
          printer: false,
        })

        const { items, result } = await collectGenerator(agent.stream([textDocBlock, textDocPrompt]))

        expect(result.stopReason).toBe('endTurn')

        const citationDeltas = items.filter(
          (item) =>
            item.type === 'modelStreamUpdateEvent' &&
            item.event.type === 'modelContentBlockDeltaEvent' &&
            item.event.delta.type === 'citationsDelta'
        )
        expect(citationDeltas.length).toBeGreaterThan(0)

        const citationsBlock = result.lastMessage.content.find(
          (block): block is CitationsBlock => block.type === 'citationsBlock'
        )
        expect(citationsBlock).toBeDefined()
        expect(citationsBlock!.citations.length).toBeGreaterThan(0)
      })
    })

    describe.skipIf(!supports.images)('multimodal input', () => {
      it('accepts ContentBlock[] input', async () => {
        const agent = new Agent({
          model: createModel(),
          printer: false,
        })

        const yellowPng = await loadFixture(yellowPngUrl)
        const imageBlock = new ImageBlock({
          format: 'png',
          source: { bytes: yellowPng },
        })

        const contentBlocks = [new TextBlock('What color is this image? Answer in one word.'), imageBlock]

        const result = await agent.invoke(contentBlocks)

        expect(result.stopReason).toBe('endTurn')
        expect(result.lastMessage.role).toBe('assistant')

        const textContent = result.lastMessage.content.find((block) => block.type === 'textBlock')
        expect(textContent).toBeDefined()
      })

      it('accepts Message[] input for conversation history', async () => {
        const agent = new Agent({
          model: createModel(),
          printer: false,
        })

        const conversationHistory = [
          new Message({
            role: 'user',
            content: [new TextBlock('Remember this number: 42')],
          }),
          new Message({
            role: 'assistant',
            content: [new TextBlock('I will remember the number 42.')],
          }),
          new Message({
            role: 'user',
            content: [new TextBlock('What number did I ask you to remember?')],
          }),
        ]

        const result = await agent.invoke(conversationHistory)

        expect(result.stopReason).toBe('endTurn')
        expect(result.lastMessage.role).toBe('assistant')

        const textContent = result.lastMessage.content.find((block) => block.type === 'textBlock')
        expect(textContent).toBeDefined()
        expect(textContent?.text).toMatch(/42/)
      })
    })

    it.skipIf(!supports.tools)('handles tool invocation', async () => {
      const agent = new Agent({
        model: createModel(),
        tools: [notebook, httpRequest],
        printer: false,
      })

      await agent.invoke('Call Open-Meteo to get the weather in NYC, and take a note of what you did')
      expect(
        agent.messages.some((message) =>
          message.content.some((block) => block.type == 'toolUseBlock' && block.name == 'notebook')
        )
      ).toBe(true)
      expect(
        agent.messages.some((message) =>
          message.content.some((block) => block.type == 'toolUseBlock' && block.name == 'http_request')
        )
      ).toBe(true)

      // Validate multi-turn works after tool use
      await collectGenerator(agent.stream('What was the result?'))
    })

    describe.skipIf(!supports.tools)('Structured Output', () => {
      it('returns validated structured output', async () => {
        const schema = z.object({ answer: z.number() })

        const agent = new Agent({
          model: createModel(),
          printer: false,
          structuredOutputSchema: schema,
        })

        const result = await agent.invoke('What is 2 + 2?')

        expect(result.structuredOutput).toStrictEqual({ answer: 4 })
      })
    })

    it.skipIf(!supports.reasoning)('emits reasoning content with thinking model', async () => {
      const agent = new Agent({
        model: createModel(models.reasoning),
        printer: false,
      })

      const { items, result } = await collectGenerator(agent.stream('What is 15 * 23? Think step by step.'))

      // Should have reasoning content deltas
      const reasoningDeltas = items.filter(
        (item) =>
          item.type === 'modelStreamUpdateEvent' &&
          item.event.type === 'modelContentBlockDeltaEvent' &&
          item.event.delta.type === 'reasoningContentDelta'
      )
      expect(reasoningDeltas.length).toBeGreaterThan(0)

      // Should also have text content with the answer
      expect(result.stopReason).toBe('endTurn')
      const textContent = result.lastMessage.content.find((block) => block.type === 'textBlock')
      expect(textContent).toBeDefined()
      expect(textContent?.text).toContain('345')
    })

    it.skipIf(!supports.toolThinking)('handles tool use with thinking model', async () => {
      const agent = new Agent({
        model: createModel(models.reasoning),
        printer: false,
        systemPrompt: 'Use the calculator tool to solve math problems. Respond with only the numeric result.',
        tools: [calculatorTool],
      })

      const { items, result } = await collectGenerator(agent.stream('What is 789 * 321?'))

      // Should have reasoning content deltas
      const reasoningDeltas = items.filter(
        (item) =>
          item.type === 'modelStreamUpdateEvent' &&
          item.event.type === 'modelContentBlockDeltaEvent' &&
          item.event.delta.type === 'reasoningContentDelta'
      )
      expect(reasoningDeltas.length).toBeGreaterThan(0)

      // Should have used the calculator tool
      const toolUseMessage = agent.messages.find((msg) =>
        msg.content.some((block) => block.type === 'toolUseBlock' && block.name === 'calculator')
      )
      expect(toolUseMessage).toBeDefined()

      // Verify reasoningSignature is present on tool use block
      const toolUseBlock = toolUseMessage!.content.find(
        (block): block is ToolUseBlock => block.type === 'toolUseBlock' && block.name === 'calculator'
      )
      expect(toolUseBlock?.reasoningSignature).toBeDefined()

      // Should contain the correct result (789 * 321 = 253269)
      expect(result.stopReason).toBe('endTurn')
      const textContent = result.lastMessage.content.find((block) => block.type === 'textBlock')
      expect(textContent).toBeDefined()
      expect(textContent?.text).toMatch(/253269/)

      // Validate multi-turn works after tool use
      await collectGenerator(agent.stream('What was the result?'))
    })

    it.skipIf(!supports.builtInTools)('handles built-in tools (code execution)', async () => {
      const agent = new Agent({
        model: createModel('builtInTools' in models ? models.builtInTools : {}),
        printer: false,
      })

      const result = await agent.invoke([
        new TextBlock('What is the sum of the first 50 prime numbers? Generate and run code to calculate it.'),
      ])

      expect(result.stopReason).toBe('endTurn')
      const textContent = result.lastMessage.content.find((block) => block.type === 'textBlock')
      expect(textContent).toBeDefined()
      expect(textContent?.text).toMatch(/5117/)

      // Validate multi-turn works after built-in tool use
      await collectGenerator(agent.stream('What was the result?'))
    })
  })
})
