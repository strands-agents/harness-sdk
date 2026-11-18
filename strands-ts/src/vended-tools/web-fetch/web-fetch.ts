import { z } from 'zod'

import { Agent } from '../../agent/agent.js'
import { createAuxiliaryInvocationContext } from '../../agent/invocation-context.js'
import type { InvokeOptions } from '../../types/agent.js'
import { decodeBase64 } from '../../types/media.js'
import { shellQuote } from '../../sandbox/constants.js'
import { SandboxAbortError, SandboxTimeoutError } from '../../sandbox/errors.js'
import { tool } from '../../tools/tool-factory.js'
import { htmlToMarkdown } from './extract.js'
import { type MakeWebFetchOptions, WEB_FETCH_DESCRIPTION_MARKDOWN, WEB_FETCH_DESCRIPTION_AGENTIC } from './types.js'
import type { Sandbox } from '../../sandbox/base.js'
import type { ExecutionResult } from '../../sandbox/types.js'
import type { ToolContext } from '../../tools/tool.js'

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024 // 5 MiB
export const DEFAULT_MAX_CONTENT_CHARS = 50_000
const TIMEOUT_SECONDS = 30

// The characters RFC 3986 allows in a URL; anything else is rejected before the URL reaches a shell.
const URL_CHARS = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/
// PowerShell prints its edition (Desktop or Core); sh expands the unset variable to an empty line.
const SHELL_PROBE = 'echo "${PSEdition}"'
const shells = new WeakMap<Sandbox, 'sh' | 'powershell'>()
// Room for the content type and exit status that follow the body in the curl output.
const TRAILER_BYTES = 1024
const CURL_FILESIZE_EXCEEDED = 63
const CURL_TIMED_OUT = 28
const NEWLINE = 0x0a

const _HEADERS = {
  'User-Agent': 'strands-agents-web-fetch/1.0',
  Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
}

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
  prompt: z
    .string()
    .optional()
    .describe(
      'Question or instruction about the page content. Leave empty to get the page content itself instead of an answer.'
    ),
})

/**
 * Create a web fetch tool. The exported {@link webFetch} is a default instance
 * with conservative limits; use this factory to tune them.
 */
