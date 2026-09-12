import { z } from 'zod'

import { Agent } from '../../agent/agent.js'
import { SandboxAbortError, SandboxTimeoutError } from '../../sandbox/errors.js'
import { shellQuote } from '../../sandbox/constants.js'
import { tool } from '../../tools/tool-factory.js'
import type { ToolContext } from '../../tools/tool.js'
import { htmlToMarkdown } from './extract.js'
import { type MakeWebFetchOptions, WEB_FETCH_DESCRIPTION_MARKDOWN, WEB_FETCH_DESCRIPTION_AGENTIC } from './types.js'

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024 // 5 MiB
export const DEFAULT_MAX_CONTENT_CHARS = 50_000
export const DEFAULT_TIMEOUT_SECONDS = 30

const _USER_AGENT = 'strands-agents-web-fetch/1.0'

const _ANALYST_PROMPT =
  'You answer a request about a single fetched web page. Use only the provided ' +
  'content; if it does not contain the answer, say so plainly. Be concise and ' +
  'factual, and preserve concrete details (names, numbers, quotes, links) ' +
  'relevant to the request.'

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
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxContentChars = options.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_SECONDS
  if (maxBytes <= 0) {
    throw new Error(`maxBytes must be a positive number, got ${maxBytes}`)
  }
  if (maxContentChars <= 0) {
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
      if (!context) {
        throw new Error('Tool context is required for web_fetch')
      }
      const [contentType, raw] = await fetchOnce(input.url, maxBytes, timeout, context)

      const isMarkup = contentType.toLowerCase().includes('html') || contentType.toLowerCase().includes('xml')
      let content = isMarkup ? await htmlToMarkdown(raw) : raw
      if (content.length > maxContentChars) {
        content = content.slice(0, maxContentChars) + '\n\n[content truncated]'
      }
      return content
    },
  })

  const agenticTool = tool({
    name,
    description,
    inputSchema: webFetchAgenticInputSchema,
    callback: async (input, context) => {
      if (!context) {
        throw new Error('Tool context is required for web_fetch')
      }
      const { url, prompt } = input

      if (!prompt.trim()) {
        throw new Error('web_fetch: agentic mode requires a non-empty prompt.')
      }

      const effectiveModel = analystModel ?? context.agent.model
      if (!effectiveModel) {
        throw new Error(
          'web_fetch: agentic mode requires a model. ' + 'Pass model to makeWebFetch or call the tool from an agent.'
        )
      }

      const invokeOptions = context.cancelSignal ? { cancelSignal: context.cancelSignal } : {}
      const [contentType, raw] = await fetchOnce(url, maxBytes, timeout, context)

      const isMarkup = contentType.toLowerCase().includes('html') || contentType.toLowerCase().includes('xml')
      let content = isMarkup ? await htmlToMarkdown(raw) : raw
      if (content.length > maxContentChars) {
        content = content.slice(0, maxContentChars) + '\n\n[content truncated]'
      }

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
 * Default web fetch tool (agentic mode). See {@link makeWebFetch} to tune limits or switch modes.
 */
export const webFetch = makeWebFetch()

// ---- Internals ----

async function fetchOnce(
  url: string,
  maxBytes: number,
  timeout: number,
  context: ToolContext
): Promise<[string, string]> {
  if (!URL.canParse(url)) {
    throw new Error(`url=<${url}> | fetch failed: invalid URL`)
  }
  const { protocol } = new URL(url)
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new Error(`url=<${url}> | fetch failed: only http and https URLs are supported`)
  }

  // --max-filesize exits 63 when Content-Length exceeds the cap.
  // --write-out writes the final-hop content-type to stderr, separate from the content.
  const command =
    `curl -sSLg --fail-with-body --max-filesize ${maxBytes}` +
    ` -A ${shellQuote(_USER_AGENT)} --write-out ${shellQuote('%{stderr}%{content_type}')} ${shellQuote(url)}`

  let result
  try {
    result = await context.agent.sandbox.execute(command, {
      timeout: timeout > 0 ? timeout : undefined,
      signal: context.cancelSignal,
    })
  } catch (error) {
    if (error instanceof SandboxAbortError) {
      throw new Error('Web fetch tool request cancelled', { cause: error })
    }
    if (error instanceof SandboxTimeoutError) throw error
    throw new Error(`url=<${url}> | fetch failed: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    })
  }

  // Length check covers chunked responses.
  if (result.exitCode === 63 || result.stdout.length > maxBytes) {
    throw new Error(`Response body exceeded max_bytes=${maxBytes}. Refusing to buffer more.`)
  }

  if (result.exitCode !== 0) {
    const firstLine = (result.stderr.split('\n')[0] ?? '').trim()
    const detail = firstLine || `curl exited with code ${result.exitCode}`
    throw new Error(`url=<${url}> | fetch failed: ${detail}`)
  }

  // On success, stderr contains only the content-type written by --write-out.
  const contentType = result.stderr.trim()

  return [contentType, result.stdout]
}
