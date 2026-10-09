import { describe, it, expect } from 'vitest'
import { deepCopy, deepCopyWithValidation } from '../json.js'
import { JsonValidationError } from '../../errors.js'

describe('deepCopy', () => {
  describe('primitive values', () => {
    it('copies strings', () => {
      const result = deepCopy('hello')
      expect(result).toBe('hello')
    })

    it('copies numbers', () => {
      const result = deepCopy(42)
      expect(result).toBe(42)
    })

    it('copies booleans', () => {
      const result = deepCopy(true)
      expect(result).toBe(true)
    })

    it('copies null', () => {
      const result = deepCopy(null)
      expect(result).toBe(null)
    })
  })

  describe('object values', () => {
    it('creates a deep copy of objects', () => {
      const original = { nested: { value: 'test' } }
      const copy = deepCopy(original)

      expect(copy).toEqual(original)
      expect(copy).not.toBe(original) // Different reference

      // Verify deep copy - modifying original shouldn't affect copy
      original.nested.value = 'changed'
      expect((copy as { nested: { value: string } }).nested.value).toBe('test')
    })

    it('copies empty objects', () => {
      const result = deepCopy({})
      expect(result).toEqual({})
    })

    it('copies objects with multiple properties', () => {
      const original = { a: 1, b: 'two', c: true, d: null }
      const copy = deepCopy(original)
      expect(copy).toEqual(original)
    })
  })

  describe('array values', () => {
    it('creates a deep copy of arrays', () => {
      const original = [1, 2, 3, { nested: 'value' }]
      const copy = deepCopy(original)

      expect(copy).toEqual(original)
      expect(copy).not.toBe(original) // Different reference

      // Verify deep copy - modifying original shouldn't affect copy
      original[0] = 999
      expect((copy as number[])[0]).toBe(1)
    })

    it('copies empty arrays', () => {
      const result = deepCopy([])
      expect(result).toEqual([])
    })

    it('copies nested arrays', () => {
      const original = [
        [1, 2],
        [3, 4],
      ]
      const copy = deepCopy(original)
      expect(copy).toEqual(original)
    })
  })

  describe('error handling', () => {
    it('throws error for circular references', () => {
      const circular: { self?: unknown } = {}
      circular.self = circular

      expect(() => deepCopy(circular)).toThrow('Unable to serialize tool result')
    })

    it('silently drops functions from objects', () => {
      const withFunction = {
        normalProp: 'value',
        funcProp: (): string => 'test',
      }

      const result = deepCopy(withFunction)
      expect(result).toEqual({ normalProp: 'value' })
      expect(result).not.toHaveProperty('funcProp')
    })

    it('silently drops symbols from objects', () => {
      const sym = Symbol('test')
      const withSymbol = {
        normalProp: 'value',
        [sym]: 'symbolValue',
      }

      const result = deepCopy(withSymbol)
      expect(result).toEqual({ normalProp: 'value' })
      // Symbols are dropped during JSON serialization
      expect(Object.getOwnPropertySymbols(result as object)).toHaveLength(0)
    })

    it('silently drops undefined values from objects', () => {
      const withUndefined = {
        normalProp: 'value',
        undefinedProp: undefined,
      }

      const result = deepCopy(withUndefined)
      expect(result).toEqual({ normalProp: 'value' })
      expect(result).not.toHaveProperty('undefinedProp')
    })
  })

  describe('complex nested structures', () => {
    it('copies deeply nested structures', () => {
      const original = {
        level1: {
          level2: {
            level3: {
              array: [1, 2, { deep: 'value' }],
              string: 'test',
            },
          },
        },
      }

      const copy = deepCopy(original)
      expect(copy).toEqual(original)
      expect(copy).not.toBe(original)
    })

    it('copies arrays of objects', () => {
      const original = [
        { id: 1, name: 'first' },
        { id: 2, name: 'second' },
        { id: 3, name: 'third' },
      ]

      const copy = deepCopy(original)
      expect(copy).toEqual(original)
      expect(copy).not.toBe(original)
    })
  })
})