export function makeWebFetch(options: MakeWebFetchOptions = {}): ReturnType<typeof tool> {
  const { mode = 'agentic', model: analystModel, transport = 'direct' } = options
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxContentChars = options.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new Error(`maxBytes must be a positive number, got ${maxBytes}`)
  }
  if (!Number.isFinite(maxContentChars) || maxContentChars <= 0) {
    throw new Error(`maxContentChars must be a positive number, got ${maxContentChars}`)
  }
  if (transport !== 'direct' && transport !== 'sandbox') {
    throw new Error(`transport must be 'direct' or 'sandbox', got ${JSON.stringify(transport)}`)
  }

  const name = options.name ?? 'web_fetch'
  const description =
    options.description ?? (mode === 'markdown' ? WEB_FETCH_DESCRIPTION_MARKDOWN : WEB_FETCH_DESCRIPTION_AGENTIC)

  const markdownTool = tool({
    name,
    description,
    inputSchema: webFetchMarkdownInputSchema,
    callback: async (input, context) => {
      const { url } = input
      const signal = context?.cancelSignal ?? null

      const [contentType, raw] = await fetchOnce(url, maxBytes, signal, transportSandbox(transport, context))

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
      const { url, prompt = '' } = input

      const effectiveModel = analystModel ?? context?.agent.auxModel
      if (prompt.trim() && !effectiveModel) {
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
      const [contentType, raw] = await fetchOnce(url, maxBytes, signal, transportSandbox(transport, context))

      const isMarkup = contentType.toLowerCase().includes('html') || contentType.toLowerCase().includes('xml')
      let content = isMarkup ? await htmlToMarkdown(raw) : raw
      if (content.length > maxContentChars) {
        content = content.slice(0, maxContentChars) + '\n\n[content truncated]'
      }
      if (!prompt.trim() || !effectiveModel) {
        return content
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
  signal: AbortSignal | null,
  sandbox?: Sandbox
): Promise<[string, string]> {
  // Validate scheme before hitting the network
  if (!URL.canParse(url)) {
    throw new Error(`url=<${url}> | fetch failed: invalid URL`)
  }
  const { protocol } = new URL(url)
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new Error(`url=<${url}> | fetch failed: only http and https URLs are supported`)
  }

  if (sandbox) {
    const [contentType, body] = await fetchSandbox(sandbox, url, maxBytes, signal)
    return [contentType, new TextDecoder(_parseCharset(contentType)).decode(body)]
  }

  const timeoutSignal = AbortSignal.timeout(TIMEOUT_SECONDS * 1000)
  const fetchSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal
  let response: Response
  try {
    response = await globalThis.fetch(url, { method: 'GET', headers: _HEADERS, signal: fetchSignal })
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

/** The host agent's sandbox for the `'sandbox'` transport, `undefined` for `'direct'`. */
function transportSandbox(transport: string, context: ToolContext | undefined): Sandbox | undefined {
  if (transport === 'direct') return undefined
  const sandbox = context?.agent.sandbox
  if (!sandbox) {
    throw new Error("web_fetch: transport 'sandbox' requires a sandbox. Call the tool from an agent.")
  }
  return sandbox
}

/** Perform one HTTP GET as `curl` inside `sandbox`, returning `[contentType, body]`. */
async function fetchSandbox(
  sandbox: Sandbox,
  url: string,
  maxBytes: number,
  signal: AbortSignal | null
): Promise<[string, Uint8Array]> {
  url = url.trim()
  if (!URL_CHARS.test(url)) {
    throw new Error(
      `url=<${url}> | fetch failed: the URL may only contain the characters RFC 3986 allows, ` +
        'percent-encode spaces and non-ASCII characters'
    )
  }
  // The WHATWG parser repairs forms like `https:///host`; curl would not.
  if (!/^https?:\/\/[^/?#]/i.test(url)) {
    throw new Error(`url=<${url}> | fetch failed: only http and https URLs are supported`)
  }
  if (signal?.aborted) {
    throw new Error('Web fetch tool request cancelled')
  }

  // A body that fills `limit` bytes has pushed the trailer out, so it is over `maxBytes`.
  const limit = maxBytes + TRAILER_BYTES
  let result
  try {
    const build = (await shellOf(sandbox)) === 'powershell' ? powershellCurlCommand : curlCommand
    result = await sandbox.execute(build(url, maxBytes, limit), {
      timeout: TIMEOUT_SECONDS + 5,
      signal: signal ?? undefined,
    })
  } catch (error) {
    if (error instanceof SandboxAbortError) {
      throw new Error('Web fetch tool request cancelled', { cause: error })
    }
    if (error instanceof SandboxTimeoutError) {
      throw new Error(`url=<${url}> | fetch timed out`, { cause: error })
    }
    throw error
  }

  return parseCurlResult(result, url, maxBytes, limit)
}

/** Split the curl command's output into `[contentType, body]`, throwing if curl failed. */
function parseCurlResult(result: ExecutionResult, url: string, maxBytes: number, limit: number): [string, Uint8Array] {
  let exitCode = result.exitCode
  let body: Uint8Array = new Uint8Array()
  let contentType = ''
  if (exitCode === 0) {
    const data = decodeBase64(result.stdout.replace(/\s+/g, ''))
    const statusStart = data.lastIndexOf(NEWLINE)
    const head = data.subarray(0, Math.max(statusStart, 0))
    const typeStart = head.lastIndexOf(NEWLINE)
    const latin1 = new TextDecoder('latin1')
    body = head.subarray(0, Math.max(typeStart, 0))
    contentType = latin1.decode(head.subarray(typeStart + 1)).trim()
    const status = Number.parseInt(latin1.decode(data.subarray(statusStart + 1)), 10)
    exitCode = data.length >= limit ? CURL_FILESIZE_EXCEEDED : status
  }
  if (Number.isNaN(exitCode)) {
    throw new Error(`url=<${url}> | fetch failed: unexpected curl output from the sandbox`)
  }
  if (exitCode === CURL_FILESIZE_EXCEEDED || body.length > maxBytes) {
    throw new Error(`Response body exceeded max_bytes=${maxBytes}. Refusing to buffer more.`)
  }
  if (exitCode === CURL_TIMED_OUT) {
    throw new Error(`url=<${url}> | fetch timed out`)
  }
  if (exitCode !== 0) {
    throw new Error(`url=<${url}> | fetch failed: ${result.stderr.trim() || `curl exited with code ${exitCode}`}`)
  }
  return [contentType, body]
}

/** The shell `sandbox` runs commands in, probed once per sandbox. */
async function shellOf(sandbox: Sandbox): Promise<'sh' | 'powershell'> {
  let shell = shells.get(sandbox)
  if (!shell) {
    const result = await sandbox.execute(SHELL_PROBE, { timeout: TIMEOUT_SECONDS })
    // A failed probe is inconclusive: answer `sh` for this call and probe again next time.
    if (result.exitCode !== 0) return 'sh'
    shell = ['Desktop', 'Core'].includes(result.stdout.trim()) ? 'powershell' : 'sh'
    shells.set(sandbox, shell)
  }
  return shell
}

function curlCommand(url: string, maxBytes: number, limit: number): string {
  // stdout is base64 of the body, a newline, the content type, a newline, and curl's exit status. `head` stops
  // curl at `limit` bytes, which --max-filesize alone does not when the response has no Content-Length.
  return (
    `{ curl ${curlArgs(maxBytes)} -w '\\n%{content_type}' -- ${shellQuote(url)}; ` +
    `printf '\\n%s' "$?"; } | head -c ${limit} | base64`
  )
}

function powershellCurlCommand(url: string, maxBytes: number, limit: number): string {
  // Same stdout as `curlCommand`. `curl.exe` because `curl` is an Invoke-WebRequest alias in Windows
  // PowerShell; .NET reads the raw bytes and writes errors, both of which PowerShell's own pipeline would re-encode.
  const args = `${curlArgs(maxBytes)} -w "\\n%{content_type}\\n0" -- "${url.replace(/'/g, "''")}"`
  return [
    '$status = 127',
    'try {',
    `  $info = New-Object Diagnostics.ProcessStartInfo 'curl.exe', '${args}'`,
    '  $info.UseShellExecute = $false',
    '  $info.RedirectStandardOutput = $true',
    '  $info.RedirectStandardError = $true',
    '  $process = [Diagnostics.Process]::Start($info)',
    '  $errors = $process.StandardError.ReadToEndAsync()',
    `  $bytes = (New-Object IO.BinaryReader $process.StandardOutput.BaseStream).ReadBytes(${limit})`,
    `  $full = $bytes.Length -ge ${limit}`,
    '  if ($full) { try { $process.Kill() } catch { } }',
    '  $process.WaitForExit()',
    '  $status = if ($full) { 0 } else { $process.ExitCode }',
    '  if ($status -eq 0) { [Convert]::ToBase64String($bytes) } else { [Console]::Error.Write($errors.Result) }',
    '} catch { if ($status -eq 0) { $status = 1 }; [Console]::Error.Write($_.Exception.Message) }',
    'exit $status',
  ].join('\n')
}

function curlArgs(maxBytes: number): string {
  // -g keeps `[]` in the URL literal; --proto/--proto-redir keep the request and every redirect on http(s).
  // Double quotes mean the same to sh and to a Windows command line.
  return (
    `-sSL -g --fail --proto "=http,https" --proto-redir "=http,https" --max-time ${TIMEOUT_SECONDS} ` +
    `--max-filesize ${maxBytes} -A "${_HEADERS['User-Agent']}" -H "Accept: ${_HEADERS.Accept}"`
  )
}
