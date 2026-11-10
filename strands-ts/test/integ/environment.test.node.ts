import { describe, it, expect } from 'vitest'

import { isBrowser, isNode } from '$/sdk/__fixtures__/environment.js'

describe('environment', () => {
  describe('Node.js compatibility', () => {
    it('works in Node.js environment', () => {
      // Test Node.js specific features are available
      expect(typeof process).toBe('object')
      expect(process.version).toBeDefined()
    })
  })

  describe('environment detection', () => {
    it('correctly identifies Node.js environment', () => {
      expect(isNode).toBe(true)
      expect(isBrowser).toBe(false)
      expect(typeof process).toBe('object')
    })
  })
})
