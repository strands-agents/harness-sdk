import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  ProtocolError,
  SdkErrorCode,
} from '@modelcontextprotocol/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createTaskRoutingFetch, TaskTransport } from '../task-transport.js'

import type {
  ClientCapabilities,
  FetchLike,
  JSONRPCMessage,
  JSONRPCRequest,
  MessageExtraInfo,
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/client'

const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks'
const PROTOCOL_VERSION = '2026-07-28'
const CLIENT_INFO = { name: 'transport-test-client', version: '1.2.3' }
const CLIENT_CAPABILITIES: ClientCapabilities = {
  roots: { listChanged: true },
  extensions: {
    [TASKS_EXTENSION]: {},
    'example.com/other': { mode: 'preserved' },
  },
}

interface SentMessage {
  message: JSONRPCMessage
  options?: TransportSendOptions
}

class RecordingTransport implements Transport {
  public readonly sent: SentMessage[] = []
  public readonly hasPerRequestStream: boolean

  public onclose: (() => void) | undefined
  public onerror: ((error: Error) => void) | undefined
  public onmessage: (<Message extends JSONRPCMessage>(message: Message, extra?: MessageExtraInfo) => void) | undefined

  public constructor(hasPerRequestStream: boolean = true) {
    this.hasPerRequestStream = hasPerRequestStream
  }

  public async start(): Promise<void> {}

  public async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    this.sent.push({ message, ...(options && { options }) })
  }

  public async close(): Promise<void> {
    this.onclose?.()
  }

  public emit(message: JSONRPCMessage): void {
    this.onmessage?.(message)
  }
}

afterEach(() => {
  vi.useRealTimers()
})

async function createTransport(
  hasPerRequestStream: boolean = true
): Promise<{ inner: RecordingTransport; transport: TaskTransport }> {
  const inner = new RecordingTransport(hasPerRequestStream)
  const transport = new TaskTransport(inner, () => ({
    [PROTOCOL_VERSION_META_KEY]: PROTOCOL_VERSION,
    [CLIENT_INFO_META_KEY]: CLIENT_INFO,
    [CLIENT_CAPABILITIES_META_KEY]: CLIENT_CAPABILITIES,
  }))
  await transport.start()
  return { inner, transport }
}