describe('deepCopyWithValidation', () => {
  describe('primitive values', () => {
    it('copies strings', () => {
      const result = deepCopyWithValidation('hello', 'testValue')
      expect(result).toBe('hello')
    })

    it('copies numbers', () => {
      const result = deepCopyWithValidation(42, 'testValue')
      expect(result).toBe(42)
    })

    it('copies booleans', () => {
      const result = deepCopyWithValidation(true, 'testValue')
      expect(result).toBe(true)
    })

    it('copies null', () => {
      const result = deepCopyWithValidation(null, 'testValue')
      expect(result).toBe(null)
    })
  })

  describe('object values', () => {
    it('creates a deep copy of objects', () => {
      const original = { nested: { value: 'test' } }
      const copy = deepCopyWithValidation(original, 'testValue')

      expect(copy).toEqual(original)
      expect(copy).not.toBe(original) // Different reference

      // Verify deep copy - modifying original shouldn't affect copy
      original.nested.value = 'changed'
      expect((copy as { nested: { value: string } }).nested.value).toBe('test')
    })

    it('copies empty objects', () => {
      const result = deepCopyWithValidation({}, 'testValue')
      expect(result).toEqual({})
    })

    it('copies objects with multiple properties', () => {
      const original = { a: 1, b: 'two', c: true, d: null }
      const copy = deepCopyWithValidation(original, 'testValue')
      expect(copy).toEqual(original)
    })
  })

  describe('array values', () => {
    it('creates a deep copy of arrays', () => {
      const original = [1, 2, 3, { nested: 'value' }]
      const copy = deepCopyWithValidation(original, 'testValue')

      expect(copy).toEqual(original)
      expect(copy).not.toBe(original) // Different reference

      // Verify deep copy - modifying original shouldn't affect copy
      original[0] = 999
      expect((copy as number[])[0]).toBe(1)
    })

    it('copies empty arrays', () => {
      const result = deepCopyWithValidation([], 'testValue')
      expect(result).toEqual([])
    })

    it('copies nested arrays', () => {
      const original = [
        [1, 2],
        [3, 4],
      ]
      const copy = deepCopyWithValidation(original, 'testValue')
      expect(copy).toEqual(original)
    })
  })

  describe('validation errors', () => {
    it('throws JsonValidationError for functions at top level', () => {
      const func = (): string => 'test'

      expect(() => deepCopyWithValidation(func, 'testValue')).toThrow(JsonValidationError)
      expect(() => deepCopyWithValidation(func, 'testValue')).toThrow(
        'testValue contains a function which cannot be serialized'
      )
    })

    it('throws JsonValidationError for functions in objects', () => {
      const withFunction = {
        normalProp: 'value',
        funcProp: (): string => 'test',
      }

      expect(() => deepCopyWithValidation(withFunction, 'testValue')).toThrow(JsonValidationError)
      expect(() => deepCopyWithValidation(withFunction, 'testValue')).toThrow(
        'testValue.funcProp contains a function which cannot be serialized'
      )
    })

    it('throws JsonValidationError for functions in nested objects', () => {
      const nested = {
        level1: {
          level2: {
            func: (): string => 'test',
          },
        },
      }

      expect(() => deepCopyWithValidation(nested, 'config')).toThrow(JsonValidationError)
      expect(() => deepCopyWithValidation(nested, 'config')).toThrow(
        'config.level1.level2.func contains a function which cannot be serialized'
      )
    })

    it('throws JsonValidationError for functions in arrays', () => {
      const withFunction = [1, 2, (): string => 'test']

      expect(() => deepCopyWithValidation(withFunction, 'items')).toThrow(JsonValidationError)
      expect(() => deepCopyWithValidation(withFunction, 'items')).toThrow(
        'items[2] contains a function which cannot be serialized'
      )
    })

    it('throws JsonValidationError with the correct path for sibling keys after nested objects', () => {
      const withFunction = {
        ok: 1,
        nested: { x: 1 },
        bad: (): string => 'test',
      }

      expect(() => deepCopyWithValidation(withFunction, 'value for key "a"')).toThrow(JsonValidationError)
      expect(() => deepCopyWithValidation(withFunction, 'value for key "a"')).toThrow(
        'value for key "a".bad contains a function which cannot be serialized'
      )
    })

    it('throws JsonValidationError with the correct path for array elements after nested objects', () => {
      const withFunction = [{ x: 1 }, (): string => 'test']

      expect(() => deepCopyWithValidation(withFunction, 'items')).toThrow(JsonValidationError)
      expect(() => deepCopyWithValidation(withFunction, 'items')).toThrow(
        'items[1] contains a function which cannot be serialized'
      )
    })

    it('throws JsonValidationError with the correct path for keys after multiple levels of nesting', () => {
      const withFunction = {
        first: { deep: { deeper: 1 } },
        second: { deep: { deeper: 1 } },
        bad: (): string => 'test',
      }

      expect(() => deepCopyWithValidation(withFunction, 'value')).toThrow(JsonValidationError)
      expect(() => deepCopyWithValidation(withFunction, 'value')).toThrow(
        'value.bad contains a function which cannot be serialized'
      )
    })

    it('throws JsonValidationError for symbols in objects', () => {
      const sym = Symbol('test')
      const withSymbol = {
        normalProp: 'value',
        symProp: sym,
      }

      expect(() => deepCopyWithValidation(withSymbol, 'testValue')).toThrow(JsonValidationError)
      expect(() => deepCopyWithValidation(withSymbol, 'testValue')).toThrow(
        'testValue.symProp contains a symbol which cannot be serialized'
      )
    })

    it('throws JsonValidationError for symbols in arrays', () => {
      const sym = Symbol('test')
      const withSymbol = [1, 2, sym]

      expect(() => deepCopyWithValidation(withSymbol, 'items')).toThrow(JsonValidationError)
      expect(() => deepCopyWithValidation(withSymbol, 'items')).toThrow(
        'items[2] contains a symbol which cannot be serialized'
      )
    })

    it('throws JsonValidationError for undefined values in objects', () => {
      const withUndefined = {
        normalProp: 'value',
        undefinedProp: undefined,
      }

      expect(() => deepCopyWithValidation(withUndefined, 'testValue')).toThrow(JsonValidationError)
      expect(() => deepCopyWithValidation(withUndefined, 'testValue')).toThrow(
        'testValue.undefinedProp is undefined which cannot be serialized'
      )
    })

    it('throws JsonValidationError for undefined values in arrays', () => {
      const withUndefined = [1, 2, undefined]

      expect(() => deepCopyWithValidation(withUndefined, 'items')).toThrow(JsonValidationError)
      expect(() => deepCopyWithValidation(withUndefined, 'items')).toThrow(
        'items[2] is undefined which cannot be serialized'
      )
    })

    it('throws JsonValidationError for circular references', () => {
      const circular: { self?: unknown } = {}
      circular.self = circular

      expect(() => deepCopyWithValidation(circular, 'testValue')).toThrow('circular structure')
    })
  })

  describe('complex nested structures', () => {
    it('copies deeply nested structures', () => {
      const original = {
        level1: {
          level2: {
            level3: {
              array: [1, 2, { deep: 'value' }],
              string: 'test',
            },
          },
        },
      }

      const copy = deepCopyWithValidation(original, 'testValue')
      expect(copy).toEqual(original)
      expect(copy).not.toBe(original)
    })

    it('copies arrays of objects', () => {
      const original = [
        { id: 1, name: 'first' },
        { id: 2, name: 'second' },
        { id: 3, name: 'third' },
      ]

      const copy = deepCopyWithValidation(original, 'testValue')
      expect(copy).toEqual(original)
      expect(copy).not.toBe(original)
    })
  })

  describe('context path parameter', () => {
    it('uses custom context path in error messages', () => {
      const withFunction = {
        func: (): string => 'test',
      }

      expect(() => deepCopyWithValidation(withFunction, 'initialState')).toThrow(
        'initialState.func contains a function which cannot be serialized'
      )
    })

    it('uses default context path when not provided', () => {
      const withFunction = {
        func: (): string => 'test',
      }

      expect(() => deepCopyWithValidation(withFunction)).toThrow(
        'value.func contains a function which cannot be serialized'
      )
    })
  })
})
