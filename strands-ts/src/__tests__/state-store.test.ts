import { describe, expect, it } from 'vitest'
import { StateStore } from '../state-store.js'
import {
  isStateSerializable,
  loadStateFromJSONSymbol,
  loadStateSerializable,
  serializeStateSerializable,
  stateToJSONSymbol,
} from '../types/serializable.js'

describe('StateStore', () => {
  describe('constructor', () => {
    it('creates empty state when no initial state provided', () => {
      const state = new StateStore()
      expect(state.keys()).toEqual([])
    })

    it('creates state with initial values', () => {
      const state = new StateStore({ key1: 'value1', key2: 42 })
      expect(state.get('key1')).toBe('value1')
      expect(state.get('key2')).toBe(42)
    })

    it('stores deep copy of initial state', () => {
      const initial = { nested: { value: 'test' } }
      const state = new StateStore(initial)

      // Mutate original
      initial.nested.value = 'changed'

      // State should not be affected
      expect(state.get('nested')).toEqual({ value: 'test' })
    })

    it('throws error for function in initial state', () => {
      const invalidState = { func: () => 'test', value: 'keep' }
      expect(() => new StateStore(invalidState as never)).toThrow(
        'initialState.func contains a function which cannot be serialized'
      )
    })

    it('throws error for symbol in initial state', () => {
      const sym = Symbol('test')
      const invalidState = { sym, value: 'keep' }
      expect(() => new StateStore(invalidState as never)).toThrow(
        'initialState.sym contains a symbol which cannot be serialized'
      )
    })

    it('throws error for undefined in initial state', () => {
      const invalidState = { undef: undefined, value: 'keep' }
      expect(() => new StateStore(invalidState as never)).toThrow(
        'initialState.undef is undefined which cannot be serialized'
      )
    })

    it('throws error for nested function in initial state', () => {
      const invalidState = { nested: { func: () => 'test' } }
      expect(() => new StateStore(invalidState as never)).toThrow(
        'initialState.nested.func contains a function which cannot be serialized'
      )
    })

    it('throws error for function in array in initial state', () => {
      const invalidState = { arr: [1, () => 'test', 3] }
      expect(() => new StateStore(invalidState as never)).toThrow(
        'initialState.arr[1] contains a function which cannot be serialized'
      )
    })
  })

  describe('get', () => {
    it('throws error when key is null or undefined', () => {
      const state = new StateStore()
      expect(() => state.get(null as any)).toThrow('key is required')
      expect(() => state.get(undefined as any)).toThrow('key is required')
    })

    it('returns undefined when key does not exist', () => {
      const state = new StateStore()
      expect(state.get('nonexistent')).toBeUndefined()
    })

    it('returns value when key exists', () => {
      const state = new StateStore({ key1: 'value1' })
      expect(state.get('key1')).toBe('value1')
    })

    it('returns deep copy that cannot mutate stored state', () => {
      const state = new StateStore({ nested: { value: 'test' } })
      const retrieved = state.get<{ nested: { value: string } }>('nested')

      // Mutate retrieved value
      retrieved!.value = 'changed'

      // Stored state should not be affected
      expect(state.get('nested')).toEqual({ value: 'test' })
    })

    it('infers correct type with generic state interface', () => {
      interface TestState {
        user: { name: string; age: number }
        count: number
        items: string[]
      }

      const state = new StateStore({ user: { name: 'John', age: 30 }, count: 5, items: ['a', 'b'] })

      // Type inference tests
      const user = state.get<TestState>('user')
      const count = state.get<TestState>('count')
      const items = state.get<TestState>('items')

      expect(user).toEqual({ name: 'John', age: 30 })
      expect(count).toBe(5)
      expect(items).toEqual(['a', 'b'])
    })

    it('returns undefined for non-existent key with typed interface', () => {
      interface TestState {
        existing: string
      }

      const state = new StateStore({ existing: 'value' })
      const result = state.get<TestState>('existing')

      expect(result).toBe('value')

      // Non-existent key
      const state2 = new StateStore()
      const missing = state2.get<TestState>('existing')

      expect(missing).toBeUndefined()

      // @ts-expect-error properties not on the TestsState are an error
      state2.get<TestState>('not-really')
    })
  })

  describe('set', () => {
    it('sets string value successfully', () => {
      const state = new StateStore()
      state.set('key1', 'value1')
      expect(state.get('key1')).toBe('value1')
    })

    it('sets number value successfully', () => {
      const state = new StateStore()
      state.set('key1', 42)
      expect(state.get('key1')).toBe(42)
    })

    it('sets boolean value successfully', () => {
      const state = new StateStore()
      state.set('key1', true)
      expect(state.get('key1')).toBe(true)
    })

    it('sets null value successfully', () => {
      const state = new StateStore()
      state.set('key1', null)
      expect(state.get('key1')).toBeNull()
    })

    it('sets object value successfully', () => {
      const state = new StateStore()
      state.set('key1', { nested: 'value' })
      expect(state.get('key1')).toEqual({ nested: 'value' })
    })

    it('sets array value successfully', () => {
      const state = new StateStore()
      state.set('key1', [1, 2, 3])
      expect(state.get('key1')).toEqual([1, 2, 3])
    })

    it('overwrites existing value', () => {
      const state = new StateStore({ key1: 'old' })
      state.set('key1', 'new')
      expect(state.get('key1')).toBe('new')
    })

    it('stores deep copy that cannot mutate stored state', () => {
      const state = new StateStore()
      const value = { nested: { value: 'test' } }
      state.set('key1', value)

      // Mutate original
      value.nested.value = 'changed'

      // Stored state should not be affected
      expect(state.get('key1')).toEqual({ nested: { value: 'test' } })
    })

    it('throws error for function in value', () => {
      const state = new StateStore({ existing: 'value' })
      const obj = { func: () => 'test', value: 'keep' }
      expect(() => state.set('key1', obj)).toThrow(
        'value for key "key1".func contains a function which cannot be serialized'
      )
    })

    it('throws error for symbol in value', () => {
      const state = new StateStore()
      const sym = Symbol('test')
      expect(() => state.set('key1', { sym } as never)).toThrow(
        'value for key "key1".sym contains a symbol which cannot be serialized'
      )
    })

    it('throws error for nested function in value', () => {
      const state = new StateStore()
      const obj = { nested: { func: () => 'test' } }
      expect(() => state.set('key1', obj)).toThrow(
        'value for key "key1".nested.func contains a function which cannot be serialized'
      )
    })

    it('throws error for function in array', () => {
      const state = new StateStore()
      const arr = [1, () => 'test', 3]
      expect(() => state.set('key1', arr)).toThrow(
        'value for key "key1"[1] contains a function which cannot be serialized'
      )
    })

    it('throws error for top-level symbol values', () => {
      const state = new StateStore()
      expect(() => state.set('key1', Symbol('test'))).toThrow(
        'value for key "key1" contains a symbol which cannot be serialized'
      )
    })

    it('throws error for top-level undefined values', () => {
      const state = new StateStore()
      expect(() => state.set('key1', undefined)).toThrow('value for key "key1" is undefined which cannot be serialized')
    })

    it('accepts typed value with generic state interface', () => {
      interface TestState {
        user: { name: string; age: number }
        count: number
      }

      const state = new StateStore()

      state.set<TestState>('user', { name: 'Alice', age: 25 })
      state.set<TestState>('count', 10)

      expect(state.get('user')).toEqual({ name: 'Alice', age: 25 })
      expect(state.get('count')).toBe(10)

      // @ts-expect-error properties not on the TestsState are an error
      state.set<TestState>('not-really', 'nope')
    })
  })

  describe('delete', () => {
    it('removes existing key', () => {
      const state = new StateStore({ key1: 'value1', key2: 'value2' })
      state.delete('key1')
      expect(state.get('key1')).toBeUndefined()
      expect(state.get('key2')).toBe('value2')
    })

    it('does not throw error for non-existent key', () => {
      const state = new StateStore()
      expect(() => state.delete('nonexistent')).not.toThrow()
    })

    it('supports typed usage with generic state interface', () => {
      interface TestState {
        user: { name: string }
        count: number
      }

      const state = new StateStore({ user: { name: 'Alice' }, count: 5 })

      // Typed delete
      state.delete<TestState>('user')
      expect(state.get('user')).toBeUndefined()
      expect(state.get('count')).toBe(5)
    })
  })

  describe('clear', () => {
    it('removes all values', () => {
      const state = new StateStore({ key1: 'value1', key2: 'value2' })
      state.clear()
      expect(state.keys()).toEqual([])
      expect(state.get('key1')).toBeUndefined()
      expect(state.get('key2')).toBeUndefined()
    })

    it('works on empty state', () => {
      const state = new StateStore()
      expect(() => state.clear()).not.toThrow()
      expect(state.keys()).toEqual([])
    })
  })

  describe('getAll', () => {
    it('returns object with all state', () => {
      const state = new StateStore({ key1: 'value1', key2: 42 })
      expect(state.getAll()).toEqual({ key1: 'value1', key2: 42 })
    })

    it('returns empty object for empty state', () => {
      const state = new StateStore()
      expect(state.getAll()).toEqual({})
    })
  })

  describe('keys', () => {
    it('returns array of all keys', () => {
      const state = new StateStore({ key1: 'value1', key2: 'value2' })
      expect(state.keys().sort()).toEqual(['key1', 'key2'])
    })

    it('returns empty array for empty state', () => {
      const state = new StateStore()
      expect(state.keys()).toEqual([])
    })

    it('returns new array each time', () => {
      const state = new StateStore({ key1: 'value1' })
      const keys1 = state.keys()
      const keys2 = state.keys()
      expect(keys1).not.toBe(keys2)
    })
  })

  describe('stateToJSONSymbol (via symbol)', () => {
    it('returns deep copy of state', () => {
      const state = new StateStore({ key1: 'value1', nested: { deep: true } })
      const json = state[stateToJSONSymbol]()
      expect(json).toEqual({ key1: 'value1', nested: { deep: true } })
    })

    it('can be accessed via serializeStateSerializable helper', () => {
      const state = new StateStore({ key1: 'value1' })
      const json = serializeStateSerializable(state)
      expect(json).toEqual({ key1: 'value1' })
    })
  })

  describe('loadStateFromJSONSymbol (via symbol)', () => {
    it('replaces state with json data', () => {
      const state = new StateStore({ old: 'data' })
      state[loadStateFromJSONSymbol]({ new: 'data', count: 42 })
      expect(state.getAll()).toEqual({ new: 'data', count: 42 })
    })

    it('clears state when given non-object', () => {
      const state = new StateStore({ key: 'value' })
      state[loadStateFromJSONSymbol](null)
      expect(state.getAll()).toEqual({})
    })

    it('can be accessed via loadStateSerializable helper', () => {
      const state = new StateStore({ old: 'data' })
      loadStateSerializable(state, { new: 'data' })
      expect(state.getAll()).toEqual({ new: 'data' })
    })
  })

  describe('isStateSerializable', () => {
    it('returns true for StateStore instances', () => {
      const state = new StateStore()
      expect(isStateSerializable(state)).toBe(true)
    })

    it('returns false for plain objects', () => {
      const obj = { toJSON: () => ({}), loadStateFromJson: () => {} }
      expect(isStateSerializable(obj)).toBe(false)
    })

    it('returns false for null', () => {
      expect(isStateSerializable(null)).toBe(false)
    })

    it('returns false for objects with only one symbol method', () => {
      const partial = { [stateToJSONSymbol]: () => ({}) }
      expect(isStateSerializable(partial)).toBe(false)
    })

    it('returns true for objects implementing both symbol methods', () => {
      const custom = {
        [stateToJSONSymbol]: () => ({ custom: true }),
        [loadStateFromJSONSymbol]: () => {},
      }
      expect(isStateSerializable(custom)).toBe(true)
    })
  })
})
