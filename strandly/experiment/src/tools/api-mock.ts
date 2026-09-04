/**
 * Realistic API mock — verbose responses with headers/metadata, nested JSON
 * bodies, optional unreliability (intermittent 500s, timeouts).
 *
 * Compared to makeApiMock():
 * - Responses include headers, request ID, timing metadata
 * - Bodies are nested JSON the agent must dig into
 * - Unreliability flag: ~10% of calls return 500/timeout requiring retry
 * - Rate limiting: returns 429 after N calls in a window
 */

import { tool } from '../../../../strands-ts/src/tools/tool-factory.js'
import { z } from 'zod'

export interface Endpoint {
  method: string
  path: string
  response: { status: number; body: unknown }
  latencyMs?: number
}

export interface ApiMockOptions {
  unreliable?: boolean
  /** Fraction of calls that fail transiently (default 0.1 when unreliable=true) */
  failRate?: number
  /** Max calls per 10s window before 429 (default: no limit) */
  rateLimit?: number
}

export function makeApiMock(endpoints: Endpoint[], options: ApiMockOptions = {}) {
  const UNRELIABLE = options.unreliable ?? false
  const FAIL_RATE = options.failRate ?? 0.1
  const RATE_LIMIT = options.rateLimit ?? 0

  const callLog: Array<{ method: string; path: string; timestamp: number; status: number }> = []
  let callCount = 0
  let windowStart = Date.now()
  let requestIdCounter = 1000

  function checkRateLimit(): object | null {
    if (!RATE_LIMIT) return null
    const now = Date.now()
    if (now - windowStart > 10_000) {
      windowStart = now
      callCount = 0
    }
    callCount++
    if (callCount > RATE_LIMIT) {
      return {
        status: 429,
        headers: { 'retry-after': '2', 'x-rate-limit-remaining': '0' },
        body: { error: 'rate_limit_exceeded', message: 'Too many requests. Retry after 2 seconds.' },
      }
    }
    return null
  }

  function maybeInjectFailure(): object | null {
    if (!UNRELIABLE) return null
    if (Math.random() >= FAIL_RATE) return null

    const failures = [
      { status: 500, body: { error: 'internal_server_error', message: 'An unexpected error occurred. Please retry.', traceId: `tr-${requestIdCounter}` } },
      { status: 503, body: { error: 'service_unavailable', message: 'Service temporarily unavailable. Retry shortly.', retryAfterMs: 500 } },
      { status: 504, body: { error: 'gateway_timeout', message: 'Upstream service did not respond in time.' } },
    ]
    return failures[Math.floor(Math.random() * failures.length)]!
  }

  const request = tool({
    name: 'api_request',
    description: 'Make an HTTP request to the API. Returns a response object with status, headers, and body. The body is JSON that may contain nested data structures.',
    inputSchema: z.object({
      method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']),
      path: z.string().describe('The API path (e.g., /users?page=1)'),
      body: z.any().optional().describe('Request body for POST/PUT/PATCH (as JSON object)'),
      headers: z.record(z.string(), z.string()).optional().describe('Request headers'),
    }),
    callback: async (input) => {
      const reqId = `req-${requestIdCounter++}`

      // Rate limit check
      const rlResponse = checkRateLimit()
      if (rlResponse) {
        callLog.push({ method: input.method, path: input.path, timestamp: Date.now(), status: 429 })
        return JSON.stringify({ ...rlResponse, requestId: reqId })
      }

      // Unreliability check
      const failure = maybeInjectFailure()
      if (failure) {
        const status = (failure as any).status
        callLog.push({ method: input.method, path: input.path, timestamp: Date.now(), status })
        return JSON.stringify({ ...failure, requestId: reqId, headers: { 'x-request-id': reqId } })
      }

      // Find matching endpoint
      const endpoint = endpoints.find(e => e.method === input.method && matchPath(e.path, input.path))
      if (!endpoint) {
        callLog.push({ method: input.method, path: input.path, timestamp: Date.now(), status: 404 })
        return JSON.stringify({
          status: 404,
          requestId: reqId,
          headers: { 'x-request-id': reqId },
          body: { error: 'not_found', message: `No endpoint matches ${input.method} ${input.path}`, availablePaths: endpoints.map(e => `${e.method} ${e.path}`) },
        })
      }

      if (endpoint.latencyMs) {
        await new Promise(resolve => setTimeout(resolve, endpoint.latencyMs))
      }

      callLog.push({ method: input.method, path: input.path, timestamp: Date.now(), status: endpoint.response.status })

      return JSON.stringify({
        status: endpoint.response.status,
        requestId: reqId,
        headers: {
          'x-request-id': reqId,
          'content-type': 'application/json',
          ...(endpoint.response.status === 200 && { 'x-cache': 'MISS' }),
        },
        body: endpoint.response.body,
      })
    },
  })

  return {
    request,
    tools: [request],
    getCallLog: () => callLog,
    getCallCount: () => callLog.length,
  }
}

function matchPath(pattern: string, actual: string): boolean {
  // Split off query params for matching
  const [patternPath, patternQuery] = pattern.split('?')
  const [actualPath, actualQuery] = actual.split('?')

  // If pattern has query params, require exact match
  if (patternQuery) {
    if (patternQuery !== actualQuery) return false
  }

  const patternParts = patternPath!.split('/')
  const actualParts = actualPath!.split('/')
  if (patternParts.length !== actualParts.length) return false
  return patternParts.every((part, i) => part.startsWith(':') || part === actualParts[i])
}
