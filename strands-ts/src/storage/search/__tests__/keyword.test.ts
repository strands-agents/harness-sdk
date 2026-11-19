import { describe, it, expect, vi } from 'vitest'
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

  it('returns the stored bytes with each result', async () => {
    const storage = new InMemoryStorage()
    const data = new TextEncoder().encode('enable dark mode in settings')
    await storage.write('notes/dark-mode.md', data)

    const results = await KeywordSearchStrategy.search(storage, 'dark mode')

    expect(results).toStrictEqual([{ key: 'notes/dark-mode.md', score: 2, data }])
  })

  it('skips entries whose read throws', async () => {
    const storage = new InMemoryStorage()
    await storage.write('good.md', new TextEncoder().encode('dark mode'))
    await storage.write('locked.md', new TextEncoder().encode('dark mode'))
    const originalRead = storage.read.bind(storage)
    vi.spyOn(storage, 'read').mockImplementation(async (key: string) => {
      if (key === 'locked.md') throw new Error("Failed to read 'locked.md' from local storage")
      return originalRead(key)
    })

    const results = await KeywordSearchStrategy.search(storage, 'dark mode')

    expect(results.map((result) => result.key)).toStrictEqual(['good.md'])
  })

  describe('configured to report sections', () => {
    const buriedAnswer = (): string => {
      const lines = Array.from({ length: 60 }, (_, index) => `line ${index + 1}: nothing of note`)
      lines[40] = 'line 41: the payment database connection pool was exhausted'
      return lines.join('\n')
    }

    const sectionOf = (content: string, range: { start: number; end: number }): string =>
      new TextDecoder().decode(new TextEncoder().encode(content).slice(range.start, range.end))

    it('reports the matching section of the entry rather than the whole entry', async () => {
      const storage = new InMemoryStorage()
      const content = buriedAnswer()
      await storage.write('incident.md', new TextEncoder().encode(content))

      const results = await new KeywordSearchStrategy({ sectionContextLines: 2 }).search(
        storage,
        'database connection pool exhausted'
      )

      const section = sectionOf(content, results[0]!.byteRange!)
      expect(section).toContain('line 41: the payment database connection pool was exhausted')
      expect(section.split('\n')).toHaveLength(5)
      expect(section).not.toContain('line 38:')
    })

    it('reads the section as byte offsets, so multi-byte content does not shift it', async () => {
      const storage = new InMemoryStorage()
      const content = ['😀'.repeat(10), 'the connection pool was exhausted', 'tail'].join('\n')
      await storage.write('incident.md', new TextEncoder().encode(content))

      const results = await new KeywordSearchStrategy({ sectionContextLines: 0 }).search(storage, 'connection pool')

      expect(sectionOf(content, results[0]!.byteRange!)).toBe('the connection pool was exhausted')
    })

    it('reports no section when only the key matched', async () => {
      const storage = new InMemoryStorage()
      await storage.write('connection-pool.md', new TextEncoder().encode('unrelated body text'))

      const results = await new KeywordSearchStrategy({ sectionContextLines: 2 }).search(storage, 'connection pool')

      expect(results[0]!.score).toBeGreaterThan(0)
      expect(results[0]!.byteRange).toBeUndefined()
    })

    it('covers the whole entry when left unconfigured', async () => {
      const storage = new InMemoryStorage()
      await storage.write('incident.md', new TextEncoder().encode(buriedAnswer()))

      const results = await new KeywordSearchStrategy().search(storage, 'connection pool')

      expect(results[0]!.byteRange).toBeUndefined()
    })
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

  it('ignores stop words in the query', async () => {
    const storage = new InMemoryStorage()
    await storage.write('deploy.md', new TextEncoder().encode('the deploy process runs nightly'))
    await storage.write('weather.md', new TextEncoder().encode('what is the weather like'))

    const results = await KeywordSearchStrategy.search(storage, 'what is the deploy process')

    expect(results.map((result) => result.key)).toStrictEqual(['deploy.md'])
  })

  it('returns empty array for a query made only of stop words', async () => {
    const storage = new InMemoryStorage()
    await storage.write('note.md', new TextEncoder().encode('what is the plan'))

    const results = await KeywordSearchStrategy.search(storage, 'what is the')
    expect(results).toEqual([])
  })

  it('does not score the file extension of the key', async () => {
    const storage = new InMemoryStorage()
    await storage.write('release-notes.md', new TextEncoder().encode('ship on fridays'))

    expect(await KeywordSearchStrategy.search(storage, 'update AGENTS.md')).toEqual([])
    expect((await KeywordSearchStrategy.search(storage, 'release')).map((result) => result.key)).toStrictEqual([
      'release-notes.md',
    ])
  })

  it('reads entries in concurrent batches of at most 8', async () => {
    const storage = new InMemoryStorage()
    for (let index = 0; index < 20; index++) {
      await storage.write(`note-${index}.md`, new TextEncoder().encode('dark mode'))
    }
    const originalRead = storage.read.bind(storage)
    let inFlight = 0
    let maxInFlight = 0
    vi.spyOn(storage, 'read').mockImplementation(async (key: string) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight--
      return originalRead(key)
    })

    const results = await KeywordSearchStrategy.search(storage, 'dark mode')

    expect(results).toHaveLength(20)
    expect(maxInFlight).toBe(8)
  })
})
