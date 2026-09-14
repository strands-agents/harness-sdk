import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolContext } from '../../../tools/tool.js'
import type { LocalAgent } from '../../../types/agent.js'
import type { ExecutionResult } from '../../../sandbox/types.js'
import type { Sandbox } from '../../../sandbox/base.js'
import { SandboxAbortError, SandboxTimeoutError } from '../../../sandbox/errors.js'
import { Agent } from '../../../agent/agent.js'
import { makeWebFetch, webFetch } from '../web-fetch.js'
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

function makeSandbox(overrides: Partial<{ execute: Sandbox['execute'] }> = {}): Sandbox {
  return {
    execute: vi.fn(),
    executeStreaming: vi.fn(),
    executeCode: vi.fn(),
    executeCodeStreaming: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    listFiles: vi.fn(),
    getTools: vi.fn().mockReturnValue([]),
    readText: vi.fn(),
    writeText: vi.fn(),
    ...overrides,
  } as unknown as Sandbox
}

function makeExecutionResult(stdout: string, options: { exitCode?: number; stderr?: string } = {}): ExecutionResult {
  return {
    type: 'executionResult',
    exitCode: options.exitCode ?? 0,
    stdout,
    stderr: options.stderr ?? '',
    outputFiles: [],
  }
}

/**
 * Build a mock ExecutionResult matching curl --write-out output:
 * body in stdout, content-type in stderr.
 */
function makeCurlResult(
  body: string,
  options: { contentType?: string; exitCode?: number; stderr?: string } = {}
): ExecutionResult {
  const { contentType = 'text/plain', exitCode = 0 } = options
  const stderr = options.stderr ?? (exitCode === 0 ? contentType : '')
  return makeExecutionResult(body, { exitCode, stderr })
}

function makeContext(sandbox: Sandbox, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    toolUse: { name: 'web_fetch', toolUseId: 'test-id', input: {} },
    agent: { model: undefined, sandbox } as unknown as LocalAgent,
    invocationState: {},
    cancelSignal: new AbortController().signal,
    interrupt: vi.fn() as ToolContext['interrupt'],
    ...overrides,
  }
}

