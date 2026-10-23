import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { transformJSONSchema } from '@anthropic-ai/sdk/lib/transform-json-schema'
import {
  FORCED_TOOL_CHOICE_UNSUPPORTED_MESSAGES,
  NATIVE_OUTPUT_REJECTED_MESSAGES,
  NATIVE_OUTPUT_UNSUPPORTED_MESSAGES,
  clearStructuredOutputSupport,
  findUnsupportedNativeOutputFeature,
  handleRejectedMechanism,
  structuredOutputMechanisms,
  toNativeOutputSchema,
  type StructuredOutputMechanism,
} from '../native-output.js'
import { zodSchemaToJsonSchema } from '../../tools/zod-utils.js'
import { logger } from '../../logging/logger.js'
import type { ToolChoice } from '../../tools/types.js'
import { deepCopy, type JSONSchema } from '../../types/json.js'

const Person = z.object({ name: z.string(), age: z.number().int() })
const Roster = z
  .object({
    members: z.array(Person).min(2),
    lead: Person.nullable().optional(),
    code: z
      .string()
      .regex(/^[A-Z]+$/)
      .describe('Team code'),
    founded: z.iso.date(),
    score: z.number().min(0),
  })
  .describe('A team of people')
const Team = Roster.extend({ color: z.enum(['red', 'blue']), kind: z.literal(['a', 'b']) })
const WithRecord = z.object({ scores: z.record(z.string(), z.number()) })
const WithNestedRecord = z.object({ team: Roster, extra: z.array(WithRecord) })
const WithTuple = z.object({ point: z.tuple([z.number(), z.number()]) })
const WithAny = z.object({ value: z.any() })
const WithMixedLiteral = z.object({ value: z.literal(['a', 1]) })
const WithCatchall = z.object({ name: z.string() }).catchall(z.string())

const FORCED: ToolChoice = { tool: { name: 'strands_structured_output' } }

