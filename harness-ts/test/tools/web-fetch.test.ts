import { Buffer } from 'node:buffer'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
const { SHELL_PROBE, shellOf } = await import('../../src/sandbox.js')
// The mock above swaps Agent for a fake; the end-to-end test needs a real agent's host sandbox.
const { Agent: RealAgent } = await vi.importActual<typeof import('@strands-agents/sdk')>('@strands-agents/sdk')

const model = { id: 'fake-model' } as unknown as Model

class FakeSandbox {
  commands: string[] = []
  constructor(
    private readonly response: {
      body?: Uint8Array | string
      contentType?: string
      redirect?: string
      exitCode?: number
      stderr?: string
    } = {}
  ) {}
  execute(command: string): Promise<ExecutionResult> {
    this.commands.push(command)
    if (command === SHELL_PROBE) return Promise.resolve(this.probeAnswer())
    const exitCode = this.response.exitCode ?? 0
    const body = this.response.body ?? ''
    const encoded = Buffer.from(typeof body === 'string' ? Buffer.from(body) : body).toString('base64')
    const trailer = [this.response.contentType ?? 'text/html', this.response.redirect ?? '']
    return Promise.resolve({
      type: 'executionResult',
      exitCode,
      stdout: exitCode === 0 ? this.render(trailer, encoded) : '',
      stderr: this.response.stderr ?? '',
      outputFiles: [],
    })
  }
  protected probeAnswer(): ExecutionResult {
    return { type: 'executionResult', exitCode: 0, stdout: '\n', stderr: '', outputFiles: [] }
  }
  /** What the shell pipeline prints: the two trailer lines, then base64(1) output (wrapped at 76 columns). */
  protected render(trailer: string[], encoded: string): string {
    const wrapped = encoded.match(/.{1,76}/g)?.join('\n') ?? ''
    return `${trailer.join('\n')}\n${wrapped}\n`
  }
  get curl(): string {
    return this.commands.find((c) => c.startsWith('f=$(mktemp') && c.includes('curl '))!
  }
}

/** Fake sandbox whose shell is Windows PowerShell: the probe reports the edition, lines end in CRLF, and the base64
 * body is one unwrapped line. */
