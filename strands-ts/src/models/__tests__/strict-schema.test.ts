// Covers the cases in strands-py/tests/strands/models/test_strict_schema.py. The TS transform
// also terminates recursive $refs, closes union and additionalProperties object schemas, and
// keeps a $ref target's additionalProperties, which the Python transform does not.
import { describe, it, expect, vi } from 'vitest'
import { ensureStrictJsonSchema, findUnsupportedStrictKeywords } from '../strict-schema.js'
import { deepCopy } from '../../types/json.js'
import type { JSONSchema } from '../../types/json.js'
import { logger } from '../../logging/logger.js'

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

    expect(result).toEqual({
      type: 'object',
      properties: { item: { $ref: '#/$defs/MyItem' } },
      $defs: { MyItem: { type: 'object', properties: { name: { type: 'string' } }, additionalProperties: false } },
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

    expect(result).toEqual({
      type: 'object',
      properties: { item: { $ref: '#/definitions/MyItem' } },
      definitions: {
        MyItem: { type: 'object', properties: { name: { type: 'string' } }, additionalProperties: false },
      },
      additionalProperties: false,
    })
  })

  it('inlines a $ref that has sibling keys, existing keys winning', () => {
    const result = asRecord(
      ensureStrictJsonSchema(
        schema({
          type: 'object',
          properties: { item: { $ref: '#/$defs/MyItem', description: 'An item' } },
          $defs: {
            MyItem: { type: 'object', description: 'from $defs', properties: { name: { type: 'string' } } },
          },
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

  it('leaves required unchanged', () => {
    const input = schema({
      type: 'object',
      properties: { required_field: { type: 'string' }, optional_field: { type: 'string' } },
      required: ['required_field'],
    })

    expect(asRecord(ensureStrictJsonSchema(input))['required']).toEqual(['required_field'])
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

  it('terminates on a recursive $ref with sibling keys, leaving the cycle point unresolved', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const result = asRecord(
      ensureStrictJsonSchema(
        schema({
          type: 'object',
          properties: { filter: { $ref: '#/definitions/Filter', description: 'root filter' } },
          definitions: {
            Filter: {
              type: 'object',
              properties: { and: { type: 'array', items: { $ref: '#/definitions/Filter', description: 'sub' } } },
            },
          },
        })
      )
    )

    type Node = Record<string, unknown>
    const filter = (result['properties'] as Record<string, Node>)['filter']!
    expect(filter['description']).toBe('root filter')
    expect(filter['additionalProperties']).toBe(false)

    let node: Node = filter
    while (!('$ref' in node)) {
      node = (node['properties'] as Record<string, Node>)['and']!['items'] as Node
    }
    expect(node).toEqual({ $ref: '#/definitions/Filter', description: 'sub' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ref=<#/definitions/Filter> | recursive $ref'))
    warn.mockRestore()
  })

  it('does not mutate nested objects or $defs of the original', () => {
    const original = schema({
      type: 'object',
      properties: {
        outer: { type: 'object', properties: { inner: { type: 'string' } } },
        item: { $ref: '#/$defs/Item', description: 'an item' },
      },
      $defs: { Item: { type: 'object', properties: { name: { type: 'string' } } } },
    })
    const snapshot = deepCopy(original)

    ensureStrictJsonSchema(original)

    expect(original).toEqual(snapshot)
  })

  it('closes an object whose type is a union including object', () => {
    const result = ensureStrictJsonSchema(
      schema({
        type: 'object',
        properties: { addr: { type: ['object', 'null'], properties: { city: { type: 'string' } } } },
      })
    )

    expect(result).toEqual({
      type: 'object',
      properties: {
        addr: { type: ['object', 'null'], properties: { city: { type: 'string' } }, additionalProperties: false },
      },
      additionalProperties: false,
    })
  })

  it('closes objects inside a schema-valued additionalProperties', () => {
    const result = ensureStrictJsonSchema(
      schema({
        type: 'object',
        additionalProperties: { type: 'object', properties: { v: { type: 'string' } } },
      })
    )

    expect(result).toEqual({
      type: 'object',
      additionalProperties: { type: 'object', properties: { v: { type: 'string' } }, additionalProperties: false },
    })
  })

  it("keeps a $ref target's additionalProperties when the ref node also declares type object", () => {
    const result = asRecord(
      ensureStrictJsonSchema(
        schema({
          type: 'object',
          properties: { m: { $ref: '#/$defs/Map', type: 'object' } },
          $defs: { Map: { type: 'object', additionalProperties: { type: 'string' } } },
        })
      )
    )

    expect((result['properties'] as Record<string, unknown>)['m']).toEqual({
      type: 'object',
      additionalProperties: { type: 'string' },
    })
  })
  it('does not resolve a $ref through the prototype chain', () => {
    const result = asRecord(
      ensureStrictJsonSchema(
        schema({ type: 'object', properties: { x: { $ref: '#/$defs/__proto__', description: 'd' } }, $defs: {} })
      )
    )

    expect((result['properties'] as Record<string, unknown>)['x']).toEqual({
      $ref: '#/$defs/__proto__',
      description: 'd',
    })
  })

  it('keeps an inlined __proto__ key as an own property and still closes the node', () => {
    const result = asRecord(
      ensureStrictJsonSchema(
        JSON.parse(
          '{"type":"object","properties":{"x":{"$ref":"#/$defs/Item","description":"d"}},' +
            '"$defs":{"Item":{"type":"object","__proto__":{"additionalProperties":true}}}}'
        ) as JSONSchema
      )
    )
    const x = (result['properties'] as Record<string, Record<string, unknown>>)['x']!

    expect(Object.getPrototypeOf(x)).toBe(Object.prototype)
    expect(Object.hasOwn(x, 'additionalProperties')).toBe(true)
    expect(x['additionalProperties']).toBe(false)
  })
})

describe('findUnsupportedStrictKeywords', () => {
  it('returns nothing for a closed schema without bounds', () => {
    const strict = ensureStrictJsonSchema(
      schema({
        type: 'object',
        properties: { a: { type: 'string' }, b: { type: 'array', items: { type: 'integer' } } },
      })
    )

    expect(findUnsupportedStrictKeywords(strict)).toEqual([])
  })

  it('reports open additionalProperties and bounds anywhere in the schema, sorted and deduplicated', () => {
    const keywords = findUnsupportedStrictKeywords(
      schema({
        type: 'object',
        properties: {
          headers: { type: 'object', additionalProperties: { type: 'string', maxLength: 10 } },
          count: { type: 'integer', minimum: 0, maximum: 5 },
          timeout: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 60 },
          tags: { type: 'array', items: { type: 'string', minLength: 1 } },
        },
        $defs: { Step: { type: 'number', multipleOf: 2, minimum: 1 } },
        additionalProperties: false,
      })
    )

    expect(keywords).toEqual([
      'additionalProperties',
      'exclusiveMaximum',
      'exclusiveMinimum',
      'maxLength',
      'maximum',
      'minLength',
      'minimum',
      'multipleOf',
    ])
  })

  it('does not treat property names as keywords', () => {
    const keywords = findUnsupportedStrictKeywords(
      schema({ type: 'object', properties: { minimum: { type: 'number' } }, additionalProperties: false })
    )

    expect(keywords).toEqual([])
  })
})