describe('native-output', () => {
  beforeEach(() => {
    clearStructuredOutputSupport()
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('structuredOutputMechanisms', () => {
    it.each<{ name: string; toolChoice: ToolChoice | undefined; expected: StructuredOutputMechanism[] }>([
      { name: 'a forced tool', toolChoice: FORCED, expected: ['forced', 'native', 'auto'] },
      { name: 'any tool', toolChoice: { any: {} }, expected: ['forced', 'native', 'auto'] },
      { name: 'auto tool choice', toolChoice: { auto: {} }, expected: ['native', 'auto'] },
      { name: 'no tool choice', toolChoice: undefined, expected: ['native', 'auto'] },
    ])('lists the mechanisms strongest first for $name', ({ toolChoice, expected }) => {
      expect(structuredOutputMechanisms('p', 'm', toolChoice, Person)).toStrictEqual(expected)
    })

    it('skips mechanisms the model info says are unsupported, without a request', () => {
      expect(
        structuredOutputMechanisms('p', 'm', FORCED, Person, { capabilities: { forcedToolChoice: false } })
      ).toStrictEqual(['native', 'auto'])
      expect(
        structuredOutputMechanisms('p', 'm', FORCED, Person, {
          capabilities: { nativeStructuredOutput: false },
        })
      ).toStrictEqual(['forced', 'auto'])
      expect(
        structuredOutputMechanisms('p', 'm', FORCED, Person, {
          capabilities: { forcedToolChoice: true, nativeStructuredOutput: true },
        })
      ).toStrictEqual(['forced', 'native', 'auto'])
    })

    it('skips mechanisms the model was learned to reject', () => {
      handleRejectedMechanism('p', 'm', 'forced', Person, FORCED_TOOL_CHOICE_UNSUPPORTED_MESSAGES[0]!)
      expect(structuredOutputMechanisms('p', 'm', FORCED, Person)).toStrictEqual(['native', 'auto'])

      handleRejectedMechanism('p', 'm', 'native', Person, NATIVE_OUTPUT_UNSUPPORTED_MESSAGES[0]!)
      expect(structuredOutputMechanisms('p', 'm', FORCED, Person)).toStrictEqual(['auto'])
    })

    it('skips native output and warns for a schema it cannot represent', () => {
      expect(structuredOutputMechanisms('p', 'm', FORCED, WithRecord)).toStrictEqual(['forced', 'auto'])
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('feature=<record fields>'))
    })

    it('does not inspect the schema when native output is known unsupported', () => {
      handleRejectedMechanism('p', 'm', 'native', WithTuple, NATIVE_OUTPUT_UNSUPPORTED_MESSAGES[0]!)

      expect(structuredOutputMechanisms('p', 'm', FORCED, WithTuple)).toStrictEqual(['forced', 'auto'])
      expect(logger.warn).not.toHaveBeenCalled()
    })
  })

  describe('handleRejectedMechanism', () => {
    it.each([
      ...FORCED_TOOL_CHOICE_UNSUPPORTED_MESSAGES.map((signal) => ({ mechanism: 'forced' as const, signal })),
      ...NATIVE_OUTPUT_UNSUPPORTED_MESSAGES.map((signal) => ({ mechanism: 'native' as const, signal })),
    ])('remembers that the model rejects $mechanism for every schema: $signal', ({ mechanism, signal }) => {
      expect(handleRejectedMechanism('p', 'm', mechanism, Person, `ValidationException: ${signal}.`)).toBe(true)

      expect(structuredOutputMechanisms('p', 'm', FORCED, Team)).not.toContain(mechanism)
      expect(structuredOutputMechanisms('p', 'other-model', FORCED, Person)).toContain(mechanism)
      expect(structuredOutputMechanisms('other-provider', 'm', FORCED, Person)).toContain(mechanism)
    })

    it.each(NATIVE_OUTPUT_REJECTED_MESSAGES)(
      'remembers a rejected native schema for that schema only: %s',
      (signal) => {
        expect(handleRejectedMechanism('p', 'm', 'native', Person, `invalid_request_error: ${signal}`)).toBe(true)

        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining('native structured output rejected the schema')
        )
        expect(structuredOutputMechanisms('p', 'm', FORCED, Person)).toStrictEqual(['forced', 'auto'])
        expect(structuredOutputMechanisms('p', 'm', FORCED, Team)).toStrictEqual(['forced', 'native', 'auto'])
      }
    )

    it.each<{ mechanism: StructuredOutputMechanism; message: string }>([
      { mechanism: 'forced', message: 'Input is too long for requested model' },
      { mechanism: 'forced', message: NATIVE_OUTPUT_REJECTED_MESSAGES[0]! },
      { mechanism: 'native', message: FORCED_TOOL_CHOICE_UNSUPPORTED_MESSAGES[0]! },
      { mechanism: 'auto', message: FORCED_TOOL_CHOICE_UNSUPPORTED_MESSAGES[0]! },
    ])('ignores an unrelated $mechanism error: $message', ({ mechanism, message }) => {
      expect(handleRejectedMechanism('p', 'm', mechanism, Person, message)).toBe(false)

      expect(structuredOutputMechanisms('p', 'm', FORCED, Person)).toStrictEqual(['forced', 'native', 'auto'])
    })
  })

  describe('findUnsupportedNativeOutputFeature', () => {
    it.each<{ name: string; schema: JSONSchema; expected: string | undefined }>([
      { name: 'a flat object', schema: zodSchemaToJsonSchema(Person), expected: undefined },
      { name: 'nested objects, unions, enums and formats', schema: zodSchemaToJsonSchema(Team), expected: undefined },
      { name: 'a record', schema: zodSchemaToJsonSchema(WithRecord), expected: 'record fields' },
      { name: 'a nested record', schema: zodSchemaToJsonSchema(WithNestedRecord), expected: 'record fields' },
      { name: 'a catchall', schema: zodSchemaToJsonSchema(WithCatchall), expected: 'record fields' },
      {
        name: 'pattern properties',
        schema: { type: 'object', patternProperties: { '^a': { type: 'string' } } },
        expected: 'record fields',
      },
      { name: 'a tuple', schema: zodSchemaToJsonSchema(WithTuple), expected: 'tuple fields' },
      { name: 'an untyped field', schema: zodSchemaToJsonSchema(WithAny), expected: 'untyped fields' },
      { name: 'a mixed literal', schema: zodSchemaToJsonSchema(WithMixedLiteral), expected: 'untyped fields' },
    ])('returns $expected for $name', ({ schema, expected }) => {
      expect(findUnsupportedNativeOutputFeature(schema)).toBe(expected)
    })
  })

  describe('toNativeOutputSchema', () => {
    it.each([
      { name: 'a flat object', schema: Person },
      { name: 'nested objects, unions and formats', schema: Roster },
      { name: 'a nested record', schema: WithNestedRecord },
    ])('matches the Anthropic SDK transform for $name', ({ schema }) => {
      const jsonSchema = zodSchemaToJsonSchema(schema)

      expect(toNativeOutputSchema(jsonSchema)).toStrictEqual(transformJSONSchema(jsonSchema))
    })

    it('keeps enums, which native output supports', () => {
      const schema = zodSchemaToJsonSchema(z.object({ color: z.enum(['red', 'blue']) }))

      expect(toNativeOutputSchema(schema)).toStrictEqual({
        type: 'object',
        properties: { color: { type: 'string', enum: ['red', 'blue'] } },
        additionalProperties: false,
        required: ['color'],
      })
    })

    it('keeps $defs alongside a $ref and moves unsupported array keywords into the description', () => {
      const schema = {
        $defs: { Item: { type: 'array', items: false, minItems: 3 } },
        $ref: '#/$defs/Item',
      } as unknown as JSONSchema

      expect(toNativeOutputSchema(schema)).toStrictEqual({
        $defs: { Item: { type: 'array', description: '{items: false, minItems: 3}' } },
        $ref: '#/$defs/Item',
      })
    })

    it('converts oneOf to anyOf, keeps allOf, and moves unsupported formats and item bounds into the description', () => {
      const schema = {
        type: 'object',
        properties: {
          choice: { oneOf: [{ type: 'string', format: 'phone' }, { type: 'integer' }] },
          merged: { allOf: [{ type: 'object', properties: { a: { type: 'string' } } }] },
          tags: { type: 'array', items: { type: 'string' }, minItems: 1 },
        },
      } as unknown as JSONSchema

      expect(toNativeOutputSchema(schema)).toStrictEqual({
        type: 'object',
        properties: {
          choice: { anyOf: [{ type: 'string', description: '{format: "phone"}' }, { type: 'integer' }] },
          merged: {
            allOf: [{ type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false }],
          },
          tags: { type: 'array', items: { type: 'string' }, minItems: 1 },
        },
        additionalProperties: false,
      })
    })

    it('does not mutate the input schema', () => {
      const schema = zodSchemaToJsonSchema(Team)
      const copy = deepCopy(schema)

      toNativeOutputSchema(schema)

      expect(schema).toStrictEqual(copy)
    })

    it('throws for an untyped node', () => {
      expect(() => toNativeOutputSchema(zodSchemaToJsonSchema(WithAny))).toThrow("Schema must have a 'type'")
    })
  })
})