class FakePowerShellSandbox extends FakeSandbox {
  protected override probeAnswer(): ExecutionResult {
    return { type: 'executionResult', exitCode: 0, stdout: 'Desktop\r\n', stderr: '', outputFiles: [] }
  }
  protected override render(trailer: string[], encoded: string): string {
    return `${trailer.join('\r\n')}\r\n${encoded}\r\n`
  }
  override get curl(): string {
    return this.commands.find((c) => c.includes('curl.exe '))!
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
    expect(prompt).toContain('Fetched URL: https://example.com\n')
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
      '--no-location',
      "--proto '=http,https'",
      '--max-time',
      '-o "$f"',
      '%{content_type}',
      '%{redirect_url}',
      " -- '",
    ]) {
      expect(command).toContain(flag)
    }
    // One shell probe, then one round-trip: the shell picks the scratch file, returns the body as base64, and
    // removes the file itself.
    expect(sandbox.commands).toEqual([SHELL_PROBE, command])
    expect(command.startsWith('f=$(mktemp -t strands-web-fetch.XXXXXX) && ')).toBe(true)
    expect(command).toMatch(/\| base64; s=\$\?; rm -f "\$f"; exit \$s$/)
  })

  it('handles a missing content type without shifting the trailer', async () => {
    const sandbox = new FakeSandbox({ body: 'a < b <i>', contentType: '' })
    const tool = makeWebFetch({ model })
    expect(await invoke(tool, { url: 'https://example.com' }, sandbox)).toBe('a < b <i>')
  })

  it('truncates the body in the sandbox instead of rejecting large pages', () => {
    const sandbox = new FakeSandbox({ body: 'x' })
    const tool = makeWebFetch({ model })
    return invoke(tool, { url: 'https://example.com' }, sandbox).then(() => {
      expect(sandbox.curl).toContain('&& head -c 5242880 "$f" | base64')
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
    expect(sandbox.commands).toHaveLength(2)
  })

  it('probes the shell once per sandbox', async () => {
    const sandbox = new FakeSandbox({ body: 'page', contentType: 'text/plain' })
    const tool = makeWebFetch({ model })
    await invoke(tool, { url: 'https://example.com/a' }, sandbox)
    await invoke(tool, { url: 'https://example.com/b' }, sandbox)
    expect(sandbox.commands.filter((c) => c === SHELL_PROBE)).toHaveLength(1)
    expect(sandbox.commands).toHaveLength(3)
  })

  it('runs curl.exe through PowerShell and reads CRLF output', async () => {
    const sandbox = new FakePowerShellSandbox({ body: 'Hello wörld', contentType: 'text/plain; charset=utf-8' })
    const tool = makeWebFetch({ model })
    expect(await invoke(tool, { url: "https://example.com/it's" }, sandbox)).toBe('Hello wörld')
    const command = sandbox.curl
    expect(command).toContain("\n  curl.exe -sS -g --fail --no-location --proto '=http,https' --max-time ")
    // The URL is a single-quoted PowerShell literal (no expansion), with its own quotes doubled.
    expect(command.split("'https://example.com/it''s'")).toHaveLength(2)
    expect(command).toContain('$([guid]::NewGuid())')
    expect(command).toContain('strands-web-fetch-')
    expect(command).toContain(`.ReadBytes([Math]::Min($in.Length, ${5 * 1024 * 1024}))`)
    expect(command.endsWith('exit $s')).toBe(true)
    // Failures reach stderr through the console handle rather than PowerShell's CLIXML-wrapped error stream, and a
    // curl.exe that cannot run is exit 127.
    expect(command).toContain('\n$s = 127\ntry {\n')
    expect(command).toContain('} catch { if ($s -eq 0) { $s = 1 }; [Console]::Error.Write($_.Exception.Message) }')
    // Both the stderr check and the cleanup take the temp path literally (%TEMP% may contain wildcards).
    expect(command.split('-LiteralPath')).toHaveLength(3)
    expect(command).not.toContain('mktemp')
    expect(command).not.toContain('&&')
  })

  it('reports a PowerShell curl failure', async () => {
    const sandbox = new FakePowerShellSandbox({
      exitCode: 22,
      stderr: 'curl: (22) The requested URL returned error: 404\r\n',
    })
    const tool = makeWebFetch({ model })
    expect(await invoke(tool, { url: 'https://example.com/missing' }, sandbox)).toMatch(/\(22\).*404/)
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
    expect(sandbox.commands).toHaveLength(2)
    expect(invokeCalls).toHaveLength(2)
  })

  // Every sandbox command here is a fresh process (a PowerShell start on Windows) and they run in sequence: more
  // than the default 5 s allows on a busy CI runner.
  it('fetches end to end through the local environment sandbox', { timeout: 60_000 }, async () => {
    const server = createServer((req, res) => {
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
      expect(await invoke(tool, { url: `${base}/page` }, sandbox)).toBe('Hello wörld')
      expect(await invoke(tool, { url: `${base}/big` }, sandbox)).toBe('日'.repeat(50_000))
      expect(await invoke(tool, { url: `${base}/huge` }, sandbox)).toBe('x'.repeat(50_000))
      expect(await invoke(tool, { url: `${base}/notype` }, sandbox)).toBe('a < b')
      // Same scratch directory the tool derives, asked in the shell the local environment actually runs.
      const leftovers =
        (await shellOf(sandbox)) === 'powershell'
          ? "(Get-ChildItem ([IO.Path]::GetTempPath()) -Filter 'strands-web-fetch*' | Measure-Object).Count"
          : 'ls "${TMPDIR:-/tmp}" | grep -c strands-web-fetch'
      expect((await sandbox.execute(leftovers)).stdout.trim()).toBe('0')
      expect(await invoke(tool, { url: `${base}/missing` }, sandbox)).toContain('404')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('reports a redirect from either shell without summarizing or caching it', async () => {
    const notice =
      'Failed to fetch https://example.com/docs: it redirects to https://other.example/landing, and web_fetch ' +
      'does not follow redirects. Call web_fetch with that URL to read it.'
    for (const Sandbox of [FakeSandbox, FakePowerShellSandbox]) {
      const sandbox = new Sandbox({ body: 'redirect body', redirect: 'https://other.example/landing' })
      const tool = makeWebFetch({ model })
      expect(await invoke(tool, { url: 'https://example.com/docs', prompt: 'anything' }, sandbox)).toBe(notice)
      expect(await invoke(tool, { url: 'https://example.com/docs' }, sandbox)).toBe(notice)
      expect(sandbox.commands).toHaveLength(3)
    }
    expect(invokeCalls).toHaveLength(0)
  })

  it.each(['ftp://example.com/file', 'javascript:alert(1)', `https://example.com/${'a'.repeat(8192)}`])(
    'does not name a redirect target it would not fetch: %s',
    async (redirect) => {
      const tool = makeWebFetch({ model })
      expect(await invoke(tool, { url: 'https://example.com/docs' }, new FakeSandbox({ redirect }))).toBe(
        'Failed to fetch https://example.com/docs: it redirects to a location web_fetch cannot fetch.'
      )
    }
  )

  it.each(['curl', 'direct'] as const)(
    'stops at a same-host or cross-host redirect with the %s transport',
    { timeout: 60_000 },
    async (transport) => {
      const requests: string[] = []
      const listen = async (name: string, location: () => string): Promise<[string, () => Promise<void>]> => {
        const server = createServer((req, res) => {
          requests.push(`${name}${req.url}`)
          if (req.url === '/docs/moved') res.writeHead(302, { Location: '/private' })
          else if (req.url === '/docs/away') res.writeHead(308, { Location: location() })
          // Raw UTF-8 bytes and a space, as servers send them.
          else if (req.url === '/docs/odd')
            res.writeHead(301, { Location: Buffer.from('/a b/café?x=a|b').toString('latin1') })
          res.end('secret')
        })
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
        return [base, () => new Promise<void>((resolve) => server.close(() => resolve()))]
      }
      const [other, closeOther] = await listen('other', () => '')
      const [base, close] = await listen('base', () => `${other}/landing?q=1`)
      const tool = makeWebFetch({ model, transport })
      const sandbox = new RealAgent({ model }).sandbox
      // A curl config file that turns redirect following on must not bring it back.
      const curlHome = mkdtempSync(join(tmpdir(), 'strands-curlrc-'))
      writeFileSync(join(curlHome, '.curlrc'), '--location\n')
      vi.stubEnv('CURL_HOME', curlHome)
      try {
        const moved = await invoke(tool, { url: `${base}/docs/moved` }, sandbox)
        expect(moved).toContain(`Failed to fetch ${base}/docs/moved: it redirects to ${base}/private, and`)
        const away = await invoke(tool, { url: `${base}/docs/away` }, sandbox)
        expect(away).toContain(`Failed to fetch ${base}/docs/away: it redirects to ${other}/landing?q=1, and`)
        // curl percent-encodes in lower case.
        const odd = await invoke(tool, { url: `${base}/docs/odd` }, sandbox)
        expect(odd.toLowerCase()).toContain(`it redirects to ${base}/a%20b/caf%c3%a9?x=a%7cb, and`)
        expect(requests).toEqual(['base/docs/moved', 'base/docs/away', 'base/docs/odd'])
      } finally {
        vi.unstubAllEnvs()
        rmSync(curlHome, { recursive: true, force: true })
        await Promise.all([close(), closeOther()])
      }
    }
  )
})
