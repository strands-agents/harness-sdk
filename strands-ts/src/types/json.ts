import type { JSONSchema7 } from 'json-schema'
/**
 * Interface for objects that can be serialized to JSON via `toJSON()`.
 *
 * @typeParam T - The type returned by `toJSON()`.
 */
export interface JSONSerializable<T = unknown> {
  toJSON(): T
}

import { JsonValidationError } from '../errors.js'

/**
 * Represents any valid JSON value.
 * This type ensures type safety for JSON-serializable data.
 *
 * @example
 * ```typescript
 * const value: JSONValue = { key: 'value', nested: { arr: [1, 2, 3] } }
 * const text: JSONValue = 'hello'
 * const num: JSONValue = 42
 * const bool: JSONValue = true
 * const nothing: JSONValue = null
 * ```
 */
export type JSONValue = string | number | boolean | null | { [key: string]: JSONValue } | JSONValue[]

/**
 * Represents a JSON Schema definition.
 * Used for defining the structure of tool inputs and outputs.
 *
 * This is based on JSON Schema Draft 7 specification.
 *
 * @example
 * ```typescript
 * const schema: JSONSchema = {
 *   type: 'object',
 *   properties: {
 *     name: { type: 'string' },
 *     age: { type: 'number' }
 *   },
 *   required: ['name']
 * }
 * ```
 */
export type JSONSchema = JSONSchema7

/**
 * Creates a deep copy of a value using JSON serialization.
 *
 * @param value - The value to copy
 * @returns A deep copy of the value
 * @throws Error if the value cannot be JSON serialized
 */
export function deepCopy(value: unknown): JSONValue {
  try {
    return JSON.parse(JSON.stringify(value)) as JSONValue
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    throw new Error(`Unable to serialize tool result: ${errorMessage}`, { cause: error })
  }
}

/**
 * Creates a deep copy of a value with explicit validation for non-serializable types.
 * Uses JSON.stringify's replacer to detect and report non-serializable values with path information.
 *
 * @param value - The value to copy
 * @param contextPath - Context path for error messages (e.g., 'initialState', 'value for key "config"')
 * @returns A deep copy of the value
 * @throws JsonValidationError if value contains functions, symbols, or undefined values
 */
export function deepCopyWithValidation(value: unknown, contextPath: string = 'value'): JSONValue {
  const pathStack: { obj: object; path: string }[] = []

  const replacer = function (this: object, key: string, val: unknown): unknown {
    // `this` is the object currently being serialized, so any frame above it belongs to a finished subtree
    while (pathStack.length > 0 && pathStack[pathStack.length - 1]?.obj !== this) {
      pathStack.pop()
    }
    const parentFrame = pathStack[pathStack.length - 1]

    // Build current path
    let currentPath = contextPath
    if (key !== '') {
      // Check if parent is array (numeric key pattern)
      const isArrayIndex = /^\d+$/.test(key)
      if (isArrayIndex) {
        currentPath = parentFrame ? `${parentFrame.path}[${key}]` : `${contextPath}[${key}]`
      } else {
        currentPath = parentFrame ? `${parentFrame.path}.${key}` : `${contextPath}.${key}`
      }
    }

    // Check for non-serializable types
    if (typeof val === 'function') {
      throw new JsonValidationError(`${currentPath} contains a function which cannot be serialized`)
    }

    if (typeof val === 'symbol') {
      throw new JsonValidationError(`${currentPath} contains a symbol which cannot be serialized`)
    }

    if (val === undefined) {
      throw new JsonValidationError(`${currentPath} is undefined which cannot be serialized`)
    }

    // Track path for nested objects/arrays
    if (val !== null && typeof val === 'object') {
      pathStack.push({ obj: val, path: currentPath })
    }

    return val
  }

  try {
    const serialized = JSON.stringify(value, replacer)
    return JSON.parse(serialized) as JSONValue
  } catch (error) {
    // If it's our validation error, re-throw it
    if (error instanceof JsonValidationError) {
      throw error
    }
    // Otherwise, wrap it
    const errorMessage = error instanceof Error ? error.message : String(error)
    throw new Error(`Unable to serialize value: ${errorMessage}`, { cause: error })
  }
}

/**
 * Removes undefined values from an object.
 * Useful for JSON serialization to avoid including undefined fields in output.
 *
 * @param obj - Object with potentially undefined values
 * @returns New object with undefined values removed
 *
 * @example
 * ```typescript
 * const data = { name: 'test', value: undefined, count: 0 }
 * const clean = omitUndefined(data)
 * // Result: { name: 'test', count: 0 }
 * ```
 */
export function omitUndefined<T extends object>(obj: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  const result = {} as { [K in keyof T]: Exclude<T[K], undefined> }
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      ;(result as Record<string, unknown>)[key] = value
    }
  }
  return result
}
/**
 * Recursively transforms a type by converting all Uint8Array properties to strings.
 * Used for JSON serialization where binary data is encoded as base64 strings.
 *
 * @example
 * ```typescript
 * interface Data {
 *   name: string
 *   bytes: Uint8Array
 *   nested: { content: Uint8Array }
 * }
 *
 * type SerializedData = Serialized<Data>
 * // Result: { name: string; bytes: string; nested: { content: string } }
 * ```
 */
export type Serialized<T> = T extends Uint8Array
  ? string
  : T extends (infer U)[]
    ? Serialized<U>[]
    : T extends object
      ? { [K in keyof T]: Serialized<T[K]> }
      : T

/**
 * Represents data that may contain either Uint8Array (runtime) or string (serialized) for binary fields.
 * Used for deserialization where input may come from JSON (strings) or direct construction (Uint8Array).
 *
 * @example
 * ```typescript
 * interface Data {
 *   bytes: Uint8Array
 * }
 *
 * type InputData = MaybeSerializedInput<Data>
 * // Result: { bytes: Uint8Array | string }
 * ```
 */
export type MaybeSerializedInput<T> = T extends Uint8Array
  ? Uint8Array | string
  : T extends (infer U)[]
    ? MaybeSerializedInput<U>[]
    : T extends object
      ? { [K in keyof T]: MaybeSerializedInput<T[K]> }
      : T
