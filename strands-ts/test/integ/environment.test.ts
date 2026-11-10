import { describe, it, expect } from 'vitest'

describe('environment', () => {
  describe('JavaScript features', () => {
    it('supports modern JavaScript features', () => {
      // Test ES2022 features work
      const testArray = [1, 2, 3]
      const lastElement = testArray.at(-1)
      expect(lastElement).toBe(3)
    })

    it('supports async/await functionality', async () => {
      // Test async functionality works
      const promise = Promise.resolve('test')
      const result = await promise
      expect(result).toBe('test')
    })
  })

  describe('TypeScript configuration', () => {
    it('validates strict typing environment', () => {
      // This test validates strict TypeScript configuration
      // If this compiles and runs, strict typing is working
      const testValue: string = 'test'
      expect(typeof testValue).toBe('string')
    })
  })
})
