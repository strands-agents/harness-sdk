import { z } from 'zod'

import { Agent } from '../../agent/agent.js'
import { createAuxiliaryInvocationContext } from '../../agent/invocation-context.js'
import type { InvokeOptions } from '../../types/agent.js'
import { tool } from '../../tools/tool-factory.js'
import { htmlToMarkdown } from './extract.js'
import { type MakeWebFetchOptions, WEB_FETCH_DESCRIPTION_MARKDOWN, WEB_FETCH_DESCRIPTION_AGENTIC } from './types.js'

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024 // 5 MiB
export const DEFAULT_MAX_CONTENT_CHARS = 50_000

const _HEADERS = {
  'User-Agent': 'strands-agents-web-fetch/1.0',
  Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
}

const _ANALYST_PROMPT =
  'You answer a request about a single fetched web page. Use only the provided ' +
  'content; if it does not contain the answer, say so plainly. Be concise and ' +
  'factual, and preserve concrete details (names, numbers, quotes, links) ' +
  'relevant to the request.'

function offsetSchema(action: string): z.ZodOptional<z.ZodNumber> {
  return z
    .number()
    .int()
    .optional()
    .describe(
      'Character offset into the extracted content to start from. Use the value given in a ' +
        `previous result's truncation marker to ${action} the next part of a long page. Defaults to 0.`
    )
}

/**
 * Zod schema for markdown mode web fetch input validation.
 */
const webFetchMarkdownInputSchema = z.object({
  url: z.string().describe('URL to fetch. Must be http:// or https://.'),
  offset: offsetSchema('read'),
})

/**
 * Zod schema for agentic mode web fetch input validation.
 */
const webFetchAgenticInputSchema = z.object({
  url: z.string().describe('URL to fetch. Must be http:// or https://.'),
  prompt: z.string().describe('Question or instruction about the page content.'),
  offset: offsetSchema('ask about'),
})

/**
 * Create a web fetch tool. The exported {@link webFetch} is a default instance
 * with conservative limits; use this factory to tune them.
 */
