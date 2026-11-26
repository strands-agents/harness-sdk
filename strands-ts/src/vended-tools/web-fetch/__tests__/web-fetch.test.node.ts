import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

import { describe, expect, it, vi } from 'vitest'
import { NotASandboxLocalEnvironment } from '../../../sandbox/not-a-sandbox-local-environment.js'
import { makeWebFetch } from '../web-fetch.js'
import type { ToolContext } from '../../../tools/tool.js'
import type { LocalAgent } from '../../../types/agent.js'

const hasCurl = spawnSync('curl', ['--version']).status === 0

describe('webFetch sandbox option', () => {
  it.skipIf(!hasCurl)('fetches end to end through the local environment', { timeout: 60_000 }, async () => {
    const streamTotal = 64 * 1024 * 1024
    let streamSent = 0
    const server = createServer(async (request, response) => {
      if (request.url === '/gzip' || request.url === '/gzipbomb') {
        // Compressed whether or not the request asked for it.
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Encoding': 'gzip' })
        response.end(gzipSync(request.url === '/gzip' ? 'wörld' : Buffer.alloc(5_000_000, 'x')))
        return
      }
      if (request.url === '/redirect') {
        response.writeHead(302, { Location: '/page' }).end()
        return
      }
      if (request.url === '/redirect-file') {
        // --proto-redir must refuse this; without it curl -L would read a local file.
        response.writeHead(302, { Location: 'file:///etc/passwd' }).end()
        return
      }
      if (request.url === '/huge') {
        response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': 500_000 })
        response.end(Buffer.alloc(500_000, 'x'))
        return
      }
      if (request.url === '/stream') {
        // No Content-Length: the size is unknown until the connection closes.
        response.writeHead(200, { 'Content-Type': 'text/plain' })
        const chunk = Buffer.alloc(65536, 'x')
        while (streamSent < streamTotal && !response.destroyed) {
          streamSent += chunk.length
          if (!response.write(chunk)) await Promise.race([once(response, 'drain'), once(response, 'close')])
        }
        response.end()
        return
      }
      if (request.url === '/notype') {
        response.writeHead(200, { 'Content-Length': 5 }).end('a < b')
        return
      }
      if (request.url === '/big') {
        // Well past the sandbox's 64 KiB read chunks: multi-byte characters must survive intact.
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('日'.repeat(100_000))
        return
      }
      if (request.url === '/sjis') {
        // "日本語" in Shift_JIS.
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=Shift_JIS' })
        response.end(Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]))
        return
      }
      response.writeHead(request.url === '/missing' ? 404 : 200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end('<html><body><script>x</script><p>Hello <b>wörld</b></p></body></html>')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    const sandbox = new NotASandboxLocalEnvironment()
    const execute = vi.spyOn(sandbox, 'execute')
    const context: ToolContext = {
      toolUse: { name: 'web_fetch', toolUseId: 'test-id', input: {} },
      agent: { sandbox } as unknown as LocalAgent,
      invocationState: {},
      cancelSignal: new AbortController().signal,
      interrupt: () => {
        throw new Error('interrupt not available in mock context')
      },
    }
    const fetchPath = (path: string, options: { maxBytes?: number; maxContentChars?: number } = {}): Promise<unknown> =>
      makeWebFetch({ mode: 'markdown', sandbox: true, ...options }).invoke({ url: `${base}${path}` }, context)

    // Without -q this .curlrc would make curl fetch a second URL into the same output.
    const curlHome = mkdtempSync(join(tmpdir(), 'web-fetch-'))
    writeFileSync(join(curlHome, '.curlrc'), `url = "${base}/notype"\n`)
    vi.stubEnv('CURL_HOME', curlHome)

    try {
      expect(await fetchPath('/redirect')).toBe('Hello **wörld**\n')
      await expect(fetchPath('/redirect-file')).rejects.toThrow('curl: (1) Protocol "file"')
      expect(await fetchPath('/gzip')).toBe('wörld')
      await expect(fetchPath('/gzipbomb', { maxBytes: 100_000 })).rejects.toThrow('max_bytes=100000')
      expect(execute).toHaveBeenLastCalledWith(expect.stringContaining('curl'), expect.anything())
      expect(await fetchPath('/big', { maxContentChars: 400_000 })).toBe('日'.repeat(100_000))
      expect(await fetchPath('/sjis')).toBe('日本語')
      expect(await fetchPath('/notype')).toBe('a < b')
      await expect(fetchPath('/huge', { maxBytes: 100_000 })).rejects.toThrow('max_bytes=100000')
      await expect(fetchPath('/stream', { maxBytes: 100_000 })).rejects.toThrow('max_bytes=100000')
      await expect(fetchPath('/missing')).rejects.toThrow('404')
    } finally {
      vi.unstubAllEnvs()
      rmSync(curlHome, { recursive: true })
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    // curl was stopped long before the server ran out of body to send.
    expect(streamSent).toBeLessThan(streamTotal)
  })
})
