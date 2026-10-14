/**
 * Strict JSON schema transformation for tool definitions.
 *
 * Strict tool use requires `additionalProperties: false` on every object type. This applies
 * that recursively. Modeled after OpenAI's `_ensure_strict_json_schema`.
 */

import type { JSONSchema, JSONValue } from '../types/json.js'
import { logger } from '../logging/logger.js'
import { warnOnce } from '../logging/warn-once.js'

type SchemaNode = Record<string, JSONValue>

function isRecord(value: JSONValue | undefined): value is SchemaNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Return a deep copy of `schema` with `additionalProperties: false` applied recursively to
 * object types. The original is not mutated.
 *
 * @internal
 */
export function ensureStrictJsonSchema(schema: JSONSchema): JSONSchema {
  const schemaCopy = JSON.parse(JSON.stringify(schema)) as SchemaNode
  applyStrict(schemaCopy, schemaCopy)
  return schemaCopy as JSONSchema
}

/** Keywords whose value is a map of subschemas. */
const SCHEMA_MAP_KEYWORDS = ['$defs', 'definitions', 'properties']
/** Keywords whose value is a list of subschemas. */
const SCHEMA_LIST_KEYWORDS = ['anyOf', 'allOf', 'oneOf']
/** Keywords whose value is a single subschema. */
const SCHEMA_VALUE_KEYWORDS = ['items', 'additionalProperties']

/** Keywords outside Bedrock's strict-mode subset that the transform does not rewrite. */
const UNSUPPORTED_STRICT_KEYWORDS = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
]

/** Return the direct subschemas of `schema`, including `$defs`/`definitions` entries. */
function childSchemas(schema: SchemaNode): SchemaNode[] {
  const children: (JSONValue | undefined)[] = []
  for (const keyword of SCHEMA_MAP_KEYWORDS) {
    const map = schema[keyword]
    if (isRecord(map)) children.push(...Object.values(map))
  }
  for (const keyword of SCHEMA_LIST_KEYWORDS) {
    const list = schema[keyword]
    if (Array.isArray(list)) children.push(...list)
  }
  for (const keyword of SCHEMA_VALUE_KEYWORDS) {
    children.push(schema[keyword])
  }
  return children.filter(isRecord)
}

function isObjectType(schema: SchemaNode): boolean {
  const type = schema['type']
  return type === 'object' || (Array.isArray(type) && type.includes('object'))
}

/**
 * Apply strict-mode constraints to `schema` in place. `root` resolves `$ref` pointers; `inlining`
 * holds the refs being inlined on the current path so recursive refs terminate.
 */
function applyStrict(schema: SchemaNode, root: SchemaNode, inlining: ReadonlySet<string> = new Set()): void {
  // A node still carrying a $ref is left for the inline below, so the target's own value wins.
  if (isObjectType(schema) && !Object.hasOwn(schema, 'additionalProperties') && !Object.hasOwn(schema, '$ref')) {
    schema['additionalProperties'] = false
  }

  for (const child of childSchemas(schema)) {
    applyStrict(child, root, inlining)
  }

  // A $ref alongside sibling keys must be inlined; existing keys win over the resolved schema.
  const ref = schema['$ref']
  if (typeof ref !== 'string' || Object.keys(schema).length <= 1) {
    return
  }
  if (inlining.has(ref)) {
    warnOnce(logger, `ref=<${ref}> | recursive $ref cannot be inlined, leaving it unresolved`)
    return
  }
  const resolved = resolveRef(root, ref)
  if (!isRecord(resolved)) {
    return
  }
  const merged: SchemaNode = { ...(JSON.parse(JSON.stringify(resolved)) as SchemaNode), ...schema }
  delete merged['$ref']
  for (const key of Object.keys(schema)) {
    delete schema[key]
  }
  // defineProperties keeps a `__proto__` key as an own property instead of invoking the setter.
  Object.defineProperties(schema, Object.getOwnPropertyDescriptors(merged))
  applyStrict(schema, root, new Set(inlining).add(ref))
}

/**
 * Return the keywords in `schema` that Bedrock's strict mode rejects, sorted: any
 * `additionalProperties` other than `false`, and numeric/length bounds.
 *
 * @internal
 */
export function findUnsupportedStrictKeywords(schema: JSONSchema): string[] {
  const found = new Set<string>()
  collectUnsupportedKeywords(schema as SchemaNode, found)
  return [...found].sort()
}

function collectUnsupportedKeywords(schema: SchemaNode, found: Set<string>): void {
  for (const keyword of UNSUPPORTED_STRICT_KEYWORDS) {
    if (Object.hasOwn(schema, keyword)) found.add(keyword)
  }
  if (Object.hasOwn(schema, 'additionalProperties') && schema['additionalProperties'] !== false) {
    found.add('additionalProperties')
  }
  for (const child of childSchemas(schema)) {
    collectUnsupportedKeywords(child, found)
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
    if (!isRecord(current) || !Object.hasOwn(current, key)) {
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
