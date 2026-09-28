import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ToolContext } from '../../../tools/tool.js'
import type { LocalAgent } from '../../../types/agent.js'
import { Agent } from '../../../agent/agent.js'
import { makeWebFetch, webFetch, DEFAULT_MAX_BYTES, DEFAULT_MAX_CONTENT_CHARS } from '../web-fetch.js'
import { WEB_FETCH_DESCRIPTION_MARKDOWN, WEB_FETCH_DESCRIPTION_AGENTIC } from '../types.js'

const mockInvoke = vi.fn()

vi.mock('../../../agent/agent.js', () => ({
  Agent: vi.fn().mockImplementation(function () {
    return { invoke: mockInvoke }
  }),
}))

function makeAgentResult(text: string) {
  return {
    lastMessage: {
      content: [{ type: 'textBlock', text }],
    },
    toString: () => text,
  }
}

vi.mock('../extract.js', () => ({
  htmlToMarkdown: vi.fn((html: string) => `md:${html}`),
}))

describe('webFetch tool', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function mockFetch(body: string, options: { status?: number; statusText?: string; contentType?: string } = {}): void {
    const { status = 200, statusText = 'OK', contentType = 'text/plain' } = options
    const headers = new Map<string, string>([['content-type', contentType]])
    const encoded = new TextEncoder().encode(body)
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: status < 400,
      status,
      statusText,
      headers: { get: (key: string) => headers.get(key) ?? null },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoded)
          controller.close()
        },
      }),
    })
  }

  function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
    return {
      toolUse: { name: 'web_fetch', toolUseId: 'test-id', input: {} },
      agent: { model: undefined } as unknown as LocalAgent,
      invocationState: {},
      cancelSignal: new AbortController().signal,
      interrupt: vi.fn() as ToolContext['interrupt'],
      ...overrides,
    }
  }

  describe('makeWebFetch factory', () => {
    it('defaults to agentic mode', () => {
      expect(makeWebFetch().description).toBe(WEB_FETCH_DESCRIPTION_AGENTIC)
      expect(webFetch.name).toBe('web_fetch')
    })

    it('markdown mode uses markdown description', () => {
      expect(makeWebFetch({ mode: 'markdown' }).description).toBe(WEB_FETCH_DESCRIPTION_MARKDOWN)
    })

    it('custom name and description override defaults', () => {
      const t = makeWebFetch({ name: 'fetch_page', description: 'custom desc' })
      expect(t.name).toBe('fetch_page')
      expect(t.description).toBe('custom desc')
    })

    it('rejects non-positive maxBytes', () => {
      expect(() => makeWebFetch({ maxBytes: 0 })).toThrow(/maxBytes/)
      expect(() => makeWebFetch({ maxBytes: -1 })).toThrow(/maxBytes/)
    })

    it('rejects non-positive maxContentChars', () => {
      expect(() => makeWebFetch({ maxContentChars: 0 })).toThrow(/maxContentChars/)
      expect(() => makeWebFetch({ maxContentChars: -1 })).toThrow(/maxContentChars/)
    })

    it('exports correct default constants', () => {
      expect(DEFAULT_MAX_BYTES).toBe(5 * 1024 * 1024)
      expect(DEFAULT_MAX_CONTENT_CHARS).toBe(50_000)
    })
  })

  describe('markdown mode', () => {
    it('html response is converted to markdown', async () => {
      mockFetch('<h1>Hi</h1>', { contentType: 'text/html' })
      const result = await makeWebFetch({ mode: 'markdown' }).invoke({ url: 'https://example.com/' })
      expect(result).toBe('md:<h1>Hi</h1>')
    })

    it('xml content type is also converted to markdown', async () => {
      mockFetch('<p>xhtml</p>', { contentType: 'application/xhtml+xml' })
      const result = await makeWebFetch({ mode: 'markdown' }).invoke({ url: 'https://example.com/page.xhtml' })
      expect(result).toBe('md:<p>xhtml</p>')
    })

    it('non-html response is returned as-is', async () => {
      mockFetch('plain text response', { contentType: 'text/plain' })
      const result = await makeWebFetch({ mode: 'markdown' }).invoke({ url: 'https://example.com/robots.txt' })
      expect(result).toBe('plain text response')
    })

    it('content is truncated at maxContentChars', async () => {
      mockFetch('x'.repeat(200), { contentType: 'text/plain' })
      const result = await makeWebFetch({ mode: 'markdown', maxContentChars: 50 }).invoke({
        url: 'https://example.com/',
      })
      expect(result).toContain('x'.repeat(50))
      expect(result).not.toContain('x'.repeat(51))
      expect(result).toContain('[content truncated]')
    })

    it('rejects non-http scheme', async () => {
      await expect(makeWebFetch({ mode: 'markdown' }).invoke({ url: 'file:///etc/passwd' })).rejects.toThrow(
        /only http and https/
      )
    })

    it('rejects invalid URL', async () => {
      await expect(makeWebFetch({ mode: 'markdown' }).invoke({ url: 'not a url' })).rejects.toThrow(/invalid URL/)
    })

    it('rejects 4xx status', async () => {
      mockFetch('Not Found', { status: 404, statusText: 'Not Found' })
      await expect(makeWebFetch({ mode: 'markdown' }).invoke({ url: 'https://example.com/missing' })).rejects.toThrow(
        'HTTP 404'
      )
    })

    it('rejects response body exceeding maxBytes', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => null },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(DEFAULT_MAX_BYTES + 1))
            controller.close()
          },
        }),
      })
      await expect(makeWebFetch({ mode: 'markdown' }).invoke({ url: 'https://example.com/' })).rejects.toThrow(
        /max_bytes/
      )
    })

    it('wraps network errors', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('connection refused'))
      await expect(makeWebFetch({ mode: 'markdown' }).invoke({ url: 'https://example.com/' })).rejects.toThrow(
        /fetch failed/
      )
    })

    it('throws on abort signal', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      await expect(makeWebFetch({ mode: 'markdown' }).invoke({ url: 'https://example.com/' })).rejects.toThrow(
        'Web fetch tool request cancelled'
      )
    })

    it('decodes response body using charset from Content-Type', async () => {
      // iso-8859-1 byte 0xA9 is the copyright sign ©; under utf-8 it would be a replacement char
      const latin1Bytes = new Uint8Array([0x3c, 0x70, 0x3e, 0xa9, 0x3c, 0x2f, 0x70, 0x3e]) // <p>©</p>
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: (key: string) => (key === 'content-type' ? 'text/plain; charset=iso-8859-1' : null) },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(latin1Bytes)
            controller.close()
          },
        }),
      })
      const result = await makeWebFetch({ mode: 'markdown' }).invoke({ url: 'https://example.com/' })
      expect(result).toContain('©')
    })

    it('aborts mid-body-read when the stream reader throws an AbortError', async () => {
      let readCount = 0
      const mockCancel = vi.fn().mockResolvedValue(undefined)
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => null },
        body: {
          getReader: () => ({
            read: vi.fn().mockImplementation(async () => {
              readCount += 1
              if (readCount === 1) return { done: false, value: new Uint8Array([0x61]) }
              throw new DOMException('The operation was aborted', 'AbortError')
            }),
            releaseLock: vi.fn(),
            cancel: mockCancel,
          }),
        },
      })
      await expect(makeWebFetch({ mode: 'markdown' }).invoke({ url: 'https://example.com/' })).rejects.toThrow(
        'Web fetch tool request cancelled'
      )
      expect(mockCancel).toHaveBeenCalled()
    })

    it('sends correct user-agent header and passes cancel signal', async () => {
      mockFetch('ok')
      const controller = new AbortController()
      await makeWebFetch({ mode: 'markdown' }).invoke(
        { url: 'https://example.com/' },
        makeContext({ cancelSignal: controller.signal })
      )
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://example.com/',
        expect.objectContaining({
          headers: expect.objectContaining({ 'User-Agent': 'strands-agents-web-fetch/1.0' }),
        })
      )
    })
  })

  describe('agentic mode', () => {
    it('requires a non-empty prompt', async () => {
      mockFetch('<p>content</p>', { contentType: 'text/html' })
      await expect(
        makeWebFetch({ mode: 'agentic', model: {} as LocalAgent['model'] }).invoke({
          url: 'https://example.com/',
          prompt: '   ',
        })
      ).rejects.toThrow('agentic mode requires a non-empty prompt')
    })

    it('requires a model when no context agent', async () => {
      mockFetch('<p>content</p>', { contentType: 'text/html' })
      await expect(
        makeWebFetch({ mode: 'agentic' }).invoke({ url: 'https://example.com/', prompt: 'Summarize' })
      ).rejects.toThrow('agentic mode requires a model')
    })

    it('uses factory model when provided', async () => {
      mockFetch('<p>page content</p>', { contentType: 'text/html' })
      const fakeModel = {} as LocalAgent['model']
      mockInvoke.mockResolvedValue(makeAgentResult('the answer'))
      await makeWebFetch({ mode: 'agentic', model: fakeModel }).invoke({
        url: 'https://example.com/',
        prompt: 'What is this?',
      })
      expect(vi.mocked(Agent).mock.calls.at(-1)?.[0]?.model).toBe(fakeModel)
    })

    it('falls back to host agent model', async () => {
      mockFetch('<p>page content</p>', { contentType: 'text/html' })
      const hostModel = {} as LocalAgent['model']
      mockInvoke.mockResolvedValue(makeAgentResult('host answer'))
      await makeWebFetch({ mode: 'agentic' }).invoke(
        { url: 'https://example.com/', prompt: 'Summarize' },
        makeContext({ agent: { model: hostModel } as unknown as LocalAgent })
      )
      expect(vi.mocked(Agent).mock.calls.at(-1)?.[0]?.model).toBe(hostModel)
    })

    it('passes prompt and page content to analyst', async () => {
      mockFetch('page content', { contentType: 'text/plain' })
      mockInvoke.mockResolvedValue(makeAgentResult('the answer'))
      const result = await makeWebFetch({ mode: 'agentic', model: {} as LocalAgent['model'] }).invoke({
        url: 'https://example.com/',
        prompt: 'What is this about?',
      })
      expect(result).toBe('the answer')
      const [invokePrompt] = mockInvoke.mock.calls[0] ?? []
      expect(invokePrompt).toContain('What is this about?')
      expect(invokePrompt).toContain('page content')
    })

    it('strips reasoning blocks from analyst result', async () => {
      mockFetch('page content', { contentType: 'text/plain' })
      mockInvoke.mockResolvedValue({
        lastMessage: {
          content: [
            { type: 'reasoningBlock', text: 'internal chain-of-thought' },
            { type: 'textBlock', text: 'the answer' },
          ],
        },
      })
      const result = await makeWebFetch({ mode: 'agentic', model: {} as LocalAgent['model'] }).invoke({
        url: 'https://example.com/',
        prompt: 'Summarize',
      })
      expect(result).toBe('the answer')
      expect(result).not.toContain('chain-of-thought')
    })

    it('truncates content before passing to analyst', async () => {
      mockFetch('x'.repeat(200), { contentType: 'text/plain' })
      mockInvoke.mockResolvedValue(makeAgentResult('answer'))
      await makeWebFetch({ mode: 'agentic', model: {} as LocalAgent['model'], maxContentChars: 50 }).invoke({
        url: 'https://example.com/',
        prompt: 'Summarize',
      })
      const [invokePrompt] = mockInvoke.mock.calls[0] ?? []
      expect(invokePrompt).toContain('x'.repeat(50))
      expect(invokePrompt).not.toContain('x'.repeat(51))
      expect(invokePrompt).toContain('[content truncated]')
    })

    it('wraps analyst error with url context', async () => {
      mockFetch('<p>content</p>', { contentType: 'text/html' })
      mockInvoke.mockRejectedValue(new Error('analyst boom'))
      await expect(
        makeWebFetch({ mode: 'agentic', model: {} as LocalAgent['model'] }).invoke({
          url: 'https://example.com/',
          prompt: 'Summarize',
        })
      ).rejects.toThrow(/web fetch analyst failed/)
    })
  })
})