describe('TaskTransport', () => {
  describe('task-aware tool calls', () => {
    it('resolves the original task handle without forwarding a synthetic result', async () => {
      const { inner, transport } = await createTransport()
      const baseHandler = vi.fn()
      transport.onmessage = baseHandler
      const taskResult = {
        resultType: 'task',
        taskId: 'task-1',
        status: 'working',
        createdAt: '2026-08-04T12:00:00.000Z',
        lastUpdatedAt: '2026-08-04T12:00:00.000Z',
        ttlMs: 60_000,
      }
      const resultPromise = transport.request(
        'tools/call',
        {
          name: 'long_task',
          arguments: {},
          _meta: { traceparent: '00-abc-def-01' },
        },
        {
          timeoutMs: 1_000,
          headers: { 'Mcp-Param-Tenant': 'tenant-1' },
        }
      )

      expect(inner.sent).toEqual([
        {
          message: {
            jsonrpc: '2.0',
            id: 'strands-task:0',
            method: 'tools/call',
            params: {
              name: 'long_task',
              arguments: {},
              _meta: {
                traceparent: '00-abc-def-01',
                [PROTOCOL_VERSION_META_KEY]: PROTOCOL_VERSION,
                [CLIENT_INFO_META_KEY]: CLIENT_INFO,
                [CLIENT_CAPABILITIES_META_KEY]: CLIENT_CAPABILITIES,
              },
            },
          },
          options: {
            headers: { 'Mcp-Param-Tenant': 'tenant-1' },
            requestSignal: expect.any(AbortSignal),
          },
        },
      ])

      inner.emit({
        jsonrpc: '2.0',
        id: 'strands-task:0',
        result: taskResult,
      })

      await expect(resultPromise).resolves.toEqual(taskResult)
      expect(baseHandler).not.toHaveBeenCalled()
    })
  })

  describe('protocol metadata', () => {
    it('merges lifecycle metadata and routes responses outside the base protocol', async () => {
      const { inner, transport } = await createTransport()
      const baseHandler = vi.fn()
      transport.onmessage = baseHandler

      const resultPromise = transport.request(
        'tasks/update',
        {
          taskId: 'task/世界',
          inputResponses: { approval: { action: 'accept', content: { approved: true } } },
          _meta: {
            traceparent: '00-abc-def-01',
            caller: { id: 'caller-1' },
            [PROTOCOL_VERSION_META_KEY]: 'stale-version',
            [CLIENT_INFO_META_KEY]: { name: 'stale-client', version: '0' },
          },
        },
        { timeoutMs: 1_000 }
      )

      expect(inner.sent).toEqual([
        {
          message: {
            jsonrpc: '2.0',
            id: 'strands-task:0',
            method: 'tasks/update',
            params: {
              taskId: 'task/世界',
              inputResponses: {
                approval: { action: 'accept', content: { approved: true } },
              },
              _meta: {
                traceparent: '00-abc-def-01',
                caller: { id: 'caller-1' },
                [PROTOCOL_VERSION_META_KEY]: PROTOCOL_VERSION,
                [CLIENT_INFO_META_KEY]: CLIENT_INFO,
                [CLIENT_CAPABILITIES_META_KEY]: CLIENT_CAPABILITIES,
              },
            },
          },
          options: {
            headers: {
              'Mcp-Method': 'tasks/update',
              'Mcp-Name': '=?base64?dGFzay/kuJbnlYw=?=',
            },
            requestSignal: expect.any(AbortSignal),
          },
        },
      ])

      inner.emit({
        jsonrpc: '2.0',
        id: 'strands-task:0',
        result: { resultType: 'complete', _meta: { acknowledged: true } },
      })
      await expect(resultPromise).resolves.toEqual({
        resultType: 'complete',
        _meta: { acknowledged: true },
      })
      expect(baseHandler).not.toHaveBeenCalled()
    })

    it('strips only the modern task capability from legacy initialize requests', async () => {
      const { inner, transport } = await createTransport()
      const initialize: JSONRPCRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          clientInfo: CLIENT_INFO,
          capabilities: CLIENT_CAPABILITIES,
        },
      }

      await transport.send(initialize)

      expect((inner.sent[0]!.message as JSONRPCRequest).params).toEqual({
        protocolVersion: '2025-11-25',
        clientInfo: CLIENT_INFO,
        capabilities: {
          roots: { listChanged: true },
          extensions: {
            'example.com/other': { mode: 'preserved' },
          },
        },
      })
      expect(initialize.params).toEqual({
        protocolVersion: '2025-11-25',
        clientInfo: CLIENT_INFO,
        capabilities: CLIENT_CAPABILITIES,
      })
    })

    it('uses the current SDK metadata when issuing task requests', async () => {
      const inner = new RecordingTransport()
      let capabilities = CLIENT_CAPABILITIES
      const transport = new TaskTransport(inner, () => ({
        [PROTOCOL_VERSION_META_KEY]: PROTOCOL_VERSION,
        [CLIENT_INFO_META_KEY]: CLIENT_INFO,
        [CLIENT_CAPABILITIES_META_KEY]: capabilities,
      }))
      await transport.start()
      capabilities = { ...CLIENT_CAPABILITIES, sampling: {} }
      const resultPromise = transport.request('tasks/get', { taskId: 'task-1' }, { timeoutMs: 1_000 })

      expect((inner.sent[0]!.message as JSONRPCRequest).params?._meta).toEqual({
        [PROTOCOL_VERSION_META_KEY]: PROTOCOL_VERSION,
        [CLIENT_INFO_META_KEY]: CLIENT_INFO,
        [CLIENT_CAPABILITIES_META_KEY]: capabilities,
      })
      inner.emit({ jsonrpc: '2.0', id: 'strands-task:0', result: { resultType: 'complete' } })
      await resultPromise
    })
  })

  describe('lifecycle request failures', () => {
    it('translates JSON-RPC errors with their data intact', async () => {
      const { inner, transport } = await createTransport()
      const resultPromise = transport.request('tasks/cancel', { taskId: 'task-1' }, { timeoutMs: 1_000 })

      inner.emit({
        jsonrpc: '2.0',
        id: 'strands-task:0',
        error: {
          code: -32_000,
          message: 'Cancellation rejected',
          data: { state: 'completed' },
        },
      })

      const error = await resultPromise.catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(ProtocolError)
      expect(error).toEqual(
        expect.objectContaining({
          code: -32_000,
          message: 'Cancellation rejected',
          data: { state: 'completed' },
        })
      )
    })

    it('enforces lifecycle request timeouts and ignores late responses', async () => {
      vi.useFakeTimers()
      const { inner, transport } = await createTransport()
      const baseHandler = vi.fn()
      transport.onmessage = baseHandler

      const resultPromise = transport.request('tasks/get', { taskId: 'task-1' }, { timeoutMs: 25 })
      const requestSignal = inner.sent[0]!.options!.requestSignal!
      expect(requestSignal.aborted).toBe(false)
      const rejection = expect(resultPromise).rejects.toEqual(
        expect.objectContaining({
          code: SdkErrorCode.RequestTimeout,
          data: { method: 'tasks/get', timeoutMs: 25 },
        })
      )
      await vi.advanceTimersByTimeAsync(25)
      await rejection
      expect(requestSignal.aborted).toBe(true)
      expect(requestSignal.reason).toEqual(
        expect.objectContaining({
          code: SdkErrorCode.RequestTimeout,
          data: { method: 'tasks/get', timeoutMs: 25 },
        })
      )

      inner.emit({
        jsonrpc: '2.0',
        id: 'strands-task:0',
        result: { resultType: 'complete' },
      })
      expect(baseHandler).not.toHaveBeenCalled()
    })

    it('aborts the transport send when the caller signal is aborted', async () => {
      const { inner, transport } = await createTransport()
      const controller = new AbortController()
      const primaryError = new Error('caller cancelled lifecycle request')
      const resultPromise = transport.request(
        'tasks/cancel',
        { taskId: 'task-1' },
        { signal: controller.signal, timeoutMs: 1_000 }
      )
      const requestSignal = inner.sent[0]!.options!.requestSignal!

      controller.abort(primaryError)

      await expect(resultPromise).rejects.toBe(primaryError)
      expect(requestSignal.aborted).toBe(true)
      expect(requestSignal.reason).toBe(primaryError)
    })

    it('sends a cancellation notification when a caller aborts a shared-channel request', async () => {
      const { inner, transport } = await createTransport(false)
      const controller = new AbortController()
      const primaryError = new Error('caller cancelled shared request')
      const resultPromise = transport.request(
        'tools/call',
        { name: 'slow_tool', arguments: {} },
        { signal: controller.signal, timeoutMs: 1_000 }
      )

      controller.abort(primaryError)

      await expect(resultPromise).rejects.toBe(primaryError)
      expect(inner.sent).toEqual([
        {
          message: {
            jsonrpc: '2.0',
            id: 'strands-task:0',
            method: 'tools/call',
            params: {
              name: 'slow_tool',
              arguments: {},
              _meta: {
                [PROTOCOL_VERSION_META_KEY]: PROTOCOL_VERSION,
                [CLIENT_INFO_META_KEY]: CLIENT_INFO,
                [CLIENT_CAPABILITIES_META_KEY]: CLIENT_CAPABILITIES,
              },
            },
          },
          options: {},
        },
        {
          message: {
            jsonrpc: '2.0',
            method: 'notifications/cancelled',
            params: {
              requestId: 'strands-task:0',
              reason: String(primaryError),
              _meta: {
                [PROTOCOL_VERSION_META_KEY]: PROTOCOL_VERSION,
                [CLIENT_INFO_META_KEY]: CLIENT_INFO,
                [CLIENT_CAPABILITIES_META_KEY]: CLIENT_CAPABILITIES,
              },
            },
          },
        },
      ])
    })

    it('sends a cancellation notification when a shared-channel request times out', async () => {
      vi.useFakeTimers()
      const { inner, transport } = await createTransport(false)
      const resultPromise = transport.request('tasks/get', { taskId: 'task-1' }, { timeoutMs: 25 })
      const rejection = expect(resultPromise).rejects.toEqual(
        expect.objectContaining({
          code: SdkErrorCode.RequestTimeout,
          data: { method: 'tasks/get', timeoutMs: 25 },
        })
      )

      await vi.advanceTimersByTimeAsync(25)
      await rejection

      expect(inner.sent[1]).toEqual({
        message: {
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: {
            requestId: 'strands-task:0',
            reason: expect.stringContaining('MCP tasks/get request timed out'),
            _meta: {
              [PROTOCOL_VERSION_META_KEY]: PROTOCOL_VERSION,
              [CLIENT_INFO_META_KEY]: CLIENT_INFO,
              [CLIENT_CAPABILITIES_META_KEY]: CLIENT_CAPABILITIES,
            },
          },
        },
      })
    })
  })

  describe('notifications', () => {
    it('routes task notifications to the task handler and leaves other notifications untouched', async () => {
      const { inner, transport } = await createTransport()
      const taskHandler = vi.fn()
      const baseHandler = vi.fn()
      transport.onTaskNotification = taskHandler
      transport.onmessage = baseHandler

      const taskNotification = {
        jsonrpc: '2.0' as const,
        method: 'notifications/tasks',
        params: { taskId: 'task-1', status: 'working' },
      }
      inner.emit(taskNotification)
      const logNotification = {
        jsonrpc: '2.0' as const,
        method: 'notifications/message',
        params: { level: 'info', data: 'hello' },
      }
      inner.emit(logNotification)

      expect(taskHandler).toHaveBeenCalledWith(taskNotification.params)
      expect(baseHandler).toHaveBeenCalledWith(logNotification, undefined)
    })
  })
})

