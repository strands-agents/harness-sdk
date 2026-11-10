import { describe, expect, it } from 'vitest'
import { validateIdentifier, validateScope, validateUuidV7 } from '../validation.js'

describe('validateIdentifier', () => {
  describe('when identifier is valid', () => {
    it('returns the identifier', () => {
      expect(validateIdentifier('valid-id')).toBe('valid-id')
    })
  })

  describe('when identifier contains forward slash', () => {
    it('throws error', () => {
      expect(() => validateIdentifier('invalid/id')).toThrow(
        "Identifier 'invalid/id' can only contain lowercase letters, numbers, hyphens, and underscores"
      )
    })
  })

  describe('when identifier contains backslash', () => {
    it('throws error', () => {
      expect(() => validateIdentifier('invalid\\id')).toThrow(
        "Identifier 'invalid\\id' can only contain lowercase letters, numbers, hyphens, and underscores"
      )
    })
  })
})

describe('validateScope', () => {
  describe('when scope is supported', () => {
    it('returns the scope', () => {
      expect([validateScope('agent'), validateScope('multiAgent')]).toEqual(['agent', 'multiAgent'])
    })
  })

  describe('when scope contains path traversal', () => {
    it('throws error', () => {
      expect(() => validateScope('../../outside')).toThrow(
        "Invalid scope '../../outside': must be 'agent' or 'multiAgent'"
      )
    })
  })
})

describe('validateUuidV7', () => {
  describe('when id is a valid UUID v7', () => {
    it('does not throw', () => {
      expect(() => validateUuidV7('01956891-2b4c-7000-8abc-123456789abc')).not.toThrow()
    })
  })

  describe('when id is a UUID v4 (wrong version)', () => {
    it('throws error', () => {
      expect(() => validateUuidV7('550e8400-e29b-41d4-a716-446655440000')).toThrow(
        "'550e8400-e29b-41d4-a716-446655440000' is not a valid UUID v7 snapshot ID"
      )
    })
  })

  describe('when id is a timestamp string', () => {
    it('throws error', () => {
      expect(() => validateUuidV7('2025-01-15T10:30:00Z')).toThrow(
        "'2025-01-15T10:30:00Z' is not a valid UUID v7 snapshot ID"
      )
    })
  })

  describe('when id contains path traversal', () => {
    it('throws error', () => {
      expect(() => validateUuidV7('../evil')).toThrow("'../evil' is not a valid UUID v7 snapshot ID")
    })
  })

  describe('when id is empty string', () => {
    it('throws error', () => {
      expect(() => validateUuidV7('')).toThrow("'' is not a valid UUID v7 snapshot ID")
    })
  })
})
