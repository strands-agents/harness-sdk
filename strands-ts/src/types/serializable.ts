/**
 * Serialization interfaces for state persistence.
 *
 * This module provides interfaces for objects that can serialize and deserialize
 * their state, enabling persistence and restoration of runtime state.
 *
 * StateSerializable uses symbol-keyed methods to keep the serialization API internal,
 * preventing accidental usage by customers (e.g., accessing agent.appState.toJSON() directly).
 */

import type { JSONValue } from './json.js'

/**
 * Symbol for the serialization method on StateSerializable objects.
 */
export const stateToJSONSymbol = Symbol('StateSerializable.toJSON')

/**
 * Symbol for the deserialization method on StateSerializable objects.
 */
export const loadStateFromJSONSymbol = Symbol('StateSerializable.loadStateFromJSON')

/**
 * Interface for mutable state containers that can serialize and restore their state.
 * Uses symbol-keyed methods to keep the API internal.
 *
 * Use JSONSerializable for immutable value objects (with static fromJSON).
 * Use StateSerializable for mutable state that loads into an existing instance.
 */
export interface StateSerializable {
  /**
   * Serializes the state to a JSON value.
   *
   * @returns The serialized state
   */
  [stateToJSONSymbol](): JSONValue

  /**
   * Loads state from a previously serialized JSON value.
   *
   * @param json - The serialized state to load
   */
  [loadStateFromJSONSymbol](json: JSONValue): void
}

/**
 * Type guard to check if an object implements StateSerializable.
 *
 * @param obj - The object to check
 * @returns True if the object implements StateSerializable
 */
export function isStateSerializable(obj: unknown): obj is StateSerializable {
  return (
    obj !== null &&
    typeof obj === 'object' &&
    typeof (obj as StateSerializable)[stateToJSONSymbol] === 'function' &&
    typeof (obj as StateSerializable)[loadStateFromJSONSymbol] === 'function'
  )
}

/**
 * Serializes a StateSerializable object to JSON.
 *
 * @param obj - The StateSerializable object to serialize
 * @returns The serialized JSON value
 */
export function serializeStateSerializable(obj: StateSerializable): JSONValue {
  return obj[stateToJSONSymbol]()
}

/**
 * Loads state from JSON into a StateSerializable object.
 *
 * @param obj - The StateSerializable object to load state into
 * @param json - The JSON value to load
 */
export function loadStateSerializable(obj: StateSerializable, json: JSONValue): void {
  obj[loadStateFromJSONSymbol](json)
}
