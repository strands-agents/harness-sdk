import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { tool } from '../tool-factory.js'
import { Tool } from '../tool.js'
import { createMockContext } from '../../__fixtures__/tool-helpers.js'
import { collectGenerator } from '../../__fixtures__/model-test-helpers.js'
import type { JSONValue } from '../../types/json.js'
import type { ToolContext } from '../tool.js'

/**
 * Helper to create a mock ToolContext with just input for zod tool tests.
 */
function createContext(input: JSONValue): ToolContext {
  return createMockContext({
    name: 'testTool',
    toolUseId: 'test-123',
    input,
  })
}

describe('tool', () => {
  describe('tool creation and properties', () => {
    it('creates tool with correct properties', () => {
      const myTool = tool({
        name: 'testTool',
        description: 'Test description',
        inputSchema: z.object({ value: z.string() }),
        callback: (input) => input.value,
      })

      expect(myTool.name).toBe('testTool')
      expect(myTool.description).toBe('Test description')
      expect(myTool.toolSpec).toEqual({
        name: 'testTool',
        description: 'Test description',
        inputSchema: {
          type: 'object',
          properties: {
            value: { type: 'string' },
          },
          required: ['value'],
          additionalProperties: false,
        },
      })
    })

    it('handles optional description', () => {
      const myTool = tool({
        name: 'testTool',
        inputSchema: z.object({ value: z.string() }),
        callback: (input) => input.value,
      })

      expect(myTool.name).toBe('testTool')
      expect(myTool.description).toBe('')
    })
  })

  describe('invoke() method', () => {
    describe('basic return types', () => {
      it('handles synchronous callback', async () => {
        const myTool = tool({
          name: 'sync',
          description: 'Synchronous tool',
          inputSchema: z.object({ a: z.number(), b: z.number() }),
          callback: (input) => input.a + input.b,
        })

        const result = await myTool.invoke({ a: 5, b: 3 })
        expect(result).toBe(8)
      })

      it('handles promise callback', async () => {
        const myTool = tool({
          name: 'async',
          description: 'Async tool',
          inputSchema: z.object({ value: z.string() }),
          callback: async (input) => `Result: ${input.value}`,
        })

        const result = await myTool.invoke({ value: 'test' })
        expect(result).toBe('Result: test')
      })

      it('handles async generator callback', async () => {
        const myTool = tool({
          name: 'generator',
          description: 'Generator tool',
          inputSchema: z.object({ count: z.number() }),
          callback: async function* (input) {
            for (let i = 1; i <= input.count; i++) {
              yield i
            }
            return 0
          },
        })

        const result = await myTool.invoke({ count: 3 })
        expect(result).toBe(0)
      })
    })

    describe('validation', () => {
      it('throws on invalid input', async () => {
        const myTool = tool({
          name: 'validator',
          description: 'Validates input',
          inputSchema: z.object({ age: z.number().min(0).max(120) }),
          callback: (input) => input.age,
        })

        await expect(myTool.invoke({ age: -1 })).rejects.toThrow()
        await expect(myTool.invoke({ age: 150 })).rejects.toThrow()
      })

      it('validates required fields', async () => {
        const myTool = tool({
          name: 'required',
          description: 'Required fields',
          inputSchema: z.object({
            name: z.string(),
            email: z.string().email(),
          }),
          callback: (input) => `${input.name}: ${input.email}`,
        })

        await expect(myTool.invoke({ name: 'John' } as never)).rejects.toThrow()
        await expect(myTool.invoke({ email: 'invalid-email' } as never)).rejects.toThrow()
      })
    })

    describe('context handling', () => {
      it('passes context to callback', async () => {
        const callback = vi.fn((input, context) => {
          expect(context).toBeDefined()
          return input.value
        })

        const myTool = tool({
          name: 'context',
          description: 'Uses context',
          inputSchema: z.object({ value: z.string() }),
          callback,
        })

        const mockContext = createContext({ value: 'test' })
        await myTool.invoke({ value: 'test' }, mockContext)
        expect(callback).toHaveBeenCalled()
      })
    })
  })

  describe('stream() method', () => {
    describe('basic return types', () => {
      it('streams synchronous callback result', async () => {
        const myTool = tool({
          name: 'sync',
          description: 'Synchronous tool',
          inputSchema: z.object({ value: z.string() }),
          callback: (input) => input.value,
        })

        const context = createContext({ value: 'hello' })
        const { items: events, result } = await collectGenerator(myTool.stream(context))

        expect(events).toHaveLength(0) // No stream events for sync
        expect(result.status).toBe('success')
        expect(result.content).toHaveLength(1)
        expect(result.content[0]).toEqual(expect.objectContaining({ type: 'textBlock', text: 'hello' }))
      })

      it('streams promise callback result', async () => {
        const myTool = tool({
          name: 'async',
          description: 'Async tool',
          inputSchema: z.object({ value: z.number() }),
          callback: async (input) => input.value * 2,
        })

        const context = createContext({ value: 21 })
        const { items: events, result } = await collectGenerator(myTool.stream(context))

        expect(events).toHaveLength(0) // No stream events for promise
        expect(result.status).toBe('success')
        expect(result.content).toHaveLength(1)
        expect(result.content[0]).toEqual(expect.objectContaining({ type: 'textBlock', text: '42' }))
      })

      it('streams async generator callback results', async () => {
        const myTool = tool({
          name: 'generator',
          description: 'Generator tool',
          inputSchema: z.object({ count: z.number() }),
          callback: async function* (input) {
            for (let i = 1; i <= input.count; i++) {
              yield `Step ${i}`
            }
            return 0
          },
        })

        const context = createContext({ count: 3 })
        const { items: events, result } = await collectGenerator(myTool.stream(context))

        expect(events).toHaveLength(3)
        const eventData = events.map((e) => e.data)
        expect(eventData).toEqual(['Step 1', 'Step 2', 'Step 3'])
        expect(result.status).toBe('success')
      })
    })

    describe('validation', () => {
      it('returns error result on validation failure', async () => {
        const myTool = tool({
          name: 'validator',
          description: 'Validates input',
          inputSchema: z.object({ age: z.number().min(0) }),
          callback: (input) => input.age,
        })

        const context = createContext({ age: -5 })
        const { items: events, result } = await collectGenerator(myTool.stream(context))

        expect(events).toHaveLength(0)
        expect(result.status).toBe('error')
        expect(result.content.length).toBeGreaterThan(0)
        const firstContent = result.content[0]
        if (firstContent && firstContent.type == 'textBlock') {
          expect(firstContent.text).toContain('age')
        }
      })

      it('returns error result on missing required fields', async () => {
        const myTool = tool({
          name: 'required',
          description: 'Required fields',
          inputSchema: z.object({
            name: z.string(),
            value: z.number(),
          }),
          callback: (input) => `${input.name}: ${input.value}`,
        })

        const context = createContext({ name: 'test' })
        const { items: events, result } = await collectGenerator(myTool.stream(context))

        expect(events).toHaveLength(0)
        expect(result.status).toBe('error')
      })
    })

    describe('error handling', () => {
      it('catches callback errors and returns error result', async () => {
        const myTool = tool({
          name: 'error',
          description: 'Throws error',
          inputSchema: z.object({ value: z.string() }),
          callback: () => {
            throw new Error('Callback error')
          },
        })

        const context = createContext({ value: 'test' })
        const { items: events, result } = await collectGenerator(myTool.stream(context))

        expect(events).toHaveLength(0)
        expect(result.status).toBe('error')
        expect(result.content.length).toBeGreaterThan(0)
        const firstContent = result.content[0]
        if (firstContent && firstContent.type == 'textBlock') {
          expect(firstContent.text).toBe('Error: Callback error')
        }
      })

      it('catches async callback errors', async () => {
        const myTool = tool({
          name: 'asyncError',
          description: 'Throws async error',
          inputSchema: z.object({ value: z.string() }),
          callback: async () => {
            throw new Error('Async error')
          },
        })

        const context = createContext({ value: 'test' })
        const { items: events, result } = await collectGenerator(myTool.stream(context))

        expect(events).toHaveLength(0)
        expect(result.status).toBe('error')
        expect(result.content.length).toBeGreaterThan(0)
        const firstContent = result.content[0]
        if (firstContent && firstContent.type == 'textBlock') {
          expect(firstContent.text).toBe('Error: Async error')
        }
      })
    })
  })

  describe('complex scenarios', () => {
    it('handles nested object schemas', async () => {
      const myTool = tool({
        name: 'nested',
        description: 'Nested objects',
        inputSchema: z.object({
          user: z.object({
            name: z.string(),
            age: z.number(),
          }),
          metadata: z.object({
            timestamp: z.number(),
          }),
        }),
        callback: (input) => `${input.user.name} (${input.user.age})`,
      })

      const result = await myTool.invoke({
        user: { name: 'Alice', age: 30 },
        metadata: { timestamp: Date.now() },
      })
      expect(result).toBe('Alice (30)')
    })

    it('handles enum schemas', async () => {
      const myTool = tool({
        name: 'calculator',
        description: 'Basic calculator',
        inputSchema: z.object({
          operation: z.enum(['add', 'subtract', 'multiply', 'divide']),
          a: z.number(),
          b: z.number(),
        }),
        callback: (input) => {
          switch (input.operation) {
            case 'add':
              return input.a + input.b
            case 'subtract':
              return input.a - input.b
            case 'multiply':
              return input.a * input.b
            case 'divide':
              return input.a / input.b
          }
        },
      })

      expect(await myTool.invoke({ operation: 'add', a: 5, b: 3 })).toBe(8)
      expect(await myTool.invoke({ operation: 'multiply', a: 4, b: 7 })).toBe(28)
    })

    it('handles optional fields', async () => {
      const myTool = tool({
        name: 'greeting',
        description: 'Generates greeting',
        inputSchema: z.object({
          name: z.string(),
          title: z.string().optional(),
        }),
        callback: (input) => {
          return input.title ? `${input.title} ${input.name}` : input.name
        },
      })

      expect(await myTool.invoke({ name: 'Smith' })).toBe('Smith')
      expect(await myTool.invoke({ name: 'Smith', title: 'Dr.' })).toBe('Dr. Smith')
    })

    it('handles array schemas', async () => {
      const myTool = tool({
        name: 'sum',
        description: 'Sums numbers',
        inputSchema: z.object({
          numbers: z.array(z.number()),
        }),
        callback: (input) => input.numbers.reduce((a, b) => a + b, 0),
      })

      expect(await myTool.invoke({ numbers: [1, 2, 3, 4, 5] })).toBe(15)
    })
  })

  describe('JSON schema generation', () => {
    it('generates valid JSON schema from Zod schema', () => {
      const myTool = tool({
        name: 'test',
        description: 'Test tool',
        inputSchema: z.object({
          name: z.string(),
          age: z.number(),
          email: z.string().email(),
        }),
        callback: () => 'result',
      })

      const schema = myTool.toolSpec.inputSchema
      expect(schema).toEqual({
        type: 'object',
        additionalProperties: false,
        properties: {
          age: {
            type: 'number',
          },
          email: {
            format: 'email',
            pattern:
              "^(?:[A-Za-z0-9_'+\\-]+\\.)*[A-Za-z0-9_'+\\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$",
            type: 'string',
          },
          name: {
            type: 'string',
          },
        },
        required: ['name', 'age', 'email'],
      })
    })
  })

  describe('instanceof checks', () => {
    it('passes instanceof Tool check and has InvokableTool methods', () => {
      const myTool = tool({
        name: 'testTool',
        description: 'Test description',
        inputSchema: z.object({ value: z.string() }),
        callback: (input) => input.value,
      })

      // Verify instanceof Tool
      expect(myTool instanceof Tool).toBe(true)

      // Verify InvokableTool interface methods are present
      expect(typeof myTool.invoke).toBe('function')
      expect(typeof myTool.stream).toBe('function')

      // Verify can be used as type guard (various types)
      expect(myTool instanceof Tool).toBe(true)
      expect({} instanceof Tool).toBe(false)
      // TypeScript doesn't allow null/undefined in instanceof, verify they're not Tool instances differently
      expect((null as unknown) instanceof Tool).toBe(false)
    })
  })

  describe('optional inputSchema', () => {
    describe('when inputSchema is undefined', () => {
      it('creates tool with default empty object schema', () => {
        const myTool = tool({
          name: 'noInputTool',
          description: 'Tool with no input',
          callback: () => 'result',
        })

        expect(myTool.name).toBe('noInputTool')
        expect(myTool.description).toBe('Tool with no input')
        expect(myTool.toolSpec).toEqual({
          name: 'noInputTool',
          description: 'Tool with no input',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        })
      })

      it('invoke() works with empty object', async () => {
        const myTool = tool({
          name: 'getPreferences',
          description: 'Gets user preferences',
          callback: () => ({ theme: 'dark', language: 'en' }),
        })

        const result = await myTool.invoke({})
        expect(result).toEqual({ theme: 'dark', language: 'en' })
      })

      it('stream() works with empty input', async () => {
        const myTool = tool({
          name: 'getStatus',
          description: 'Gets system status',
          callback: () => ({ status: 'operational', uptime: 99.9 }),
        })

        const { result } = await collectGenerator(myTool.stream(createContext({})))

        expect(result).toEqual({
          type: 'toolResultBlock',
          toolUseId: 'test-123',
          status: 'success',
          content: [
            expect.objectContaining({
              type: 'jsonBlock',
              json: { status: 'operational', uptime: 99.9 },
            }),
          ],
        })
      })

      it('callback receives empty object when no schema', async () => {
        let capturedInput: unknown
        const myTool = tool({
          name: 'captureInput',
          description: 'Captures input',
          callback: (input) => {
            capturedInput = input
            return 'captured'
          },
        })

        await myTool.invoke({})
        expect(capturedInput).toEqual({})
      })

      it('works with async callback', async () => {
        const myTool = tool({
          name: 'asyncNoInput',
          description: 'Async tool',
          callback: async () => {
            return 'async result'
          },
        })

        const result = await myTool.invoke({})
        expect(result).toBe('async result')
      })

      it('works with async generator callback', async () => {
        const myTool = tool({
          name: 'streamNoInput',
          description: 'Streaming tool',
          callback: async function* () {
            yield 'Starting...'
            yield 'Processing...'
            return 'Complete!'
          },
        })

        const result = await myTool.invoke({})
        expect(result).toBe('Complete!')
      })
    })

    describe('when inputSchema is z.void()', () => {
      it('creates tool with default empty object schema', () => {
        const myTool = tool({
          name: 'voidInputTool',
          description: 'Tool with z.void() input',
          inputSchema: z.void(),
          callback: () => 'result',
        })

        expect(myTool.name).toBe('voidInputTool')
        expect(myTool.description).toBe('Tool with z.void() input')
        expect(myTool.toolSpec).toEqual({
          name: 'voidInputTool',
          description: 'Tool with z.void() input',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        })
      })

      it('invoke() works with empty object', async () => {
        const myTool = tool({
          name: 'refreshCache',
          description: 'Refreshes the cache',
          inputSchema: z.void(),
          callback: () => ({ refreshed: true, timestamp: Date.now() }),
        })

        const result = await myTool.invoke({} as never)
        expect(result).toHaveProperty('refreshed', true)
        expect(result).toHaveProperty('timestamp')
      })

      it('stream() works with empty input', async () => {
        const myTool = tool({
          name: 'pingServer',
          description: 'Pings the server',
          inputSchema: z.void(),
          callback: () => ({ pong: true }),
        })

        const { result } = await collectGenerator(myTool.stream(createContext({})))

        expect(result).toEqual({
          type: 'toolResultBlock',
          toolUseId: 'test-123',
          status: 'success',
          content: [
            expect.objectContaining({
              type: 'jsonBlock',
              json: { pong: true },
            }),
          ],
        })
      })

      it('works with async generator callback', async () => {
        const myTool = tool({
          name: 'streamVoidInput',
          description: 'Streaming with void input',
          inputSchema: z.void(),
          callback: async function* () {
            yield 'Step 1'
            yield 'Step 2'
            return 'Done'
          },
        })

        const { items: streamEvents, result } = await collectGenerator(myTool.stream(createContext({})))

        expect(streamEvents).toEqual([
          { type: 'toolStreamEvent', data: 'Step 1' },
          { type: 'toolStreamEvent', data: 'Step 2' },
        ])

        expect(result).toEqual({
          type: 'toolResultBlock',
          toolUseId: 'test-123',
          status: 'success',
          content: [
            expect.objectContaining({
              type: 'textBlock',
              text: 'Done',
            }),
          ],
        })
      })

      it('does not throw Zod conversion errors', () => {
        // This test verifies that z.void() doesn't cause errors during tool creation
        expect(() => {
          tool({
            name: 'voidTool',
            description: 'Tool with void',
            inputSchema: z.void(),
            callback: () => 'ok',
          })
        }).not.toThrow()
      })
    })
  })
})
