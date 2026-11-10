import { describe, it, expect } from 'vitest'
import { docsLanguagesSchema } from '../src/content.config'

describe('docsLanguagesSchema', () => {
  it('accepts a single language string', () => {
    expect(docsLanguagesSchema.safeParse('python').success).toBe(true)
    expect(docsLanguagesSchema.safeParse('typescript').success).toBe(true)
  })

  it('accepts a single-element array', () => {
    expect(docsLanguagesSchema.safeParse(['python']).success).toBe(true)
    expect(docsLanguagesSchema.safeParse(['typescript']).success).toBe(true)
  })

  it('accepts undefined (field omitted)', () => {
    expect(docsLanguagesSchema.safeParse(undefined).success).toBe(true)
  })

  it('rejects an array listing all SDK languages', () => {
    const result = docsLanguagesSchema.safeParse(['python', 'typescript'])
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('omit the field entirely')
    }
  })

  it('rejects regardless of order', () => {
    expect(docsLanguagesSchema.safeParse(['typescript', 'python']).success).toBe(false)
  })

  it('rejects regardless of case', () => {
    expect(docsLanguagesSchema.safeParse(['Python', 'TypeScript']).success).toBe(false)
  })
})
