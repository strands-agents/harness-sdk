/**
 * Structured output enforcement for model providers: mechanism order, learned support, and native output schemas.
 *
 * What a model rejects is learned from its errors and kept for the life of the process, without eviction: support is
 * a property of the model, and a stale entry costs at most a weaker mechanism.
 */

import type { z } from 'zod'
import type { JSONSchema, JSONValue } from '../types/json.js'
import type { ToolChoice } from '../tools/types.js'
import type { ModelInfo } from './model-info.js'
import { zodSchemaToJsonSchema } from '../tools/zod-utils.js'
import { logger } from '../logging/logger.js'
import { warnOnce } from '../logging/warn-once.js'
import { childSchemas, isRecord, type SchemaNode } from './strict-schema.js'

/**
 * Ways a provider can enforce a structured output request, strongest first.
 *
 * @internal
 */
export type StructuredOutputMechanism = 'forced' | 'native' | 'auto'

const STRUCTURED_OUTPUT_MECHANISMS: readonly StructuredOutputMechanism[] = ['forced', 'native', 'auto']

// Mechanisms each model was learned to reject, keyed by provider and model ID, so later requests skip them.
const UNSUPPORTED_MECHANISMS = new Map<string, Set<StructuredOutputMechanism>>()

// Output schemas a model's native output rejected, keyed by provider and model ID.
const REJECTED_NATIVE_SCHEMAS = new Map<string, WeakSet<z.ZodType>>()

// String formats native structured output accepts; others are moved into the field description.
const SUPPORTED_STRING_FORMATS = new Set([
  'date-time',
  'time',
  'date',
  'duration',
  'email',
  'hostname',
  'uri',
  'ipv4',
  'ipv6',
  'uuid',
])

// A schema node needs one of these to be representable; without them it accepts any value.
const SCHEMA_TYPE_KEYS = ['type', 'anyOf', 'oneOf', 'allOf', '$ref']

// Providers report these cases only as a generic 400, so the message text is the only signal. "Documented" entries
// are published provider error text; "observed" entries were seen in live responses and may change wording.

/**
 * Error substrings meaning the model cannot be forced to call a tool.
 *
 * @internal
 */
export const FORCED_TOOL_CHOICE_UNSUPPORTED_MESSAGES = [
  'tool_choice: type "tool" and "any" are not supported', // documented: Anthropic API errors, forced tool use
  "doesn't support the toolConfig.toolChoice", // observed: Bedrock models without tool choice support
]

/**
 * Error substrings meaning the model has no native structured output.
 *
 * @internal
 */
export const NATIVE_OUTPUT_UNSUPPORTED_MESSAGES = [
  "doesn't support the outputConfig field", // observed: Bedrock models without structured output
  'output_config.format: Extra inputs are not permitted', // observed: Claude models without structured output
]

/**
 * Error substrings meaning native structured output cannot express the schema or request.
 *
 * @internal
 */
export const NATIVE_OUTPUT_REJECTED_MESSAGES = [
  'output_config.format.schema', // observed: unsupported JSON Schema keyword
  'Schemas contains too many', // observed: optional or union parameter limit
  'Schema is too complex', // documented: Anthropic structured outputs, schema complexity limits
  'Citations cannot be enabled when output format is set', // observed: citations with native output
]

/**
 * Lists the mechanisms to try for a structured output request, strongest first, skipping those the model was learned
 * to reject.
 *
 * Native output is skipped for schemas it cannot represent, such as record and tuple fields, so those schemas fall
 * back to auto: structured output is then best effort rather than guaranteed.
 *
 * @param provider - The provider sending the request
 * @param modelId - The model the request is sent to
 * @param toolChoice - The requested tool choice; forcing is only tried when it forces a tool
 * @param schema - The schema the response must produce
 * @param modelInfo - What the SDK knows about the model; a known-unsupported mechanism is skipped without a request
 * @returns The mechanisms to try in order; never empty, since auto is always available
 *
 * @internal
 */
