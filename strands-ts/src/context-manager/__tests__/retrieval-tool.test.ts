import { describe, it, expect } from 'vitest'
import { createRetrievalTool, RETRIEVAL_TOOL_NAME } from '../retrieval-tool.js'
import { Archive } from '../archive.js'
import { InMemoryStorage } from '../../storage/in-memory-storage.js'
import { ImageBlock } from '../../types/media.js'
import { JsonBlock, TextBlock, ToolResultBlock } from '../../types/messages.js'
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
})
