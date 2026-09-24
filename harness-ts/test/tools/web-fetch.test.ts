import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'
import { ReadableStream } from 'node:stream/web'
import type { AddressInfo } from 'node:net'

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionResult, Model, Tool, ToolContext } from '@strands-agents/sdk'

const invokeCalls: string[] = []
const constructed: Array<{ model: unknown }> = []

vi.mock('@strands-agents/sdk', async (importActual) => {
  const actual = await importActual<typeof import('@strands-agents/sdk')>()
  class FakeAgent {
    constructor(config: { model: unknown }) {
      constructed.push({ model: config.model })
    }
    invoke(prompt: string): Promise<{ toString: () => string }> {
      invokeCalls.push(prompt)
      return Promise.resolve({ toString: () => 'summary answer' })
    }
  }
  return { ...actual, Agent: FakeAgent }
})

const { makeWebFetch } = await import('../../src/tools/web-fetch.js')
// The mock above swaps Agent for a fake; the end-to-end test needs a real agent's host sandbox.
const { Agent: RealAgent } = await vi.importActual<typeof import('@strands-agents/sdk')>('@strands-agents/sdk')

const model = { id: 'fake-model' } as unknown as Model

class FakeSandbox {
  commands: string[] = []
  files = new Map<string, Uint8Array>()
  constructor(
    private readonly response: {
      body?: Uint8Array | string
      contentType?: string
      url?: string
      exitCode?: number
      stderr?: string
    } = {}
  ) {}
  execute(command: string): Promise<ExecutionResult> {
    this.commands.push(command)
    if (command.startsWith('rm -f ')) {
      for (const path of command.slice('rm -f '.length).split(' ')) this.files.delete(path.replaceAll("'", ''))
      return Promise.resolve({ type: 'executionResult', exitCode: 0, stdout: '', stderr: '', outputFiles: [] })
    }
    const exitCode = this.response.exitCode ?? 0
    if (exitCode === 0) {
      const body = this.response.body ?? ''
      this.files.set(
        /-o (\S+)/.exec(command)![1]!.replaceAll("'", ''),
        typeof body === 'string' ? Buffer.from(body) : body
      )
    }
    return Promise.resolve({
      type: 'executionResult',
      exitCode,
      stdout: `${this.response.contentType ?? 'text/html'}\n${this.response.url ?? 'https://example.com/final'}\n`,
      stderr: this.response.stderr ?? '',
      outputFiles: [],
    })
  }
  readFile(path: string): Promise<Uint8Array> {
    const data = this.files.get(path)
    if (!data) throw new Error(`no file ${path}`)
    return Promise.resolve(data)
  }
  get curl(): string {
    return this.commands.find((c) => c.startsWith('curl '))!
  }
}

function invoke(tool: Tool, input: unknown, sandbox: unknown = new FakeSandbox()): Promise<string> {
  const context = { agent: { sandbox } } as unknown as ToolContext
  return (tool as unknown as { invoke: (i: unknown, c: ToolContext) => Promise<string> }).invoke(input, context)
}

beforeEach(() => {
  invokeCalls.length = 0
  constructed.length = 0
})

