import {
  InMemoryTransport,
  ProtocolError,
  ProtocolErrorCode,
  SERVER_INFO_META_KEY,
  SdkErrorCode,
} from '@modelcontextprotocol/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { McpClient, McpTaskCancelledError, McpTaskFailedError, type TasksConfig } from '../client.js'
import { McpTool } from '../../tools/mcp-tool.js'

import type {
  JSONRPCMessage,
  JSONRPCRequest,
  RequestId,
  ServerCapabilities,
  Transport,
} from '@modelcontextprotocol/client'

const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks'
const MODERN_PROTOCOL_VERSION = '2026-07-28'
const LEGACY_PROTOCOL_VERSION = '2025-11-25'
const TASK_ID = 'task-1'
const CREATED_AT = '2026-08-04T12:00:00.000Z'
const NO_RESPONSE = Symbol('no-response')

type RequestHandler = (request: JSONRPCRequest) => unknown

interface ScriptedServerOptions {
  era?: 'modern' | 'legacy'
  capabilities?: ServerCapabilities
}

interface TaskHarness {
  client: McpClient
  server: ScriptedServer
  tool: McpTool
}

class ScriptedServer {
  public readonly messages: JSONRPCMessage[] = []

  private readonly _transport: Transport
  private readonly _era: 'modern' | 'legacy'
  private readonly _capabilities: ServerCapabilities
  private readonly _handlers = new Map<string, RequestHandler>()

  public constructor(transport: Transport, options: ScriptedServerOptions) {
    this._transport = transport
    this._era = options.era ?? 'modern'
    this._capabilities = options.capabilities ?? {
      tools: {},
      extensions: { [TASKS_EXTENSION]: {} },
    }
    this._transport.onmessage = this._receive.bind(this)
  }

  public handle(method: string, handler: RequestHandler): void {
    this._handlers.set(method, handler)
  }

  public requests(method: string): JSONRPCRequest[] {
    return this.messages.filter(
      (message): message is JSONRPCRequest => isJsonRpcRequest(message) && message.method === method
    )
  }

  public async notify(method: string, params: Record<string, unknown>): Promise<void> {
    await this._transport.send({
      jsonrpc: '2.0',
      method,
      params,
    })
  }

  public async close(): Promise<void> {
    await this._transport.close()
  }

  private _receive(message: JSONRPCMessage): void {
    this.messages.push(message)
    if (!isJsonRpcRequest(message)) return

    if (message.method === 'server/discover') {
      if (this._era === 'legacy') {
        void this._sendError(message.id, ProtocolErrorCode.MethodNotFound, 'Method not found')
      } else {
        void this._sendResult(message.id, {
          resultType: 'complete',
          supportedVersions: [MODERN_PROTOCOL_VERSION],
          capabilities: this._capabilities,
          _meta: {
            [SERVER_INFO_META_KEY]: { name: 'task-test-server', version: '1.0.0' },
          },
        })
      }
      return
    }

    if (message.method === 'initialize') {
      void this._sendResult(message.id, {
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        capabilities: this._capabilities,
        serverInfo: { name: 'legacy-task-test-server', version: '1.0.0' },
      })
      return
    }

    const handler = this._handlers.get(message.method)
    if (!handler) {
      void this._sendError(message.id, ProtocolErrorCode.MethodNotFound, `No handler for ${message.method}`)
      return
    }

    void Promise.resolve()
      .then(() => handler(message))
      .then(async (result) => {
        if (result !== NO_RESPONSE) await this._sendResult(message.id, result)
      })
      .catch(async (error: unknown) => {
        if (error instanceof ProtocolError) {
          await this._sendError(message.id, error.code, error.message, error.data)
        } else {
          await this._sendError(message.id, ProtocolErrorCode.InternalError, 'Scripted server failure')
        }
      })
  }

  private async _sendResult(id: RequestId, result: unknown): Promise<void> {
    await this._transport.send({
      jsonrpc: '2.0',
      id,
      result,
    } as JSONRPCMessage)
  }