export function makeWebFetch(options: MakeWebFetchOptions = {}): ReturnType<typeof tool> {
  const { mode = 'agentic', model: analystModel } = options
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxContentChars = options.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new Error(`maxBytes must be a positive number, got ${maxBytes}`)
  }
  if (!Number.isFinite(maxContentChars) || maxContentChars <= 0) {
    throw new Error(`maxContentChars must be a positive number, got ${maxContentChars}`)
  }

  const name = options.name ?? 'web_fetch'
  const description =
    options.description ?? (mode === 'markdown' ? WEB_FETCH_DESCRIPTION_MARKDOWN : WEB_FETCH_DESCRIPTION_AGENTIC)

  const markdownTool = tool({
    name,
    description,
    inputSchema: webFetchMarkdownInputSchema,
    callback: async (input, context) => {
      const { url, offset = 0 } = input
      const signal = context?.cancelSignal ?? null

      const [contentType, raw] = await fetchOnce(url, maxBytes, signal)

      const window = selectWindow(await extractContent(contentType, raw), offset, maxContentChars)
      return appendMarker(window, window.text, true)
    },
  })

  const agenticTool = tool({
    name,
    description,
    inputSchema: webFetchAgenticInputSchema,
    callback: async (input, context) => {
      const { url, prompt, offset = 0 } = input

      if (!prompt.trim()) {
        throw new Error('web_fetch: agentic mode requires a non-empty prompt.')
      }

      const effectiveModel = analystModel ?? context?.agent.auxModel
      if (!effectiveModel) {
        throw new Error(
          'web_fetch: agentic mode requires a model. ' + 'Pass model to makeWebFetch or call the tool from an agent.'
        )
      }

      const signal = context?.cancelSignal ?? null
      const auxiliaryInvocationContext = createAuxiliaryInvocationContext(context?.invocationContext)
      const invokeOptions: InvokeOptions = {
        ...(context?.cancelSignal && { cancelSignal: context.cancelSignal }),
        ...(auxiliaryInvocationContext && { invocationContext: auxiliaryInvocationContext }),
      }
      const [contentType, raw] = await fetchOnce(url, maxBytes, signal)

      const window = selectWindow(await extractContent(contentType, raw), offset, maxContentChars)
      // The analyst sees the bounds only; the paging hint is for the calling agent.
      const analystContent = appendMarker(window, window.text, false)

      // Fresh agent per call — no history from one fetch bleeds into the next.
      const analyst = new Agent({ model: effectiveModel, systemPrompt: _ANALYST_PROMPT, printer: false })
      const invokePrompt = `URL: ${url}\n\nRequest: ${prompt}\n\n--- Content ---\n${analystContent}`
      try {
        const result = await analyst.invoke(invokePrompt, invokeOptions)
        const answer = result.lastMessage.content
          .filter((block) => block.type === 'textBlock')
          .map((block) => block.text)
          .join('')
        return appendMarker(window, answer, true)
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
 * Default web fetch tool (agentic mode). See {@link makeWebFetch} to tune limits or switch modes.
 */
export const webFetch = makeWebFetch()

// ---- Internals ----

/** Convert markup bodies to markdown; return other content types as-is. */
async function extractContent(contentType: string, raw: string): Promise<string> {
  const isMarkup = contentType.toLowerCase().includes('html') || contentType.toLowerCase().includes('xml')
  return isMarkup ? await htmlToMarkdown(raw) : raw
}

/** The slice of extracted content delivered for one call, with its bounds. */
interface ContentWindow {
  text: string
  offset: number
  end: number
  total: number
}

/**
 * Return `content.slice(offset, offset + maxContentChars)` with its bounds.
 * Throws when `offset` is negative or past the end of the content.
 */
function selectWindow(content: string, offset: number, maxContentChars: number): ContentWindow {
  const total = content.length
  if (offset < 0) {
    throw new Error(`offset must be non-negative, got ${offset}`)
  }
  if (offset > 0 && offset >= total) {
    throw new Error(
      `offset ${offset} is past the end of the content (${total} characters); omit offset or pass a value below ${total}`
    )
  }
  const end = Math.min(offset + maxContentChars, total)
  return { text: content.slice(offset, end), offset, end, total }
}

/**
 * Append a truncation marker to `text` unless the window is the whole content.
 * The marker reports the window bounds and total length; with `withHint` it also
 * tells the caller how to read the next window, or that this is the end.
 */
function appendMarker(window: ContentWindow, text: string, withHint: boolean): string {
  if (window.offset === 0 && window.end === window.total) {
    return text
  }
  let marker = `[content truncated: showing characters ${window.offset}-${window.end} of ${window.total}`
  if (withHint) {
    const hint = window.end < window.total ? `pass offset=${window.end} to read the next window` : 'end of content'
    marker += `; ${hint}`
  }
  return `${text}\n\n${marker}]`
}

async function fetchOnce(url: string, maxBytes: number, signal: AbortSignal | null): Promise<[string, string]> {
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
    response = await globalThis.fetch(url, { method: 'GET', headers: _HEADERS, signal })
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
    return [response.headers.get('content-type') ?? '', '']
  }

  const contentType = response.headers.get('content-type') ?? ''
  const charset = _parseCharset(contentType)
  const reader = response.body.getReader()
  const decoder = new TextDecoder(charset)
  const chunks: string[] = []
  let total = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        throw new Error(`Response body exceeded max_bytes=${maxBytes}. Refusing to buffer more.`)
      }
      chunks.push(decoder.decode(value, { stream: true }))
    }
    chunks.push(decoder.decode())
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Web fetch tool request cancelled', { cause: error })
    }
    throw error
  } finally {
    reader.cancel().catch(() => {})
    reader.releaseLock()
  }

  return [contentType, chunks.join('')]
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