describe('web_fetch', () => {
  it('reduces HTML to text and answers via the summarizer model', async () => {
    const sandbox = new FakeSandbox({
      body: '<html><body><script>x=1</script><p>Hello  <b>world</b></p></body></html>',
    })
    const tool = makeWebFetch({ model })
    const answer = await invoke(tool, { url: 'https://example.com', prompt: 'What does it say?' }, sandbox)

    expect(answer).toBe('summary answer')
    expect(constructed[0]!.model).toBe(model)
    const prompt = invokeCalls[0]!
    expect(prompt).toContain('What does it say?')
    expect(prompt).toContain('Fetched URL: https://example.com/final')
    expect(prompt).toContain('Hello world')
    expect(prompt).not.toContain('<script>')
  })

  it('runs curl in the agent sandbox with the URL quoted and globbing off, then removes the body file', async () => {
    const sandbox = new FakeSandbox({ body: 'body', contentType: 'text/plain' })
    const tool = makeWebFetch({ model })
    await invoke(tool, { url: "https://example.com/a'b$(id);c" }, sandbox)

    // Legal URL characters that mean something to a shell arrive single-quoted.
    const command = sandbox.curl
    expect(command).toContain(`'https://example.com/a'\\''b$(id);c'`)
    for (const flag of [
      '-g',
      '--fail',
      "--proto '=http,https'",
      "--proto-redir '=http,https'",
      '--max-time',
      '-o ',
      '%{content_type}',
      '%{url_effective}',
      " -- '",
    ]) {
      expect(command).toContain(flag)
    }
    expect(sandbox.commands.at(-1)!.startsWith('rm -f ')).toBe(true)
    expect(sandbox.files.size).toBe(0)
  })

  it('handles a missing content type without shifting the trailer', async () => {
    const sandbox = new FakeSandbox({ body: 'a < b <i>', contentType: '', url: 'https://example.com/report.html' })
    const tool = makeWebFetch({ model })
    expect(await invoke(tool, { url: 'https://example.com' }, sandbox)).toBe('a < b <i>')
  })

  it('truncates the body in the sandbox instead of rejecting large pages', () => {
    const sandbox = new FakeSandbox({ body: 'x' })
    const tool = makeWebFetch({ model })
    return invoke(tool, { url: 'https://example.com' }, sandbox).then(() => {
      expect(sandbox.curl).toMatch(/&& head -c 5242880 '[^']+' > '[^']+\.part' && mv -f /)
      expect(sandbox.curl).not.toContain('--max-filesize')
    })
  })

  it('honours the response charset and falls back to utf-8 for an unknown one', async () => {
    const tool = makeWebFetch({ model })
    const latin1 = new FakeSandbox({
      body: Buffer.from('caf\xe9', 'latin1'),
      contentType: 'text/plain; charset=ISO-8859-1',
    })
    expect(await invoke(tool, { url: 'https://example.com/latin1' }, latin1)).toBe('café')
    const unknown = new FakeSandbox({ body: 'é', contentType: 'text/plain; charset=not-a-codec' })
    expect(await invoke(tool, { url: 'https://example.com/unknown' }, unknown)).toBe('é')
  })

  it('returns the raw page content when no prompt is given', async () => {
    const sandbox = new FakeSandbox({ body: 'body text', contentType: 'text/plain' })
    const tool = makeWebFetch({ model })
    const withoutPrompt = await invoke(tool, { url: 'https://example.com' }, sandbox)
    expect(withoutPrompt).toBe('body text')
    const withBlankPrompt = await invoke(tool, { url: 'https://example.com', prompt: '   ' }, sandbox)
    expect(withBlankPrompt).toBe('body text')
    expect(invokeCalls).toHaveLength(0)
  })

  it('reports a curl failure without invoking the summarizer, and still cleans up', async () => {
    const sandbox = new FakeSandbox({ exitCode: 22, stderr: 'curl: (22) The requested URL returned error: 500\n' })
    const tool = makeWebFetch({ model })
    const answer = await invoke(tool, { url: 'https://example.com', prompt: 'anything' }, sandbox)

    expect(answer).toContain('Failed to fetch https://example.com')
    expect(answer).toContain('500')
    expect(invokeCalls).toHaveLength(0)
    expect(sandbox.commands.at(-1)!.startsWith('rm -f ')).toBe(true)
  })

  it('reports a sandbox failure as a fetch failure', async () => {
    const sandbox = { execute: () => Promise.reject(new Error('sandbox gone')) }
    const tool = makeWebFetch({ model })
    const answer = await invoke(tool, { url: 'https://example.com' }, sandbox)
    expect(answer).toBe('Failed to fetch https://example.com: sandbox gone')
  })

  it('rejects a non-http scheme before touching the sandbox', async () => {
    const sandbox = new FakeSandbox()
    const tool = makeWebFetch({ model })
    const answer = await invoke(tool, { url: 'ftp://example.com/f', prompt: 'x' }, sandbox)
    expect(answer).toContain('only supports http')
    expect(sandbox.commands).toHaveLength(0)
  })

  it.each([
    'https://example.com/a b',
    'https://example.com/x`id`',
    'https://example.com/"x"',
    'https://example.com/x\nrm -rf /',
    'https://example.com/{a,b}',
    'https://example.com/日本',
    'https:///no-host',
    'javascript:alert(1)',
    '',
  ])('rejects the malformed URL %j before touching the sandbox', async (url) => {
    const sandbox = new FakeSandbox()
    const tool = makeWebFetch({ model })
    const answer = await invoke(tool, { url }, sandbox)
    expect(answer).toContain('Failed to fetch')
    expect(sandbox.commands).toHaveLength(0)
  })

  it('accepts RFC 3986 URLs and trims whitespace', async () => {
    const sandbox = new FakeSandbox({ body: 'ok', contentType: 'text/plain' })
    const tool = makeWebFetch({ model })
    expect(await invoke(tool, { url: ' https://e.com/a?b=c&d=%20#f ' }, sandbox)).toBe('ok')
    expect(sandbox.curl).toContain("'https://e.com/a?b=c&d=%20#f'")
    expect(await invoke(tool, { url: 'http://[::1]:8080/x' }, sandbox)).toBe('ok')
  })

  it('fetches from the process with the direct transport, skipping the sandbox', async () => {
    const calls: Array<{ url: string; ua: string | undefined }> = []
    vi.stubGlobal('fetch', (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, ua: init.headers['User-Agent'] })
      return Promise.resolve(
        new Response('<p>Hi <b>there</b></p>', { headers: { 'content-type': 'text/html; charset=utf-8' } })
      )
    })
    try {
      const sandbox = new FakeSandbox()
      const tool = makeWebFetch({ model, transport: 'direct' })
      expect(await invoke(tool, { url: 'https://example.com' }, sandbox)).toBe('Hi there')
      expect(calls).toEqual([{ url: 'https://example.com', ua: 'strands-harness/1.0' }])
      expect(sandbox.commands).toHaveLength(0)
      expect(await invoke(tool, { url: 'https://example.com/a b' }, sandbox)).toContain('Failed to fetch')
      expect(calls).toHaveLength(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('caps a direct-transport body without buffering the rest of the stream', async () => {
    let pulls = 0
    let cancelled = false
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++
        controller.enqueue(new Uint8Array(64 * 1024).fill(0x78))
      },
      cancel() {
        cancelled = true
      },
    })
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(endless, { headers: { 'content-type': 'text/plain' } })))
    try {
      const tool = makeWebFetch({ model, transport: 'direct' })
      const text = await invoke(tool, { url: 'https://example.com/endless' }, new FakeSandbox())
      expect(text).toBe('x'.repeat(50_000))
      expect(cancelled).toBe(true)
      expect(pulls).toBeLessThan(100)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects an unknown transport', () => {
    expect(() => makeWebFetch({ model, transport: 'wget' as never })).toThrow(/transport/)
  })

  it('caches the fetched page within the TTL', async () => {
    const sandbox = new FakeSandbox({ body: 'body text', contentType: 'text/plain' })
    const tool = makeWebFetch({ model })
    await invoke(tool, { url: 'https://example.com', prompt: 'first' }, sandbox)
    await invoke(tool, { url: 'https://example.com', prompt: 'second' }, sandbox)
    expect(sandbox.commands.filter((c) => c.startsWith('curl '))).toHaveLength(1)
    expect(invokeCalls).toHaveLength(2)
  })

  it('fetches end to end through the local environment sandbox', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: '/page' })
        res.end()
        return
      }
      if (req.url === '/huge') {
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': 6 * 1024 * 1024 })
        res.end(Buffer.alloc(6 * 1024 * 1024, 'x'))
        return
      }
      if (req.url === '/notype') {
        res.writeHead(200, { 'Content-Length': 5 })
        res.end('a < b')
        return
      }
      if (req.url === '/big') {
        // Well past the sandbox's 64 KiB read chunks: multi-byte characters must survive intact.
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('日'.repeat(100_000))
        return
      }
      res.writeHead(req.url === '/missing' ? 404 : 200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<html><body><script>x</script><p>Hello <b>wörld</b></p></body></html>')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const sandbox = new RealAgent({ model }).sandbox
    const tool = makeWebFetch({ model })
    try {
      expect(await invoke(tool, { url: `${base}/redirect` }, sandbox)).toBe('Hello wörld')
      expect(await invoke(tool, { url: `${base}/big` }, sandbox)).toBe('日'.repeat(50_000))
      expect(await invoke(tool, { url: `${base}/huge` }, sandbox)).toBe('x'.repeat(50_000))
      expect(await invoke(tool, { url: `${base}/notype` }, sandbox)).toBe('a < b')
      expect((await sandbox.execute('ls /tmp | grep -c strands-web-fetch')).stdout.trim()).toBe('0')
      expect(await invoke(tool, { url: `${base}/missing` }, sandbox)).toContain('404')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
