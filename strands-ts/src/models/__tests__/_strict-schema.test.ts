// Parity mirror of strands-py/tests/strands/models/test_strict_schema.py.
// Keep the cases aligned with the Python file so the two SDKs stay in parity.
import { describe, it, expect } from 'vitest'
import { ensureStrictJsonSchema } from '../_strict-schema.js'
import type { JSONSchema } from '../../types/json.js'

const schema = (value: object): JSONSchema => value as unknown as JSONSchema
const asRecord = (value: JSONSchema): Record<string, unknown> => value as unknown as Record<string, unknown>

describe('ensureStrictJsonSchema', () => {
  it('adds additionalProperties: false to a basic object and does not mutate the original', () => {
    const original = schema({ type: 'object', properties: { x: { type: 'string' } } })
    const result = ensureStrictJsonSchema(original)

    expect(result).toEqual({
      type: 'object',
      properties: { x: { type: 'string' } },
      additionalProperties: false,
    })
    expect('additionalProperties' in asRecord(original)).toBe(false)
  })

  it('recurses into nested objects', () => {
    const result = ensureStrictJsonSchema(
      schema({
        type: 'object',
        properties: { outer: { type: 'object', properties: { inner: { type: 'integer' } } } },
      })
    )

    expect(result).toEqual({
      type: 'object',
      properties: {
        outer: { type: 'object', properties: { inner: { type: 'integer' } }, additionalProperties: false },
      },
      additionalProperties: false,
    })
  })

  it('processes $defs blocks', () => {
    const result = asRecord(
      ensureStrictJsonSchema(
        schema({
          type: 'object',
          properties: { item: { $ref: '#/$defs/MyItem' } },
          $defs: { MyItem: { type: 'object', properties: { name: { type: 'string' } } } },
        })
      )
    )

    expect(result['additionalProperties']).toBe(false)
    expect((result['$defs'] as Record<string, unknown>)['MyItem']).toEqual({
      type: 'object',
      properties: { name: { type: 'string' } },
      additionalProperties: false,
    })
  })

  it('processes definitions blocks', () => {
    const result = asRecord(
      ensureStrictJsonSchema(
        schema({
          type: 'object',
          properties: { item: { $ref: '#/definitions/MyItem' } },
          definitions: { MyItem: { type: 'object', properties: { name: { type: 'string' } } } },
        })
      )
    )

    expect(result['additionalProperties']).toBe(false)
    expect((result['definitions'] as Record<string, unknown>)['MyItem']).toEqual({
      type: 'object',
      properties: { name: { type: 'string' } },
      additionalProperties: false,
    })
  })

  it('inlines a $ref that has sibling keys, existing keys winning', () => {
    const result = asRecord(
      ensureStrictJsonSchema(
        schema({
          type: 'object',
          properties: { item: { $ref: '#/$defs/MyItem', description: 'An item' } },
          $defs: { MyItem: { type: 'object', properties: { name: { type: 'string' } } } },
        })
      )
    )

    expect((result['properties'] as Record<string, unknown>)['item']).toEqual({
      type: 'object',
      properties: { name: { type: 'string' } },
      description: 'An item',
      additionalProperties: false,
    })
  })

  it('deep-copies on inline so repeated $refs are independent', () => {
    const result = asRecord(
      ensureStrictJsonSchema(
        schema({
          type: 'object',
          properties: {
            a: { $ref: '#/$defs/Shared', description: 'first' },
            b: { $ref: '#/$defs/Shared', description: 'second' },
          },
          $defs: { Shared: { type: 'object', properties: { val: { type: 'string' } } } },
        })
      )
    )
    const properties = result['properties'] as Record<string, Record<string, unknown>>

    expect(properties['a']!['description']).toBe('first')
    expect(properties['b']!['description']).toBe('second')
    expect(properties['a']).not.toBe(properties['b'])
  })

  it('recurses into array items, anyOf, and allOf', () => {
    const result = ensureStrictJsonSchema(
      schema({
        type: 'object',
        properties: {
          items: { type: 'array', items: { type: 'object', properties: { a: { type: 'string' } } } },
          union: { anyOf: [{ type: 'object', properties: { b: { type: 'string' } } }, { type: 'null' }] },
          intersection: { allOf: [{ type: 'object', properties: { c: { type: 'string' } } }] },
        },
      })
    )

    expect(result).toEqual({
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false },
        },
        union: {
          anyOf: [
            { type: 'object', properties: { b: { type: 'string' } }, additionalProperties: false },
            { type: 'null' },
          ],
        },
        intersection: {
          allOf: [{ type: 'object', properties: { c: { type: 'string' } }, additionalProperties: false }],
        },
      },
      additionalProperties: false,
    })
  })

  it('recurses into oneOf', () => {
    const result = ensureStrictJsonSchema(
      schema({
        type: 'object',
        properties: {
          value: {
            oneOf: [
              { type: 'object', properties: { a: { type: 'string' } } },
              { type: 'object', properties: { b: { type: 'integer' } } },
            ],
          },
        },
      })
    )

    expect(result).toEqual({
      type: 'object',
      properties: {
        value: {
          oneOf: [
            { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false },
            { type: 'object', properties: { b: { type: 'integer' } }, additionalProperties: false },
          ],
        },
      },
      additionalProperties: false,
    })
  })

  it('leaves required alone by default and sets all properties when requireAllProperties is true', () => {
    const input = schema({
      type: 'object',
      properties: { required_field: { type: 'string' }, optional_field: { type: 'string' } },
      required: ['required_field'],
    })

    const without = asRecord(ensureStrictJsonSchema(input))
    expect(without['required']).toEqual(['required_field'])

    const withAll = asRecord(ensureStrictJsonSchema(input, true))
    expect(new Set(withAll['required'] as string[])).toEqual(new Set(['required_field', 'optional_field']))
  })

  it('preserves an existing additionalProperties: true', () => {
    const result = ensureStrictJsonSchema(
      schema({ type: 'object', properties: { x: { type: 'string' } }, additionalProperties: true })
    )

    expect(result).toEqual({
      type: 'object',
      properties: { x: { type: 'string' } },
      additionalProperties: true,
    })
  })

  it('preserves an existing additionalProperties: false', () => {
    const result = ensureStrictJsonSchema(
      schema({ type: 'object', properties: { x: { type: 'string' } }, additionalProperties: false })
    )

    expect(result).toEqual({
      type: 'object',
      properties: { x: { type: 'string' } },
      additionalProperties: false,
    })
  })

  it('leaves a non-object type unchanged', () => {
    expect(ensureStrictJsonSchema(schema({ type: 'string' }))).toEqual({ type: 'string' })
  })

  it('ignores a $ref that does not start with #/ but still closes the root', () => {
    const result = asRecord(
      ensureStrictJsonSchema(
        schema({ type: 'object', properties: { item: { $ref: 'external.json#/Foo', description: 'ext' } } })
      )
    )

    expect(result['additionalProperties']).toBe(false)
    expect((result['properties'] as Record<string, Record<string, unknown>>)['item']!['$ref']).toBe(
      'external.json#/Foo'
    )
  })

  it('ignores a $ref pointing at a missing path but still closes the root', () => {
    const result = asRecord(
      ensureStrictJsonSchema(
        schema({
          type: 'object',
          properties: { item: { $ref: '#/$defs/Missing', description: 'gone' } },
          $defs: {},
        })
      )
    )

    expect(result['additionalProperties']).toBe(false)
    expect('$ref' in (result['properties'] as Record<string, Record<string, unknown>>)['item']!).toBe(true)
  })
})