  private async _sendError(id: RequestId, code: number, message: string, data?: unknown): Promise<void> {
    await this._transport.send({
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message,
        ...(data !== undefined && { data }),
      },
    })
  }
}

const activeHarnesses: TaskHarness[] = []

afterEach(async () => {
  for (const { client, server } of activeHarnesses.splice(0)) {
    await client.disconnect().catch(() => undefined)
    await server.close().catch(() => undefined)
  }
  vi.useRealTimers()
})

async function createHarness(
  options: ScriptedServerOptions & {
    tasksConfig?: TasksConfig | false
  } = {}
): Promise<TaskHarness> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = new ScriptedServer(serverTransport, options)
  await serverTransport.start()
  const tasksConfig =
    options.tasksConfig === false
      ? undefined
      : {
          requestTimeout: 500,
          pollInterval: 10,
          ...options.tasksConfig,
        }
  const client = new McpClient({
    applicationName: 'task-test-client',
    applicationVersion: '1.2.3',
    transport: clientTransport,
    ...(tasksConfig !== undefined && { tasksConfig }),
  })
  const tool = new McpTool({
    name: 'task_tool',
    description: 'Task tool',
    inputSchema: { type: 'object' },
    client,
  })
  const harness = { client, server, tool }
  activeHarnesses.push(harness)
  return harness
}

function isJsonRpcRequest(message: JSONRPCMessage): message is JSONRPCRequest {
  return 'method' in message && 'id' in message
}

function requestParams(request: JSONRPCRequest): Record<string, unknown> {
  return request.params as Record<string, unknown>
}

function requestMeta(request: JSONRPCRequest): Record<string, unknown> {
  return requestParams(request)._meta as Record<string, unknown>
}