export function structuredOutputMechanisms(
  provider: string,
  modelId: string,
  toolChoice: ToolChoice | undefined,
  schema: z.ZodType,
  modelInfo: ModelInfo = {}
): StructuredOutputMechanism[] {
  const unsupported = new Set(unsupportedMechanisms(provider, modelId, schema))
  if (modelInfo.capabilities?.forcedToolChoice === false) unsupported.add('forced')
  if (modelInfo.capabilities?.nativeStructuredOutput === false) unsupported.add('native')
  const forcesTool = toolChoice !== undefined && ('any' in toolChoice || 'tool' in toolChoice)
  const feature = unsupported.has('native')
    ? undefined
    : findUnsupportedNativeOutputFeature(zodSchemaToJsonSchema(schema))
  if (feature) {
    warnOnce(
      logger,
      `feature=<${feature}> | native structured output cannot represent the schema, if the model cannot be forced to call the structured output tool structured output falls back to auto tool choice`
    )
  }
  return STRUCTURED_OUTPUT_MECHANISMS.filter(
    (mechanism) =>
      !unsupported.has(mechanism) && (mechanism !== 'forced' || forcesTool) && (mechanism !== 'native' || !feature)
  )
}

/**
 * Handles a provider error for a structured output request.
 *
 * A rejection the model gives for every request is remembered per model; native output rejecting this schema or
 * request is remembered for that schema only, and falls back to auto.
 *
 * @param provider - The provider that sent the request
 * @param modelId - The model the request was sent to
 * @param mechanism - The mechanism the rejected request used
 * @param schema - The schema the request had to produce
 * @param message - The provider's error message
 * @returns True if the rejection was recorded and the next mechanism should be tried; false if the error is unrelated
 * and should surface unchanged
 *
 * @internal
 */
export function handleRejectedMechanism(
  provider: string,
  modelId: string,
  mechanism: StructuredOutputMechanism,
  schema: z.ZodType,
  message: string
): boolean {
  const key = modelKey(provider, modelId)
  if (mechanism === 'native' && NATIVE_OUTPUT_REJECTED_MESSAGES.some((signal) => message.includes(signal))) {
    const rejected = REJECTED_NATIVE_SCHEMAS.get(key) ?? new WeakSet()
    REJECTED_NATIVE_SCHEMAS.set(key, rejected.add(schema))
    logger.warn(
      `provider=<${provider}>, model_id=<${modelId}>, error=<${message}> | native structured output rejected the schema, using auto tool choice instead`
    )
    return true
  }
  if (!isUnsupportedMechanismMessage(message, mechanism)) {
    return false
  }
  const unsupported = UNSUPPORTED_MECHANISMS.get(key) ?? new Set()
  UNSUPPORTED_MECHANISMS.set(key, unsupported.add(mechanism))
  logger.debug(
    `provider=<${provider}>, model_id=<${modelId}>, mechanism=<${mechanism}> | model rejects structured output mechanism`
  )
  return true
}

/**
 * Clears the structured output support learned from model errors.
 *
 * @internal
 */
export function clearStructuredOutputSupport(): void {
  UNSUPPORTED_MECHANISMS.clear()
  REJECTED_NATIVE_SCHEMAS.clear()
}

/**
 * Finds a schema feature that native structured output cannot represent without losing data.
 *
 * Native output requires `additionalProperties: false` on every object, has no tuple support, and needs a type on
 * every node, so record and tuple fields would be emptied or left unconstrained, and untyped fields such as
 * `z.any()` cannot be converted. Such schemas must not use native output.
 *
 * @param schema - A JSON schema, for example from `z.toJSONSchema()`
 * @returns A description of the first unsupported feature found, or undefined if the schema can be represented
 *
 * @internal
 */
export function findUnsupportedNativeOutputFeature(schema: JSONSchema): string | undefined {
  return findUnsupportedFeature(schema as SchemaNode)
}

/**
 * Converts a JSON schema to the subset native structured output accepts.
 *
 * Mirrors the Anthropic SDK's `transformJSONSchema`, for every provider: objects get `additionalProperties: false`,
 * and keywords outside the supported subset are moved into the field description, where the model can still follow
 * them. Validate the result against the original schema, which still enforces every constraint.
 *
 * @param schema - A JSON schema, for example from `z.toJSONSchema()`
 * @returns The converted schema
 * @throws Error if a schema node has no `type`, `anyOf`, `oneOf`, `allOf` or `$ref`
 *
 * @internal
 */
export function toNativeOutputSchema(schema: JSONSchema): JSONSchema {
  return convertNode(schema as SchemaNode) as JSONSchema
}

function unsupportedMechanisms(
  provider: string,
  modelId: string,
  schema: z.ZodType
): ReadonlySet<StructuredOutputMechanism> {
  const key = modelKey(provider, modelId)
  const unsupported = UNSUPPORTED_MECHANISMS.get(key) ?? new Set()
  if (REJECTED_NATIVE_SCHEMAS.get(key)?.has(schema)) {
    return new Set([...unsupported, 'native'])
  }
  return unsupported
}

