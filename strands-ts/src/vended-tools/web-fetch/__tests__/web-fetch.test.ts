import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ToolContext } from '../../../tools/tool.js'
import type { LocalAgent } from '../../../types/agent.js'
import { Agent } from '../../../agent/agent.js'
import { InvocationContextImpl } from '../../../agent/invocation-context.js'
import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'
import { SandboxAbortError, SandboxTimeoutError } from '../../../sandbox/errors.js'
import { encodeBase64 } from '../../../types/media.js'
import type { Sandbox } from '../../../sandbox/base.js'
import type { ExecutionResult } from '../../../sandbox/types.js'
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

    it('rejects an unknown transport', () => {
      expect(() => makeWebFetch({ transport: 'wget' as 'direct' })).toThrow(/transport/)
    })

    it('rejects non-finite maxBytes', () => {
      expect(() => makeWebFetch({ maxBytes: Number.NaN })).toThrow(/maxBytes/)
      expect(() => makeWebFetch({ maxBytes: Number.POSITIVE_INFINITY })).toThrow(/maxBytes/)
      expect(() => makeWebFetch({ maxBytes: Number.NEGATIVE_INFINITY })).toThrow(/maxBytes/)
    })

    it('rejects non-finite maxContentChars', () => {
      expect(() => makeWebFetch({ maxContentChars: Number.NaN })).toThrow(/maxContentChars/)
      expect(() => makeWebFetch({ maxContentChars: Number.POSITIVE_INFINITY })).toThrow(/maxContentChars/)
      expect(() => makeWebFetch({ maxContentChars: Number.NEGATIVE_INFINITY })).toThrow(/maxContentChars/)
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

    it.each(['cancel', 'timeout'] as const)('aborts the request on %s', async (source) => {
      const controllers = { cancel: new AbortController(), timeout: new AbortController() }
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controllers.timeout.signal)
      mockFetch('ok')
      await makeWebFetch({ mode: 'markdown' }).invoke(
        { url: 'https://example.com/' },
        makeContext({ cancelSignal: controllers.cancel.signal })
      )
      expect(timeoutSpy).toHaveBeenCalledWith(30_000)
      timeoutSpy.mockRestore()
      const signal = vi.mocked(globalThis.fetch).mock.calls[0]![1]!.signal!
      expect(signal.aborted).toBe(false)
      controllers[source].abort()
      expect(signal.aborted).toBe(true)
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
    it.each([{}, { prompt: '' }, { prompt: '   ' }])(
      'returns the page content without a model for an empty prompt (%j)',
      async (input) => {
        mockFetch('x'.repeat(100), { contentType: 'text/plain' })
        const result = await makeWebFetch({ mode: 'agentic', maxContentChars: 50 }).invoke({
          url: 'https://example.com/',
          ...input,
        })
        expect(result).toBe('x'.repeat(50) + '\n\n[content truncated]')
        expect(vi.mocked(Agent)).not.toHaveBeenCalled()
      }
    )

    it('tells the model the prompt is optional', () => {
      const { description, inputSchema } = makeWebFetch().toolSpec
      expect(description).toContain('Leave the prompt empty')
      expect(inputSchema).toMatchObject({
        required: ['url'],
        properties: { prompt: { description: expect.stringContaining('Leave empty') } },
      })
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

    it('falls back to host agent auxModel', async () => {
      mockFetch('<p>page content</p>', { contentType: 'text/html' })
      const hostModel = {} as LocalAgent['model']
      const hostAuxModel = {} as LocalAgent['model']
      mockInvoke.mockResolvedValue(makeAgentResult('host answer'))
      await makeWebFetch({ mode: 'agentic' }).invoke(
        { url: 'https://example.com/', prompt: 'Summarize' },
        makeContext({ agent: { model: hostModel, auxModel: hostAuxModel } as unknown as LocalAgent })
      )
      expect(vi.mocked(Agent).mock.calls.at(-1)?.[0]?.model).toBe(hostAuxModel)
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

    describe('request limits', () => {
      it('adds the analyst usage to the request total and runs it past a spent limit', async () => {
        const { Agent: RealAgent } = await vi.importActual<{ Agent: typeof Agent }>('../../../agent/agent.js')
        vi.mocked(Agent).mockImplementationOnce(function (config) {
          return new RealAgent(config)
        })
        mockFetch('page content', { contentType: 'text/plain' })
        const analystModel = new MockMessageModel().addTurn(
          { type: 'textBlock', text: 'the answer' },
          { usage: { inputTokens: 20, outputTokens: 6, totalTokens: 26 } }
        )
        const parentInvocationContext = new InvocationContextImpl({ turns: 1 })
        parentInvocationContext.usage.turnsTaken = 5

        const result = await makeWebFetch({ mode: 'agentic', model: analystModel }).invoke(
          { url: 'https://example.com/', prompt: 'Summarize' },
          makeContext({ invocationContext: parentInvocationContext })
        )

        expect(result).toBe('the answer')
        expect(parentInvocationContext.usage).toEqual({
          turnsTaken: 5,
          inputTokens: 20,
          outputTokens: 6,
          totalTokens: 26,
        })
      })
    })
  })

  describe('sandbox transport', () => {
    /** What the curl command sends back before base64: the body, then the content type and exit status. */
    function curlOutput(body: string | Uint8Array = '', contentType = 'text/html', status = 0): Uint8Array {
      const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
      const trailer = new TextEncoder().encode(`\n${contentType}\n${status}`)
      const output = new Uint8Array(bytes.length + trailer.length)
      output.set(bytes)
      output.set(trailer, bytes.length)
      return output
    }

    /** Fake sandbox whose shell is `sh`: the curl command prints `output` as wrapped base64. */
    class FakeSandbox {
      commands: string[] = []
      options: unknown[] = []
      protected probeOutput = '\n'
      protected lineEnd = '\n'
      constructor(private readonly response: { output?: Uint8Array; stderr?: string; exitCode?: number } = {}) {}

      async execute(command: string, options?: unknown): Promise<ExecutionResult> {
        this.commands.push(command)
        this.options.push(options)
        if (command === 'echo "${PSEdition}"') return this.result(this.probeOutput)
        const lines = encodeBase64(this.response.output ?? new Uint8Array()).match(/.{1,76}/g) ?? []
        return this.result(lines.map((line) => line + this.lineEnd).join(''))
      }

      private result(stdout: string): ExecutionResult {
        const { stderr = '', exitCode = 0 } = this.response
        return { type: 'executionResult', exitCode, stdout, stderr, outputFiles: [] }
      }
    }

    /** Fake sandbox whose shell is Windows PowerShell: the probe reports the edition and lines end in CRLF. */
    class FakePowerShellSandbox extends FakeSandbox {
      protected override probeOutput = 'Desktop\r\n'
      protected override lineEnd = '\r\n'
    }

    function sandboxContext(sandbox: FakeSandbox, overrides: Partial<ToolContext> = {}): ToolContext {
      return makeContext({ agent: { sandbox: sandbox as unknown as Sandbox } as unknown as LocalAgent, ...overrides })
    }

    function sandboxFetch(sandbox: FakeSandbox, url = 'https://example.com/', maxBytes?: number): Promise<unknown> {
      const options = { mode: 'markdown' as const, transport: 'sandbox' as const, ...(maxBytes && { maxBytes }) }
      return makeWebFetch(options).invoke({ url }, sandboxContext(sandbox))
    }

    it.each([undefined, makeContext()])('requires a sandbox (%#)', async (context) => {
      globalThis.fetch = vi.fn()
      await expect(
        makeWebFetch({ mode: 'markdown', transport: 'sandbox' }).invoke({ url: 'https://example.com/' }, context)
      ).rejects.toThrow('requires a sandbox')
      expect(globalThis.fetch).not.toHaveBeenCalled()
    })

    it('runs curl in the sandbox', async () => {
      globalThis.fetch = vi.fn()
      const sandbox = new FakeSandbox({ output: curlOutput('<h1>Hi</h1>') })
      const result = await sandboxFetch(sandbox, " https://example.com/a'b$(id);c ", 2000)
      expect(result).toBe('md:<h1>Hi</h1>')
      expect(globalThis.fetch).not.toHaveBeenCalled()
      // One shell probe, then one round-trip.
      const [probe, command] = sandbox.commands
      expect(probe).toBe('echo "${PSEdition}"')
      // Legal URL characters that mean something to a shell arrive single-quoted.
      expect(command).toContain(" -- 'https://example.com/a'\\''b$(id);c'; ")
      for (const flag of [
        'curl -sSL -g --fail ',
        '--proto "=http,https"',
        '--proto-redir "=http,https"',
        '--max-time 30 ',
        '--max-filesize 2000 ',
        '-A "strands-agents-web-fetch/1.0"',
        '-H "Accept: text/html,application/xhtml+xml;q=0.9,*/*;q=0.8"',
        "-w '\\n%{content_type}'",
      ]) {
        expect(command).toContain(flag)
      }
      // head stops curl once the body cannot fit in maxBytes, with or without a Content-Length.
      expect(command).toMatch(/printf '\\n%s' "\$\?"; \} \| head -c 3024 \| base64$/)
      expect(sandbox.options[1]).toMatchObject({ timeout: 35, signal: expect.any(AbortSignal) })
    })

    it('returns a non-html response as-is', async () => {
      const sandbox = new FakeSandbox({ output: curlOutput('raw <b>text</b>\n', 'text/plain') })
      expect(await sandboxFetch(sandbox)).toBe('raw <b>text</b>\n')
    })

    it('handles a missing content type', async () => {
      const sandbox = new FakeSandbox({ output: curlOutput('a < b <i>', '') })
      expect(await sandboxFetch(sandbox)).toBe('a < b <i>')
    })

    it('decodes the body with the response charset', async () => {
      // "日本語" in Shift_JIS.
      const body = new Uint8Array([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea])
      const sandbox = new FakeSandbox({ output: curlOutput(body, "text/plain; charset='Shift_JIS'") })
      expect(await sandboxFetch(sandbox)).toBe('日本語')
    })

    it('falls back to utf-8 for an unknown charset', async () => {
      const sandbox = new FakeSandbox({ output: curlOutput('é', 'text/plain; charset=not-a-codec') })
      expect(await sandboxFetch(sandbox)).toBe('é')
    })

    it('rejects an HTTP error status', async () => {
      const sandbox = new FakeSandbox({
        output: curlOutput('', 'text/html', 22),
        stderr: 'curl: (22) The requested URL returned error: 404\n',
      })
      await expect(sandboxFetch(sandbox, 'https://example.com/missing')).rejects.toThrow(
        /fetch failed: curl: \(22\).*404$/
      )
    })

    it('reports the shell error when curl is missing', async () => {
      // The shell could not start curl, so only the exit status follows the (empty) body.
      const sandbox = new FakeSandbox({ output: new TextEncoder().encode('\n127'), stderr: 'sh: 1: curl: not found\n' })
      await expect(sandboxFetch(sandbox)).rejects.toThrow('curl: not found')
    })

    it.each(['', 'not curl output'])('rejects unexpected output (%j)', async (output) => {
      const sandbox = new FakeSandbox({ output: new TextEncoder().encode(output) })
      await expect(sandboxFetch(sandbox)).rejects.toThrow('unexpected curl output')
    })

    it.each([
      ['a Content-Length over the cap', curlOutput('', 'text/plain', 63)],
      ['a body over the cap', curlOutput('x'.repeat(51), 'text/plain')],
      ['a body that fills the limit', new Uint8Array(50 + 1024).fill(120)],
    ])('rejects %s', async (_name, output) => {
      await expect(sandboxFetch(new FakeSandbox({ output }), 'https://example.com/', 50)).rejects.toThrow(
        'max_bytes=50'
      )
    })

    it('returns a body at the cap', async () => {
      const sandbox = new FakeSandbox({ output: curlOutput('x'.repeat(50), 'text/plain') })
      expect(await sandboxFetch(sandbox, 'https://example.com/', 50)).toBe('x'.repeat(50))
    })

    it('reports a curl timeout', async () => {
      const sandbox = new FakeSandbox({ output: curlOutput('', '', 28), stderr: 'curl: (28) Operation timed out\n' })
      await expect(sandboxFetch(sandbox)).rejects.toThrow('fetch timed out')
    })

    it.each([
      [new SandboxTimeoutError(35), 'fetch timed out'],
      [new SandboxAbortError(), 'Web fetch tool request cancelled'],
    ])('wraps %s from the sandbox', async (error, message) => {
      class ThrowingSandbox extends FakeSandbox {
        override async execute(command: string, options?: unknown): Promise<ExecutionResult> {
          if (command.includes('curl')) throw error
          return super.execute(command, options)
        }
      }
      await expect(sandboxFetch(new ThrowingSandbox())).rejects.toThrow(message)
    })

    it('does not run a command when already cancelled', async () => {
      const sandbox = new FakeSandbox()
      await expect(
        makeWebFetch({ mode: 'markdown', transport: 'sandbox' }).invoke(
          { url: 'https://example.com/' },
          sandboxContext(sandbox, { cancelSignal: AbortSignal.abort() })
        )
      ).rejects.toThrow('Web fetch tool request cancelled')
      expect(sandbox.commands).toStrictEqual([])
    })

    it.each([
      'ftp://example.com/file',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'https:///no-host',
      'https://example.com/a b',
      'https://example.com/x`id`',
      'https://example.com/"x"',
      'https://example.com/x\nrm -rf /',
      'https://example.com/{a,b}',
      'https://example.com/日本',
      '',
    ])('rejects the URL %j before any command runs', async (url) => {
      const sandbox = new FakeSandbox()
      await expect(sandboxFetch(sandbox, url)).rejects.toThrow('fetch failed')
      expect(sandbox.commands).toStrictEqual([])
    })

    it('probes the shell once per sandbox', async () => {
      const sandbox = new FakeSandbox({ output: curlOutput('page', 'text/plain') })
      await sandboxFetch(sandbox, 'https://example.com/a')
      await sandboxFetch(sandbox, 'http://[::1]:8080/b')
      expect(sandbox.commands.filter((command) => command === 'echo "${PSEdition}"')).toHaveLength(1)
      expect(sandbox.commands).toHaveLength(3)
    })

    it('falls back to sh and probes again after a failed probe', async () => {
      class FailingProbeSandbox extends FakeSandbox {
        override async execute(command: string, options?: unknown): Promise<ExecutionResult> {
          const result = await super.execute(command, options)
          return command.includes('PSEdition') ? { ...result, exitCode: 1 } : result
        }
      }
      const sandbox = new FailingProbeSandbox({ output: curlOutput('page', 'text/plain') })
      expect(await sandboxFetch(sandbox)).toBe('page')
      expect(await sandboxFetch(sandbox)).toBe('page')
      expect(sandbox.commands.filter((command) => command.includes('PSEdition'))).toHaveLength(2)
      expect(sandbox.commands[1]).toContain('head -c')
    })

    it('runs curl.exe through PowerShell', async () => {
      const sandbox = new FakePowerShellSandbox({ output: curlOutput('Hello wörld', 'text/plain; charset=utf-8') })
      expect(await sandboxFetch(sandbox, "https://example.com/it's", 2000)).toBe('Hello wörld')
      const command = sandbox.commands[1]!
      // The curl.exe command line is one single-quoted PowerShell literal (no expansion): the URL's own quote is
      // doubled, and curl.exe sees the URL double-quoted.
      expect(command).toContain(
        "  $info = New-Object Diagnostics.ProcessStartInfo 'curl.exe', '-sSL -g --fail " +
          '--proto "=http,https" --proto-redir "=http,https" --max-time 30 --max-filesize 2000 ' +
          '-A "strands-agents-web-fetch/1.0" -H "Accept: text/html,application/xhtml+xml;q=0.9,*/*;q=0.8" ' +
          '-w "\\n%{content_type}\\n0" -- "https://example.com/it\'\'s"\'\n'
      )
      // .NET stops reading (and kills curl.exe) once the body cannot fit in maxBytes.
      expect(command).toContain('.ReadBytes(3024)')
      expect(command).toContain('$process.Kill()')
      // A curl.exe that cannot start is exit 127, reported through the console handle.
      expect(command.startsWith('$status = 127\ntry {\n')).toBe(true)
      expect(command).toContain(
        '} catch { if ($status -eq 0) { $status = 1 }; [Console]::Error.Write($_.Exception.Message) }'
      )
      expect(command.endsWith('exit $status')).toBe(true)
      expect(command).not.toContain('head -c')
      expect(sandbox.options[1]).toMatchObject({ timeout: 35 })
    })

    it('rejects an HTTP error status from PowerShell', async () => {
      const sandbox = new FakePowerShellSandbox({
        stderr: 'curl: (22) The requested URL returned error: 404\r\n',
        exitCode: 22,
      })
      await expect(sandboxFetch(sandbox, 'https://example.com/missing')).rejects.toThrow(
        /fetch failed: curl: \(22\).*404$/
      )
    })

    it('rejects a Content-Length over the cap from PowerShell', async () => {
      const sandbox = new FakePowerShellSandbox({ stderr: 'curl: (63) Maximum file size exceeded\r\n', exitCode: 63 })
      await expect(sandboxFetch(sandbox, 'https://example.com/', 50)).rejects.toThrow('max_bytes=50')
    })

    it('fetches through the sandbox in agentic mode', async () => {
      const sandbox = new FakeSandbox({ output: curlOutput('page content', 'text/plain') })
      mockInvoke.mockResolvedValue(makeAgentResult('the answer'))
      const agentic = makeWebFetch({ model: {} as LocalAgent['model'], transport: 'sandbox' })
      const context = sandboxContext(sandbox)
      expect(await agentic.invoke({ url: 'https://example.com/', prompt: 'Summarize' }, context)).toBe('the answer')
      expect(mockInvoke.mock.calls[0]?.[0]).toContain('page content')
      expect(await agentic.invoke({ url: 'https://example.com/' }, context)).toBe('page content')
    })
  })
})
