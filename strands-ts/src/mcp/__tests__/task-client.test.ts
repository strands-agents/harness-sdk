import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  InMemoryTransport,
  PROTOCOL_VERSION_META_KEY,
  ProtocolError,
  ProtocolErrorCode,
  SERVER_INFO_META_KEY,
  SUBSCRIPTION_ID_META_KEY,
  SdkError,
  SdkErrorCode,
  specTypeSchemas,
} from '@modelcontextprotocol/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { McpClient, McpTaskCancelledError, type TasksConfig } from '../client.js'
import { McpTool } from '../../tools/mcp-tool.js'

import type {
  CallToolResult,
  ClientCapabilities,
  JSONRPCMessage,
  JSONRPCRequest,
  RequestId,
  ServerCapabilities,
  Transport,
} from '@modelcontextprotocol/client'
import type { McpCreateTaskResult, McpGetTaskResult, McpInputRequests } from '../task-types.js'
import type { JSONSchema } from '../../types/json.js'
import type { McpTaskRequestOptions } from '../client.js'
import type { ElicitationCallback } from '../../types/elicitation.js'

const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks'
const MODERN_PROTOCOL_VERSION = '2026-07-28'
const LEGACY_PROTOCOL_VERSION = '2025-11-25'
const TASK_ID = 'task-1'
const CREATED_AT = '2026-08-04T12:00:00.000Z'
const TASK_METADATA = { taskId: TASK_ID, createdAt: CREATED_AT, ttlMs: 60_000 }
const NO_RESPONSE = Symbol('no-response')
const STRUCTURED_OUTPUT_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    answer: { type: 'number' },
  },
  required: ['answer'],
  additionalProperties: false,
}

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
    elicitationCallback?: ConstructorParameters<typeof McpClient>[0]['elicitationCallback']
    outputSchema?: JSONSchema
    requestTimeouts?: ConstructorParameters<typeof McpClient>[0]['requestTimeouts']
  } = {}
): Promise<TaskHarness> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = new ScriptedServer(serverTransport, options)
  await serverTransport.start()
  const tasksConfig =
    options.tasksConfig === false
      ? undefined
      : {
          ttl: 500,
          pollIntervalMs: 10,
          useNotifications: false,
          ...options.tasksConfig,
        }
  const client = new McpClient({
    applicationName: 'task-test-client',
    applicationVersion: '1.2.3',
    transport: clientTransport,
    ...(tasksConfig !== undefined && { tasksConfig }),
    ...(options.elicitationCallback && { elicitationCallback: options.elicitationCallback }),
    ...(options.requestTimeouts && { requestTimeouts: options.requestTimeouts }),
  })
  const tool = new McpTool({
    name: 'task_tool',
    description: 'Task tool',
    inputSchema: { type: 'object' },
    ...(options.outputSchema && { outputSchema: options.outputSchema }),
    client,
  })
  const harness = { client, server, tool }
  activeHarnesses.push(harness)
  return harness
}

function updatedAt(revision: number): string {
  return new Date(Date.parse(CREATED_AT) + revision * 1_000).toISOString()
}

function createTask(
  status: McpCreateTaskResult['status'] = 'working',
  overrides: Partial<McpCreateTaskResult> = {}
): McpCreateTaskResult {
  return {
    ...TASK_METADATA,
    resultType: 'task',
    status,
    lastUpdatedAt: CREATED_AT,
    pollIntervalMs: 10,
    ...overrides,
  }
}

function workingTask(revision: number, overrides: Partial<McpGetTaskResult> = {}): McpGetTaskResult {
  return {
    ...TASK_METADATA,
    resultType: 'complete',
    status: 'working',
    lastUpdatedAt: updatedAt(revision),
    pollIntervalMs: 10,
    ...overrides,
  } as McpGetTaskResult
}

function completedTask(
  revision: number,
  text: string = 'done',
  overrides: Partial<McpGetTaskResult> = {}
): McpGetTaskResult {
  return {
    ...TASK_METADATA,
    resultType: 'complete',
    status: 'completed',
    lastUpdatedAt: updatedAt(revision),
    result: {
      content: [{ type: 'text', text }],
    },
    ...overrides,
  } as McpGetTaskResult
}

function failedTask(revision: number, statusMessage?: string): McpGetTaskResult {
  return {
    ...TASK_METADATA,
    resultType: 'complete',
    status: 'failed',
    statusMessage,
    lastUpdatedAt: updatedAt(revision),
    error: {
      code: -32_603,
      message: 'Task execution failed',
      data: { retryable: false },
    },
  } as McpGetTaskResult
}

function cancelledTask(revision: number, statusMessage?: string): McpGetTaskResult {
  return {
    ...TASK_METADATA,
    resultType: 'complete',
    status: 'cancelled',
    statusMessage,
    lastUpdatedAt: updatedAt(revision),
  } as McpGetTaskResult
}

function inputRequiredTask(revision: number, inputRequests: McpInputRequests): McpGetTaskResult {
  return {
    ...TASK_METADATA,
    resultType: 'complete',
    status: 'input_required',
    lastUpdatedAt: updatedAt(revision),
    pollIntervalMs: 10,
    inputRequests,
  }
}

function directResult(text: string = 'direct'): Record<string, unknown> {
  return {
    resultType: 'complete',
    content: [{ type: 'text', text }],
  }
}

