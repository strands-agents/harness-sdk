import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ToolContext } from '../../../tools/tool.js'
import type { LocalAgent } from '../../../types/agent.js'
import { httpRequest } from '../http-request.js'

describe('httpRequest tool', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  describe.each([
    { method: 'GET' as const, status: 200, statusText: 'OK' },
    { method: 'POST' as const, status: 201, statusText: 'Created' },
    { method: 'PUT' as const, status: 200, statusText: 'OK' },
    { method: 'DELETE' as const, status: 204, statusText: 'No Content' },
    { method: 'PATCH' as const, status: 200, statusText: 'OK' },
    { method: 'HEAD' as const, status: 200, statusText: 'OK' },
    { method: 'OPTIONS' as const, status: 200, statusText: 'OK' },
  ])('$method request', ({ method, status, statusText }) => {
    it('returns successful response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status,
        statusText,
        headers: new Map([['content-type', 'application/json']]),
        text: async () => '{"success":true}',
      })

      const result = await httpRequest.invoke({
        method,
        url: 'https://api.example.com/resource',
      })

      expect(result.status).toBe(status)
      expect(result.statusText).toBe(statusText)
      expect(result.headers['content-type']).toBe('application/json')
      expect(result.body).toBe('{"success":true}')
    })
  })

  describe('request configuration', () => {
    it('sends request with custom headers and body', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Map([]),
        text: async () => '{"id":123}',
      })

      await httpRequest.invoke({
        method: 'POST',
        url: 'https://api.example.com/users',
        body: '{"name":"test"}',
        headers: { 'Content-Type': 'application/json' },
      })

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.example.com/users',
        expect.objectContaining({
          method: 'POST',
          body: '{"name":"test"}',
          headers: { 'Content-Type': 'application/json' },
        })
      )
    })
  })

  describe('response handling', () => {
    it('handles empty response body', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
        statusText: 'No Content',
        headers: new Map([]),
        text: async () => '',
      })

      const result = await httpRequest.invoke({
        method: 'DELETE',
        url: 'https://api.example.com/resource',
      })

      expect(result.body).toBe('')
    })

    it('handles string response body', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Map([]),
        text: async () => 'Plain text response',
      })

      const result = await httpRequest.invoke({
        method: 'GET',
        url: 'https://api.example.com/text',
      })

      expect(result.body).toBe('Plain text response')
    })

    it('converts response headers to plain object', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Map([
          ['content-type', 'application/json'],
          ['x-custom-header', 'value'],
        ]),
        text: async () => '{}',
      })

      const result = await httpRequest.invoke({
        method: 'GET',
        url: 'https://api.example.com',
      })

      expect(result.headers).toEqual({
        'content-type': 'application/json',
        'x-custom-header': 'value',
      })
    })
  })

  describe('HTTP status codes', () => {
    it('succeeds for 2xx status codes', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        statusText: 'Created',
        headers: new Map([]),
        text: async () => 'created',
      })

      const result = await httpRequest.invoke({
        method: 'POST',
        url: 'https://api.example.com',
      })

      expect(result.status).toBe(201)
    })

    it('throws error for 3xx redirect status codes', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 301,
        statusText: 'Moved Permanently',
        headers: new Map([]),
        text: async () => '',
      })

      await expect(
        httpRequest.invoke({
          method: 'GET',
          url: 'https://api.example.com/moved',
        })
      ).rejects.toThrow('HTTP 301')
    })

    it('throws error for 4xx client error codes', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        headers: new Map([]),
        text: async () => 'Not found',
      })

      await expect(
        httpRequest.invoke({
          method: 'GET',
          url: 'https://api.example.com/notfound',
        })
      ).rejects.toThrow('HTTP 404 Not Found')
    })

    it('throws error for 5xx server error codes', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        headers: new Map([]),
        text: async () => 'Server error',
      })

      await expect(
        httpRequest.invoke({
          method: 'GET',
          url: 'https://api.example.com/error',
        })
      ).rejects.toThrow('HTTP 500')
    })
  })

  describe('error handling', () => {
    it('throws timeout error when request exceeds timeout', async () => {
      globalThis.fetch = vi.fn().mockImplementation(
        async (_url, _options) =>
          new Promise((_resolve, reject) => {
            globalThis.setTimeout(() => {
              const error = new Error('The operation was aborted')
              error.name = 'AbortError'
              reject(error)
            }, 100)
          })
      )

      await expect(
        httpRequest.invoke({
          method: 'GET',
          url: 'https://slow-api.example.com',
          timeout: 0.1,
        })
      ).rejects.toThrow('Request timed out')
    })

    it('throws error for network failures', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error: Failed to fetch'))

      await expect(
        httpRequest.invoke({
          method: 'GET',
          url: 'https://invalid-domain.com',
        })
      ).rejects.toThrow('Network error: Failed to fetch')
    })

    it('uses context.cancelSignal when it differs from the agent signal', async () => {
      let requestSignal: AbortSignal | undefined
      globalThis.fetch = vi.fn((_url, options) => {
        const signal = options?.signal as AbortSignal
        requestSignal = signal
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')), {
            once: true,
          })
        })
      })
      const executionController = new AbortController()
      const agentController = new AbortController()
      const context: ToolContext = {
        toolUse: {
          name: 'http_request',
          toolUseId: 'task-http',
          input: { method: 'GET', url: 'https://slow-api.example.com' },
        },
        agent: { cancelSignal: agentController.signal } as LocalAgent,
        invocationState: {},
        cancelSignal: executionController.signal,
        interrupt: vi.fn() as ToolContext['interrupt'],
      }

      const request = httpRequest.invoke(
        {
          method: 'GET',
          url: 'https://slow-api.example.com',
        },
        context
      )
      await vi.waitFor(() => expect(requestSignal).toBeDefined())
      const cancelled = expect(request).rejects.toThrow('Request cancelled: GET https://slow-api.example.com')
      executionController.abort()

      await cancelled
    })
  })
})