function modelKey(provider: string, modelId: string): string {
  return `${provider}:${modelId}`
}

function isUnsupportedMechanismMessage(message: string, mechanism: StructuredOutputMechanism): boolean {
  if (mechanism === 'forced') {
    return FORCED_TOOL_CHOICE_UNSUPPORTED_MESSAGES.some((signal) => message.includes(signal))
  }
  if (mechanism === 'native') {
    return NATIVE_OUTPUT_UNSUPPORTED_MESSAGES.some((signal) => message.includes(signal))
  }
  return false
}

function findUnsupportedFeature(schema: SchemaNode): string | undefined {
  if ('prefixItems' in schema) return 'tuple fields'
  const additionalProperties = schema['additionalProperties']
  if ((additionalProperties !== undefined && additionalProperties !== false) || 'patternProperties' in schema) {
    return 'record fields'
  }
  if (!SCHEMA_TYPE_KEYS.some((key) => key in schema)) return 'untyped fields'

  for (const child of childSchemas(schema)) {
    const feature = findUnsupportedFeature(child)
    if (feature) return feature
  }
  return undefined
}

function convertNode(schema: SchemaNode): SchemaNode {
  const remaining = { ...schema }
  const converted: SchemaNode = {}

  const defs = take(remaining, '$defs')
  if (isRecord(defs)) {
    converted['$defs'] = Object.fromEntries(
      Object.entries(defs).map(([name, definition]) => [name, convertNode(definition as SchemaNode)])
    )
  }

  const ref = take(remaining, '$ref')
  if (ref !== undefined) {
    converted['$ref'] = ref
    return converted
  }

  const type = take(remaining, 'type')
  convertComposition(remaining, converted, type)

  for (const key of ['enum', 'description', 'title']) {
    const value = take(remaining, key)
    if (value !== undefined) converted[key] = value
  }

  if (type === 'object') convertObject(remaining, converted)
  else if (type === 'string') convertString(remaining, converted)
  else if (type === 'array') convertArray(remaining, converted)

  const leftover = Object.entries(remaining)
  if (leftover.length > 0) {
    const unsupported = `{${leftover.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(', ')}}`
    const description = converted['description']
    converted['description'] = description !== undefined ? `${description}\n\n${unsupported}` : unsupported
  }

  return converted
}

function convertComposition(remaining: SchemaNode, converted: SchemaNode, type: JSONValue | undefined): void {
  const anyOf = take(remaining, 'anyOf')
  const oneOf = take(remaining, 'oneOf')
  const allOf = take(remaining, 'allOf')

  if (Array.isArray(anyOf)) converted['anyOf'] = anyOf.map((variant) => convertNode(variant as SchemaNode))
  else if (Array.isArray(oneOf)) converted['anyOf'] = oneOf.map((variant) => convertNode(variant as SchemaNode))
  else if (Array.isArray(allOf)) converted['allOf'] = allOf.map((variant) => convertNode(variant as SchemaNode))
  else if (type === undefined) throw new Error("Schema must have a 'type', 'anyOf', 'oneOf', or 'allOf' field.")
  else converted['type'] = type
}

function convertObject(remaining: SchemaNode, converted: SchemaNode): void {
  const properties = take(remaining, 'properties')
  converted['properties'] = Object.fromEntries(
    Object.entries(isRecord(properties) ? properties : {}).map(([name, property]) => [
      name,
      convertNode(property as SchemaNode),
    ])
  )
  take(remaining, 'additionalProperties')
  converted['additionalProperties'] = false
  const required = take(remaining, 'required')
  if (required !== undefined) converted['required'] = required
}

function convertString(remaining: SchemaNode, converted: SchemaNode): void {
  const format = take(remaining, 'format')
  if (typeof format === 'string' && SUPPORTED_STRING_FORMATS.has(format)) converted['format'] = format
  else if (format !== undefined) remaining['format'] = format
}

function convertArray(remaining: SchemaNode, converted: SchemaNode): void {
  const items = take(remaining, 'items')
  if (isRecord(items)) converted['items'] = convertNode(items)
  else if (items !== undefined) remaining['items'] = items
  const minItems = take(remaining, 'minItems')
  if (minItems === 0 || minItems === 1) converted['minItems'] = minItems
  else if (minItems !== undefined) remaining['minItems'] = minItems
}

/** Removes a key from a schema node and returns its value. */
function take(schema: SchemaNode, key: string): JSONValue | undefined {
  const value = schema[key]
  delete schema[key]
  return value
}