function elicitationRequest(message: string, requestMeta?: Record<string, unknown>): McpInputRequests[string] {
  return {
    method: 'elicitation/create',
    params: {
      mode: 'form',
      message,
      requestedSchema: {
        type: 'object',
        properties: {
          value: { type: 'string' },
        },
        required: ['value'],
      },
      ...(requestMeta && { _meta: requestMeta }),
    },
  }
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

async function acknowledgeTaskSubscription(server: ScriptedServer, request: JSONRPCRequest): Promise<void> {
  await server.notify('notifications/subscriptions/acknowledged', {
    _meta: { [SUBSCRIPTION_ID_META_KEY]: request.id },
    notifications: { taskIds: [TASK_ID] },
  })
}

function taskNotificationParams(task: McpGetTaskResult, meta: Record<string, unknown> = {}): Record<string, unknown> {
  const params = { ...task } as Record<string, unknown>
  delete params.resultType
  params._meta = meta
  return params
}

describe('McpClient SEP-2663 tasks', () => {
  describe('tool listing', () => {
    it('paginates through all pages of tools through the SDK', async () => {
      const { client, server } = await createHarness({ tasksConfig: false })
      const pages = ['a', 'b', 'c'].map((suffix, index) => ({
        resultType: 'complete',
        ttlMs: 0,
        cacheScope: 'private',
        tools: [{ name: `tool_${suffix}`, description: suffix.toUpperCase(), inputSchema: { type: 'object' } }],
        ...(index < 2 && { nextCursor: `page${index + 2}` }),
      }))
      server.handle('tools/list', () => pages.shift()!)

      const tools = await client.listTools()

      expect(tools.map((tool) => tool.name)).toEqual(['tool_a', 'tool_b', 'tool_c'])
      expect(server.requests('tools/list').map((request) => requestParams(request).cursor)).toEqual([
        undefined,
        'page2',
        'page3',
      ])
    })
  })

  describe('tool invocation', () => {
    it.each(['sdk', 'direct', 'task'])('preserves the full SDK tool result for %s calls', async (kind) => {
      const { client, server, tool } = await createHarness({
        tasksConfig: kind === 'sdk' ? false : {},
      })
      const result = {
        content: [{ type: 'text', text: 'answer', _meta: { source: 'fixture' } }],
        structuredContent: { answer: 42 },
        isError: false,
        _meta: { correlation: 'result-1', optional: undefined },
        'example.com/extension': { values: [1, 2] },
      } satisfies CallToolResult
      const wireResult = kind === 'task' ? createTask() : { resultType: 'complete', ...result }
      server.handle('tools/call', () => wireResult)
      server.handle('tasks/get', () => completedTask(1, 'answer', { result }))

      await expect(client.callTool(tool, { value: 1 })).resolves.toStrictEqual(result)
      await expect(client.callToolWithTask(tool, { value: 2 })).resolves.toStrictEqual(
        kind === 'task' ? wireResult : result
      )
      expect(server.requests('tasks/get')).toHaveLength(kind === 'task' ? 1 : 0)
    })

    it('fulfills input-required results and retries the tool call with opaque request state', async () => {
      const callback = vi.fn<ElicitationCallback>().mockResolvedValue({
        action: 'accept',
        content: { value: 'approved' },
      })
      const { client, server, tool } = await createHarness({
        elicitationCallback: callback,
        outputSchema: STRUCTURED_OUTPUT_SCHEMA,
      })
      const inputRequest = elicitationRequest('Approve this tool call', { trustPolicy: 'strict' })
      const results = [
        {
          resultType: 'input_required',
          inputRequests: { approval: inputRequest },
          requestState: 'opaque-state',
        },
        {
          resultType: 'complete',
          content: [{ type: 'text', text: 'approved' }],
          structuredContent: { answer: 42 },
        },
      ]
      server.handle('tools/call', () => results.shift()!)

      await expect(client.callTool(tool, { value: 1 })).resolves.toEqual({
        content: [{ type: 'text', text: 'approved' }],
        structuredContent: { answer: 42 },
      })

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          mcpReq: expect.objectContaining({
            id: 'approval',
            _meta: { trustPolicy: 'strict' },
            signal: expect.any(AbortSignal),
          }),
        }),
        inputRequest.params
      )
      const elicitationContext = callback.mock.calls[0]![0]
      await expect(
        elicitationContext.mcpReq.send({ method: 'tools/list' }, specTypeSchemas.ListToolsResult)
      ).rejects.toMatchObject({ code: SdkErrorCode.SendFailed })
      await expect(
        elicitationContext.mcpReq.notify({ method: 'notifications/roots/list_changed' })
      ).rejects.toMatchObject({ code: SdkErrorCode.SendFailed })
      const requests = server.requests('tools/call')
      expect(requests.map((request) => request.id)).toEqual([
        expect.stringMatching(/^strands-task:/),
        expect.stringMatching(/^strands-task:/),
      ])
      expect(requests[0]!.id).not.toBe(requests[1]!.id)
      expect(requestParams(requests[1]!)).toEqual({
        name: 'task_tool',
        arguments: { value: 1 },
        inputResponses: {
          approval: {
            action: 'accept',
            content: { value: 'approved' },
          },
        },
        requestState: 'opaque-state',
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
          [CLIENT_INFO_META_KEY]: { name: 'task-test-client', version: '1.2.3' },
          [CLIENT_CAPABILITIES_META_KEY]: {
            elicitation: { form: {}, url: {} },
            extensions: { [TASKS_EXTENSION]: {} },
          },
        },
      })
      expect(server.requests('tasks/get')).toEqual([])
    })

    it.each([{ requestState: 'opaque-state' }, { requestState: '', inputRequests: {} }])(
      'paces request-state-only retries without inventing input responses: %j',
      async (params) => {
        vi.useFakeTimers()
        const { client, server, tool } = await createHarness()
        const results = [
          {
            resultType: 'input_required',
            ...params,
          },
          directResult('ready'),
        ]
        server.handle('tools/call', () => results.shift()!)

        const resultPromise = client.callTool(tool, {})
        await vi.advanceTimersByTimeAsync(0)
        expect(server.requests('tools/call')).toHaveLength(1)

        await vi.advanceTimersByTimeAsync(249)
        expect(server.requests('tools/call')).toHaveLength(1)

        await vi.advanceTimersByTimeAsync(1)
        await expect(resultPromise).resolves.toEqual({
          content: [{ type: 'text', text: 'ready' }],
        })
        expect(requestParams(server.requests('tools/call')[1]!)).toEqual(
          expect.objectContaining({
            name: 'task_tool',
            arguments: {},
            requestState: params.requestState,
          })
        )
        expect(requestParams(server.requests('tools/call')[1]!)).not.toHaveProperty('inputResponses')
      }
    )

    it.each([
      { kind: 'direct', array: false },
      { kind: 'task', array: false },
      { kind: 'direct', array: true },
      { kind: 'task', array: true },
    ])('dispatches registered roots and sampling handlers for $kind calls (array=$array)', async ({ kind, array }) => {
      const { client, server, tool } = await createHarness()
      const rootsResult = { roots: [{ uri: 'file:///workspace', name: 'Workspace' }] }
      const samplingResult = {
        role: 'assistant' as const,
        model: 'test-model',
        content: array ? [{ type: 'text' as const, text: 'Summary' }] : { type: 'text' as const, text: 'Summary' },
      }
      const rootsHandler = vi.fn(async () => rootsResult)
      const samplingHandler = vi.fn(async () => samplingResult)
      client.client.registerCapabilities({ roots: {}, sampling: {} })
      client.client.setRequestHandler('roots/list', rootsHandler)
      client.client.setRequestHandler('sampling/createMessage', samplingHandler)
      const inputRequests = {
        roots: { method: 'roots/list' },
        sample: {
          method: 'sampling/createMessage',
          params: { messages: [{ role: 'user', content: { type: 'text', text: 'Summarize' } }], maxTokens: 64 },
        },
      } satisfies McpInputRequests
      const results =
        kind === 'direct'
          ? [{ resultType: 'input_required', inputRequests }, directResult('done')]
          : [createTask('input_required')]
      server.handle('tools/call', () => results.shift()!)
      const states = [inputRequiredTask(1, inputRequests), completedTask(2)]
      server.handle('tasks/get', () => states.shift()!)
      server.handle('tasks/update', () => ({ resultType: 'complete' }))

      await expect(client.callTool(tool, {})).resolves.toEqual({
        content: [{ type: 'text', text: 'done' }],
      })
      expect(requestMeta(server.requests('tools/call')[0]!)[CLIENT_CAPABILITIES_META_KEY]).toEqual({
        extensions: { [TASKS_EXTENSION]: {} },
        roots: {},
        sampling: {},
      })
      expect(rootsHandler).toHaveBeenCalledTimes(1)
      expect(samplingHandler).toHaveBeenCalledTimes(1)
      if (kind === 'direct') {
        expect(requestParams(server.requests('tools/call')[1]!).inputResponses).toEqual({
          roots: rootsResult,
          sample: samplingResult,
        })
      } else {
        expect(server.requests('tasks/update').map((request) => requestParams(request).inputResponses)).toEqual([
          { roots: rootsResult },
          { sample: samplingResult },
        ])
      }
    })

    it.each(['direct', 'task'])('preserves modern URL input metadata and context for %s calls', async (kind) => {
      const callback = vi.fn(async () => ({ action: 'accept' as const }))
      const { client, server, tool } = await createHarness({ elicitationCallback: callback })
      const inputRequests = {
        authorize: {
          method: 'elicitation/create',
          params: {
            mode: 'url',
            message: 'Authorize',
            url: 'https://example.com/authorize',
            _meta: { correlation: 'authorization-1' },
          },
        },
      } satisfies McpInputRequests
      const results =
        kind === 'direct'
          ? [{ resultType: 'input_required', inputRequests }, directResult('authorized')]
          : [createTask('input_required')]
      server.handle('tools/call', () => results.shift()!)
      const states = [inputRequiredTask(1, inputRequests), completedTask(2, 'authorized')]
      server.handle('tasks/get', () => states.shift()!)
      server.handle('tasks/update', () => ({ resultType: 'complete' }))

      await expect(client.callTool(tool, {})).resolves.toEqual({
        content: [{ type: 'text', text: 'authorized' }],
      })
      const { _meta, ...params } = inputRequests.authorize.params
      expect(callback).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          mcpReq: expect.objectContaining({
            id: kind === 'task' ? `task:${TASK_ID}:authorize` : 'authorize',
            _meta,
            signal: expect.any(AbortSignal),
          }),
        }),
        params
      )
      const responseRequest = server.requests(kind === 'direct' ? 'tools/call' : 'tasks/update').at(-1)!
      expect(requestParams(responseRequest).inputResponses).toEqual({ authorize: { action: 'accept' } })
    })

    it('stops repeated input-required results at the SDK round limit', async () => {
      const callback = vi.fn().mockResolvedValue({
        action: 'accept',
        content: { value: 'approved' },
      })
      const { client, server, tool } = await createHarness({ elicitationCallback: callback })
      server.handle('tools/call', () => ({
        resultType: 'input_required',
        inputRequests: { approval: elicitationRequest('Approve this tool call') },
        requestState: 'opaque-state',
      }))

      await expect(client.callTool(tool, {})).rejects.toEqual(
        expect.objectContaining({
          code: SdkErrorCode.InputRequiredRoundsExceeded,
          data: expect.objectContaining({ rounds: 10 }),
        })
      )
      expect(callback).toHaveBeenCalledTimes(10)
      expect(server.requests('tools/call')).toHaveLength(11)
    })

    it('polls a task created by an input-required retry', async () => {
      const callback = vi.fn().mockResolvedValue({
        action: 'accept',
        content: { value: 'approved' },
      })
      const { client, server, tool } = await createHarness({ elicitationCallback: callback })
      const results = [
        {
          resultType: 'input_required',
          inputRequests: { approval: elicitationRequest('Approve this tool call') },
          requestState: 'opaque-state',
        },
        createTask(),
      ]
      server.handle('tools/call', () => results.shift()!)
      server.handle('tasks/get', () => completedTask(1, 'finished'))

      await expect(client.callTool(tool, {})).resolves.toEqual({
        content: [{ type: 'text', text: 'finished' }],
      })
      expect(server.requests('tools/call')).toHaveLength(2)
      expect(server.requests('tasks/get')).toHaveLength(1)
    })

    it.each(['native', 'direct', 'task'])('applies SDK form defaults for %s input', async (kind) => {
      const callback = vi.fn<ElicitationCallback>().mockResolvedValue({ action: 'accept', content: {} })
      const { client, server, tool } = await createHarness({
        elicitationCallback: callback,
        ...(kind === 'native' && { tasksConfig: false }),
      })
      client.client.registerCapabilities({ elicitation: { form: { applyDefaults: true } } })
      const inputRequests = {
        approval: {
          method: 'elicitation/create',
          params: {
            mode: 'form',
            message: 'Approve',
            requestedSchema: {
              type: 'object',
              properties: { value: { type: 'string', default: 'approved' } },
              required: ['value'],
            },
          },
        },
      } satisfies McpInputRequests
      const results =
        kind === 'task'
          ? [createTask('input_required')]
          : [{ resultType: 'input_required', inputRequests }, directResult('done')]
      server.handle('tools/call', () => results.shift()!)
      const states = [inputRequiredTask(1, inputRequests), completedTask(2)]
      server.handle('tasks/get', () => states.shift()!)
      server.handle('tasks/update', () => ({ resultType: 'complete' }))

      await expect(client.callTool(tool, {})).resolves.toEqual({
        content: [{ type: 'text', text: 'done' }],
      })
      const responseRequest = server.requests(kind === 'task' ? 'tasks/update' : 'tools/call').at(-1)!
      expect(requestParams(responseRequest).inputResponses).toEqual({
        approval: { action: 'accept', content: { value: 'approved' } },
      })
      expect(callback).toHaveBeenCalledOnce()
    })

    it.each([
      { kind: 'direct', response: { malformed: true } },
      { kind: 'direct', response: { roots: [] } },
      { kind: 'task', response: { malformed: true } },
      { kind: 'task', response: { roots: [] } },
    ])('rejects malformed elicitation responses for $kind input: $response', async ({ kind, response }) => {
      const callback = vi.fn().mockResolvedValue(response)
      const { client, server, tool } = await createHarness({ elicitationCallback: callback })
      const inputRequests = { approval: elicitationRequest('Approve this tool call') }
      server.handle('tools/call', () =>
        kind === 'task' ? createTask('input_required') : { resultType: 'input_required', inputRequests }
      )
      server.handle('tasks/get', () => inputRequiredTask(1, inputRequests))
      server.handle('tasks/cancel', () => ({ resultType: 'complete' }))

      await expect(client.callTool(tool, {})).rejects.toMatchObject({
        code: ProtocolErrorCode.InvalidParams,
        message: expect.stringContaining('Invalid elicitation result'),
      })
      expect(server.requests('tools/call')).toHaveLength(1)
      expect(server.requests('tasks/update')).toEqual([])
    })

    it.each(['direct', 'task'])('rejects an elicitation response to roots/list for %s input', async (kind) => {
      const { client, server, tool } = await createHarness()
      client.client.registerCapabilities({ roots: {} })
      client.client.setRequestHandler('roots/list', vi.fn().mockResolvedValue({ action: 'accept' }))
      const inputRequests = { roots: { method: 'roots/list' } } satisfies McpInputRequests
      server.handle('tools/call', () =>
        kind === 'task' ? createTask('input_required') : { resultType: 'input_required', inputRequests }
      )
      server.handle('tasks/get', () => inputRequiredTask(1, inputRequests))
      server.handle('tasks/cancel', () => ({ resultType: 'complete' }))

      await expect(client.callTool(tool, {})).rejects.toMatchObject({ code: SdkErrorCode.InvalidResult })
      expect(server.requests('tools/call')).toHaveLength(1)
      expect(server.requests('tasks/update')).toEqual([])
    })

    it('returns a validated task handle from callToolWithTask without polling', async () => {
      const { client, server, tool } = await createHarness({ outputSchema: STRUCTURED_OUTPUT_SCHEMA })
      const task = createTask()
      server.handle('tools/call', () => task)

      await expect(client.callToolWithTask(tool, { value: 'keep' })).resolves.toEqual(task)
      expect(server.requests('tasks/get')).toEqual([])

      const callRequest = server.requests('tools/call')[0]!
      expect(requestParams(callRequest)).toEqual({
        name: 'task_tool',
        arguments: { value: 'keep' },
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
          [CLIENT_INFO_META_KEY]: { name: 'task-test-client', version: '1.2.3' },
          [CLIENT_CAPABILITIES_META_KEY]: {
            extensions: { [TASKS_EXTENSION]: {} },
          },
        },
      })
    })

    it.each([
      { kind: 'working task', text: 'finished' },
      { kind: 'direct result', text: 'direct' },
    ])('returns validated structured output from a $kind', async ({ kind, text }) => {
      const { client, server, tool } = await createHarness({ outputSchema: STRUCTURED_OUTPUT_SCHEMA })
      const result = {
        content: [{ type: 'text', text }],
        structuredContent: { answer: 42 },
      }
      server.handle('tools/call', () =>
        kind === 'working task' ? createTask() : { ...result, resultType: 'complete' }
      )
      if (kind === 'working task') {
        server.handle('tasks/get', () => completedTask(1, text, { result }))
      }

      await expect(client.callTool(tool, {})).resolves.toEqual({
        content: [{ type: 'text', text }],
        structuredContent: { answer: 42 },
      })
      if (kind === 'working task') expect(server.requests('tasks/get')).toHaveLength(1)
    })

    it.each([
      {
        name: 'direct result without structured content',
        configure(server: ScriptedServer): void {
          server.handle('tools/call', () => directResult())
        },
        message: 'has an output schema but did not return structured content',
      },
      {
        name: 'completed task with mismatched structured content',
        configure(server: ScriptedServer): void {
          server.handle('tools/call', () => createTask())
          server.handle('tasks/get', () =>
            completedTask(1, 'invalid', {
              result: {
                content: [{ type: 'text', text: 'invalid' }],
                structuredContent: { answer: 'not-a-number' },
              },
            })
          )
        },
        message: "Structured content does not match the tool's output schema",
      },
    ])('rejects a $name', async ({ configure, message }) => {
      const { client, server, tool } = await createHarness({ outputSchema: STRUCTURED_OUTPUT_SCHEMA })
      configure(server)

      await expect(client.callTool(tool, {})).rejects.toThrow(message)
    })

    it('preserves completed tool results with isError true', async () => {
      const { client, server, tool } = await createHarness()
      server.handle('tools/call', () => createTask('completed'))
      server.handle('tasks/get', () =>
        completedTask(1, 'tool-level failure', {
          result: {
            content: [{ type: 'text', text: 'tool-level failure' }],
            isError: true,
          },
        })
      )

      await expect(client.callTool(tool, {})).resolves.toEqual({
        content: [{ type: 'text', text: 'tool-level failure' }],
        isError: true,
      })
    })
  })

  describe('explicit lifecycle operations', () => {
    it('validates get, update, and cancel independently with exact request metadata', async () => {
      const { client, server } = await createHarness()
      const getResult = workingTask(1)
      server.handle('tasks/get', () => getResult)
      server.handle('tasks/update', () => ({ resultType: 'complete', _meta: { ack: 'update' } }))
      server.handle('tasks/cancel', () => ({ resultType: 'complete', _meta: { ack: 'cancel' } }))

      await expect(client.getTask(TASK_ID)).resolves.toEqual(getResult)
      await expect(
        client.updateTask(TASK_ID, {
          answer: { action: 'accept', content: { value: 'yes' } },
        })
      ).resolves.toEqual({ resultType: 'complete', _meta: { ack: 'update' } })
      await expect(client.cancelTask(TASK_ID)).resolves.toEqual({
        resultType: 'complete',
        _meta: { ack: 'cancel' },
      })

      const expectedParams = {
        taskId: TASK_ID,
        _meta: expect.objectContaining({
          [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
          [CLIENT_CAPABILITIES_META_KEY]: { extensions: { [TASKS_EXTENSION]: {} } },
        }),
      }
      expect(
        ['tasks/get', 'tasks/update', 'tasks/cancel'].map((method) => ({
          method,
          params: requestParams(server.requests(method)[0]!),
        }))
      ).toEqual([
        { method: 'tasks/get', params: expectedParams },
        {
          method: 'tasks/update',
          params: {
            ...expectedParams,
            inputResponses: {
              answer: { action: 'accept', content: { value: 'yes' } },
            },
          },
        },
        { method: 'tasks/cancel', params: expectedParams },
      ])
    })

    describe.each([
      {
        method: 'tasks/get',
        invoke: (client: McpClient, options: McpTaskRequestOptions): Promise<unknown> =>
          client.getTask(TASK_ID, options),
      },
      {
        method: 'tasks/update',
        invoke: (client: McpClient, options: McpTaskRequestOptions): Promise<unknown> =>
          client.updateTask(
            TASK_ID,
            {
              answer: { action: 'accept', content: { value: 'yes' } },
            },
            options
          ),
      },
      {
        method: 'tasks/cancel',
        invoke: (client: McpClient, options: McpTaskRequestOptions): Promise<unknown> =>
          client.cancelTask(TASK_ID, options),
      },
    ])('$method cancellation', ({ invoke, method }) => {
      it('honors AbortSignal during the request', async () => {
        const { client, server } = await createHarness()
        const controller = new AbortController()
        const primaryError = new Error(`${method} cancelled`)
        server.handle(method, () => NO_RESPONSE)

        const resultPromise = invoke(client, { signal: controller.signal })
        const rejection = expect(resultPromise).rejects.toBe(primaryError)
        await vi.waitFor(() => {
          expect(server.requests(method)).toHaveLength(1)
        })
        controller.abort(primaryError)

        await rejection
      })

      it('does not connect when already cancelled', async () => {
        const { client, server } = await createHarness()
        const reason = new Error('cancelled before connection')

        await expect(invoke(client, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason)

        expect(server.messages).toEqual([])
        expect(client.connectionState).toBe('disconnected')
      })

      it.each(['abort', 'timeout'])('bounds connection waiting by %s', async (cancellation) => {
        vi.useFakeTimers()
        const { client, server } = await createHarness()
        const connect = vi.spyOn(client, 'connect').mockImplementation(() => new Promise<void>(() => {}))
        const controller = new AbortController()
        const reason = new Error('cancelled during connection')
        const promise = invoke(client, { signal: controller.signal, timeoutMs: 10 })
        const rejection =
          cancellation === 'abort'
            ? expect(promise).rejects.toBe(reason)
            : expect(promise).rejects.toMatchObject({ code: SdkErrorCode.RequestTimeout })

        if (cancellation === 'abort') controller.abort(reason)
        else await vi.advanceTimersByTimeAsync(10)

        await rejection
        expect(connect).toHaveBeenCalledOnce()
        expect(server.requests(method)).toEqual([])
      })
    })
  })

  describe('poll scheduling', () => {
    it('honors changing poll intervals returned by the server', async () => {
      vi.useFakeTimers()
      const { client, server, tool } = await createHarness({ tasksConfig: { pollIntervalMs: 25 } })
      server.handle('tools/call', () => createTask('working', { pollIntervalMs: 50 }))
      const states = [workingTask(1, { pollIntervalMs: 80 }), completedTask(2, 'after changing intervals')]
      server.handle('tasks/get', () => states.shift()!)

      const resultPromise = client.callTool(tool, {})
      await vi.advanceTimersByTimeAsync(0)
      expect(server.requests('tasks/get')).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(49)
      expect(server.requests('tasks/get')).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(1)
      expect(server.requests('tasks/get')).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(79)
      expect(server.requests('tasks/get')).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1)

      await expect(resultPromise).resolves.toEqual({
        content: [{ type: 'text', text: 'after changing intervals' }],
      })
      expect(server.requests('tasks/get')).toHaveLength(2)
    })

    it('uses the configured bounded default when pollIntervalMs is absent', async () => {
      vi.useFakeTimers()
      const { client, server, tool } = await createHarness({ tasksConfig: { pollIntervalMs: 35 } })
      const seed = createTask()
      delete seed.pollIntervalMs
      server.handle('tools/call', () => seed)
      server.handle('tasks/get', () => completedTask(1, 'default interval'))

      const resultPromise = client.callTool(tool, {})
      await vi.advanceTimersByTimeAsync(34)
      expect(server.requests('tasks/get')).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(1)

      await expect(resultPromise).resolves.toEqual({
        content: [{ type: 'text', text: 'default interval' }],
      })
    })

    it('clamps a zero server interval to avoid a busy loop', async () => {
      vi.useFakeTimers()
      const { client, server, tool } = await createHarness()
      server.handle('tools/call', () => createTask('working', { pollIntervalMs: 0 }))
      server.handle('tasks/get', () => completedTask(1))

      const resultPromise = client.callTool(tool, {})
      await vi.advanceTimersByTimeAsync(9)
      expect(server.requests('tasks/get')).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(1)

      await expect(resultPromise).resolves.toEqual({
        content: [{ type: 'text', text: 'done' }],
      })
    })
  })

  describe('timeouts and cancellation', () => {
    it.each([
      { phase: 'pending discovery', tasks: false },
      { phase: 'pending discovery', tasks: true },
      { phase: 'discovery response', tasks: false },
      { phase: 'discovery response', tasks: true },
    ])('keeps disconnect final during $phase (tasks: $tasks)', async ({ phase, tasks }) => {
      const [transport, serverTransport] = InMemoryTransport.createLinkedPair()
      const requests: JSONRPCRequest[] = []
      let resolveDiscovery!: (request: JSONRPCRequest) => void
      const discovery = new Promise<JSONRPCRequest>((resolve) => {
        resolveDiscovery = resolve
      })
      serverTransport.onmessage = (message): void => {
        if (!isJsonRpcRequest(message)) return
        requests.push(message)
        if (message.method === 'server/discover') resolveDiscovery(message)
      }
      await serverTransport.start()
      const client = new McpClient({
        transport,
        continueOnError: true,
        ...(tasks && { tasksConfig: {} }),
      })

      try {
        const completions = [
          client.connect(),
          client.connect(),
          client.connect(true),
          client.listTools(),
          ...(tasks ? [client.getTask(TASK_ID)] : []),
        ]
        const rejections = completions.map((completion) =>
          expect(completion).rejects.toMatchObject({ code: SdkErrorCode.ConnectionClosed })
        )
        const request = await discovery
        if (phase === 'discovery response') {
          await serverTransport.send({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              resultType: 'complete',
              supportedVersions: [MODERN_PROTOCOL_VERSION],
              capabilities: { extensions: { [TASKS_EXTENSION]: {} } },
            },
          })
        }

        await client.disconnect()
        await Promise.all(rejections)

        expect(client.connectionState).toBe('disconnected')
        expect(client.serverCapabilities).toBeUndefined()
        expect(client.client.transport).toBeUndefined()
        expect(requests.map((message) => message.method)).toEqual(['server/discover'])
      } finally {
        await client.disconnect()
        await serverTransport.close()
      }
    })

    it('does not restart a forced reconnect after disconnect while closing', async () => {
      const { client, server } = await createHarness()
      await client.connect()
      let releaseClose!: () => void
      const closing = new Promise<void>((resolve) => {
        releaseClose = resolve
      })
      const close = client.client.close.bind(client.client)
      vi.spyOn(client.client, 'close').mockImplementationOnce(async () => {
        await closing
        await close()
      })

      const completion = expect(client.connect(true)).rejects.toMatchObject({ code: SdkErrorCode.ConnectionClosed })
      await client.disconnect()
      releaseClose()
      await completion

      expect(client.connectionState).toBe('disconnected')
      expect(client.client.transport).toBeUndefined()
      expect(server.requests('server/discover')).toHaveLength(1)
    })

    it.each(['poll delay', 'poll request', 'input callback'])(
      'disconnects immediately during a pending %s without reconnecting',
      async (phase) => {
        vi.useFakeTimers()
        const callback = vi.fn((): Promise<never> => new Promise(() => {}))
        const { client, server, tool } = await createHarness({ elicitationCallback: callback })
        server.handle('tools/call', () =>
          createTask(phase === 'input callback' ? 'input_required' : 'working', {
            pollIntervalMs: phase === 'poll delay' ? 500 : 10,
          })
        )
        server.handle('tasks/get', () =>
          phase === 'input callback' ? inputRequiredTask(1, { approval: elicitationRequest('Approve') }) : NO_RESPONSE
        )

        const rejected = vi.fn()
        const completion = client.callTool(tool, {}).catch(rejected)
        await vi.advanceTimersByTimeAsync(10)
        if (phase === 'input callback') expect(callback).toHaveBeenCalledOnce()
        const requestsBeforeDisconnect = server.messages.length

        await client.disconnect()
        await vi.advanceTimersByTimeAsync(0)
        expect(rejected).toHaveBeenCalledWith(expect.objectContaining({ code: SdkErrorCode.ConnectionClosed }))
        await completion
        if (phase === 'input callback') {
          expect(callback).toHaveBeenCalledWith(
            expect.objectContaining({
              mcpReq: expect.objectContaining({ signal: expect.objectContaining({ aborted: true }) }),
            }),
            expect.any(Object)
          )
        }
        await vi.advanceTimersByTimeAsync(1_000)
        expect(server.requests('server/discover')).toHaveLength(1)
        expect(server.requests('tasks/cancel')).toEqual([])
        expect(server.messages.slice(requestsBeforeDisconnect).filter(isJsonRpcRequest)).toEqual([])
        expect(client.connectionState).toBe('disconnected')
      }
    )

    it('allows input handling to outlast a wire request timeout within the overall deadline', async () => {
      vi.useFakeTimers()
      const { client, server, tool } = await createHarness({
        tasksConfig: { timeoutMs: 1_000, ttl: 30 },
        elicitationCallback: async () => {
          await new Promise((resolve) => setTimeout(resolve, 60))
          return { action: 'accept', content: { value: 'approved' } }
        },
      })
      const results = [
        { resultType: 'input_required', inputRequests: { approval: elicitationRequest('Approve') } },
        directResult('approved'),
      ]
      server.handle('tools/call', () => results.shift()!)

      const completion = expect(client.callTool(tool, {})).resolves.toEqual({
        content: [{ type: 'text', text: 'approved' }],
      })
      await vi.advanceTimersByTimeAsync(60)
      await completion
      expect(server.requests('tools/call')).toHaveLength(2)
    })

    it.each(['elicitation', 'request-state'])('bounds low-level %s handling by the call timeout', async (kind) => {
      vi.useFakeTimers()
      const callback = vi.fn((): Promise<never> => new Promise(() => {}))
      const { client, server, tool } = await createHarness({ elicitationCallback: callback })
      server.handle('tools/call', () => ({
        resultType: 'input_required',
        ...(kind === 'elicitation'
          ? { inputRequests: { approval: elicitationRequest('Approve') } }
          : { requestState: 'pending' }),
      }))

      const rejection = expect(client.callToolWithTask(tool, {}, { timeoutMs: 30 })).rejects.toEqual(
        expect.objectContaining({ code: SdkErrorCode.RequestTimeout })
      )
      await vi.advanceTimersByTimeAsync(30)
      await rejection
      if (kind === 'elicitation') {
        expect(callback).toHaveBeenCalledWith(
          expect.objectContaining({
            mcpReq: expect.objectContaining({ signal: expect.objectContaining({ aborted: true }) }),
          }),
          expect.any(Object)
        )
      }
      await vi.advanceTimersByTimeAsync(300)
      expect(server.requests('tools/call')).toHaveLength(1)
    })

    it.each([
      { name: 'before receiving a task handle', response: NO_RESPONSE, cancellations: 0 },
      {
        name: 'after receiving a task handle',
        response: createTask('working', { pollIntervalMs: 1_000 }),
        cancellations: 1,
      },
    ])('times out $name and sends $cancellations cancellations', async ({ response, cancellations }) => {
      vi.useFakeTimers()
      const { client, server, tool } = await createHarness({ tasksConfig: { timeoutMs: 50 } })
      server.handle('tools/call', () => response)
      server.handle('tasks/cancel', () => ({ resultType: 'complete' }))

      const resultPromise = client.callTool(tool, {})
      const rejection = expect(resultPromise).rejects.toEqual(
        expect.objectContaining({ code: SdkErrorCode.RequestTimeout })
      )
      await vi.advanceTimersByTimeAsync(50)

      await rejection
      expect(server.requests('tasks/cancel')).toHaveLength(cancellations)
      if (cancellations) expect(server.requests('tasks/get')).toEqual([])
    })

    it('cancels exactly once when a lifecycle request times out', async () => {
      vi.useFakeTimers()
      const { client, server, tool } = await createHarness({
        tasksConfig: { timeoutMs: 500, ttl: 25 },
      })
      server.handle('tools/call', () => createTask('working', { pollIntervalMs: 10 }))
      server.handle('tasks/get', () => NO_RESPONSE)
      server.handle('tasks/cancel', () => ({ resultType: 'complete' }))

      const resultPromise = client.callTool(tool, {})
      const rejection = expect(resultPromise).rejects.toEqual(
        expect.objectContaining({
          code: SdkErrorCode.RequestTimeout,
          message: 'MCP tasks/get request timed out',
        })
      )
      await vi.advanceTimersByTimeAsync(35)
      await rejection
      await vi.advanceTimersByTimeAsync(0)

      expect(server.requests('tasks/get')).toHaveLength(1)
      expect(server.requests('tasks/cancel')).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(500)
      expect(server.requests('tasks/cancel')).toHaveLength(1)
    })

    it.each(['acknowledged', 'unanswered', 'rejected'])(
      'preserves caller abort when remote cancellation is %s',
      async (outcome) => {
        vi.useFakeTimers()
        const { client, server, tool } = await createHarness()
        const controller = new AbortController()
        const primaryError = new Error('caller cancelled')
        server.handle('tools/call', () => createTask('working', { pollIntervalMs: 500 }))
        server.handle('tasks/cancel', () => {
          if (outcome === 'rejected') {
            throw new ProtocolError(ProtocolErrorCode.InternalError, 'remote cancellation failed')
          }
          return outcome === 'unanswered' ? NO_RESPONSE : { resultType: 'complete' }
        })

        const rejected = vi.fn()
        void client.callTool(tool, {}, { signal: controller.signal }).catch(rejected)
        await vi.advanceTimersByTimeAsync(0)
        controller.abort(primaryError)
        await vi.advanceTimersByTimeAsync(0)

        expect(rejected.mock.calls[0]?.[0]).toBe(primaryError)
        expect(server.requests('tasks/cancel')).toHaveLength(1)
        if (outcome === 'acknowledged') {
          await vi.advanceTimersByTimeAsync(2_000)
          expect(server.requests('tasks/cancel')).toHaveLength(1)
        }
        if (outcome !== 'rejected') expect(server.requests('tasks/get')).toEqual([])
      }
    )
  })

  describe('terminal states', () => {
    it('preserves failed-task error data and status context', async () => {
      const { client, server, tool } = await createHarness()
      server.handle('tools/call', () => createTask('failed'))
      server.handle('tasks/get', () => failedTask(1, 'The remote worker stopped'))

      const error = await client.callTool(tool, {}).catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(ProtocolError)
      expect(error).toEqual(
        expect.objectContaining({
          code: -32_603,
          data: { retryable: false },
          message: 'Task execution failed: The remote worker stopped',
        })
      )
    })

    it('translates cancelled tasks with useful status context', async () => {
      const { client, server, tool } = await createHarness()
      server.handle('tools/call', () => createTask('cancelled'))
      server.handle('tasks/get', () => cancelledTask(1, 'Cancelled by policy'))

      await expect(client.callTool(tool, {})).rejects.toEqual(
        expect.objectContaining({
          name: 'McpTaskCancelledError',
          statusMessage: 'Cancelled by policy',
          message: 'MCP task was cancelled: Cancelled by policy',
        })
      )
    })
  })

  describe('input_required handling', () => {
    it('uses the elicitation handler, preserves request context, and deduplicates repeated keys', async () => {
      const callback = vi.fn<ElicitationCallback>().mockResolvedValue({
        action: 'accept',
        content: { value: 'approved' },
      })
      const { client, server, tool } = await createHarness({ elicitationCallback: callback })
      const request = elicitationRequest('Approve this task', { trustPolicy: 'strict' })
      server.handle('tools/call', () => createTask('input_required'))
      const states = [
        inputRequiredTask(1, { approval: request }),
        inputRequiredTask(2, { approval: request }),
        completedTask(3, 'approved'),
      ]
      server.handle('tasks/get', () => states.shift()!)
      server.handle('tasks/update', () => ({ resultType: 'complete' }))

      await expect(client.callTool(tool, {})).resolves.toEqual({
        content: [{ type: 'text', text: 'approved' }],
      })

      expect(callback).toHaveBeenCalledTimes(1)
      expect(callback.mock.calls[0]).toEqual([
        expect.objectContaining({
          mcpReq: expect.objectContaining({
            id: `task:${TASK_ID}:approval`,
            _meta: { trustPolicy: 'strict' },
            signal: expect.any(AbortSignal),
          }),
        }),
        request.params,
      ])
      expect(server.requests('tasks/update').map(requestParams)).toEqual([
        expect.objectContaining({
          taskId: TASK_ID,
          inputResponses: {
            approval: {
              action: 'accept',
              content: { value: 'approved' },
            },
          },
        }),
      ])
      expect(server.requests('tasks/get')).toHaveLength(3)

      const elicitationContext = callback.mock.calls[0]![0]
      server.handle('tools/list', () => ({ resultType: 'complete', ttlMs: 0, cacheScope: 'private', tools: [] }))
      await expect(
        elicitationContext.mcpReq.send({ method: 'tools/list' }, specTypeSchemas.ListToolsResult, { timeout: 100 })
      ).resolves.toMatchObject({ tools: [] })
      await expect(elicitationContext.mcpReq.notify({ method: 'notifications/roots/list_changed' })).rejects.toThrow(
        "Notification 'notifications/roots/list_changed' is not supported"
      )
    })

    it('supports partial response sets through separate tasks/update acknowledgements', async () => {
      const callback = vi.fn().mockResolvedValue({
        action: 'accept',
        content: { value: 'answer' },
      })
      const { client, server, tool } = await createHarness({ elicitationCallback: callback })
      server.handle('tools/call', () => createTask('input_required'))
      const states = [
        inputRequiredTask(1, {
          first: elicitationRequest('First question'),
          second: elicitationRequest('Second question'),
        }),
        completedTask(2, 'both answered'),
      ]
      server.handle('tasks/get', () => states.shift()!)
      server.handle('tasks/update', () => ({ resultType: 'complete' }))

      await expect(client.callTool(tool, {})).resolves.toEqual({
        content: [{ type: 'text', text: 'both answered' }],
      })

      expect(callback).toHaveBeenCalledTimes(2)
      expect(server.requests('tasks/update').map((request) => requestParams(request).inputResponses)).toEqual([
        {
          first: {
            action: 'accept',
            content: { value: 'answer' },
          },
        },
        {
          second: {
            action: 'accept',
            content: { value: 'answer' },
          },
        },
      ])
    })

    it('propagates tasks/update failures without prompting the same key again', async () => {
      const callback = vi.fn().mockResolvedValue({
        action: 'accept',
        content: { value: 'answer' },
      })
      const { client, server, tool } = await createHarness({ elicitationCallback: callback })
      server.handle('tools/call', () => createTask('input_required'))
      server.handle('tasks/get', () =>
        inputRequiredTask(1, {
          answer: elicitationRequest('Question'),
        })
      )
      server.handle('tasks/update', () => {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Input response rejected', {
          field: 'answer',
        })
      })
      server.handle('tasks/cancel', () => ({ resultType: 'complete' }))

      const error = await client.callTool(tool, {}).catch((caught: unknown) => caught)

      expect(error).toEqual(
        expect.objectContaining({
          code: ProtocolErrorCode.InvalidParams,
          message: 'Input response rejected',
          data: { field: 'answer' },
        })
      )
      expect(callback).toHaveBeenCalledTimes(1)
      expect(server.requests('tasks/update')).toHaveLength(1)
      expect(server.requests('tasks/cancel')).toHaveLength(1)
    })

    it('cancels an unfinished task when its input callback fails', async () => {
      const primaryError = new Error('Input callback failed')
      const { client, server, tool } = await createHarness({
        elicitationCallback: async () => {
          throw primaryError
        },
      })
      server.handle('tools/call', () => createTask('input_required', { ttlMs: null }))
      server.handle('tasks/get', () => inputRequiredTask(1, { answer: elicitationRequest('Question') }))
      server.handle('tasks/cancel', () => ({ resultType: 'complete' }))

      await expect(client.callTool(tool, {})).rejects.toBe(primaryError)
      expect(server.requests('tasks/cancel')).toHaveLength(1)
      expect(server.requests('tasks/update')).toEqual([])
    })

    it('fails clearly for input requests without a registered handler', async () => {
      const { client, server, tool } = await createHarness()
      server.handle('tools/call', () => createTask('input_required'))
      server.handle('tasks/get', () =>
        inputRequiredTask(1, {
          sample: {
            method: 'sampling/createMessage',
            params: {
              messages: [{ role: 'user', content: { type: 'text', text: 'Summarize' } }],
              maxTokens: 64,
            },
          },
        })
      )

      await expect(client.callTool(tool, {})).rejects.toThrow(
        'No MCP input handler is registered for "sampling/createMessage"'
      )
      expect(server.requests('tasks/update')).toEqual([])
    })

    it('enforces the overall timeout while an elicitation handler is still pending', async () => {
      vi.useFakeTimers()
      const callback = vi.fn((): Promise<never> => new Promise(() => {}))
      const { client, server, tool } = await createHarness({
        tasksConfig: { timeoutMs: 50 },
        elicitationCallback: callback,
      })
      server.handle('tools/call', () => createTask('input_required'))
      server.handle('tasks/get', () =>
        inputRequiredTask(1, {
          answer: elicitationRequest('Question'),
        })
      )
      server.handle('tasks/cancel', () => ({ resultType: 'complete' }))

      const resultPromise = client.callTool(tool, {})
      const rejection = expect(resultPromise).rejects.toEqual(
        expect.objectContaining({ code: SdkErrorCode.RequestTimeout })
      )
      await vi.advanceTimersByTimeAsync(50)

      await rejection
      expect(callback).toHaveBeenCalledTimes(1)
      expect(server.requests('tasks/cancel')).toHaveLength(1)
    })
  })

  describe('response validation and state reconciliation', () => {
    it.each(['direct', 'task'])('rejects a %s tool result with no content array', async (kind) => {
      const { client, server, tool } = await createHarness()
      server.handle('tools/call', () => (kind === 'direct' ? { resultType: 'complete' } : createTask('completed')))
      server.handle('tasks/get', () => ({ ...completedTask(1), result: {} }))

      await expect(client.callTool(tool, {})).rejects.toEqual(
        expect.objectContaining({ code: SdkErrorCode.InvalidResult })
      )
    })

    it.each([
      { path: 'task-aware', tasksConfig: {} },
      { path: 'direct', tasksConfig: false },
    ] as const)('rejects empty input requests without request state for $path calls', async ({ tasksConfig }) => {
      const { client, server, tool } = await createHarness({ tasksConfig })
      server.handle('tools/call', () => ({ resultType: 'input_required', inputRequests: {} }))

      await expect(client.callTool(tool, {})).rejects.toEqual(
        expect.objectContaining({ code: SdkErrorCode.InvalidResult })
      )
      expect(server.requests('tools/call')).toHaveLength(1)
    })

    it('sanitizes malformed task-handle errors without echoing server data', async () => {
      const { client, server, tool } = await createHarness()
      server.handle('tools/call', () => ({
        ...createTask(),
        taskId: '',
        statusMessage: 'credential=server-secret',
      }))

      const error = await client.callToolWithTask(tool, {}).catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(SdkError)
      expect(error).toEqual(expect.objectContaining({ code: SdkErrorCode.InvalidResult }))
      expect(String(error)).toContain('MCP tools/call returned a malformed SEP-2663 response')
      expect(String(error)).not.toContain('server-secret')
    })

    it.each([
      {
        invoke: (client: McpClient): Promise<unknown> => client.getTask(TASK_ID),
        method: 'tasks/get',
        result: {
          ...workingTask(1),
          status: 'completed',
        },
      },
      {
        invoke: (client: McpClient): Promise<unknown> =>
          client.updateTask(TASK_ID, {
            answer: { action: 'accept', content: { value: 'yes' } },
          }),
        method: 'tasks/update',
        result: workingTask(1),
      },
      {
        invoke: (client: McpClient): Promise<unknown> => client.cancelTask(TASK_ID),
        method: 'tasks/cancel',
        result: workingTask(1),
      },
    ])('rejects malformed $method responses predictably', async ({ invoke, method, result }) => {
      const { client, server } = await createHarness()
      server.handle(method, () => result)

      await expect(invoke(client)).rejects.toEqual(expect.objectContaining({ code: SdkErrorCode.InvalidResult }))
    })

    it('rejects a terminal seed that changes status', async () => {
      const { client, server, tool } = await createHarness()
      server.handle('tools/call', () => createTask('completed'))
      server.handle('tasks/get', () => workingTask(1))

      await expect(client.callTool(tool, {})).rejects.toThrow('MCP task changed after reaching a terminal state')
    })

    it('accepts a valid state transition that shares the previous timestamp', async () => {
      const { client, server, tool } = await createHarness()
      server.handle('tools/call', () => createTask('working'))
      server.handle('tasks/get', () => completedTask(0, 'same timestamp'))

      await expect(client.callTool(tool, {})).resolves.toEqual({
        content: [{ type: 'text', text: 'same timestamp' }],
      })
    })

    it('ignores stale duplicate states and continues to a newer terminal state', async () => {
      const { client, server, tool } = await createHarness()
      server.handle('tools/call', () => createTask())
      const states = [
        workingTask(2, { statusMessage: 'newest working state' }),
        workingTask(1, { statusMessage: 'stale working state' }),
        completedTask(3, 'latest result'),
      ]
      server.handle('tasks/get', () => states.shift()!)

      await expect(client.callTool(tool, {})).resolves.toEqual({
        content: [{ type: 'text', text: 'latest result' }],
      })
      expect(server.requests('tasks/get')).toHaveLength(3)
    })
  })

  describe('concurrent tasks', () => {
    it('keeps polling state isolated across simultaneous calls', async () => {
      const { client, server, tool } = await createHarness()
      server.handle('tools/call', (request) => {
        const argumentsValue = requestParams(request).arguments as { id: string }
        return createTask('working', { taskId: `task-${argumentsValue.id}` })
      })
      server.handle('tasks/get', (request) => {
        const taskId = requestParams(request).taskId as string
        return completedTask(1, `result for ${taskId}`, { taskId })
      })

      const [first, second] = await Promise.all([
        client.callTool(tool, { id: 'a' }),
        client.callTool(tool, { id: 'b' }),
      ])

      expect([first, second]).toEqual([
        { content: [{ type: 'text', text: 'result for task-a' }] },
        { content: [{ type: 'text', text: 'result for task-b' }] },
      ])
      expect(
        server
          .requests('tasks/get')
          .map((request) => requestParams(request).taskId)
          .sort()
      ).toEqual(['task-a', 'task-b'])
    })
  })

  describe('task notifications', () => {
    it.each([
      { notifications: false, status: 'completed' },
      { notifications: false, status: 'cancelled' },
      { notifications: false, status: 'failed' },
      { notifications: true, status: 'completed' },
    ] as const)(
      'polls pending input to $status when notifications=$notifications are unavailable',
      async ({ notifications, status }) => {
        vi.useFakeTimers()
        const callback = vi.fn((): Promise<never> => new Promise(() => {}))
        const { client, server, tool } = await createHarness({
          tasksConfig: { useNotifications: notifications },
          elicitationCallback: callback,
        })
        const terminal =
          status === 'completed' ? completedTask(2) : status === 'cancelled' ? cancelledTask(2) : failedTask(2)
        const states = [inputRequiredTask(1, { answer: elicitationRequest('Question') }), terminal]
        server.handle('tools/call', () => createTask('input_required'))
        server.handle('tasks/get', () => states.shift()!)
        server.handle('subscriptions/listen', () => {
          throw new ProtocolError(ProtocolErrorCode.MethodNotFound, 'Subscriptions unavailable')
        })
        const result = client.callTool(tool, {})
        const completion =
          status === 'completed'
            ? expect(result).resolves.toEqual({ content: [{ type: 'text', text: 'done' }] })
            : expect(result).rejects.toBeInstanceOf(status === 'cancelled' ? McpTaskCancelledError : ProtocolError)

        await vi.advanceTimersByTimeAsync(10)
        await completion
        expect(callback).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            mcpReq: expect.objectContaining({ signal: expect.objectContaining({ aborted: true }) }),
          }),
          expect.any(Object)
        )
        expect(server.requests('tasks/get')).toHaveLength(2)
        expect(server.requests('tasks/update')).toEqual([])
        expect(server.requests('tasks/cancel')).toEqual([])
        await vi.advanceTimersByTimeAsync(1_000)
        expect(server.requests('tasks/get')).toHaveLength(2)
      }
    )

    it('cancels the input poll when the callback completes', async () => {
      vi.useFakeTimers()
      let answer: ((value: { action: 'accept' }) => void) | undefined
      const { client, server, tool } = await createHarness({
        elicitationCallback: () =>
          new Promise((resolve) => {
            answer = resolve
          }),
      })
      let polls = 0
      server.handle('tools/call', () => createTask('input_required'))
      server.handle('tasks/get', () => {
        polls += 1
        if (polls === 1) return inputRequiredTask(1, { answer: elicitationRequest('Question') })
        return polls === 2 ? NO_RESPONSE : completedTask(2)
      })
      server.handle('tasks/update', () => ({ resultType: 'complete' }))
      const completion = expect(client.callTool(tool, {})).resolves.toEqual({
        content: [{ type: 'text', text: 'done' }],
      })
      await vi.advanceTimersByTimeAsync(10)
      const pendingPoll = server.requests('tasks/get')[1]!
      answer!({ action: 'accept' })
      await vi.advanceTimersByTimeAsync(10)
      await completion
      expect(server.messages).toContainEqual(
        expect.objectContaining({
          method: 'notifications/cancelled',
          params: expect.objectContaining({ requestId: pendingPoll.id }),
        })
      )
      expect(server.requests('tasks/update')).toHaveLength(1)
      expect(server.requests('tasks/cancel')).toEqual([])
    })

    it.each(['completed', 'cancelled', 'failed'] as const)(
      'cancels a pending poll when a %s notification arrives',
      async (status) => {
        vi.useFakeTimers()
        const { client, server, tool } = await createHarness({ tasksConfig: { useNotifications: true } })
        server.handle('tools/call', () => createTask())
        server.handle('tasks/get', () => NO_RESPONSE)
        server.handle('subscriptions/listen', async (request) => {
          await acknowledgeTaskSubscription(server, request)
          return NO_RESPONSE
        })
        const result = client.callTool(tool, {})
        const completion =
          status === 'completed'
            ? expect(result).resolves.toEqual({ content: [{ type: 'text', text: 'done' }] })
            : expect(result).rejects.toBeInstanceOf(status === 'cancelled' ? McpTaskCancelledError : ProtocolError)
        await vi.advanceTimersByTimeAsync(10)
        const pendingPoll = server.requests('tasks/get')[0]!
        const terminal =
          status === 'completed' ? completedTask(2) : status === 'cancelled' ? cancelledTask(2) : failedTask(2)
        await server.notify('notifications/tasks', taskNotificationParams(terminal))
        await vi.advanceTimersByTimeAsync(0)
        await completion

        expect(server.messages).toContainEqual(
          expect.objectContaining({
            method: 'notifications/cancelled',
            params: expect.objectContaining({ requestId: pendingPoll.id }),
          })
        )
        expect(server.requests('tasks/cancel')).toEqual([])
        await vi.advanceTimersByTimeAsync(1_000)
        expect(server.requests('tasks/get')).toHaveLength(1)
      }
    )

    it.each(['completed', 'cancelled', 'failed'] as const)(
      'stops pending input handling when a task is %s',
      async (status) => {
        vi.useFakeTimers()
        const callback = vi.fn((): Promise<never> => new Promise(() => {}))
        const { client, server, tool } = await createHarness({
          tasksConfig: { useNotifications: true },
          elicitationCallback: callback,
        })
        server.handle('tools/call', () => createTask('input_required'))
        server.handle('tasks/get', () => inputRequiredTask(1, { answer: elicitationRequest('Question') }))
        server.handle('subscriptions/listen', async (request) => {
          await acknowledgeTaskSubscription(server, request)
          return NO_RESPONSE
        })
        const result = client.callTool(tool, {})
        const completion =
          status === 'completed'
            ? expect(result).resolves.toEqual({ content: [{ type: 'text', text: 'done' }] })
            : expect(result).rejects.toBeInstanceOf(status === 'cancelled' ? McpTaskCancelledError : ProtocolError)
        await vi.advanceTimersByTimeAsync(0)
        expect(callback).toHaveBeenCalledTimes(1)

        const terminal =
          status === 'completed' ? completedTask(2) : status === 'cancelled' ? cancelledTask(2) : failedTask(2)
        await server.notify(
          'notifications/tasks',
          taskNotificationParams(terminal, {
            [SUBSCRIPTION_ID_META_KEY]: server.requests('subscriptions/listen')[0]!.id,
          })
        )
        await vi.advanceTimersByTimeAsync(0)
        await completion
        expect(callback).toHaveBeenCalledWith(
          expect.objectContaining({
            mcpReq: expect.objectContaining({ signal: expect.objectContaining({ aborted: true }) }),
          }),
          expect.any(Object)
        )
        expect(server.requests('tasks/update')).toEqual([])
        expect(server.requests('tasks/cancel')).toEqual([])
      }
    )

    it('completes from notifications/tasks through subscriptions/listen', async () => {
      const { client, server, tool } = await createHarness({
        tasksConfig: { useNotifications: true, pollIntervalMs: 100 },
      })
      server.handle('tools/call', () => createTask('working', { pollIntervalMs: 100 }))
      server.handle('subscriptions/listen', async (request) => {
        await acknowledgeTaskSubscription(server, request)
        await server.notify(
          'notifications/tasks',
          taskNotificationParams(completedTask(1, 'notification result'), {
            [SUBSCRIPTION_ID_META_KEY]: request.id,
          })
        )
        return NO_RESPONSE
      })

      await expect(client.callTool(tool, {})).resolves.toEqual({
        content: [{ type: 'text', text: 'notification result' }],
      })
      expect(server.requests('subscriptions/listen').map(requestParams)).toEqual([
        expect.objectContaining({
          notifications: { taskIds: [TASK_ID] },
        }),
      ])
      expect(server.requests('tasks/get')).toEqual([])
    })

    it('accepts poll and notification duplicates that differ only in envelope metadata', async () => {
      const { client, server, tool } = await createHarness({ tasksConfig: { useNotifications: true } })
      server.handle('tools/call', () => createTask())
      server.handle('subscriptions/listen', async (request) => {
        await acknowledgeTaskSubscription(server, request)
        return NO_RESPONSE
      })
      server.handle('tasks/get', async () => {
        const state = completedTask(1, 'same state', { _meta: { source: 'poll' } })
        await server.notify(
          'notifications/tasks',
          taskNotificationParams(state, {
            source: 'subscription',
            [SUBSCRIPTION_ID_META_KEY]: server.requests('subscriptions/listen')[0]!.id,
          })
        )
        return state
      })

      await expect(client.callTool(tool, {})).resolves.toEqual({
        content: [{ type: 'text', text: 'same state' }],
      })
      expect(server.requests('tasks/get')).toHaveLength(1)
    })

    it('rejects contradictory poll and notification states for the same update time', async () => {
      const { client, server, tool } = await createHarness({ tasksConfig: { useNotifications: true } })
      server.handle('tools/call', () => createTask())
      server.handle('subscriptions/listen', async (request) => {
        await acknowledgeTaskSubscription(server, request)
        return NO_RESPONSE
      })
      server.handle('tasks/get', async () => {
        await server.notify(
          'notifications/tasks',
          taskNotificationParams(completedTask(1, 'notification value'), {
            [SUBSCRIPTION_ID_META_KEY]: server.requests('subscriptions/listen')[0]!.id,
          })
        )
        return completedTask(1, 'poll value')
      })

      await expect(client.callTool(tool, {})).rejects.toThrow('MCP task changed after reaching a terminal state')
    })

    it.each([
      ['rejected', 1, 'poll fallback'],
      ['malformed', 2, 'poll fallback'],
      ['closed', 1, 'poll after close'],
    ] as const)('falls back to polling when the subscription is %s', async (outcome, revision, text) => {
      const { client, server, tool } = await createHarness({ tasksConfig: { useNotifications: true } })
      server.handle('tools/call', () => createTask())
      server.handle('subscriptions/listen', async (request) => {
        if (outcome === 'rejected') {
          throw new ProtocolError(ProtocolErrorCode.InternalError, 'Subscriptions unavailable')
        }
        await acknowledgeTaskSubscription(server, request)
        if (outcome === 'closed') return { resultType: 'complete' }
        const malformed = taskNotificationParams(completedTask(1, 'invalid notification'))
        delete malformed.result
        await server.notify('notifications/tasks', malformed)
        return NO_RESPONSE
      })
      server.handle('tasks/get', () => completedTask(revision, text))

      await expect(client.callTool(tool, {})).resolves.toEqual({
        content: [{ type: 'text', text }],
      })
      if (outcome === 'rejected') expect(server.requests('subscriptions/listen')).toHaveLength(1)
      expect(server.requests('tasks/get')).toHaveLength(1)
    })
  })

  describe('protocol compatibility', () => {
    it('advertises task capability only when tasks are enabled', async () => {
      for (const tasksConfig of [{}, false] as const) {
        const { client, server, tool } = await createHarness({ tasksConfig })
        server.handle('tools/call', () => directResult())
        await client.callTool(tool, {})

        expect(requestMeta(server.requests('server/discover')[0]!)[CLIENT_CAPABILITIES_META_KEY]).toEqual(
          tasksConfig === false ? {} : { extensions: { [TASKS_EXTENSION]: {} } }
        )
        if (tasksConfig === false) {
          expect(requestMeta(server.requests('tools/call')[0]!)[CLIENT_CAPABILITIES_META_KEY]).toEqual({})
        }
      }
    })

    it('keeps legacy direct calls working without task capability metadata', async () => {
      const { client, server, tool } = await createHarness({ era: 'legacy' })
      server.handle('tools/call', () => ({ content: [{ type: 'text', text: 'legacy direct' }] }))

      await expect(client.callTool(tool, {})).resolves.toEqual({
        content: [{ type: 'text', text: 'legacy direct' }],
      })

      const initialize = server.requests('initialize')[0]!
      const initializeCapabilities = requestParams(initialize).capabilities as ClientCapabilities
      expect(initializeCapabilities.extensions?.[TASKS_EXTENSION]).toBeUndefined()
      expect(requestParams(server.requests('tools/call')[0]!)).toEqual({
        name: 'task_tool',
        arguments: {},
      })
      await expect(client.getTask(TASK_ID)).rejects.toThrow(
        `SEP-2663 task operations require negotiated MCP protocol ${MODERN_PROTOCOL_VERSION}`
      )
      expect(server.requests('tasks/get')).toEqual([])
    })

    it('rejects task handles and lifecycle methods when the server omits the extension capability', async () => {
      const { client, server, tool } = await createHarness({ capabilities: { tools: {} } })
      server.handle('tools/call', () => createTask())

      await expect(client.callToolWithTask(tool, {})).rejects.toThrow(
        `MCP server did not advertise the ${TASKS_EXTENSION} extension`
      )
      await expect(client.cancelTask(TASK_ID)).rejects.toThrow(
        `MCP server did not advertise the ${TASKS_EXTENSION} extension`
      )
      expect(server.requests('tasks/cancel')).toEqual([])
    })
  })
})

