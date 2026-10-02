import { z } from 'zod'

import { Agent } from '../../agent/agent.js'
import type { Sandbox } from '../../sandbox/base.js'
import { tool } from '../../tools/tool-factory.js'
import type { ToolContext } from '../../tools/tool.js'
import { htmlToMarkdown } from './extract.js'
import {
  type MakeWebFetchOptions,
  type WebFetchClient,
  WEB_FETCH_DESCRIPTION_MARKDOWN,
  WEB_FETCH_DESCRIPTION_AGENTIC,
} from './types.js'

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024 // 5 MiB
export const DEFAULT_MAX_CONTENT_CHARS = 50_000

const _HEADERS: Record<string, string> = {
  'User-Agent': 'strands-agents-web-fetch/1.0',
  Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
}

const _ANALYST_PROMPT =
  'You answer a request about a single fetched web page. Use only the provided ' +
  'content; if it does not contain the answer, say so plainly. Be concise and ' +
  'factual, and preserve concrete details (names, numbers, quotes, links) ' +
  'relevant to the request.'

const CURL_TIMEOUT = 30
// The characters RFC 3986 allows anywhere in a URL; anything else (whitespace,
// quotes, control characters, non-ASCII) is rejected before the URL reaches a
// shell command.  Security-critical for the curl transport.
const URL_CHARS = new RegExp(String.raw`^[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+$`)

/**
 * Zod schema for markdown mode web fetch input validation.
 */
const webFetchMarkdownInputSchema = z.object({
  url: z.string().describe('URL to fetch. Must be http:// or https://.'),
})

/**
 * Zod schema for agentic mode web fetch input validation.
 */
const webFetchAgenticInputSchema = z.object({
  url: z.string().describe('URL to fetch. Must be http:// or https://.'),
  prompt: z.string().describe('Question or instruction about the page content.'),
})

/**
 * Create a web fetch tool. The exported {@link webFetch} is a default instance
 * with conservative limits; use this factory to tune them.
 */
