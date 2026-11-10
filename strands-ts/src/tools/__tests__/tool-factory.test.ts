import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { tool } from '../tool-factory.js'
import { Tool } from '../tool.js'

describe('tool factory', () => {
  describe('dispatch logic', () => {
    it('creates ZodTool when inputSchema is a Zod type', () => {
      const myTool = tool({
        name: 'zod',
        description: 'Zod',
        inputSchema: z.object({ x: z.string() }),
        callback: (input) => input.x,
      })

      // ZodTool generates JSON schema from Zod with additionalProperties: false
      expect(myTool.toolSpec.inputSchema).toHaveProperty('additionalProperties', false)
    })

    it('creates FunctionTool when inputSchema is a plain object', () => {
      const schema = { type: 'object' as const, properties: { x: { type: 'string' as const } } }
      const myTool = tool({
        name: 'json',
        description: 'JSON',
        inputSchema: schema,
        callback: () => 'ok',
      })

      // JSON schema is passed through as-is
      expect(myTool.toolSpec.inputSchema).toStrictEqual(schema)
    })

    it('creates FunctionTool when inputSchema is omitted', () => {
      const myTool = tool({
        name: 'noSchema',
        description: 'No schema',
        callback: () => 'ok',
      })

      expect(myTool.toolSpec.inputSchema).toStrictEqual({
        type: 'object',
        properties: {},
        additionalProperties: false,
      })
    })
  })

  describe('FunctionTool invoke()', () => {
    it('handles synchronous callback', async () => {
      const myTool = tool({
        name: 'sync',
        description: 'Sync',
        inputSchema: { type: 'object' },
        callback: (input) => {
          const { a, b } = input as { a: number; b: number }
          return a + b
        },
      })

      expect(await myTool.invoke({ a: 5, b: 3 })).toBe(8)
    })

    it('handles promise callback', async () => {
      const myTool = tool({
        name: 'async',
        description: 'Async',
        inputSchema: { type: 'object' },
        callback: async (input) => `Result: ${(input as { value: string }).value}`,
      })

      expect(await myTool.invoke({ value: 'test' })).toBe('Result: test')
    })

    it('handles async generator callback', async () => {
      const myTool = tool({
        name: 'gen',
        description: 'Generator',
        inputSchema: { type: 'object' },
        callback: async function* (input) {
          const { count } = input as { count: number }
          for (let i = 1; i <= count; i++) {
            yield i
          }
          return 0
        },
      })

      expect(await myTool.invoke({ count: 3 })).toBe(0)
    })

    it('passes instanceof Tool check', () => {
      const myTool = tool({
        name: 'test',
        description: 'test',
        inputSchema: { type: 'object' },
        callback: () => 'ok',
      })

      expect(myTool instanceof Tool).toBe(true)
    })

    it('defaults description to empty string', () => {
      const myTool = tool({
        name: 'test',
        description: '',
        inputSchema: { type: 'object' },
        callback: () => 'ok',
      })

      expect(myTool.description).toBe('')
    })
  })
})