describe('webFetch tool', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

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
  })

  describe('markdown mode', () => {
    it('html response is converted to markdown', async () => {
      const sandbox = makeSandbox({
        execute: vi.fn().mockResolvedValue(makeCurlResult('<h1>Hi</h1>', { contentType: 'text/html' })),
      })
      const result = await makeWebFetch({ mode: 'markdown' }).invoke(
        { url: 'https://example.com/' },
        makeContext(sandbox)
      )
      expect(result).toBe('md:<h1>Hi</h1>')
    })

    it('xml content type is also converted to markdown', async () => {
      const sandbox = makeSandbox({
        execute: vi.fn().mockResolvedValue(makeCurlResult('<p>xhtml</p>', { contentType: 'application/xhtml+xml' })),
      })
      const result = await makeWebFetch({ mode: 'markdown' }).invoke(
        { url: 'https://example.com/page.xhtml' },
        makeContext(sandbox)
      )
      expect(result).toBe('md:<p>xhtml</p>')
    })

    it('non-html response is returned as-is', async () => {
      const sandbox = makeSandbox({
        execute: vi.fn().mockResolvedValue(makeCurlResult('plain text response', { contentType: 'text/plain' })),
      })
      const result = await makeWebFetch({ mode: 'markdown' }).invoke(
        { url: 'https://example.com/robots.txt' },
        makeContext(sandbox)
      )
      expect(result).toBe('plain text response')
    })

    it('content is truncated at maxContentChars', async () => {
      const sandbox = makeSandbox({
        execute: vi.fn().mockResolvedValue(makeCurlResult('x'.repeat(200), { contentType: 'text/plain' })),
      })
      const result = await makeWebFetch({ mode: 'markdown', maxContentChars: 50 }).invoke(
        { url: 'https://example.com/' },
        makeContext(sandbox)
      )
      expect(result).toContain('[content truncated]')
    })

    it('rejects non-http scheme', async () => {
      const sandbox = makeSandbox()
      await expect(
        makeWebFetch({ mode: 'markdown' }).invoke({ url: 'file:///etc/passwd' }, makeContext(sandbox))
      ).rejects.toThrow(/only http and https/)
    })

    it('rejects invalid URL', async () => {
      const sandbox = makeSandbox()
      await expect(
        makeWebFetch({ mode: 'markdown' }).invoke({ url: 'not a url' }, makeContext(sandbox))
      ).rejects.toThrow(/invalid URL/)
    })

    it('rejects 4xx status', async () => {
      const sandbox = makeSandbox({
        execute: vi.fn().mockResolvedValue(makeExecutionResult('', { exitCode: 22, stderr: 'HTTP/2 404 Not Found' })),
      })
      await expect(
        makeWebFetch({ mode: 'markdown' }).invoke({ url: 'https://example.com/missing' }, makeContext(sandbox))
      ).rejects.toThrow(/fetch failed: HTTP\/\S+ 404/)
    })

    it('rejects oversized body announced via Content-Length (curl exit 63)', async () => {
      const sandbox = makeSandbox({
        execute: vi.fn().mockResolvedValue(makeExecutionResult('', { exitCode: 63 })),
      })
      await expect(
        makeWebFetch({ mode: 'markdown' }).invoke({ url: 'https://example.com/' }, makeContext(sandbox))
      ).rejects.toThrow(/max_bytes/)
    })

    it('rejects oversized chunked body (exit 0, no Content-Length)', async () => {
      const sandbox = makeSandbox({
        execute: vi.fn().mockResolvedValue(makeCurlResult('x'.repeat(100))),
      })
      await expect(
        makeWebFetch({ mode: 'markdown', maxBytes: 50 }).invoke({ url: 'https://example.com/' }, makeContext(sandbox))
      ).rejects.toThrow(/max_bytes/)
    })

    it('wraps sandbox errors', async () => {
      const sandbox = makeSandbox({
        execute: vi.fn().mockRejectedValue(new Error('connection refused')),
      })
      await expect(
        makeWebFetch({ mode: 'markdown' }).invoke({ url: 'https://example.com/' }, makeContext(sandbox))
      ).rejects.toThrow(/fetch failed/)
    })

    it('maps SandboxAbortError to cancelled error', async () => {
      const sandbox = makeSandbox({
        execute: vi.fn().mockRejectedValue(new SandboxAbortError()),
      })
      await expect(
        makeWebFetch({ mode: 'markdown' }).invoke({ url: 'https://example.com/' }, makeContext(sandbox))
      ).rejects.toThrow('Web fetch tool request cancelled')
    })

    it('propagates SandboxTimeoutError unwrapped', async () => {
      const sandbox = makeSandbox({
        execute: vi.fn().mockRejectedValue(new SandboxTimeoutError(30)),
      })
      await expect(
        makeWebFetch({ mode: 'markdown' }).invoke({ url: 'https://example.com/' }, makeContext(sandbox))
      ).rejects.toBeInstanceOf(SandboxTimeoutError)
    })

    it('passes cancel signal to sandbox.execute', async () => {
      const executeMock = vi.fn().mockResolvedValue(makeCurlResult('ok'))
      const sandbox = makeSandbox({ execute: executeMock })
      const controller = new AbortController()
      await makeWebFetch({ mode: 'markdown' }).invoke(
        { url: 'https://example.com/' },
        makeContext(sandbox, { cancelSignal: controller.signal })
      )
      expect(executeMock).toHaveBeenCalledWith(
        expect.stringContaining('curl'),
        expect.objectContaining({ signal: controller.signal })
      )
    })

    it('sends the correct user-agent', async () => {
      const executeMock = vi.fn().mockResolvedValue(makeCurlResult('ok'))
      const sandbox = makeSandbox({ execute: executeMock })
      await makeWebFetch({ mode: 'markdown' }).invoke({ url: 'https://example.com/' }, makeContext(sandbox))
      expect(executeMock).toHaveBeenCalledWith(
        expect.stringContaining('strands-agents-web-fetch/1.0'),
        expect.anything()
      )
    })

    it('throws when context is missing', async () => {
      await expect(makeWebFetch({ mode: 'markdown' }).invoke({ url: 'https://example.com/' })).rejects.toThrow(
        'Tool context is required'
      )
    })
  })

  describe('agentic mode', () => {
    it('requires a non-empty prompt', async () => {
      const sandbox = makeSandbox({
        execute: vi.fn().mockResolvedValue(makeCurlResult('<p>content</p>', { contentType: 'text/html' })),
      })
      await expect(
        makeWebFetch({ mode: 'agentic', model: {} as LocalAgent['model'] }).invoke(
          { url: 'https://example.com/', prompt: '   ' },
          makeContext(sandbox)
        )
      ).rejects.toThrow('agentic mode requires a non-empty prompt')
    })

    it('requires a model when no context agent model', async () => {
      const sandbox = makeSandbox({
        execute: vi.fn().mockResolvedValue(makeCurlResult('<p>content</p>', { contentType: 'text/html' })),
      })
      await expect(
        makeWebFetch({ mode: 'agentic' }).invoke(
          { url: 'https://example.com/', prompt: 'Summarize' },
          makeContext(sandbox)
        )
      ).rejects.toThrow('agentic mode requires a model')
    })

    it('uses factory model when provided', async () => {
      const sandbox = makeSandbox({
        execute: vi.fn().mockResolvedValue(makeCurlResult('<p>page content</p>', { contentType: 'text/html' })),
      })
      const fakeModel = {} as LocalAgent['model']
      mockInvoke.mockResolvedValue(makeAgentResult('the answer'))
      await makeWebFetch({ mode: 'agentic', model: fakeModel }).invoke(
        { url: 'https://example.com/', prompt: 'What is this?' },
        makeContext(sandbox)
      )
      expect(vi.mocked(Agent).mock.calls.at(-1)?.[0]?.model).toBe(fakeModel)
    })

    it('falls back to host agent model', async () => {
      const hostModel = {} as LocalAgent['model']
      const sandbox = makeSandbox({
        execute: vi.fn().mockResolvedValue(makeCurlResult('<p>page content</p>', { contentType: 'text/html' })),
      })
      mockInvoke.mockResolvedValue(makeAgentResult('host answer'))
      await makeWebFetch({ mode: 'agentic' }).invoke(
        { url: 'https://example.com/', prompt: 'Summarize' },
        makeContext(sandbox, { agent: { model: hostModel, sandbox } as unknown as LocalAgent })
      )
      expect(vi.mocked(Agent).mock.calls.at(-1)?.[0]?.model).toBe(hostModel)
    })

    it('passes prompt and page content to analyst', async () => {
      const sandbox = makeSandbox({
        execute: vi.fn().mockResolvedValue(makeCurlResult('page content', { contentType: 'text/plain' })),
      })
      mockInvoke.mockResolvedValue(makeAgentResult('the answer'))
      const result = await makeWebFetch({ mode: 'agentic', model: {} as LocalAgent['model'] }).invoke(
        { url: 'https://example.com/', prompt: 'What is this about?' },
        makeContext(sandbox)
      )
      expect(result).toBe('the answer')
      const [invokePrompt] = mockInvoke.mock.calls[0] ?? []
      expect(invokePrompt).toContain('What is this about?')
      expect(invokePrompt).toContain('page content')
    })

    it('strips reasoning blocks from analyst result', async () => {
      const sandbox = makeSandbox({
        execute: vi.fn().mockResolvedValue(makeCurlResult('page content', { contentType: 'text/plain' })),
      })
      mockInvoke.mockResolvedValue({
        lastMessage: {
          content: [
            { type: 'reasoningBlock', text: 'internal chain-of-thought' },
            { type: 'textBlock', text: 'the answer' },
          ],
        },
      })
      const result = await makeWebFetch({ mode: 'agentic', model: {} as LocalAgent['model'] }).invoke(
        { url: 'https://example.com/', prompt: 'Summarize' },
        makeContext(sandbox)
      )
      expect(result).toBe('the answer')
      expect(result).not.toContain('chain-of-thought')
    })

    it('truncates content before passing to analyst', async () => {
      const sandbox = makeSandbox({
        execute: vi.fn().mockResolvedValue(makeCurlResult('x'.repeat(200), { contentType: 'text/plain' })),
      })
      mockInvoke.mockResolvedValue(makeAgentResult('answer'))
      await makeWebFetch({ mode: 'agentic', model: {} as LocalAgent['model'], maxContentChars: 50 }).invoke(
        { url: 'https://example.com/', prompt: 'Summarize' },
        makeContext(sandbox)
      )
      const [invokePrompt] = mockInvoke.mock.calls[0] ?? []
      expect(invokePrompt).toContain('[content truncated]')
      expect(invokePrompt).not.toContain('x'.repeat(51))
    })

    it('wraps analyst error with url context', async () => {
      const sandbox = makeSandbox({
        execute: vi.fn().mockResolvedValue(makeCurlResult('<p>content</p>', { contentType: 'text/html' })),
      })
      mockInvoke.mockRejectedValue(new Error('analyst boom'))
      await expect(
        makeWebFetch({ mode: 'agentic', model: {} as LocalAgent['model'] }).invoke(
          { url: 'https://example.com/', prompt: 'Summarize' },
          makeContext(sandbox)
        )
      ).rejects.toThrow(/web fetch analyst failed/)
    })
  })
})