describe('createTaskRoutingFetch', () => {
  it('sets the task routing name while preserving other headers and the body', async () => {
    const fetchImplementation = vi.fn<FetchLike>(async () => new Response(null, { status: 204 }))
    const routingFetch = createTaskRoutingFetch(fetchImplementation)
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 'task-request',
      method: 'tasks/get',
      params: { taskId: 'task/世界' },
    })

    await routingFetch('https://example.test/mcp', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret',
        'X-Trace-Id': 'trace-1',
        'Mcp-Method': 'tasks/get',
        'Mcp-Name': 'wrong',
      },
      body,
    })

    const init = fetchImplementation.mock.calls[0]![1]!
    const headers = new Headers(init.headers)
    expect({
      authorization: headers.get('authorization'),
      traceId: headers.get('x-trace-id'),
      method: headers.get('mcp-method'),
      name: headers.get('mcp-name'),
      body: init.body,
    }).toEqual({
      authorization: 'Bearer secret',
      traceId: 'trace-1',
      method: 'tasks/get',
      name: '=?base64?dGFzay/kuJbnlYw=?=',
      body,
    })
  })

  it('passes non-task requests through without replacing their init object', async () => {
    const fetchImplementation = vi.fn<FetchLike>(async () => new Response(null, { status: 204 }))
    const routingFetch = createTaskRoutingFetch(fetchImplementation)
    const init: RequestInit = {
      method: 'POST',
      headers: { 'X-Custom': 'preserved' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'direct', arguments: {} },
      }),
    }

    await routingFetch('https://example.test/mcp', init)

    expect(fetchImplementation.mock.calls).toEqual([['https://example.test/mcp', init]])
    expect(fetchImplementation.mock.calls[0]![1]).toBe(init)
  })
})

describe('TaskTransport progress routing', () => {
  it('forwards unrelated progress without extending an owned request', async () => {
    vi.useFakeTimers()
    const { inner, transport } = await createTransport()
    const forwarded = vi.fn()
    transport.onmessage = forwarded
    const result = transport.request(
      'tools/call',
      { name: 'slow', arguments: {} },
      {
        timeoutMs: 50,
        maxTotalTimeoutMs: 200,
        resetTimeoutOnProgress: true,
      }
    )
    const rejected = expect(result).rejects.toMatchObject({ code: SdkErrorCode.RequestTimeout })
    await vi.advanceTimersByTimeAsync(40)
    const progress = {
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken: 'different', progress: 1 },
    } as const
    inner.emit(progress)
    await vi.advanceTimersByTimeAsync(11)
    await rejected
    expect(forwarded).toHaveBeenCalledWith(progress, undefined)
    await transport.close()
  })
})
