import { describe, expect, it } from 'vitest'
import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec'
import { z } from 'zod'
import { tool } from '../tool-factory.js'
import { Tool } from '../tool.js'
import { FunctionTool } from '../function-tool.js'
import { StandardSchemaTool, type StandardToolSchema } from '../standard-schema-tool.js'
import { ZodTool } from '../zod-tool.js'
import { createMockContext } from '../../__fixtures__/tool-helpers.js'
import { collectGenerator } from '../../__fixtures__/model-test-helpers.js'
import type { JSONValue } from '../../types/json.js'
import type { ToolContext } from '../tool.js'

type FieldType = 'string' | 'number'
type Fields = Record<string, FieldType>
type Shape<F extends Fields> = { [K in keyof F]: F[K] extends 'number' ? number : string }

/**
 * A minimal schema library for these tests: an object of required string and number fields, implementing
 * Standard Schema and Standard JSON Schema. `async` makes validate() return a Promise, which the standard allows.
 */
function objectSchema<F extends Fields>(
  fields: F,
  options: { async?: boolean } = {}
): StandardToolSchema & StandardSchemaV1<unknown, Shape<F>> {
  const check = (value: unknown): StandardSchemaV1.Result<Shape<F>> => {
    if (typeof value !== 'object' || value === null) return { issues: [{ message: 'expected an object' }] }
    const issues: StandardSchemaV1.Issue[] = []
    for (const [key, type] of Object.entries(fields)) {
      const field = (value as Record<string, unknown>)[key]
      if (typeof field !== type) issues.push({ message: `expected ${type}`, path: [{ key }] })
    }
    return issues.length > 0 ? { issues } : { value: value as Shape<F> }
  }
  const jsonSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: Object.fromEntries(Object.entries(fields).map(([key, type]) => [key, { type }])),
    required: Object.keys(fields),
  }
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: (value: unknown) => (options.async ? Promise.resolve(check(value)) : check(value)),
      jsonSchema: {
        input: () => jsonSchema,
        output: () => jsonSchema,
      },
    },
  } as StandardToolSchema & StandardSchemaV1<unknown, Shape<F>>
}

type ValueSchema = ReturnType<typeof objectSchema<{ value: 'string' }>>

function createContext(input: JSONValue): ToolContext {
  return createMockContext({ name: 'testTool', toolUseId: 'test-123', input })
}