export function makeWebFetch(options: MakeWebFetchOptions = {}): ReturnType<typeof tool> {
  const { mode = 'agentic', model: analystModel } = options
  const client: WebFetchClient = options.client ?? 'curl'
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxContentChars = options.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS
  if (maxBytes <= 0) {
    throw new Error(`maxBytes must be a positive number, got ${maxBytes}`)
  }
  if (maxContentChars <= 0) {
    throw new Error(`maxContentChars must be a positive number, got ${maxContentChars}`)
  }
  if (client !== 'curl' && typeof client !== 'function') {
    throw new Error(`client must be a fetch function or 'curl', got ${typeof client}`)
  }

  const name = options.name ?? 'web_fetch'
  const description =
    options.description ?? (mode === 'markdown' ? WEB_FETCH_DESCRIPTION_MARKDOWN : WEB_FETCH_DESCRIPTION_AGENTIC)

  const markdownTool = tool({
    name,
    description,
    inputSchema: webFetchMarkdownInputSchema,
    callback: async (input, context) => {
      return fetchContent(input.url, context, client, maxBytes, maxContentChars)
    },
  })

  const agenticTool = tool({
    name,
    description,
    inputSchema: webFetchAgenticInputSchema,
    callback: async (input, context) => {
      const { url, prompt } = input

      if (!prompt.trim()) {
        throw new Error('web_fetch: agentic mode requires a non-empty prompt.')
      }

      const effectiveModel = analystModel ?? context?.agent.model
      if (!effectiveModel) {
        throw new Error(
          'web_fetch: agentic mode requires a model. ' + 'Pass model to makeWebFetch or call the tool from an agent.'
        )
      }

      const invokeOptions = context?.cancelSignal ? { cancelSignal: context.cancelSignal } : {}
      const content = await fetchContent(url, context, client, maxBytes, maxContentChars)

      // Fresh agent per call — no history from one fetch bleeds into the next.
      const analyst = new Agent({ model: effectiveModel, systemPrompt: _ANALYST_PROMPT, printer: false })
      const invokePrompt = `URL: ${url}\n\nRequest: ${prompt}\n\n--- Content ---\n${content}`
      try {
        const result = await analyst.invoke(invokePrompt, invokeOptions)
        return result.lastMessage.content
          .filter((block) => block.type === 'textBlock')
          .map((block) => block.text)
          .join('')
      } catch (error) {
        throw new Error(
          `url=<${url}> | web fetch analyst failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        )
      }
    },
  })

  return mode === 'markdown' ? markdownTool : agenticTool
}

/**
 * Default web fetch tool (agentic mode, curl transport).
 * See {@link makeWebFetch} to tune limits, switch modes, or provide a custom fetch function.
 */
export const webFetch = makeWebFetch()

// ---- Shared fetch + extract ----

/**
 * Fetch `url`, convert markup to markdown, and truncate.
 *
 * Dispatches to {@link fetchCurl} (sandbox) or {@link fetchDirect}
 * depending on `client`, then decodes, extracts readable content, and
 * enforces the character limit.
 */
async function fetchContent(
  url: string,
  context: ToolContext | undefined,
  client: WebFetchClient,
  maxBytes: number,
  maxContentChars: number
): Promise<string> {
  let contentType: string
  let data: Uint8Array

  if (typeof client === 'function') {
    const signal = context?.cancelSignal ?? null
    ;[contentType, data] = await fetchDirect(url, maxBytes, signal, client)
  } else {
    // curl transport — requires a sandbox on the host agent.
    const sandbox = getSandbox(context)
    ;[contentType, data] = await fetchCurl(sandbox, url, maxBytes)
  }

  const charset = _parseCharset(contentType)
  let raw: string
  try {
    raw = new TextDecoder(charset).decode(data)
  } catch {
    raw = new TextDecoder('utf-8').decode(data)
  }

  const isMarkup = contentType.toLowerCase().includes('html') || contentType.toLowerCase().includes('xml')
  let content = isMarkup ? await htmlToMarkdown(raw) : raw
  if (content.length > maxContentChars) {
    content = content.slice(0, maxContentChars) + '\n\n[content truncated]'
  }
  return content
}

function getSandbox(context: ToolContext | undefined): Sandbox {
  const sandbox = (context?.agent as { sandbox?: Sandbox } | undefined)?.sandbox
  if (!sandbox) {
    throw new Error(
      "web_fetch with client='curl' requires a sandbox. " +
        'Call from an agent with a sandbox, or pass a fetch function as client.'
    )
  }
  return sandbox
}

// ---- Curl transport internals ----

/**
 * Return `url` trimmed, or throw unless it is a well-formed http(s) URL.
 *
 * Only RFC 3986 characters are accepted so the URL is safe to embed in a
 * `curl` shell command without injection risk.
 */
export function validateUrl(url: string): string {
  url = url.trim()
  if (!URL_CHARS.test(url)) {
    throw new Error(
      'web_fetch URLs may only contain the characters RFC 3986 allows; ' +
        'percent-encode spaces and non-ASCII characters (and punycode the host) and retry.'
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
  if (!parsed.hostname || !/^https?:\/\/[^/?#]/i.test(url)) {
    throw new Error(`web_fetch URL has no host: ${JSON.stringify(url)}.`)
  }
  return url
}

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

/**
 * Build a `curl` command line for fetching `url` into `output`.
 */
export function curlCommand(url: string, output: string, maxBytes: number): string {
  const out = shellQuote(output)
  const part = shellQuote(output + '.part')
  return (
    `curl -sSL -g --fail --proto '=http,https' --proto-redir '=http,https' ` +
    `--max-time ${CURL_TIMEOUT} ` +
    `-A ${shellQuote(_HEADERS['User-Agent'] ?? 'strands-agents-web-fetch/1.0')} ` +
    `-o ${out} -w '%{content_type}\\n%{url_effective}' -- ${shellQuote(url)} ` +
    `&& head -c ${maxBytes} ${out} > ${part} && mv -f ${part} ${out}`
  )
}

async function fetchCurl(sandbox: Sandbox, url: string, maxBytes: number): Promise<[string, Uint8Array]> {
  url = validateUrl(url)
  const hex = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  const output = `/tmp/strands-web-fetch-${hex}`
  try {
    const result = await sandbox.execute(curlCommand(url, output, maxBytes), { timeout: CURL_TIMEOUT + 5 })
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `curl exited with code ${result.exitCode}`)
    }

    // The -w format writes content_type then url_effective, one per line.
    // Filter trailing empty entries (JS split keeps them, Python splitlines does not).
    const lines = result.stdout.split('\n').filter((l) => l.length > 0)
    const contentType = lines.length >= 2 ? (lines[lines.length - 2] ?? '').trim() : ''

    const data = await sandbox.readFile(output)
    return [contentType, data]
  } finally {
    try {
      await sandbox.execute(`rm -f ${shellQuote(output)} ${shellQuote(output + '.part')}`, { timeout: 10 })
    } catch {
      // cleanup is best-effort
    }
  }
}

// ---- Fetch function transport internals ----

async function fetchDirect(
  url: string,
  maxBytes: number,
  signal: AbortSignal | null,
  fetchFn: typeof globalThis.fetch
): Promise<[string, Uint8Array]> {
  // Validate scheme before hitting the network
  if (!URL.canParse(url)) {
    throw new Error(`url=<${url}> | fetch failed: invalid URL`)
  }
  const { protocol } = new URL(url)
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new Error(`url=<${url}> | fetch failed: only http and https URLs are supported`)
  }

  let response: Response
  try {
    response = await fetchFn(url, { method: 'GET', headers: _HEADERS, signal })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Web fetch tool request cancelled', { cause: error })
    }
    throw new Error(`url=<${url}> | fetch failed: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    })
  }

  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`HTTP ${response.status} ${response.statusText}: GET ${url}`)
  }

  // Stream the body and enforce the size cap on decompressed bytes as they arrive.
  if (!response.body) {
    return [response.headers.get('content-type') ?? '', new Uint8Array()]
  }

  const contentType = response.headers.get('content-type') ?? ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        throw new Error(`Response body exceeded max_bytes=${maxBytes}. Refusing to buffer more.`)
      }
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Web fetch tool request cancelled', { cause: error })
    }
    throw error
  } finally {
    reader.cancel().catch(() => {})
    reader.releaseLock()
  }

  // Concatenate chunks into a single Uint8Array
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }

  return [contentType, body]
}

function _parseCharset(contentType: string): string {
  const match = contentType.match(/charset=(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i)
  const charset = (match?.[1] ?? match?.[2] ?? match?.[3] ?? 'utf-8').toLowerCase()
  try {
    new TextDecoder(charset)
    return charset
  } catch {
    return 'utf-8'
  }
}
