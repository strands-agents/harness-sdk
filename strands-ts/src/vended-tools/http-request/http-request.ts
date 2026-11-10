import { tool } from '../../tools/tool-factory.js'
import { z } from 'zod'

/**
 * Zod schema for HTTP request input validation.
 */
const httpRequestInputSchema = z.object({
  method: z
    .enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'])
    .describe('HTTP method to use for the request'),
  url: z.string().url().describe('URL to send the request to'),
  headers: z.record(z.string(), z.string()).optional().describe('Optional HTTP headers as key-value pairs'),
  body: z.string().optional().describe('Optional request body as a string'),
  timeout: z.number().positive().optional().describe('Optional timeout in seconds (default: 30)'),
})

/**
 * HTTP request tool for making HTTP requests to external APIs.
 *
 * Supports all standard HTTP methods (GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS)
 * and provides comprehensive request configuration including headers, body, and timeout.
 *
 * @example
 * ```typescript
 * // With agent
 * const agent = new Agent({ tools: [httpRequest] })
 * await agent.invoke('Make a GET request to https://api.example.com/data')
 *
 * // Direct usage
 * const response = await httpRequest.invoke({
 *   method: 'POST',
 *   url: 'https://api.example.com/users',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: '{"name":"test"}',
 *   timeout: 10
 * })
 * ```
 */
export const httpRequest = tool({
  name: 'http_request',
  description:
    'Makes HTTP requests to external APIs. Supports GET, POST, PUT, DELETE, PATCH, HEAD, and OPTIONS methods. Returns response with status, headers, and body.',
  inputSchema: httpRequestInputSchema,
  callback: async (input, context) => {
    const { method, url, headers, body, timeout = 30 } = input

    // Abort on timeout or tool-execution cancellation, whichever comes first
    const timeoutSignal = AbortSignal.timeout(timeout * 1000)
    const signal = context ? AbortSignal.any([timeoutSignal, context.cancelSignal]) : timeoutSignal

    try {
      const fetchOptions: RequestInit = { method, signal }

      if (headers !== undefined) {
        fetchOptions.headers = headers
      }
      if (body !== undefined) {
        fetchOptions.body = body
      }

      const response = await globalThis.fetch(url, fetchOptions)
      const responseBody = await response.text()

      const responseHeaders: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}: ${method} ${url}`)
      }

      return {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        body: responseBody,
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        const reason = timeoutSignal.aborted ? `timed out after ${timeout} seconds` : 'cancelled'
        throw new Error(`Request ${reason}: ${method} ${url}`, { cause: error })
      }
      throw error
    }
  },
})
