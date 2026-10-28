/**
 * web_fetch: fetch a URL and answer a prompt about its content.
 *
 * Fetches the URL, reduces it to text, and asks a small fast model to answer the prompt over that
 * content, returning the answer rather than the raw page so large payloads never reach the main
 * agent's context. The summarizer runs on the same provider as the main agent (see
 * `resolveWebFetchModel` in `models.ts`), so credentials always align.
 *
 * By default the HTTP request runs as `curl` inside the agent's `sandbox` (the same seam `shell` and
 * the file tools use), so a sandbox with network isolation or egress rules covers `web_fetch` too.
 * `transport: 'direct'` opts back into a plain global `fetch` from the harness process. Candidate to
 * port into the core SDK later; keep it minimal and SDK-idiomatic.
 */

import { Buffer } from 'node:buffer'
import { TextDecoder } from 'node:util'

import { Agent, type Model, type Sandbox, tool, type Tool } from '@strands-agents/sdk'
import { z } from 'zod'

import type { WebFetchTransport } from '../types/agent.js'

const USER_AGENT = 'strands-harness/1.0'
const TIMEOUT_SECONDS = 30
const MAX_BYTES = 5 * 1024 * 1024
const MAX_CHARS = 50_000
const CACHE_TTL_MS = 15 * 60 * 1000
// The characters RFC 3986 allows anywhere in a URL; anything else (whitespace, quotes, control
// characters, non-ASCII) is rejected before the URL reaches a shell or a socket.
const URL_CHARS = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/

const SUMMARIZER_PROMPT =
  'You answer a request about a single fetched web page. Use only the provided content; if it ' +
  'does not contain the answer, say so plainly. Be concise and factual, and preserve concrete ' +
  'details (names, numbers, quotes, links) relevant to the request.'

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()
}

