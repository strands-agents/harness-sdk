import { describe, it, expect } from 'vitest'
import { bestSectionRange, matchingSections } from '../sections.js'

describe('matchingSections', () => {
  const lines = (count: number): string[] => Array.from({ length: count }, (_, index) => `line ${index + 1}`)

  it('centres a section on the matching line', () => {
    const content = lines(20)
    content[9] = 'the answer'

    const sections = matchingSections(content, (text) => (text.includes('the answer') ? 1 : 0), 2)

    expect(sections).toStrictEqual([{ start: 7, end: 11, score: 1 }])
  })

  it('clamps a section to the bounds of the content', () => {
    const content = ['the answer', ...lines(3)]

    const sections = matchingSections(content, (text) => (text.includes('the answer') ? 1 : 0), 10)

    expect(sections).toStrictEqual([{ start: 0, end: 3, score: 1 }])
  })

  it('reports one section per passage rather than one per matching line', () => {
    const content = lines(30)
    content[9] = 'the answer'
    content[10] = 'the answer again'
    content[25] = 'the answer elsewhere'

    const sections = matchingSections(content, (text) => (text.includes('the answer') ? 1 : 0), 2)

    expect(sections.map((section) => [section.start, section.end])).toStrictEqual([
      [7, 11],
      [23, 27],
    ])
  })

  it('ranks sections by the score of the whole section, best-first', () => {
    const content = ['alpha', 'filler', 'filler', 'filler', 'filler', 'filler', 'alpha beta gamma']

    const sections = matchingSections(
      content,
      (text) => text.split(/\s+/).filter((word) => word !== 'filler').length,
      1
    )

    expect(sections.map((section) => section.start)).toStrictEqual([5, 0])
  })

  it('takes any scorer, so a strategy ranking by something other than token overlap can use it', () => {
    const content = ['short', 'a much longer line of prose', 'short']

    // Scores by length, with no notion of a query at all.
    const sections = matchingSections(content, (text) => (text.length > 10 ? text.length : 0), 0)

    expect(sections).toStrictEqual([{ start: 1, end: 1, score: 27 }])
  })

  it('returns nothing when no line matches', () => {
    expect(matchingSections(lines(5), () => 0, 2)).toStrictEqual([])
  })
})

describe('bestSectionRange', () => {
  it('returns byte offsets that slice the best section out of the encoded content', () => {
    const content = ['alpha', 'the answer', 'omega'].join('\n')

    const range = bestSectionRange(content, (text) => (text.includes('the answer') ? 1 : 0), 0)

    expect(slice(content, range!)).toBe('the answer')
  })

  it('offsets by bytes rather than characters, so multi-byte content does not shift the section', () => {
    const content = ['😀'.repeat(5), 'the answer', 'ω'].join('\n')

    const range = bestSectionRange(content, (text) => (text.includes('the answer') ? 1 : 0), 0)

    expect(slice(content, range!)).toBe('the answer')
  })

  it('reaches the final byte when the section ends at the last line', () => {
    const content = ['alpha', 'the answer'].join('\n')

    const range = bestSectionRange(content, (text) => (text.includes('the answer') ? 1 : 0), 0)

    expect(range).toStrictEqual({ start: 6, end: 16 })
    expect(slice(content, range!)).toBe('the answer')
  })

  it('returns undefined when nothing in the content matched', () => {
    expect(bestSectionRange('alpha\nomega', () => 0, 2)).toBeUndefined()
  })
})

/** Slices a `byteRange` out of content the way a consumer of a search result does. */
function slice(content: string, range: { start: number; end: number }): string {
  return new TextDecoder().decode(new TextEncoder().encode(content).slice(range.start, range.end))
}
