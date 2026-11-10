import { z } from 'zod'
import type { JSONSchema } from '../types/json.js'

/**
 * Converts a Zod schema to JSON Schema format.
 * Strips the $schema property to reduce token usage.
 *
 * @param schema - The Zod schema to convert
 * @returns JSON Schema representation
 */
export function zodSchemaToJsonSchema(schema: z.ZodSchema): JSONSchema {
  const result = z.toJSONSchema(schema) as JSONSchema & { $schema?: string }
  const { $schema: _$schema, ...jsonSchema } = result
  return jsonSchema as JSONSchema
}
