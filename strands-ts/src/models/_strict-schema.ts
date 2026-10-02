/**
 * Strict JSON schema transformation for tool definitions.
 *
 * Strict tool use requires `additionalProperties: false` on every object type. This applies
 * that recursively. Modeled after OpenAI's `_ensure_strict_json_schema`.
 */

import type { JSONSchema, JSONValue } from '../types/json.js'
import { logger } from '../logging/logger.js'

type SchemaNode = Record<string, JSONValue>

function isRecord(value: JSONValue | undefined): value is SchemaNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Return a deep copy of `schema` with strict-mode constraints applied recursively:
 * `additionalProperties: false` on object types, and (only if `requireAllProperties`, which
 * OpenAI needs but Bedrock/Anthropic do not) all properties marked required. The original is
 * not mutated.
 */
export function ensureStrictJsonSchema(schema: JSONSchema, requireAllProperties = false): JSONSchema {
  const schemaCopy = JSON.parse(JSON.stringify(schema)) as SchemaNode
  applyStrict(schemaCopy, schemaCopy, requireAllProperties)
  return schemaCopy as JSONSchema
}

/** Apply strict-mode constraints to `schema` in place. `root` resolves `$ref` pointers. */
function applyStrict(schema: SchemaNode, root: SchemaNode, requireAllProperties: boolean): void {
  for (const defsKey of ['$defs', 'definitions']) {
    const defs = schema[defsKey]
    if (isRecord(defs)) {
      for (const defSchema of Object.values(defs)) {
        if (isRecord(defSchema)) {
          applyStrict(defSchema, root, requireAllProperties)
        }
      }
    }
  }

  if (schema['type'] === 'object' && !('additionalProperties' in schema)) {
    schema['additionalProperties'] = false
  }

  const properties = schema['properties']
  if (isRecord(properties)) {
    if (requireAllProperties) {
      schema['required'] = Object.keys(properties)
    }
    for (const propSchema of Object.values(properties)) {
      if (isRecord(propSchema)) {
        applyStrict(propSchema, root, requireAllProperties)
      }
    }
  }

  const items = schema['items']
  if (isRecord(items)) {
    applyStrict(items, root, requireAllProperties)
  }

  for (const combinatorKey of ['anyOf', 'allOf', 'oneOf']) {
    const variants = schema[combinatorKey]
    if (Array.isArray(variants)) {
      for (const variant of variants) {
        if (isRecord(variant)) {
          applyStrict(variant, root, requireAllProperties)
        }
      }
    }
  }

  // A $ref alongside sibling keys must be inlined; existing keys win over the resolved schema.
  const ref = schema['$ref']
  if (typeof ref === 'string' && Object.keys(schema).length > 1) {
    const resolved = resolveRef(root, ref)
    if (isRecord(resolved)) {
      const merged: SchemaNode = { ...(JSON.parse(JSON.stringify(resolved)) as SchemaNode), ...schema }
      delete merged['$ref']
      for (const key of Object.keys(schema)) {
        delete schema[key]
      }
      Object.assign(schema, merged)
      applyStrict(schema, root, requireAllProperties)
    }
  }
}

/** Resolve a `#/`-rooted `$ref` against `root`, or null if it does not resolve to an object. */
function resolveRef(root: SchemaNode, ref: string): SchemaNode | null {
  if (!ref.startsWith('#/')) {
    logger.warn(`ref=<${ref}> | unexpected $ref format, skipping resolution`)
    return null
  }

  const path = ref.slice(2).split('/')
  let current: JSONValue = root
  for (const key of path) {
    if (!isRecord(current) || !(key in current)) {
      logger.warn(`ref=<${ref}> | failed to resolve $ref path`)
      return null
    }
    const resolvedValue: JSONValue | undefined = current[key]
    if (resolvedValue === undefined) {
      logger.warn(`ref=<${ref}> | failed to resolve $ref path`)
      return null
    }
    current = resolvedValue
  }

  if (!isRecord(current)) {
    logger.warn(`ref=<${ref}> | resolved to non-dict value`)
    return null
  }

  return current
}
