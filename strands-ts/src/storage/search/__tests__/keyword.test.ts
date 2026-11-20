import { describe, it, expect, vi } from 'vitest'
import { KeywordSearchStrategy, matchingSections, sectionByteRanges } from '../keyword.js'
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

      const section = sectionOf(content, results[0]!.byteRanges![0]!)
      expect(section).toContain('line 41: the payment database connection pool was exhausted')
      expect(section.split('\n')).toHaveLength(5)
      expect(section).not.toContain('line 38:')
    })

    it('reports every matching section, best-first, so a consumer can show as many as it has room for', async () => {
      const storage = new InMemoryStorage()
      const lines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}: nothing of note`)
      lines[5] = 'line 6: the connection pool'
      lines[20] = 'line 21: the connection pool was exhausted'
      const content = lines.join('\n')
      await storage.write('incident.md', new TextEncoder().encode(content))

      const results = await new KeywordSearchStrategy({ sectionContextLines: 1 }).search(
        storage,
        'connection pool exhausted'
      )

      expect(results[0]!.byteRanges).toHaveLength(2)
      expect(results[0]!.byteRanges!.map((range) => sectionOf(content, range))).toStrictEqual([
        ['line 20: nothing of note', 'line 21: the connection pool was exhausted', 'line 22: nothing of note'].join(
          '\n'
        ),
        ['line 5: nothing of note', 'line 6: the connection pool', 'line 7: nothing of note'].join('\n'),
      ])
    })

    it('reads the section as byte offsets, so multi-byte content does not shift it', async () => {
      const storage = new InMemoryStorage()
      const content = ['😀'.repeat(10), 'the connection pool was exhausted', 'tail'].join('\n')
      await storage.write('incident.md', new TextEncoder().encode(content))

      const results = await new KeywordSearchStrategy({ sectionContextLines: 0 }).search(storage, 'connection pool')

      expect(sectionOf(content, results[0]!.byteRanges![0]!)).toBe('the connection pool was exhausted')
    })

    it('reports no section when only the key matched', async () => {
      const storage = new InMemoryStorage()
      await storage.write('connection-pool.md', new TextEncoder().encode('unrelated body text'))

      const results = await new KeywordSearchStrategy({ sectionContextLines: 2 }).search(storage, 'connection pool')

      expect(results[0]!.score).toBeGreaterThan(0)
      expect(results[0]!.byteRanges).toBeUndefined()
    })

    it('covers the whole entry when left unconfigured', async () => {
      const storage = new InMemoryStorage()
      await storage.write('incident.md', new TextEncoder().encode(buriedAnswer()))

      const results = await new KeywordSearchStrategy().search(storage, 'connection pool')

      expect(results[0]!.byteRanges).toBeUndefined()
    })
  })

  describe('narrowed by options', () => {
    const storageOf = async (...keys: string[]): Promise<InMemoryStorage> => {
      const storage = new InMemoryStorage()
      for (const key of keys) await storage.write(key, new TextEncoder().encode('dark mode toggle'))
      return storage
    }

    it('scans only the entries under a prefix', async () => {
      const storage = await storageOf('notes/a.md', 'notes/b.md', 'other/c.md')

      const results = await KeywordSearchStrategy.search(storage, 'dark mode', { prefix: 'notes/' })

      expect(results.map((result) => result.key)).toStrictEqual(['notes/a.md', 'notes/b.md'])
    })

    it('returns at most the requested number of results', async () => {
      const storage = await storageOf('a.md', 'b.md', 'c.md')

      const results = await KeywordSearchStrategy.search(storage, 'dark mode', { limit: 2 })

      expect(results).toHaveLength(2)
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

  it('keeps a section whose matching line a better overlapping section does not reach', () => {
    const content = lines(15)
    content[5] = 'alpha beta'
    content[9] = 'alpha'

    // Sections 3-7 and 7-11 overlap on line 7, and the better one stops three lines short of line 9.
    const sections = matchingSections(content, (text) => text.split(' ').filter(isQueryTerm).length, 2)

    expect(sections.map((section) => [section.start, section.end])).toStrictEqual([
      [3, 7],
      [7, 11],
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

describe('sectionByteRanges', () => {
  it('returns byte offsets that slice each section out of the encoded content', () => {
    const content = ['alpha', 'the answer', 'omega'].join('\n')

    const ranges = sectionByteRanges(content, (text) => (text.includes('the answer') ? 1 : 0), 0)

    expect(ranges.map((range) => slice(content, range))).toStrictEqual(['the answer'])
  })

  it('offsets by bytes rather than characters, so multi-byte content does not shift the section', () => {
    const content = ['😀'.repeat(5), 'the answer', 'ω'].join('\n')

    const ranges = sectionByteRanges(content, (text) => (text.includes('the answer') ? 1 : 0), 0)

    expect(ranges.map((range) => slice(content, range))).toStrictEqual(['the answer'])
  })

  it('reaches the final byte when the section ends at the last line', () => {
    const content = ['alpha', 'the answer'].join('\n')

    const ranges = sectionByteRanges(content, (text) => (text.includes('the answer') ? 1 : 0), 0)

    expect(ranges).toStrictEqual([{ start: 6, end: 16 }])
    expect(slice(content, ranges[0]!)).toBe('the answer')
  })

  it('reports at most 50 sections, so a term matching every line cannot flood a result', () => {
    const content = Array.from({ length: 200 }, () => 'the answer').join('\n')

    expect(sectionByteRanges(content, (text) => (text.includes('the answer') ? 1 : 0), 0)).toHaveLength(50)
  })

  it('returns nothing when nothing in the content matched', () => {
    expect(sectionByteRanges('alpha\nomega', () => 0, 2)).toStrictEqual([])
  })
})

function isQueryTerm(word: string): boolean {
  return word === 'alpha' || word === 'beta'
}

/** Slices a `byteRanges` entry out of content the way a consumer of a search result does. */
function slice(content: string, range: { start: number; end: number }): string {
  return new TextDecoder().decode(new TextEncoder().encode(content).slice(range.start, range.end))
}
