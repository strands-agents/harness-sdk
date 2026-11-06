import type { JSONSchema } from '../types/json.js'
import type { ToolSpec } from './types.js'

const COMPOSITE_SCHEMA_KEYS = ['$ref', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else'] as const

/**
 * Adds an optional property to a tool spec's input schema.
 *
 * @param toolSpec - The spec to extend; not mutated
 * @param name - Property name to add
 * @param property - JSON Schema for the property
 * @returns A copy of `toolSpec` with the property added, or `undefined` when the schema cannot
 *   safely take one (composite or non-object schema, or the property already exists)
 * @internal
 */
export function addInputProperty(toolSpec: ToolSpec, name: string, property: JSONSchema): ToolSpec | undefined {
  const schema = toolSpec.inputSchema ?? {}
  if (
    COMPOSITE_SCHEMA_KEYS.some((key) => schema[key] !== undefined) ||
    (schema.type !== undefined && schema.type !== 'object') ||
    (schema.properties !== undefined && (typeof schema.properties !== 'object' || Array.isArray(schema.properties))) ||
    schema.properties?.[name] !== undefined ||
    schema.required?.includes(name)
  ) {
    return
  }
  return {
    ...toolSpec,
    inputSchema: {
      ...schema,
      type: 'object',
      properties: { ...schema.properties, [name]: property },
    },
  }
}
