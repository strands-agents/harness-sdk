import { describe, it, expect } from 'vitest'
import { createRetrievalTool, RETRIEVAL_TOOL_NAME } from '../retrieval-tool.js'
import { Archive } from '../archive.js'
import { InMemoryStorage } from '../../storage/in-memory-storage.js'
import { KeywordSearchStrategy } from '../../storage/search/keyword.js'
import { ImageBlock } from '../../types/media.js'
import { JsonBlock, Message, TextBlock, ToolResultBlock } from '../../types/messages.js'
import type { SearchStrategy } from '../../storage/search/types.js'
import type { JSONValue } from '../../types/json.js'
import { collectGenerator } from '../../__fixtures__/model-test-helpers.js'
import { createMockContext } from '../../__fixtures__/tool-helpers.js'

function invoke(retrievalTool: ReturnType<typeof createRetrievalTool>, input: unknown): Promise<unknown> {
  return (retrievalTool as unknown as { invoke(input: unknown): Promise<unknown> }).invoke(input)
}

function encodeJSON(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

describe('retrieval tool', () => {
  function makeArchiveWithTextBlock(text: string): { archive: Archive; refPromise: Promise<string> } {
    const archive = new Archive(new InMemoryStorage(), 'test-session', 'test-agent')
    const refPromise = archive.store('tool-1', 0, encodeJSON({ text }))
    return { archive, refPromise }
  }

  it('has the correct tool name', () => {
    const archive = new Archive(new InMemoryStorage(), 'test-session', 'test-agent')
    const retrievalTool = createRetrievalTool(archive)
    expect(retrievalTool.name).toBe(RETRIEVAL_TOOL_NAME)
  })

  it('retrieves full text content', async () => {
    const { archive, refPromise } = makeArchiveWithTextBlock('hello world\nline two')
    const ref = await refPromise
    const retrievalTool = createRetrievalTool(archive)

    const result = await invoke(retrievalTool, { reference: ref })
    expect(result).toEqual(new TextBlock('hello world\nline two'))
  })

  it('searches with pattern', async () => {
    const text = Array.from(
      { length: 20 },
      (_, index) => `line ${index + 1}: ${index % 3 === 0 ? 'ERROR' : 'ok'}`
    ).join('\n')
    const { archive, refPromise } = makeArchiveWithTextBlock(text)
    const ref = await refPromise
    const retrievalTool = createRetrievalTool(archive)

    const result = (await invoke(retrievalTool, { reference: ref, pattern: 'ERROR' })) as string
    expect(result).toContain('ERROR')
    expect(result).toContain('match')
  })

  it('returns line range', async () => {
    const text = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join('\n')
    const { archive, refPromise } = makeArchiveWithTextBlock(text)
    const ref = await refPromise
    const retrievalTool = createRetrievalTool(archive)

    const result = (await invoke(retrievalTool, { reference: ref, line_range: { start: 5, end: 10 } })) as string
    expect(result).toContain('line 5')
    expect(result).toContain('line 10')
    expect(result).not.toContain('line 11')
  })

  it('returns error for unknown reference', async () => {
    const archive = new Archive(new InMemoryStorage(), 'test-session', 'test-agent')
    const retrievalTool = createRetrievalTool(archive)

    await expect(invoke(retrievalTool, { reference: '[ref: nonexistent]' })).rejects.toThrow(
      'reference not found: [ref: nonexistent]. Pass only the <id> from the placeholder\'s "[ref: <id>]". ' +
        'If that is what you passed, the content is unavailable — do not retry.'
    )
  })

  it('ignores whitespace around the reference', async () => {
    const archive = new Archive(new InMemoryStorage(), 'test-session', 'test-agent')
    await archive.store('tool-1', 0, encodeJSON({ text: 'original' }))

    expect(await invoke(createRetrievalTool(archive), { reference: ' tool-1 ' })).toEqual(new TextBlock('original'))
  })

  it('returns stored text that only looks like a placeholder', async () => {
    const archive = new Archive(new InMemoryStorage(), 'test-session', 'test-agent')
    await archive.store('tool-1', 0, encodeJSON({ text: '[Dropped] [ref: tool-2]' }))

    expect(await invoke(createRetrievalTool(archive), { reference: 'tool-1' })).toEqual(
      new TextBlock('[Dropped] [ref: tool-2]')
    )
  })

  describe('a tool result referenced by its toolUseId', () => {
    async function makeArchiveWithItems(): Promise<Archive> {
      const archive = new Archive(new InMemoryStorage(), 'test-session', 'test-agent')
      await archive.store('tool-1', 2, encodeJSON({ text: 'third ERROR' }))
      await archive.store('tool-1', 0, encodeJSON({ text: 'first' }))
      await archive.store('tool-1', 1, encodeJSON({ json: { count: 2 } }))
      await archive.store('tool-10', 0, encodeJSON({ text: 'another tool' }))
      return archive
    }

    it('returns every stored item in index order', async () => {
      const retrievalTool = createRetrievalTool(await makeArchiveWithItems())

      const result = await invoke(retrievalTool, { reference: 'tool-1' })

      expect(result).toEqual([
        new TextBlock('first'),
        new JsonBlock({ json: { count: 2 } }),
        new TextBlock('third ERROR'),
      ])
    })

    it('leaves out the textual items after the one that exhausts the budget', async () => {
      const archive = new Archive(new InMemoryStorage(), 'test-session', 'test-agent')
      await archive.store('tool-1', 0, encodeJSON({ text: 'a'.repeat(30) }))
      await archive.store('tool-1', 1, encodeJSON({ text: 'b'.repeat(30) }))
      await archive.store('tool-1', 2, encodeJSON({ text: 'c'.repeat(5) }))
      const retrievalTool = createRetrievalTool(archive, 10)

      expect(await invoke(retrievalTool, { reference: 'tool-1' })).toEqual([
        new TextBlock('a'.repeat(30)),
        new TextBlock(`${'b'.repeat(10)}\n\n[truncated]`),
      ])
    })

    it('returns media as media and cuts only the text to the result budget', async () => {
      const archive = new Archive(new InMemoryStorage(), 'test-session', 'test-agent')
      await archive.store('tool-1', 0, encodeJSON({ image: { format: 'png', source: { bytes: 'iVBORw0KGgo=' } } }))
      await archive.store('tool-1', 1, encodeJSON({ text: 'x'.repeat(100) }))
      const retrievalTool = createRetrievalTool(archive, 10)

      const result = (await invoke(retrievalTool, { reference: 'tool-1' })) as unknown[]

      expect(result[0]).toBeInstanceOf(ImageBlock)
      expect(result[1]).toEqual(new TextBlock(`${'x'.repeat(40)}\n\n[truncated]`))
    })

    it('searches across the items text', async () => {
      const retrievalTool = createRetrievalTool(await makeArchiveWithItems())

      const result = (await invoke(retrievalTool, { reference: 'tool-1', pattern: 'ERROR' })) as string

      expect(result).toContain('third ERROR')
      expect(result).not.toContain('another tool')
    })

    it('returns the single item itself when the result holds one', async () => {
      const archive = new Archive(new InMemoryStorage(), 'test-session', 'test-agent')
      await archive.store('tool-1', 0, encodeJSON({ text: 'only' }))
      const retrievalTool = createRetrievalTool(archive)

      expect(await invoke(retrievalTool, { reference: 'tool-1' })).toEqual(new TextBlock('only'))
    })

    it('resolves an id before an exact key whose stem is another id', async () => {
      const archive = new Archive(new InMemoryStorage(), 'test-session', 'test-agent')
      await archive.store('tool', 0, encodeJSON({ text: 'tool item 0' }))
      await archive.store('tool', 1, encodeJSON({ text: 'tool item 1' }))
      await archive.store('tool_1', 0, encodeJSON({ text: 'tool_1 item 0' }))
      await archive.store('tool_1', 1, encodeJSON({ text: 'tool_1 item 1' }))
      const retrievalTool = createRetrievalTool(archive)

      expect(await invoke(retrievalTool, { reference: 'tool_1' })).toEqual([
        new TextBlock('tool_1 item 0'),
        new TextBlock('tool_1 item 1'),
      ])
      expect(await invoke(retrievalTool, { reference: 'tool_1_1' })).toEqual(new TextBlock('tool_1 item 1'))
    })

    it('refuses to serve a stored placeholder as the original', async () => {
      const archive = new Archive(new InMemoryStorage(), 'test-session', 'test-agent')
      await archive.store(
        'tool-1',
        0,
        encodeJSON({ text: '[Dropped] [ref: tool-1]', offloaded: { method: 'drop', ref: 'tool-1' } })
      )
      const retrievalTool = createRetrievalTool(archive)

      await expect(invoke(retrievalTool, { reference: 'tool-1' })).rejects.toThrow(
        'original content for reference tool-1 is no longer available — do not retry.'
      )
    })

    it('matches the id exactly when ids contain underscores and digits', async () => {
      const archive = new Archive(new InMemoryStorage(), 'test-session', 'test-agent')
      await archive.store('call', 0, encodeJSON({ text: 'bare' }))
      await archive.store('call_12', 0, encodeJSON({ text: 'twelve' }))
      const retrievalTool = createRetrievalTool(archive)

      expect(await invoke(retrievalTool, { reference: 'call' })).toEqual(new TextBlock('bare'))
      expect(await invoke(retrievalTool, { reference: 'call_12' })).toEqual(new TextBlock('twelve'))
    })
  })

  describe('removed messages', () => {
    const removed = [
      { role: 'user', content: [{ text: 'alpha' }], trackingId: 'r0' },
      {
        role: 'assistant',
        content: [{ toolUse: { toolUseId: 't', name: 'x', input: {} } }],
        trackingId: 'r1',
      },
      {
        role: 'user',
        content: [
          { toolResult: { toolUseId: 't', status: 'success', content: [{ text: 'beta ERROR' }, { json: 1 }] } },
        ],
        trackingId: 'r2',
      },
    ]

    it('returns the stored messages as role markers and their content, and searches their text', async () => {
      const archive = new Archive(new InMemoryStorage(), 'test-session', 'test-agent')
      await archive.store('removed-m1', 0, encodeJSON(removed))
      const retrievalTool = createRetrievalTool(archive)

      expect(await invoke(retrievalTool, { reference: 'removed-m1' })).toEqual([
        new TextBlock('\n---\n[user]'),
        new TextBlock('alpha'),
        new TextBlock('\n---\n[assistant]'),
        new TextBlock('[tool call: x] {}'),
        new TextBlock('\n---\n[user]'),
        new TextBlock('[tool result: x]'),
        new TextBlock('beta ERROR'),
        new TextBlock('1'),
      ])
      const matches = (await invoke(retrievalTool, { reference: 'removed-m1', pattern: 'ERROR' })) as string
      expect(matches).toContain('[1 match for /ERROR/]')
      expect(matches).toContain('> 2| beta ERROR')
    })

    it('returns media in the stored messages as media and cuts only their text', async () => {
      const archive = new Archive(new InMemoryStorage(), 'test-session', 'test-agent')
      const image = { image: { format: 'png', source: { bytes: 'iVBORw0KGgo=' } } }
      await archive.store('removed-m1', 0, encodeJSON([{ role: 'user', content: [image, { text: 'x'.repeat(100) }] }]))
      const retrievalTool = createRetrievalTool(archive, 10)

      const result = (await invoke(retrievalTool, { reference: 'removed-m1' })) as unknown[]

      expect(result[0]).toEqual(new TextBlock('\n---\n[user]'))
      expect((result[1] as ImageBlock).toJSON()).toEqual(image)
      expect(result[2]).toEqual(new TextBlock(`${'x'.repeat(40 - '\n---\n[user]'.length)}\n\n[truncated]`))
    })
  })

  it('restores image content as an ImageBlock instead of raw JSON', async () => {
    const archive = new Archive(new InMemoryStorage(), 'test-session', 'test-agent')
    const imageData = { image: { format: 'png', source: { bytes: 'iVBORw0KGgo=' } } }
    const ref = await archive.store('tool-img', 0, encodeJSON(imageData))
    const retrievalTool = createRetrievalTool(archive)

    const result = await invoke(retrievalTool, { reference: ref })
    expect(result).toBeInstanceOf(ImageBlock)
    expect((result as ImageBlock).format).toBe('png')
  })

  it('retrieves JSON content as parsed object', async () => {
    const archive = new Archive(new InMemoryStorage(), 'test-session', 'test-agent')
    const json = { key: 'value', nested: [1, 2, 3] }
    const ref = await archive.store('tool-json', 0, encodeJSON({ json }))
    const retrievalTool = createRetrievalTool(archive)

    const result = await invoke(retrievalTool, { reference: ref })
    expect(result).toEqual(new JsonBlock({ json }))
  })

  it('returns error when searching non-text content', async () => {
    const archive = new Archive(new InMemoryStorage(), 'test-session', 'test-agent')
    const imageData = { image: { format: 'png', source: { bytes: 'iVBORw0KGgo=' } } }
    const ref = await archive.store('tool-img', 0, encodeJSON(imageData))
    const retrievalTool = createRetrievalTool(archive)

    await expect(invoke(retrievalTool, { reference: ref, pattern: 'test' })).rejects.toThrow(
      'cannot search non-text content'
    )
  })

  // Regression: https://github.com/strands-agents/harness-sdk/issues/4241 — these returned the error
  // text as a success result, and a model reading "Error" under success retries and then invents the
  // content. Driven through `stream`, which is what produces the status the model sees; `invoke`
  // deliberately lets errors throw and so cannot observe it.
  describe('failures carry error status', () => {
    async function streamResult(
      retrievalTool: ReturnType<typeof createRetrievalTool>,
      input: JSONValue
    ): Promise<ToolResultBlock> {
      const toolUse = { name: RETRIEVAL_TOOL_NAME, toolUseId: 'tu-1', input }
      const { result } = await collectGenerator(retrievalTool.stream(createMockContext(toolUse)))
      return result
    }

    it('reports an unknown reference as an error', async () => {
      const archive = new Archive(new InMemoryStorage(), 'test-session', 'test-agent')

      const result = await streamResult(createRetrievalTool(archive), { reference: 'tu-old_0' })

      expect(result.status).toBe('error')
      expect((result.content[0] as TextBlock).text).toContain('reference not found: tu-old_0')
      expect((result.content[0] as TextBlock).text).toContain('do not retry')
    })

    it('reports a stored placeholder as an error', async () => {
      const archive = new Archive(new InMemoryStorage(), 'test-session', 'test-agent')
      await archive.store(
        'tool-1',
        0,
        encodeJSON({ text: '[Dropped] [ref: tool-1]', offloaded: { method: 'drop', ref: 'tool-1' } })
      )

      const result = await streamResult(createRetrievalTool(archive), { reference: 'tool-1' })

      expect(result.status).toBe('error')
      expect((result.content[0] as TextBlock).text).toContain('no longer available')
    })

    it('reports an unsearchable entry as an error', async () => {
      const archive = new Archive(new InMemoryStorage(), 'test-session', 'test-agent')
      const ref = await archive.store(
        'tool-img',
        0,
        encodeJSON({ image: { format: 'png', source: { bytes: 'iVBO' } } })
      )

      const result = await streamResult(createRetrievalTool(archive), { reference: ref, pattern: 'test' })

      expect(result.status).toBe('error')
      expect((result.content[0] as TextBlock).text).toContain('cannot search non-text content')
    })

    it('reports an out-of-range line_range as an error', async () => {
      const { archive, refPromise } = makeArchiveWithTextBlock('only one line')
      const ref = await refPromise

      const result = await streamResult(createRetrievalTool(archive), {
        reference: ref,
        line_range: { start: 9, end: 2 },
      })

      expect(result.status).toBe('error')
      expect((result.content[0] as TextBlock).text).toContain('must be <= line_range.end')
    })
  })

  describe('a query', () => {
    /** Filler that shares no terms with the queries below, so only the planted answer can rank. */
    function buriedAnswerLines(): string[] {
      const lines = Array.from({ length: 80 }, (_, index) => `line ${index + 1}: nothing of note`)
      lines[61] = 'line 62: the payment database connection pool was exhausted at peak traffic'
      return lines
    }

    function makeArchiveWithBuriedAnswer(): { archive: Archive; refPromise: Promise<string> } {
      return makeArchiveWithTextBlock(buriedAnswerLines().join('\n'))
    }

    it('returns the sections that answer the query', async () => {
      const { archive, refPromise } = makeArchiveWithBuriedAnswer()
      const ref = await refPromise
      const retrievalTool = createRetrievalTool(archive)

      const result = (await invoke(retrievalTool, {
        reference: ref,
        query: 'why was the database connection pool exhausted',
      })) as string

      expect(result).toContain('connection pool was exhausted')
      expect(result).toMatch(/^\[showing \d+ of \d+ relevant sections? for/)
    })

    it('writes nothing to the storage to answer a query', async () => {
      const storage = new InMemoryStorage()
      const archive = new Archive(storage, 'test-session', 'test-agent')
      const ref = await archive.store('tool-1', 0, encodeJSON({ text: buriedAnswerLines().join('\n') }))
      const stored = await storage.list('')

      await invoke(createRetrievalTool(archive), { reference: ref, query: 'connection pool exhausted' })

      expect(await storage.list('')).toEqual(stored)
      expect(Object.keys(await archive.takeSnapshot())).toEqual([ref])
    })

    it('ranks on a storage with no search of its own', async () => {
      const backing = new InMemoryStorage()
      // A minimal custom backend: the Storage contract without the optional search().
      const archive = new Archive(
        {
          write: (key, data) => backing.write(key, data),
          read: (key) => backing.read(key),
          delete: (key) => backing.delete(key),
          list: (prefix) => backing.list(prefix),
        },
        'test-session',
        'test-agent'
      )
      const ref = await archive.store('tool-1', 0, encodeJSON({ text: buriedAnswerLines().join('\n') }))

      const result = (await invoke(createRetrievalTool(archive), {
        reference: ref,
        query: 'database connection pool exhausted',
      })) as string

      expect(result).toContain('connection pool was exhausted')
      expect(await backing.list('')).toEqual([`context/test-session/scopes/agent/test-agent/${ref}`])
    })

    it('rejects a query and a pattern together', async () => {
      const { archive, refPromise } = makeArchiveWithBuriedAnswer()
      const ref = await refPromise
      const retrievalTool = createRetrievalTool(archive)

      await expect(invoke(retrievalTool, { reference: ref, query: 'pool', pattern: 'pool' })).rejects.toThrow(
        'pass either query or pattern, not both. Use query for a question, pattern for a literal string.'
      )
    })

    it('keeps the result within max_tokens and reports what was withheld', async () => {
      const { archive, refPromise } = makeArchiveWithBuriedAnswer()
      const ref = await refPromise
      const retrievalTool = createRetrievalTool(archive)

      const result = (await invoke(retrievalTool, {
        reference: ref,
        query: 'line note exhausted',
        max_tokens: 200,
      })) as string

      expect(result.length).toBeLessThanOrEqual(800)
      expect(result).toContain('withheld by max_tokens')
    })

    // A budget below one section's worth returns the head of the top-ranked section, cut by line.
    // The answer surviving the cut is not guaranteed at this budget — the body is ordered by line
    // number, so a match late in the section is cut — hence the truncation message telling the model
    // to raise max_tokens rather than conclude the content does not hold the answer.
    it('cuts the top section to fit when max_tokens leaves no room for a whole one', async () => {
      const { archive, refPromise } = makeArchiveWithBuriedAnswer()
      const ref = await refPromise
      const retrievalTool = createRetrievalTool(archive)

      const result = (await invoke(retrievalTool, {
        reference: ref,
        query: 'line note exhausted',
        max_tokens: 100,
      })) as string

      expect(result.length).toBeLessThanOrEqual(400)
      expect(result).toContain('output truncated, raise max_tokens')
      // Lines from the top-ranked section, contiguous and in order, rather than a section boundary.
      expect(result).toMatch(/ 55\| line 55/)
      expect(result).not.toContain('---')
    })

    it('clamps max_tokens to the configured result budget', async () => {
      const { archive, refPromise } = makeArchiveWithBuriedAnswer()
      const ref = await refPromise
      const retrievalTool = createRetrievalTool(archive, 50)

      const result = (await invoke(retrievalTool, {
        reference: ref,
        query: 'line note exhausted',
        max_tokens: 100_000,
      })) as string

      expect(result.length).toBeLessThanOrEqual(200)
    })

    it('ranks only within line_range', async () => {
      const { archive, refPromise } = makeArchiveWithBuriedAnswer()
      const ref = await refPromise
      const retrievalTool = createRetrievalTool(archive)

      const result = (await invoke(retrievalTool, {
        reference: ref,
        query: 'why was the database connection pool exhausted',
        line_range: { start: 1, end: 40 },
      })) as string

      expect(result).not.toContain('connection pool was exhausted')
    })

    it('widens a section with context_lines, the same parameter the pattern path takes', async () => {
      const { archive, refPromise } = makeArchiveWithBuriedAnswer()
      const ref = await refPromise
      const retrievalTool = createRetrievalTool(archive)
      const linesOf = (result: string): number => result.split('\n').filter((line) => /^\s*\d+\|/.test(line)).length

      const narrow = (await invoke(retrievalTool, { reference: ref, query: 'connection pool exhausted' })) as string
      const wide = (await invoke(retrievalTool, {
        reference: ref,
        query: 'connection pool exhausted',
        context_lines: 12,
      })) as string

      expect(linesOf(narrow)).toBe(11)
      expect(linesOf(wide)).toBe(25)
    })

    it('returns the best-scoring section first rather than the earliest', async () => {
      const lines = Array.from({ length: 80 }, (_, index) => `line ${index + 1}: nothing of note`)
      lines[19] = 'line 20: the database was briefly slow'
      lines[61] = 'line 62: the payment database connection pool was exhausted at peak traffic'
      const { archive, refPromise } = makeArchiveWithTextBlock(lines.join('\n'))
      const ref = await refPromise
      const retrievalTool = createRetrievalTool(archive)

      const result = (await invoke(retrievalTool, {
        reference: ref,
        query: 'database connection pool exhausted',
        max_tokens: 150,
      })) as string

      expect(result).toContain('connection pool was exhausted')
      expect(result).not.toContain('briefly slow')
    })

    it('reports when nothing in the entry is relevant', async () => {
      const { archive, refPromise } = makeArchiveWithBuriedAnswer()
      const ref = await refPromise
      const retrievalTool = createRetrievalTool(archive)

      const result = (await invoke(retrievalTool, {
        reference: ref,
        query: 'kubernetes ingress certificate',
      })) as string
      expect(result).toBe("No relevant content found for query 'kubernetes ingress certificate'.")
    })

    describe('delegated to the configured search strategy', () => {
      /** Archives `text` under `track-1_0`, the framing a strategy can report sections of. */
      async function archiveText(archive: Archive, text: string): Promise<string> {
        await archive.storeMessage(new Message({ role: 'user', content: [new TextBlock(text)], trackingId: 'track-1' }))
        return 'track-1_0'
      }

      /**
       * A strategy standing in for a backend index: it reports the given lines as the matching
       * sections of every entry, whatever the query. A result holding a line with none of the
       * query's terms can only have come from the strategy rather than the local scan.
       */
      function lineStrategy(...matches: number[]): SearchStrategy<InMemoryStorage> {
        return {
          search: async (storage, _query, options) => {
            const keys = await storage.list(options?.prefix ?? '')
            const entries = await Promise.all(keys.map(async (key) => ({ key, data: (await storage.read(key))! })))
            return entries.map(({ key, data }) => ({
              key,
              score: 1,
              data,
              byteRanges: matches.map((line) => byteRangeOfLine(data, line)),
            }))
          },
        }
      }

      /** The byte offsets of one 0-indexed line of `data`, `end` exclusive, as a strategy reports them. */
      function byteRangeOfLine(data: Uint8Array, line: number): { start: number; end: number } {
        const encoder = new TextEncoder()
        const lines = new TextDecoder().decode(data).split('\n')
        const start = lines.slice(0, line).reduce((total, text) => total + encoder.encode(text).length + 1, 0)
        return { start, end: start + encoder.encode(lines[line]!).length }
      }

      it('returns the sections the strategy ranked rather than scanning the text itself', async () => {
        const archive = new Archive(
          new InMemoryStorage({ searchStrategy: lineStrategy(9) }),
          'test-session',
          'test-agent'
        )
        const ref = await archiveText(archive, buriedAnswerLines().join('\n'))

        const result = (await invoke(createRetrievalTool(archive), {
          reference: ref,
          query: 'kubernetes ingress certificate',
        })) as string

        expect(result).toContain('line 10: nothing of note')
        expect(result).toMatch(/^\[showing 1 of 1 relevant section for/)
      })

      it('scans the text itself when the strategy ranked the entry without reporting a section', async () => {
        const wholeEntry: SearchStrategy<InMemoryStorage> = {
          search: async (storage, _query, options) =>
            (await storage.list(options?.prefix ?? '')).map((key) => ({ key, score: 1 })),
        }
        const archive = new Archive(new InMemoryStorage({ searchStrategy: wholeEntry }), 'test-session', 'test-agent')
        const ref = await archiveText(archive, buriedAnswerLines().join('\n'))

        const result = (await invoke(createRetrievalTool(archive), {
          reference: ref,
          query: 'why was the database connection pool exhausted',
        })) as string

        expect(result).toContain('connection pool was exhausted')
      })

      it('drops a strategy section outside line_range', async () => {
        const archive = new Archive(
          new InMemoryStorage({ searchStrategy: lineStrategy(9) }),
          'test-session',
          'test-agent'
        )
        const ref = await archiveText(archive, buriedAnswerLines().join('\n'))

        const result = (await invoke(createRetrievalTool(archive), {
          reference: ref,
          query: 'kubernetes ingress certificate',
          line_range: { start: 55, end: 70 },
        })) as string

        expect(result).toBe("No relevant content found for query 'kubernetes ingress certificate' in lines 55-70.")
      })

      it('cuts a strategy section back to line_range', async () => {
        const archive = new Archive(
          new InMemoryStorage({ searchStrategy: new KeywordSearchStrategy({ sectionContextLines: 5 }) }),
          'test-session',
          'test-agent'
        )
        const ref = await archiveText(archive, buriedAnswerLines().join('\n'))

        const result = (await invoke(createRetrievalTool(archive), {
          reference: ref,
          query: 'connection pool exhausted',
          line_range: { start: 60, end: 64 },
        })) as string

        expect(result).toContain('connection pool was exhausted')
        expect(result).toMatch(/ 60\| line 60/)
        expect(result).toMatch(/ 64\| line 64/)
        expect(result).not.toMatch(/ 59\| line 59/)
        expect(result).not.toMatch(/ 65\| line 65/)
      })

      it('places each strategy section at its own entry lines across a multi-entry reference', async () => {
        const archive = new Archive(
          new InMemoryStorage({ searchStrategy: lineStrategy(1) }),
          'test-session',
          'test-agent'
        )
        const toolResult = new ToolResultBlock({
          toolUseId: 'tool-1',
          status: 'success',
          content: [new TextBlock('first alpha\nfirst beta'), new TextBlock('second alpha\nsecond beta')],
        })
        await archive.storeMessage(new Message({ role: 'user', content: [toolResult], trackingId: 'track-1' }))

        const result = (await invoke(createRetrievalTool(archive), {
          reference: 'tool-1',
          query: 'kubernetes ingress certificate',
        })) as string

        // Line 2 of each entry: the second entry's lines are offset by the first entry's length.
        expect(result).toContain('2| first beta')
        expect(result).toContain('4| second beta')
        expect(result).not.toContain('first alpha')
      })
    })

    it('rejects a query against an entry with no text to rank', async () => {
      const archive = new Archive(new InMemoryStorage(), 'test-session', 'test-agent')
      const ref = await archive.store(
        'tool-img',
        0,
        encodeJSON({ image: { format: 'png', source: { bytes: 'iVBORw0=' } } })
      )
      const retrievalTool = createRetrievalTool(archive)

      await expect(invoke(retrievalTool, { reference: ref, query: 'anything' })).rejects.toThrow(
        'cannot search non-text content'
      )
    })
  })
})
