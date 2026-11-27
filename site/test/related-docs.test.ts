import { describe, it, expect } from 'vitest'
import type { CollectionEntry } from 'astro:content'
import { relatedUserGuideFor, userGuidePagesWithTag } from '../src/util/related-docs'

function doc(id: string, title: string, tags: string[]): CollectionEntry<'docs'> {
  return { id, collection: 'docs', data: { title, tags } } as unknown as CollectionEntry<'docs'>
}

describe('relatedUserGuideFor (headless: top 10, specificity-weighted Jaccard)', () => {
  it('ranks pages by score, descending', () => {
    const current = doc('docs/user-guide/a', 'A', ['x', 'y', 'z'])
    const two = doc('docs/user-guide/b', 'B', ['x', 'y'])
    const one = doc('docs/user-guide/c', 'C', ['x'])

    const result = relatedUserGuideFor(current, [current, one, two])
    expect(result.map((r) => r.title)).toEqual(['B', 'C'])
  })

  it('breaks score ties alphabetically by title', () => {
    const current = doc('docs/user-guide/a', 'A', ['x'])
    const zebra = doc('docs/user-guide/z', 'Zebra', ['x'])
    const apple = doc('docs/user-guide/b', 'Apple', ['x'])

    const result = relatedUserGuideFor(current, [current, zebra, apple])
    expect(result.map((r) => r.title)).toEqual(['Apple', 'Zebra'])
  })

  it('excludes the current page from its own results', () => {
    const current = doc('docs/user-guide/a', 'A', ['x'])
    const other = doc('docs/user-guide/b', 'B', ['x'])

    const result = relatedUserGuideFor(current, [current, other])
    expect(result.map((r) => r.slug)).toEqual(['docs/user-guide/b'])
  })

  it('returns empty when the current page has no tags', () => {
    const current = doc('docs/user-guide/a', 'A', [])
    const other = doc('docs/user-guide/b', 'B', ['x'])

    expect(relatedUserGuideFor(current, [current, other])).toEqual([])
  })

  it('returns empty when no other page shares a tag', () => {
    const current = doc('docs/user-guide/a', 'A', ['x'])
    const other = doc('docs/user-guide/b', 'B', ['y'])

    expect(relatedUserGuideFor(current, [current, other])).toEqual([])
  })

  it('ignores candidates outside the user-guide tree', () => {
    const current = doc('docs/user-guide/a', 'A', ['x'])
    const blogLike = doc('docs/integrations/b', 'B', ['x'])
    const userGuide = doc('docs/user-guide/c', 'C', ['x'])

    const result = relatedUserGuideFor(current, [current, blogLike, userGuide])
    expect(result.map((r) => r.slug)).toEqual(['docs/user-guide/c'])
  })

  it('returns empty when the current page is not in the user-guide tree', () => {
    const current = doc('docs/integrations/a', 'A', ['x'])
    const other = doc('docs/user-guide/b', 'B', ['x'])

    expect(relatedUserGuideFor(current, [current, other])).toEqual([])
  })

  it('caps at 10 matches', () => {
    const current = doc('docs/user-guide/a', 'A', ['x'])
    const candidates = Array.from({ length: 12 }, (_, i) => doc(`docs/user-guide/${i}`, `T${i}`, ['x']))

    expect(relatedUserGuideFor(current, [current, ...candidates])).toHaveLength(10)
  })

  it('reports overlap count on each result', () => {
    const current = doc('docs/user-guide/a', 'A', ['x', 'y', 'z'])
    const two = doc('docs/user-guide/b', 'B', ['x', 'y'])
    const one = doc('docs/user-guide/c', 'C', ['x'])

    const result = relatedUserGuideFor(current, [current, one, two])
    expect(result).toEqual([
      { slug: 'docs/user-guide/b', title: 'B', overlap: 2 },
      { slug: 'docs/user-guide/c', title: 'C', overlap: 1 },
    ])
  })

  it('prefers a focused match over a coincidental multi-tag match', () => {
    // current shares 1 of its 2 tags with `focused`
    // current shares 1 of its 2 tags with `coincidental` but `coincidental`
    // has 6 unrelated tags. Specificity-weighted Jaccard correctly puts the
    // focused match first because the union is much smaller.
    const current = doc('docs/user-guide/a', 'A', ['bedrock', 'aws'])
    const focused = doc('docs/user-guide/b', 'Focused', ['bedrock'])
    const coincidental = doc('docs/user-guide/c', 'Coincidental', [
      'aws',
      'multi-agent',
      'observability',
      'deployment',
      'tools',
      'hooks',
      'event-loop',
    ])

    const result = relatedUserGuideFor(current, [current, focused, coincidental])
    expect(result.map((r) => r.title)).toEqual(['Focused', 'Coincidental'])
  })
})

describe('userGuidePagesWithTag', () => {
  it('ranks pages by relevance score, descending', () => {
    // Current page has the safety tag plus another. Pages sharing more
    // weighted overlap with current should rank above ones that only carry
    // the queried tag.
    const current = doc('docs/user-guide/a', 'A', ['safety', 'bedrock'])
    const richMatch = doc('docs/user-guide/b', 'Rich', ['safety', 'bedrock'])
    const thinMatch = doc('docs/user-guide/c', 'Thin', ['safety'])

    const result = userGuidePagesWithTag('safety', current, [current, thinMatch, richMatch])
    expect(result.map((r) => r.title)).toEqual(['Rich', 'Thin'])
  })

  it('breaks score ties alphabetically by title', () => {
    const current = doc('docs/user-guide/a', 'A', ['safety'])
    const zebra = doc('docs/user-guide/z', 'Zebra', ['safety'])
    const apple = doc('docs/user-guide/b', 'Apple', ['safety'])

    const result = userGuidePagesWithTag('safety', current, [current, zebra, apple])
    expect(result.map((r) => r.title)).toEqual(['Apple', 'Zebra'])
  })

  it('excludes the current page from its own results', () => {
    const current = doc('docs/user-guide/a', 'A', ['safety'])
    const other = doc('docs/user-guide/b', 'B', ['safety'])

    const result = userGuidePagesWithTag('safety', current, [current, other])
    expect(result.map((r) => r.slug)).toEqual(['docs/user-guide/b'])
  })

  it('returns empty when no other page carries the tag', () => {
    const current = doc('docs/user-guide/a', 'A', ['safety'])
    const other = doc('docs/user-guide/b', 'B', ['production'])

    expect(userGuidePagesWithTag('safety', current, [current, other])).toEqual([])
  })

  it('ignores pages outside the user-guide tree', () => {
    const current = doc('docs/user-guide/a', 'A', ['safety'])
    const blog = doc('docs/integrations/b', 'Blog Post', ['safety'])
    const guide = doc('docs/user-guide/c', 'Guide', ['safety'])

    const result = userGuidePagesWithTag('safety', current, [current, blog, guide])
    expect(result.map((r) => r.slug)).toEqual(['docs/user-guide/c'])
  })

  it('ignores pages with no tags', () => {
    const current = doc('docs/user-guide/a', 'A', ['safety'])
    const untagged = doc('docs/user-guide/b', 'Untagged', [])

    expect(userGuidePagesWithTag('safety', current, [current, untagged])).toEqual([])
  })
})