describe('McpClient legacy task execution', () => {
  const legacyTask = (
    status: 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled'
  ): Record<string, unknown> => ({
    taskId: TASK_ID,
    status,
    statusMessage: `legacy task ${status}`,
    ttl: 60_000,
    pollInterval: 10,
    createdAt: CREATED_AT,
    lastUpdatedAt: CREATED_AT,
  })

  async function legacyHarness(tasksConfig?: TasksConfig): Promise<TaskHarness> {
    const harness = await createHarness({
      era: 'legacy',
      ...(tasksConfig && { tasksConfig }),
      capabilities: { tools: {}, tasks: { requests: { tools: { call: {} } }, cancel: {} } },
    })
    harness.server.handle('tools/list', () => ({
      tools: [{ name: 'task_tool', inputSchema: { type: 'object' }, execution: { taskSupport: 'required' } }],
    }))
    const [tool] = await harness.client.listTools({ prefix: 'legacy' })
    return { ...harness, tool: tool! }
  }

  it.each(['working', 'input_required', 'completed'] as const)(
    'retrieves the final result from a %s task using legacy wire methods',
    async (status) => {
      const { client, server, tool } = await legacyHarness()
      server.handle('tools/call', () => ({ task: legacyTask(status) }))
      server.handle('tasks/get', () => legacyTask('completed'))
      server.handle('tasks/result', () => ({ content: [{ type: 'text', text: 'legacy result' }] }))
      await expect(client.callTool(tool, { value: 42 })).resolves.toEqual({
        content: [{ type: 'text', text: 'legacy result' }],
      })
      expect(requestParams(server.requests('tools/call')[0]!)).toMatchObject({
        name: 'task_tool',
        arguments: { value: 42 },
        task: {},
      })
      expect(server.requests('tasks/get')).toHaveLength(status === 'working' ? 1 : 0)
      expect(server.requests('tasks/result')).toHaveLength(1)
      expect(server.requests('tasks/update')).toHaveLength(0)
    }
  )

  it.each([
    { status: 'failed', errorClass: McpTaskFailedError },
    { status: 'cancelled', errorClass: McpTaskCancelledError },
  ] as const)('rejects a $status task without retrieving a payload', async ({ status, errorClass }) => {
    const { client, server, tool } = await legacyHarness()
    server.handle('tools/call', () => ({ task: legacyTask(status) }))
    const result = client.callTool(tool, {})
    await expect(result).rejects.toThrow(`legacy task ${status}`)
    await expect(result).rejects.toBeInstanceOf(errorClass)
    expect(server.requests('tasks/result')).toHaveLength(0)
  })

  it('waits for queued input on tasks/result beyond the request timeout without progress', async () => {
    vi.useFakeTimers()
    const { client, server, tool } = await legacyHarness({ requestTimeout: 100, pollTimeout: 5_000 })
    server.handle('tools/call', () => ({ task: legacyTask('input_required') }))
    server.handle(
      'tasks/result',
      () =>
        new Promise((resolve) => setTimeout(() => resolve({ content: [{ type: 'text', text: 'late answer' }] }), 300))
    )
    const result = client.callTool(tool, {})
    await vi.advanceTimersByTimeAsync(400)
    await expect(result).resolves.toEqual({ content: [{ type: 'text', text: 'late answer' }] })
    expect(server.requests('tasks/cancel')).toHaveLength(0)
  })

  it.each([
    { method: 'tasks/get', maximum: 400 },
    { method: 'tasks/get', maximum: 65 },
    { method: 'tasks/result', maximum: 400 },
    { method: 'tasks/result', maximum: 65 },
  ] as const)(
    'preserves progress reset and maximum duration for legacy $method ($maximum ms)',
    async ({ method, maximum }) => {
      vi.useFakeTimers()
      const { client, server, tool } = await legacyHarness({ requestTimeout: 65, pollTimeout: maximum })
      server.handle('tools/call', () => ({ task: legacyTask(method === 'tasks/get' ? 'working' : 'input_required') }))
      server.handle('tasks/result', () => ({ content: [{ type: 'text', text: 'legacy progress' }] }))
      server.handle(
        method,
        (request) =>
          new Promise((resolve) => {
            const token = requestMeta(request).progressToken
            expect(token).toBeDefined()
            const interval = globalThis.setInterval(() => {
              void server.notify('notifications/progress', { progressToken: token, progress: 1 })
            }, 25)
            setTimeout(() => {
              globalThis.clearInterval(interval)
              resolve(
                method === 'tasks/get'
                  ? legacyTask('completed')
                  : { content: [{ type: 'text', text: 'legacy progress' }] }
              )
            }, 150)
          })
      )
      const result = client.callTool(tool, {})
      const assertion =
        maximum === 65
          ? expect(result).rejects.toMatchObject({ code: SdkErrorCode.RequestTimeout })
          : expect(result).resolves.toMatchObject({ content: [{ type: 'text', text: 'legacy progress' }] })
      await vi.advanceTimersByTimeAsync(170)
      await assertion
    }
  )

  it('legacy polling spans multiple requests within the overall pollTimeout', async () => {
    vi.useFakeTimers()
    const { client, server, tool } = await legacyHarness({ requestTimeout: 65, pollTimeout: 400 })
    let polls = 0
    server.handle('tools/call', () => ({ task: { ...legacyTask('working'), pollInterval: 70 } }))
    server.handle('tasks/get', () => ({ ...legacyTask(++polls === 3 ? 'completed' : 'working'), pollInterval: 70 }))
    server.handle('tasks/result', () => ({ content: [{ type: 'text', text: 'done' }] }))
    const result = client.callTool(tool, {})
    await vi.advanceTimersByTimeAsync(230)
    await expect(result).resolves.toEqual({ content: [{ type: 'text', text: 'done' }] })
    expect(server.requests('tasks/get')).toHaveLength(3)
  })

  it('rejects an unsupported output schema before executing a legacy task', async () => {
    const { client, server } = await legacyHarness()
    server.handle('tools/list', () => ({
      tools: [
        {
          name: 'task_tool',
          inputSchema: { type: 'object' },
          execution: { taskSupport: 'required' },
          outputSchema: { type: 'object', $schema: 'https://example.com/unsupported-dialect' },
        },
      ],
    }))
    const [tool] = await client.listTools()
    await expect(client.callTool(tool!, {})).rejects.toThrow('outputSchema')
    expect(server.requests('tools/call')).toHaveLength(0)
  })

  it('cancels an unfinished legacy task when the caller aborts an outstanding poll', async () => {
    const { client, server, tool } = await legacyHarness()
    server.handle('tools/call', () => ({ task: legacyTask('working') }))
    server.handle('tasks/get', () => NO_RESPONSE)
    server.handle('tasks/cancel', () => legacyTask('cancelled'))
    const controller = new AbortController()
    const reason = new Error('stop legacy task')
    const result = client.callTool(tool, {}, { signal: controller.signal })
    const rejected = expect(result).rejects.toBe(reason)
    await vi.waitFor(() => expect(server.requests('tasks/get')).toHaveLength(1))
    controller.abort(reason)
    await rejected
    await vi.waitFor(() => expect(server.requests('tasks/cancel')).toHaveLength(1))
  })
})

