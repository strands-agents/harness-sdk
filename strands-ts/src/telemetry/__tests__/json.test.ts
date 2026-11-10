import { describe, it, expect } from 'vitest'
import { jsonReplacer } from '../json.js'

describe('jsonReplacer', () => {
  describe('primitive values', () => {
    it('serializes strings', () => {
      expect(JSON.stringify('hello', jsonReplacer)).toBe('"hello"')
    })

    it('serializes numbers', () => {
      expect(JSON.stringify(42, jsonReplacer)).toBe('42')
    })

    it('serializes booleans', () => {
      expect(JSON.stringify(true, jsonReplacer)).toBe('true')
    })

    it('serializes null', () => {
      expect(JSON.stringify(null, jsonReplacer)).toBe('null')
    })
  })

  describe('object values', () => {
    it('serializes simple objects', () => {
      const obj = { key: 'value', number: 42, bool: true }
      expect(JSON.stringify(obj, jsonReplacer)).toBe(JSON.stringify(obj))
    })

    it('serializes arrays', () => {
      const arr = [1, 2, 3, 'test']
      expect(JSON.stringify(arr, jsonReplacer)).toBe(JSON.stringify(arr))
    })
  })

  describe('special types', () => {
    it('handles Date objects', () => {
      const date = new Date('2024-01-01T00:00:00.000Z')
      expect(JSON.stringify(date, jsonReplacer)).toBe('"2024-01-01T00:00:00.000Z"')
    })

    it('handles Date objects nested in objects', () => {
      const date = new Date('2024-01-01T00:00:00.000Z')
      expect(JSON.stringify({ timestamp: date, name: 'test' }, jsonReplacer)).toBe(
        '{"timestamp":"2024-01-01T00:00:00.000Z","name":"test"}'
      )
    })

    it('replaces BigInt values', () => {
      const bigint = BigInt(12345678901234567890n)
      expect(JSON.stringify(bigint, jsonReplacer)).toBe('"<replaced>"')
    })

    it('replaces functions', () => {
      const fn = (): string => 'test'
      const result = JSON.parse(JSON.stringify({ callback: fn, name: 'test' }, jsonReplacer))
      expect(result).toStrictEqual({ callback: '<replaced>', name: 'test' })
    })

    it('replaces symbols', () => {
      const result = JSON.parse(JSON.stringify({ sym: Symbol('test'), name: 'test' }, jsonReplacer))
      expect(result).toStrictEqual({ sym: '<replaced>', name: 'test' })
    })

    it('replaces ArrayBuffer values', () => {
      const buffer = new ArrayBuffer(8)
      const result = JSON.parse(JSON.stringify({ data: buffer, name: 'test' }, jsonReplacer))
      expect(result).toStrictEqual({ data: '<replaced>', name: 'test' })
    })

    it('replaces Uint8Array values', () => {
      const bytes = new Uint8Array([1, 2, 3])
      const result = JSON.parse(JSON.stringify({ data: bytes, name: 'test' }, jsonReplacer))
      expect(result).toStrictEqual({ data: '<replaced>', name: 'test' })
    })

    it('handles mixed content in arrays', () => {
      const fn = (): string => 'test'
      const data = ['value', 42, fn, null, { key: true }]
      const result = JSON.parse(JSON.stringify(data, jsonReplacer))
      expect(result).toStrictEqual(['value', 42, '<replaced>', null, { key: true }])
    })

    it('handles mixed content in nested objects', () => {
      const fn = (): string => 'test'
      const now = new Date('2025-01-01T12:00:00.000Z')
      const data = {
        metadata: { timestamp: now, version: '1.0', debug: { obj: fn } },
        content: [
          { type: 'text', value: 'Hello' },
          { type: 'binary', value: fn },
        ],
        list: [fn, 1234, true, null, 'string'],
      }
      const result = JSON.parse(JSON.stringify(data, jsonReplacer))
      expect(result).toStrictEqual({
        metadata: { timestamp: '2025-01-01T12:00:00.000Z', version: '1.0', debug: { obj: '<replaced>' } },
        content: [
          { type: 'text', value: 'Hello' },
          { type: 'binary', value: '<replaced>' },
        ],
        list: ['<replaced>', 1234, true, null, 'string'],
      })
    })
  })
})