describe('tool with a Standard Schema', () => {
  describe('tool creation and properties', () => {
    it('creates a StandardSchemaTool whose input schema is the JSON Schema, without $schema', () => {
      const myTool = tool({
        name: 'testTool',
        description: 'Test description',
        inputSchema: objectSchema({ value: 'string' }),
        callback: (input) => input.value,
      })

      expect(myTool).toBeInstanceOf(StandardSchemaTool)
      expect(myTool).toBeInstanceOf(Tool)
      expect(myTool.toolSpec).toEqual({
        name: 'testTool',
        description: 'Test description',
        inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
      })
    })

    it('asks the schema for draft 2020-12', () => {
      const targets: string[] = []
      const base = objectSchema({ value: 'string' })['~standard']
      const schema = {
        '~standard': {
          ...base,
          jsonSchema: {
            input: (options: StandardJSONSchemaV1.Options): Record<string, unknown> => {
              targets.push(options.target)
              return base.jsonSchema.input(options)
            },
            output: base.jsonSchema.output,
          },
        },
      } as ValueSchema

      tool({ name: 'testTool', inputSchema: schema, callback: (value) => value.value })

      expect(targets).toEqual(['draft-2020-12'])
    })

    it('handles optional description', () => {
      const myTool = tool({ name: 'testTool', inputSchema: objectSchema({ value: 'string' }), callback: () => null })

      expect(myTool.description).toBe('')
    })
  })

  describe('invoke() method', () => {
    it('passes the validated input to the callback', async () => {
      const myTool = tool({
        name: 'sum',
        inputSchema: objectSchema({ a: 'number', b: 'number' }),
        callback: (input) => input.a + input.b,
      })

      expect(await myTool.invoke({ a: 5, b: 3 })).toBe(8)
    })

    it('returns the final value of an async generator callback', async () => {
      const myTool = tool({
        name: 'generator',
        inputSchema: objectSchema({ count: 'number' }),
        callback: async function* (input) {
          for (let i = 1; i <= input.count; i++) yield i
          return 'done'
        },
      })

      expect(await myTool.invoke({ count: 3 })).toBe('done')
    })

    it('throws with every issue and its path on invalid input', async () => {
      const myTool = tool({
        name: 'sum',
        inputSchema: objectSchema({ a: 'number', b: 'number' }),
        callback: (input) => input.a + input.b,
      })

      await expect(myTool.invoke({ a: 'x' } as never)).rejects.toThrow(
        'invalid input for tool sum: a: expected number; b: expected number'
      )
    })

    it('validates with a schema whose validate() is asynchronous', async () => {
      const myTool = tool({
        name: 'sum',
        inputSchema: objectSchema({ a: 'number', b: 'number' }, { async: true }),
        callback: (input) => input.a + input.b,
      })

      expect(await myTool.invoke({ a: 2, b: 2 })).toBe(4)
      await expect(myTool.invoke({ a: 2 } as never)).rejects.toThrow('b: expected number')
    })
  })

  describe('stream() method', () => {
    it('streams a synchronous callback result', async () => {
      const myTool = tool({
        name: 'sync',
        inputSchema: objectSchema({ value: 'string' }),
        callback: (input) => input.value,
      })

      const { items: events, result } = await collectGenerator(myTool.stream(createContext({ value: 'hello' })))

      expect(events).toHaveLength(0)
      expect(result.status).toBe('success')
      expect(result.content[0]).toEqual(expect.objectContaining({ type: 'textBlock', text: 'hello' }))
    })

    it('streams async generator callback results', async () => {
      const myTool = tool({
        name: 'generator',
        inputSchema: objectSchema({ count: 'number' }),
        callback: async function* (input) {
          for (let i = 1; i <= input.count; i++) yield `Step ${i}`
          return 0
        },
      })

      const { items: events, result } = await collectGenerator(myTool.stream(createContext({ count: 3 })))

      expect(events.map((e) => e.data)).toEqual(['Step 1', 'Step 2', 'Step 3'])
      expect(result.status).toBe('success')
    })

    it('keeps streaming when validation is asynchronous', async () => {
      const myTool = tool({
        name: 'generator',
        inputSchema: objectSchema({ count: 'number' }, { async: true }),
        callback: async function* (input) {
          for (let i = 1; i <= input.count; i++) yield `Step ${i}`
          return 'end'
        },
      })

      const { items: events, result } = await collectGenerator(myTool.stream(createContext({ count: 2 })))

      expect(events.map((e) => e.data)).toEqual(['Step 1', 'Step 2'])
      expect(result.status).toBe('success')
      expect(result.content[0]).toEqual(expect.objectContaining({ type: 'textBlock', text: 'end' }))
    })

    it('returns an error result naming the field on validation failure', async () => {
      let called = false
      const myTool = tool({
        name: 'validator',
        inputSchema: objectSchema({ age: 'number' }),
        callback: (input) => {
          called = true
          return input.age
        },
      })

      const { items: events, result } = await collectGenerator(myTool.stream(createContext({ age: 'old' })))

      expect(events).toHaveLength(0)
      expect(called).toBe(false)
      expect(result.status).toBe('error')
      expect(result.content[0]).toEqual(expect.objectContaining({ type: 'textBlock' }))
      expect(JSON.stringify(result.content)).toContain('age: expected number')
    })

    it('returns an error result on asynchronous validation failure', async () => {
      const myTool = tool({
        name: 'validator',
        inputSchema: objectSchema({ age: 'number' }, { async: true }),
        callback: (input) => input.age,
      })

      const { result } = await collectGenerator(myTool.stream(createContext({})))

      expect(result.status).toBe('error')
      expect(JSON.stringify(result.content)).toContain('age: expected number')
    })
  })

  describe('choosing the tool class', () => {
    it('keeps Zod schemas on ZodTool', () => {
      const myTool = tool({
        name: 'zod',
        inputSchema: z.object({ value: z.string() }),
        callback: (input) => input.value,
      })

      expect(myTool).toBeInstanceOf(ZodTool)
    })

    it('keeps a plain JSON Schema on FunctionTool', () => {
      const myTool = tool({
        name: 'json',
        description: 'Plain JSON Schema',
        inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
        callback: () => null,
      })

      expect(myTool).toBeInstanceOf(FunctionTool)
    })

    it('rejects a Standard Schema that cannot produce a JSON Schema', () => {
      const validateOnly = { '~standard': { version: 1, vendor: 'test', validate: () => ({ value: {} }) } }

      expect(() =>
        tool({ name: 'noJson', description: '', inputSchema: validateOnly as never, callback: () => null })
      ).toThrow('tool noJson: inputSchema implements Standard Schema but not Standard JSON Schema')
    })
  })
})
