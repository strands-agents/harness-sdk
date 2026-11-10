import { describe, it, expect } from 'vitest'

import { isBrowser, isNode } from '$/sdk/__fixtures__/environment.js'

describe('environment', () => {
  describe('Browser compatibility', () => {
    it('isNode should resolve to false', () => {
      expect(isNode).toBe(false)
    })
    it('has window object with expected properties', () => {
      expect(window).toBeDefined()
      expect(typeof window).toBe('object')
      expect(window.location).toBeDefined()
      expect(window.navigator).toBeDefined()
    })

    it('has document object with DOM methods', () => {
      expect(document).toBeDefined()
      expect(typeof document).toBe('object')
      expect(typeof document.createElement).toBe('function')
      expect(typeof document.querySelector).toBe('function')
    })

    it('has navigator object with browser information', () => {
      expect(navigator).toBeDefined()
      expect(typeof navigator).toBe('object')
      expect(typeof navigator.userAgent).toBe('string')
      expect(navigator.userAgent.length).toBeGreaterThan(0)
    })

    describe('environment detection', () => {
      it('correctly identifies browser environment', () => {
        expect(isBrowser).toBe(true)
        expect(isNode).toBe(false)
        expect(typeof window).toBe('object')
      })
    })
  })
})
