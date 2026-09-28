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

import { randomUUID } from 'node:crypto'
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

function curlCommand(url: string, output: string): string {
  // -g keeps `{}`/`[]` in the URL literal; --proto/--proto-redir keep the request and any redirect on
  // http(s) (curl would otherwise follow a redirect to ftp://); --fail turns HTTP errors into a non-zero
  // exit; -sS keeps curl's own error text on stderr. The body goes to a file (stdout is decoded text,
  // which would lose the charset and split multi-byte characters) and is truncated in the sandbox before
  // it is read back; stdout carries only the final hop's content type and URL.
  const out = shellQuote(output)
  const part = shellQuote(`${output}.part`)
  return (
    `curl -sSL -g --fail --proto '=http,https' --proto-redir '=http,https' --max-time ${TIMEOUT_SECONDS} ` +
    `-A ${shellQuote(USER_AGENT)} -o ${out} -w '%{content_type}\\n%{url_effective}' -- ${shellQuote(url)} ` +
    `&& head -c ${MAX_BYTES} ${out} > ${part} && mv -f ${part} ${out}`
  )
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
  const output = `/tmp/strands-web-fetch-${randomUUID().replaceAll('-', '')}`
  let contentType: string
  let resolvedUrl: string
  let data: Uint8Array
  try {
    const result = await sandbox.execute(curlCommand(url, output), { timeout: TIMEOUT_SECONDS + 5 })
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `curl exited with code ${result.exitCode}`)
    }
    // The trailer is the last two lines; the content-type line is empty when the header is absent.
    const lines = result.stdout.replace(/\n+$/, '').split('\n')
    resolvedUrl = (lines.pop() ?? '').trim()
    contentType = (lines.pop() ?? '').trim()
    data = await sandbox.readFile(output)
  } finally {
    await sandbox
      .execute(`rm -f ${shellQuote(output)} ${shellQuote(`${output}.part`)}`, { timeout: 10 })
      .catch(() => undefined)
  }
  return toText(data, contentType, resolvedUrl, url)
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