describe('McpClient legacy task execution', () => {
  const legacyTask = (status: McpCreateTaskResult['status']): Record<string, unknown> => ({
    taskId: TASK_ID,
    status,
    statusMessage: `legacy task ${status}`,
    ttl: 60_000,
    pollInterval: 10,
    createdAt: CREATED_AT,
    lastUpdatedAt: CREATED_AT,
  })

  async function legacyHarness(
    tasksConfig?: TasksConfig,
    requestTimeouts?: ConstructorParameters<typeof McpClient>[0]['requestTimeouts']
  ): Promise<TaskHarness> {
    const harness = await createHarness({
      era: 'legacy',
      ...(tasksConfig && { tasksConfig }),
      ...(requestTimeouts && { requestTimeouts }),
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

  it.each(['failed', 'cancelled'] as const)('rejects a %s task without retrieving a payload', async (status) => {
    const { client, server, tool } = await legacyHarness()
    server.handle('tools/call', () => ({ task: legacyTask(status) }))
    await expect(client.callTool(tool, {})).rejects.toThrow(`legacy task ${status}`)
    expect(server.requests('tasks/result')).toHaveLength(0)
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
      const { client, server, tool } = await legacyHarness(
        { ttl: 65, pollTimeout: maximum },
        { resetTimeoutOnProgress: true }
      )
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

  it('lets legacy polling outlast the per-request pollTimeout', async () => {
    vi.useFakeTimers()
    const { client, server, tool } = await legacyHarness({ ttl: 65, pollTimeout: 110 })
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

describe('McpClient requestTimeouts with task support', () => {
  it.each([
    { era: 'modern', tasks: true, maximum: 400 },
    { era: 'modern', tasks: true, maximum: 65 },
    { era: 'modern', tasks: false, maximum: 400 },
    { era: 'legacy', tasks: true, maximum: 400 },
    { era: 'legacy', tasks: true, maximum: 65 },
    { era: 'legacy', tasks: false, maximum: 400 },
  ] as const)(
    'resets inactivity while enforcing the total limit ($era, tasks=$tasks, maximum=$maximum)',
    async ({ era, tasks, maximum }) => {
      vi.useFakeTimers()
      const { client, server, tool } = await createHarness({
        era,
        tasksConfig: tasks ? { ttl: 65 } : false,
        requestTimeouts: { timeout: 65, maxTotalTimeout: maximum, resetTimeoutOnProgress: true },
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
              resolve(era === 'modern' ? directResult() : { content: [{ type: 'text', text: 'direct' }] })
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

describe('McpClient default overall task deadlines', () => {
  it.each(['modern', 'legacy'] as const)('preserves the %s default when timeoutMs is omitted', async (era) => {
    vi.useFakeTimers()
    const { client, server } = await createHarness({
      era,
      ...(era === 'legacy' && {
        capabilities: { tools: {}, tasks: { requests: { tools: { call: {} } }, cancel: {} } },
      }),
    })
    server.handle('tools/list', () => ({
      ...(era === 'modern' && { resultType: 'complete', ttlMs: 0, cacheScope: 'private' }),
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
    server.handle('tools/call', () =>
      era === 'modern' ? createTask('working', { pollIntervalMs: 100_000 }) : { task: legacyState }
    )
    server.handle('tasks/get', () => (era === 'modern' ? workingTask(0, { pollIntervalMs: 100_000 }) : legacyState))
    server.handle('tasks/cancel', () =>
      era === 'modern' ? { resultType: 'complete' } : { ...legacyState, status: 'cancelled' }
    )
    const controller = new AbortController()
    const settled = vi.fn()
    const result = client.callTool(tool!, {}, { signal: controller.signal }).then(settled, settled)
    await vi.advanceTimersByTimeAsync(299_999)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2)
    if (era === 'modern') {
      expect(settled).toHaveBeenCalledWith(expect.objectContaining({ code: SdkErrorCode.RequestTimeout }))
    } else {
      expect(settled).not.toHaveBeenCalled()
      const reason = new Error('stop unlimited legacy task')
      controller.abort(reason)
      await result
      expect(settled).toHaveBeenCalledWith(reason)
    }
    await result
  })
})
