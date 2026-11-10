import { describe, it, expect } from 'vitest'
import { searchContent, isSearchableContent } from '../search.js'

describe('isSearchableContent', () => {
  it('returns true for text/* types', () => {
    expect(isSearchableContent('text/plain')).toBe(true)
    expect(isSearchableContent('text/html')).toBe(true)
  })

  it('returns true for application/json', () => {
    expect(isSearchableContent('application/json')).toBe(true)
  })

  it('returns false for binary types', () => {
    expect(isSearchableContent('image/png')).toBe(false)
    expect(isSearchableContent('video/mp4')).toBe(false)
    expect(isSearchableContent('application/pdf')).toBe(false)
  })
})

describe('searchContent', () => {
  const maxChars = 10_000

  describe('empty content', () => {
    it('returns empty message for empty string', () => {
      expect(searchContent('', { context_lines: 5, pattern: 'x' }, maxChars)).toBe('Content is empty (0 lines).')
    })

    it('returns empty message for single empty line', () => {
      expect(searchContent('\n', { context_lines: 5, line_range: { start: 1, end: 1 } }, maxChars)).not.toContain(
        'Content is empty'
      )
    })
  })

  describe('line_range validation', () => {
    const text = 'line 1\nline 2\nline 3\nline 4\nline 5'

    it('returns error when start > end', () => {
      const result = searchContent(text, { context_lines: 5, line_range: { start: 5, end: 2 } }, maxChars)
      expect(result).toContain('must be <= line_range.end')
    })

    it('returns error when start > total lines', () => {
      const result = searchContent(text, { context_lines: 5, line_range: { start: 100, end: 200 } }, maxChars)
      expect(result).toContain('beyond content length (5 lines)')
    })

    it('clamps end to total lines', () => {
      const result = searchContent(text, { context_lines: 5, line_range: { start: 3, end: 999 } }, maxChars)
      expect(result).toContain('[Lines 3-5 of 5]')
      expect(result).toContain('line 3')
      expect(result).toContain('line 5')
    })
  })

  describe('pattern search', () => {
    const text = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')

    it('finds a single match with context', () => {
      const result = searchContent(text, { pattern: 'line 10', context_lines: 2 }, maxChars)
      expect(result).toContain('[1 match for /line 10/]')
      expect(result).toContain('> 10| line 10')
      expect(result).toContain('   8| line 8')
      expect(result).toContain('  12| line 12')
      expect(result).not.toContain('line 7')
    })

    it('finds multiple matches', () => {
      const result = searchContent(text, { pattern: 'line [12]0', context_lines: 0 }, maxChars)
      expect(result).toContain('2 matches')
      expect(result).toContain('> 10| line 10')
      expect(result).toContain('> 20| line 20')
    })

    it('returns no-match message when pattern not found', () => {
      const result = searchContent(text, { pattern: 'nonexistent', context_lines: 5 }, maxChars)
      expect(result).toContain("No matches found for pattern 'nonexistent'")
      expect(result).toContain('searched 20 lines')
    })

    it('uses context_lines: 0 for no context', () => {
      const result = searchContent(text, { pattern: 'line 5', context_lines: 0 }, maxChars)
      expect(result).toContain('> 5| line 5')
      expect(result).not.toContain('line 4')
      expect(result).not.toContain('line 6')
    })

    it('merges overlapping context into one group', () => {
      const result = searchContent(text, { pattern: 'line [67]', context_lines: 2 }, maxChars)
      expect(result).toContain('2 matches')
      expect(result).not.toContain('---')
    })

    it('separates non-overlapping groups with ---', () => {
      const result = searchContent(text, { pattern: 'line (1|20)', context_lines: 0 }, maxChars)
      expect(result).toContain('---')
    })

    it('falls back to literal match on invalid regex', () => {
      const text = 'foo (bar\nbaz\nfoo (bar again'
      const result = searchContent(text, { pattern: 'foo (bar', context_lines: 0 }, maxChars)
      expect(result).toContain('2 matches')
      expect(result).toContain('> 1| foo (bar')
      expect(result).toContain('> 3| foo (bar again')
    })

    it('sanitizes pattern in header', () => {
      const text = 'test line\nanother line'
      const result = searchContent(text, { pattern: 'test]\nline', context_lines: 0 }, maxChars)
      // The header should not contain raw ] or newlines
      const header = result.split('\n')[0]!
      expect(header).not.toContain(']/')
      expect(header).not.toContain('\n')
    })
  })

  describe('pattern search with line_range', () => {
    const text = Array.from({ length: 30 }, (_, i) => `item ${i + 1}`).join('\n')

    it('searches only within the specified range', () => {
      const result = searchContent(
        text,
        { pattern: 'item 1', line_range: { start: 10, end: 20 }, context_lines: 0 },
        maxChars
      )
      expect(result).toContain('in lines 10-20')
      expect(result).toContain('> 10| item 10')
      expect(result).toContain('> 11| item 11')
      expect(result).not.toContain('> 1|')
    })

    it('reports no matches within range', () => {
      const result = searchContent(
        text,
        { pattern: 'item 5', line_range: { start: 10, end: 20 }, context_lines: 0 },
        maxChars
      )
      expect(result).toContain('No matches found')
      expect(result).toContain('in lines 10-20')
    })
  })

  describe('line range (no pattern)', () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n')

    it('returns specified range with header', () => {
      const result = searchContent(text, { line_range: { start: 5, end: 10 }, context_lines: 5 }, maxChars)
      expect(result).toContain('[Lines 5-10 of 50]')
      expect(result).toContain('  5| line 5')
      expect(result).toContain(' 10| line 10')
    })

    it('does not show lines outside range', () => {
      const result = searchContent(text, { line_range: { start: 5, end: 10 }, context_lines: 5 }, maxChars)
      expect(result).not.toContain('line 4')
      expect(result).not.toContain('line 11')
    })

    it('does not include --- separators for contiguous lines', () => {
      const result = searchContent(text, { line_range: { start: 1, end: 10 }, context_lines: 5 }, maxChars)
      expect(result).not.toContain('---')
    })
  })

  describe('truncation', () => {
    it('truncates pattern results when output exceeds maxChars', () => {
      const text = Array.from({ length: 500 }, (_, i) => `match line ${i + 1}`).join('\n')
      const result = searchContent(text, { pattern: 'match', context_lines: 0 }, 200)
      expect(result).toContain('output truncated, narrow your search')
      expect(result.length).toBeLessThanOrEqual(280)
    })

    it('truncates line range results when output exceeds maxChars', () => {
      const text = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n')
      const result = searchContent(text, { line_range: { start: 1, end: 500 }, context_lines: 5 }, 200)
      expect(result).toContain('output truncated, narrow your range')
      expect(result.length).toBeLessThanOrEqual(280)
    })

    it('preserves body for single-long-line content in pattern search', () => {
      const longJson = '{"key":"' + 'x'.repeat(5000) + '"}'
      const result = searchContent(longJson, { pattern: 'key', context_lines: 0 }, 500)
      expect(result).toContain('output truncated')
      expect(result).toContain('{"key":"')
    })

    it('preserves body for single-long-line content in line range', () => {
      const longJson = '{"key":"' + 'x'.repeat(5000) + '"}'
      const result = searchContent(longJson, { line_range: { start: 1, end: 50 }, context_lines: 5 }, 500)
      expect(result).toContain('output truncated')
      expect(result).toContain('{"key":"')
    })

    it('does not truncate when output fits within maxChars', () => {
      const text = 'short\ncontent'
      const result = searchContent(text, { line_range: { start: 1, end: 2 }, context_lines: 5 }, maxChars)
      expect(result).not.toContain('truncated')
    })
  })
})