/** Return `url` trimmed, or throw unless it is a well-formed http(s) URL. */
function validateUrl(url: string): string {
  url = url.trim()
  if (!URL_CHARS.test(url)) {
    throw new Error(
      'web_fetch URLs may only contain the characters RFC 3986 allows; percent-encode spaces and non-ASCII ' +
        'characters (and punycode the host) and retry.'
    )
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`web_fetch could not parse the URL ${JSON.stringify(url)}.`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`web_fetch only supports http(s) URLs, got ${JSON.stringify(url)}.`)
  }
  // Check the raw authority too: the WHATWG parser silently repairs forms like `https:///host`.
  if (!parsed.hostname || !/^https?:\/\/[^/?#]/i.test(url)) {
    throw new Error(`web_fetch URL has no host: ${JSON.stringify(url)}.`)
  }
  return url
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function curlCommand(url: string): string {
  // -g keeps `{}`/`[]` in the URL literal; --proto/--proto-redir keep the request and any redirect on
  // http(s) (curl would otherwise follow a redirect to ftp://); --fail turns HTTP errors into a non-zero
  // exit; -sS keeps curl's own error text on stderr. The body is spooled to a file the shell picks with
  // mktemp (so the path only ever has to make sense inside the sandbox), truncated there, and returned over
  // stdout as base64: ASCII survives the chunked stdout decoding that raw bytes would not, and the charset is
  // applied once here. stdout is the final hop's content type and URL, then the base64 body.
  return (
    `f=$(mktemp -t strands-web-fetch.XXXXXX) && ` +
    `curl -sSL -g --fail --proto '=http,https' --proto-redir '=http,https' --max-time ${TIMEOUT_SECONDS} ` +
    `-A ${shellQuote(USER_AGENT)} -o "$f" -w '%{content_type}\\n%{url_effective}\\n' -- ${shellQuote(url)} ` +
    `&& head -c ${MAX_BYTES} "$f" | base64; s=$?; rm -f "$f"; exit $s`
  )
}

function powershellCurlCommand(url: string): string {
  // The same contract for a sandbox whose shell is PowerShell (the local environment on Windows). `curl.exe`
  // because plain `curl` is an Invoke-WebRequest alias there; the body is truncated and base64-encoded in
  // .NET. Errors are written through the console handle, not PowerShell's own error stream, which is
  // CLIXML-wrapped when stderr is a pipe; the `try` also turns a missing curl.exe into a plain exit 127.
  // `-LiteralPath` because `%TEMP%` may contain wildcard characters.
  const quoted = `'${url.replace(/'/g, "''")}'`
  return [
    '$f = Join-Path ([IO.Path]::GetTempPath()) "strands-web-fetch-$([guid]::NewGuid())"',
    '$s = 127',
    'try {',
    `  curl.exe -sSL -g --fail --proto '=http,https' --proto-redir '=http,https' --max-time ${TIMEOUT_SECONDS} ` +
      `-A '${USER_AGENT}' -o $f --stderr "$f.err" -w '%{content_type}\\n%{url_effective}\\n' ${quoted}`,
    '  $s = $LASTEXITCODE',
    '  if ($s -eq 0) {',
    '    $in = [IO.File]::OpenRead($f)',
    `    try { $b = (New-Object IO.BinaryReader $in).ReadBytes([Math]::Min($in.Length, ${MAX_BYTES})) }` +
      ' finally { $in.Dispose() }',
    '    [Convert]::ToBase64String($b)',
    '  } elseif (Test-Path -LiteralPath "$f.err") { [Console]::Error.Write([IO.File]::ReadAllText("$f.err")) }',
    '} catch { if ($s -eq 0) { $s = 1 }; [Console]::Error.Write($_.Exception.Message) }',
    'Remove-Item -Force -LiteralPath $f, "$f.err" -ErrorAction SilentlyContinue',
    'exit $s',
  ].join('\n')
}

// The Sandbox contract names no shell dialect, so the only check that holds for every sandbox is to ask: PowerShell
// prints its edition (`Desktop` or `Core`), `sh` expands the unset variable to an empty line.
/** @internal Exported for tests. */
export const SHELL_PROBE = 'echo "${PSEdition}"'
const shells = new WeakMap<Sandbox, 'sh' | 'powershell'>()

/** @internal Exported for tests. */
export async function shellOf(sandbox: Sandbox): Promise<'sh' | 'powershell'> {
  let shell = shells.get(sandbox)
  if (!shell) {
    const result = await sandbox.execute(SHELL_PROBE, { timeout: 10 })
    shell = ['Desktop', 'Core'].includes(result.stdout.trim()) ? 'powershell' : 'sh'
    shells.set(sandbox, shell)
  }
  return shell
}

function decode(data: Uint8Array, contentType: string): string {
  const charset = /charset=["']?([\w.-]+)/i.exec(contentType)?.[1] ?? 'utf-8'
  try {
    return new TextDecoder(charset).decode(data)
  } catch {
    return new TextDecoder().decode(data)
  }
}

type Fetched = { resolvedUrl: string; text: string }

function toText(data: Uint8Array, contentType: string, resolvedUrl: string, url: string): Fetched {
  const raw = decode(data, contentType)
  const text = contentType.toLowerCase().includes('html') ? htmlToText(raw) : raw
  return { resolvedUrl: resolvedUrl.trim() || url, text: text.slice(0, MAX_CHARS) }
}

/** Fetch a validated `url` with `curl` inside `sandbox`; throws when curl fails. */
async function fetchCurl(sandbox: Sandbox, url: string): Promise<Fetched> {
  const command = (await shellOf(sandbox)) === 'powershell' ? powershellCurlCommand(url) : curlCommand(url)
  const result = await sandbox.execute(command, { timeout: TIMEOUT_SECONDS + 5 })
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `curl exited with code ${result.exitCode}`)
  }
  // Two header lines (the content-type line is empty when the header is absent), then the base64 body,
  // which base64(1) may wrap; whitespace is not part of the encoding.
  const [contentType = '', resolvedUrl = '', ...body] = result.stdout.split('\n')
  const data = new Uint8Array(Buffer.from(body.join('').replace(/\s+/g, ''), 'base64'))
  return toText(data, contentType.trim(), resolvedUrl.trim(), url)
}

