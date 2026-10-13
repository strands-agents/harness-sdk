import { describe, it, expect } from 'vitest'
import { tagToSlug, slugToTag, formatDate } from '../src/util/blog'

describe('tagToSlug', () => {
  it('converts tags to URL-safe slugs', () => {
    expect(tagToSlug('Open Source')).toBe('open-source')
    expect(tagToSlug('Case Studies')).toBe('case-studies')
    expect(tagToSlug('Architecture')).toBe('architecture')
    expect(tagToSlug('Tutorials')).toBe('tutorials')
  })

  it('handles multiple spaces', () => {
    expect(tagToSlug('Some  Tag')).toBe('some-tag')
  })

  it('handles single word', () => {
    expect(tagToSlug('Benchmarks')).toBe('benchmarks')
  })
})

describe('slugToTag', () => {
  const allTags = ['Architecture', 'Tutorials', 'Production', 'Benchmarks', 'Open Source', 'Case Studies']

  it('finds original tag from slug', () => {
    expect(slugToTag('open-source', allTags)).toBe('Open Source')
    expect(slugToTag('case-studies', allTags)).toBe('Case Studies')
    expect(slugToTag('architecture', allTags)).toBe('Architecture')
    expect(slugToTag('tutorials', allTags)).toBe('Tutorials')
    expect(slugToTag('production', allTags)).toBe('Production')
    expect(slugToTag('benchmarks', allTags)).toBe('Benchmarks')
  })

  it('returns undefined for unknown slugs', () => {
    expect(slugToTag('nonexistent', allTags)).toBeUndefined()
  })
})

describe('formatDate', () => {
  it('formats dates in readable US format', () => {
    const date = new Date('2026-02-20T00:00:00Z')
    const result = formatDate(date)
    expect(result).toContain('February')
    expect(result).toContain('2026')
    expect(result).toContain('20')
  })

  it('handles different months', () => {
    const date = new Date('2025-12-15T12:00:00Z')
    const result = formatDate(date)
    expect(result).toContain('December')
    expect(result).toContain('2025')
  })
})
