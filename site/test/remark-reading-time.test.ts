import { describe, it, expect } from 'vitest'
import remarkReadingTime from '../src/plugins/remark-reading-time'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

describe('remarkReadingTime', () => {
  it('injects readingTime into frontmatter', () => {
    const file = { data: {} } as { data: { astro?: { frontmatter?: Record<string, unknown> } } }
    const content = 'This is a test paragraph with some words. '.repeat(100)
    const tree = unified().use(remarkParse).parse(content)

    remarkReadingTime()(tree, file)

    expect(file.data.astro?.frontmatter?.readingTime).toBeDefined()
    expect(typeof file.data.astro!.frontmatter!.readingTime).toBe('string')
    expect(file.data.astro!.frontmatter!.readingTime).toContain('min read')
  })

  it('handles short content', () => {
    const file = { data: {} } as { data: { astro?: { frontmatter?: Record<string, unknown> } } }
    const tree = unified().use(remarkParse).parse('Hello world')

    remarkReadingTime()(tree, file)

    expect(file.data.astro?.frontmatter?.readingTime).toBeDefined()
    expect(file.data.astro!.frontmatter!.readingTime).toContain('min read')
  })

  it('initializes astro frontmatter if not present', () => {
    const file = { data: {} } as { data: { astro?: { frontmatter?: Record<string, unknown> } } }
    const tree = unified().use(remarkParse).parse('Test content')

    remarkReadingTime()(tree, file)

    expect(file.data.astro).toBeDefined()
    expect(file.data.astro!.frontmatter).toBeDefined()
  })
})