/** Fetch a validated `url` from the harness process with global `fetch` (bypasses the sandbox). */
async function fetchDirect(url: string): Promise<Fetched> {
  let response: Response
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_SECONDS * 1000),
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error(`web_fetch gave up after ${TIMEOUT_SECONDS}s.`, { cause: err })
    }
    throw err
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`)
  }
  return toText(await readCapped(response), response.headers.get('content-type') ?? '', response.url, url)
}

/** Read at most `MAX_BYTES` of the (decoded) body, then cancel the stream rather than buffering the rest. */
async function readCapped(response: Response): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.byteLength
  }
  if (size >= MAX_BYTES) await reader.cancel()
  const data = new Uint8Array(Math.min(size, MAX_BYTES))
  let offset = 0
  for (const chunk of chunks) {
    const slice = chunk.subarray(0, Math.min(chunk.byteLength, data.byteLength - offset))
    data.set(slice, offset)
    offset += slice.byteLength
    if (offset >= data.byteLength) break
  }
  return data
}

async function fetchText(sandbox: Sandbox, url: string, transport: WebFetchTransport): Promise<Fetched> {
  url = validateUrl(url)
  return transport === 'curl' ? fetchCurl(sandbox, url) : fetchDirect(url)
}

/** Options for {@link makeWebFetch}. */
export interface MakeWebFetchOptions {
  /** The summarizer that answers the prompt over the fetched page. */
  model: Model
  /** `'curl'` runs inside the agent's sandbox (the default); `'direct'` fetches from the harness process. */
  transport?: WebFetchTransport | undefined
}

/** Build a `web_fetch` tool whose summarizer answers over the fetched page using `model`. */
export function makeWebFetch({ model, transport = 'curl' }: MakeWebFetchOptions): Tool {
  if (transport !== 'curl' && transport !== 'direct') {
    throw new Error(`web_fetch transport must be 'curl' or 'direct', got ${JSON.stringify(transport)}.`)
  }
  const cache = new Map<string, { expires: number; resolvedUrl: string; text: string }>()

  return tool({
    name: 'web_fetch',
    description:
      'Fetch a URL and answer a prompt about its content. Performs an HTTP GET, reduces the ' +
      'response to text, and asks a small fast model to answer the prompt using only that content, ' +
      'returning the answer rather than the raw page so large pages do not flood the conversation. ' +
      'Fetched content is cached for 15 minutes, so repeated fetches of the same URL are fast while ' +
      'each prompt is answered fresh.',
    inputSchema: z.object({
      url: z.string().describe('The http(s) URL to fetch.'),
      prompt: z
        .string()
        .optional()
        .describe(
          'What to extract from or answer about the fetched content. Leave empty to get the ' +
            'whole page content back verbatim instead of a model-generated answer.'
        ),
    }),
    callback: async (input, context) => {
      if (!context) throw new Error('Tool context is required for web_fetch.')
      let resolvedUrl: string
      let text: string
      const cached = cache.get(input.url)
      if (cached && cached.expires > Date.now()) {
        ;({ resolvedUrl, text } = cached)
      } else {
        try {
          ;({ resolvedUrl, text } = await fetchText(context.agent.sandbox, input.url, transport))
        } catch (err) {
          return `Failed to fetch ${input.url}: ${err instanceof Error ? err.message : String(err)}`
        }
        cache.set(input.url, { expires: Date.now() + CACHE_TTL_MS, resolvedUrl, text })
      }

      if (!input.prompt?.trim()) {
        return text
      }

      const summarizer = new Agent({ model, systemPrompt: SUMMARIZER_PROMPT, printer: false })
      const result = await summarizer.invoke(
        `Fetched URL: ${resolvedUrl}\n\nRequest: ${input.prompt}\n\n--- Content ---\n${text}`
      )
      return result.toString()
    },
  })
}
