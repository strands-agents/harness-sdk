import { deepCopy, deepCopyWithValidation, type JSONValue } from './types/json.js'
import { loadStateFromJSONSymbol, stateToJSONSymbol, type StateSerializable } from './types/serializable.js'

/**
 * Key-value storage for application state outside conversation context.
 * State is not passed to the model during inference but is accessible
 * by tools (via ToolContext) and application logic.
 *
 * All values are deep copied on get/set operations to prevent reference mutations.
 * Values must be JSON serializable.
 *
 * @example
 * ```typescript
 * const state = new StateStore({ userId: 'user-123' })
 * state.set('sessionId', 'session-456')
 * const userId = state.get('userId') // 'user-123'
 * ```
 */
export class StateStore implements StateSerializable {
  private _state: Record<string, JSONValue>

  /**
   * Creates a new StateStore instance.
   *
   * @param initialState - Optional initial state values
   * @throws Error if initialState is not JSON serializable
   */
  constructor(initialState?: Record<string, JSONValue>) {
    if (initialState !== undefined) {
      this._state = deepCopyWithValidation(initialState, 'initialState') as Record<string, JSONValue>
    } else {
      this._state = {}
    }
  }

  /**
   * Get a state value by key with optional type-safe property lookup.
   * Returns a deep copy to prevent mutations.
   *
   * @typeParam TState - The complete state interface type
   * @typeParam K - The property key (inferred from argument)
   * @param key - Key to retrieve specific value
   * @returns The value for the key, or undefined if key doesn't exist
   *
   * @example
   * ```typescript
   * // Typed usage
   * const user = state.get<MyState>('user')      // { name: string; age: number } | undefined
   *
   * // Untyped usage
   * const value = state.get('someKey')            // JSONValue | undefined
   * ```
   */
  get<TState, K extends keyof TState = keyof TState>(key: K): TState[K] | undefined
  get(key: string): JSONValue | undefined
  get(key: string): JSONValue | Record<string, JSONValue> | undefined {
    if (key == null) {
      throw new Error('key is required')
    }

    const value = this._state[key]
    if (value === undefined) {
      return undefined
    }

    // Return deep copy to prevent mutations
    return deepCopy(value)
  }

  /**
   * Set a state value with optional type-safe property validation.
   * Validates JSON serializability and stores a deep copy.
   *
   * @typeParam TState - The complete state interface type
   * @typeParam K - The property key (inferred from argument)
   * @param key - The key to set
   * @param value - The value to store (must be JSON serializable)
   * @throws Error if value is not JSON serializable
   *
   * @example
   * ```typescript
   * // Typed usage
   * state.set<MyState>('user', { name: 'Alice', age: 25 })
   *
   * // Untyped usage
   * state.set('someKey', { any: 'value' })
   * ```
   */
  set<TState, K extends keyof TState = keyof TState>(key: K, value: TState[K]): void
  set(key: string, value: unknown): void
  set(key: string, value: unknown): void {
    this._state[key] = deepCopyWithValidation(value, `value for key "${key}"`)
  }

  /**
   * Delete a state value by key with optional type-safe property validation.
   *
   * @typeParam TState - The complete state interface type
   * @typeParam K - The property key (inferred from argument)
   * @param key - The key to delete
   *
   * @example
   * ```typescript
   * // Typed usage
   * state.delete<MyState>('user')
   *
   * // Untyped usage
   * state.delete('someKey')
   * ```
   */
  delete<TState, K extends keyof TState = keyof TState>(key: K): void
  delete(key: string): void
  delete(key: string): void {
    delete this._state[key]
  }

  /**
   * Clear all state values.
   */
  clear(): void {
    this._state = {}
  }

  /**
   * Get a copy of all state as an object.
   *
   * @returns Deep copy of all state
   */
  getAll(): Record<string, JSONValue> {
    return deepCopy(this._state) as Record<string, JSONValue>
  }

  /**
   * Get all state keys.
   *
   * @returns Array of state keys
   */
  keys(): string[] {
    return Object.keys(this._state)
  }

  /**
   * Returns the serialized state as JSON value.
   *
   * @returns Deep copy of all state
   */
  [stateToJSONSymbol](): JSONValue {
    return deepCopy(this._state) as JSONValue
  }

  /**
   * Loads state from a previously serialized JSON value.
   *
   * @param json - The serialized state to load
   */
  [loadStateFromJSONSymbol](json: JSONValue): void {
    if (json !== null && typeof json === 'object' && !Array.isArray(json)) {
      this._state = deepCopy(json) as Record<string, JSONValue>
    } else {
      this._state = {}
    }
  }
}
