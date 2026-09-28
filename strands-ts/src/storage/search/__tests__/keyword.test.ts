import { describe, it, expect } from 'vitest'
import { KeywordSearchStrategy } from '../keyword.js'
import { InMemoryStorage } from '../../in-memory-storage.js'

describe('KeywordSearchStrategy', () => {
  it('returns matching entries scored by token overlap', async () => {
    const storage = new InMemoryStorage()
    await storage.write('notes/dark-mode.md', new TextEncoder().encode('enable dark mode in settings'))
    await storage.write('notes/deploy.md', new TextEncoder().encode('deploy to production'))

    const results = await KeywordSearchStrategy.search(storage, 'dark mode')

    expect(results).toHaveLength(1)
    expect(results[0]!.key).toBe('notes/dark-mode.md')
    expect(results[0]!.score).toBeGreaterThan(0)
  })

  it('returns empty array for empty query', async () => {
    const storage = new InMemoryStorage()
    await storage.write('key', new TextEncoder().encode('content'))

    const results = await KeywordSearchStrategy.search(storage, '')
    expect(results).toEqual([])
  })

  it('returns empty array for whitespace-only query', async () => {
    const storage = new InMemoryStorage()
    await storage.write('key', new TextEncoder().encode('content'))

    const results = await KeywordSearchStrategy.search(storage, '   ')
    expect(results).toEqual([])
  })

  it('matches case-insensitively', async () => {
    const storage = new InMemoryStorage()
    await storage.write('note.md', new TextEncoder().encode('Dark Mode Toggle'))

    const results = await KeywordSearchStrategy.search(storage, 'dark mode')

    expect(results).toHaveLength(1)
  })

  it('includes the key in the scoring text', async () => {
    const storage = new InMemoryStorage()
    await storage.write('dark-mode.md', new TextEncoder().encode('some unrelated body'))

    const results = await KeywordSearchStrategy.search(storage, 'dark mode')

    expect(results).toHaveLength(1)
    expect(results[0]!.key).toBe('dark-mode.md')
  })

  it('ranks results by score descending', async () => {
    const storage = new InMemoryStorage()
    await storage.write('a.md', new TextEncoder().encode('dark'))
    await storage.write('b.md', new TextEncoder().encode('dark mode toggle feature'))

    const results = await KeywordSearchStrategy.search(storage, 'dark mode')

    expect(results.length).toBe(2)
    expect(results[0]!.score).toBeGreaterThanOrEqual(results[1]!.score)
  })

  it('returns empty array when no content matches', async () => {
    const storage = new InMemoryStorage()
    await storage.write('note.md', new TextEncoder().encode('completely unrelated content'))

    const results = await KeywordSearchStrategy.search(storage, 'kubernetes deployment')
    expect(results).toEqual([])
  })
})