describe('McpClient task request timeouts', () => {
  it.each([{ maximum: 400 }, { maximum: 65 }] as const)(
    'resets inactivity while enforcing the total limit (legacy, maximum=$maximum)',
    async ({ maximum }) => {
      vi.useFakeTimers()
      const { client, server, tool } = await createHarness({
        era: 'legacy',
        tasksConfig: { requestTimeout: 65, pollTimeout: maximum },
      })
      server.handle(
        'tools/call',
        (request) =>
          new Promise((resolve) => {
            const token = requestMeta(request).progressToken
            expect(token).toBeDefined()
            const interval = globalThis.setInterval(() => {
              void server.notify('notifications/progress', { progressToken: token, progress: 1 })
            }, 25)
            setTimeout(() => {
              globalThis.clearInterval(interval)
              resolve({ content: [{ type: 'text', text: 'direct' }] })
            }, 150)
          })
      )
      const result = client.callTool(tool, {})
      const assertion =
        maximum === 65
          ? expect(result).rejects.toMatchObject({ code: SdkErrorCode.RequestTimeout })
          : expect(result).resolves.toMatchObject({ content: [{ type: 'text', text: 'direct' }] })
      await vi.advanceTimersByTimeAsync(160)
      await assertion
    }
  )
})

describe('McpClient call timeout validation', () => {
  it.each([{ tasksConfig: {} as TasksConfig }, { tasksConfig: false as const }])(
    'rejects a non-integer timeoutMs (tasksConfig: $tasksConfig)',
    async ({ tasksConfig }) => {
      const { client, tool } = await createHarness({ tasksConfig })
      await expect(client.callTool(tool, {}, { timeoutMs: 1500.5 })).rejects.toThrow(/positive safe integer/)
    }
  )
})

describe('McpClient default overall task deadlines', () => {
  it('applies the default overall deadline in the legacy era when pollTimeout is omitted', async () => {
    vi.useFakeTimers()
    const { client, server } = await createHarness({
      era: 'legacy',
      capabilities: { tools: {}, tasks: { requests: { tools: { call: {} } }, cancel: {} } },
    })
    server.handle('tools/list', () => ({
      tools: [{ name: 'task_tool', inputSchema: { type: 'object' }, execution: { taskSupport: 'required' } }],
    }))
    const [tool] = await client.listTools()
    const legacyState = {
      taskId: TASK_ID,
      status: 'working',
      ttl: 600_000,
      pollInterval: 100_000,
      createdAt: CREATED_AT,
      lastUpdatedAt: CREATED_AT,
    }
    server.handle('tools/call', () => ({ task: legacyState }))
    server.handle('tasks/get', () => legacyState)
    server.handle('tasks/cancel', () => ({ ...legacyState, status: 'cancelled' }))
    const settled = vi.fn()
    const result = client.callTool(tool!, {}).then(settled, settled)
    await vi.advanceTimersByTimeAsync(299_999)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2)
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ code: SdkErrorCode.RequestTimeout }))
    await result
  })
})
