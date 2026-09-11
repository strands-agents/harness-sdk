import {
  CLIENT_CAPABILITIES_META_KEY,
  SERVER_INFO_META_KEY,
  SUBSCRIPTION_ID_META_KEY,
  createMcpHandler,
  inputRequired,
  inputResponse,
  McpServer,
} from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { buffer } from 'node:stream/consumers'
import { promisify } from 'node:util'
import * as z from 'zod'

import type { CallToolResult, InputRequests, JSONRPCErrorResponse, RequestId } from '@modelcontextprotocol/server'
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

const TASK_EXTENSION_ID = 'io.modelcontextprotocol/tasks'
const ELICITATION_REQUEST_KEY = 'elicitation'

const SERVER_INFO = {
  name: 'test-mcp-task-server',
  version: '2.0.0',
}

const valueInputSchema = z.object({
  value: z.string().optional(),
})

const taskTools = {
  instant_task: {
    title: 'Instant Task',
    description: 'Creates a task that is already completed',
    inputSchema: valueInputSchema,
  },
  long_running_task: {
    title: 'Long Running Task',
    description: 'Creates a working task that completes after a short delay',
    inputSchema: z.object({
      duration: z.number().int().nonnegative().max(5_000).optional(),
      message: z.string().optional(),
    }),
  },
  failing_task: {
    title: 'Failing Task',
    description: 'Creates a task that fails with a JSON-RPC execution error',
    inputSchema: z.object({ error_message: z.string().optional() }),
  },
  input_required_task: {
    title: 'Input Required Task',
    description: 'Creates a task with an embedded elicitation request',
    inputSchema: z.object({ prompt: z.string().optional() }),
  },
  cancellable_task: {
    title: 'Cancellable Task',
    description: 'Creates a working task that remains active until cancelled',
    inputSchema: z.object({ message: z.string().optional() }),
  },
  cancelled_task: {
    title: 'Cancelled Task',
    description: 'Creates a task in the cancelled state',
    inputSchema: z.object({ reason: z.string().optional() }),
  },
}

type TaskToolName = keyof typeof taskTools

const jsonRpcMessageSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number().int()]).optional(),
  method: z.string(),
  params: z.looseObject({}).optional(),
})

const taskOperationParamsSchema = z.looseObject({
  taskId: z.string(),
})

const updateTaskParamsSchema = taskOperationParamsSchema.extend({
  inputResponses: z.record(z.string(), z.unknown()),
})

const taskSubscriptionParamsSchema = z.looseObject({
  notifications: z.looseObject({
    taskIds: z.array(z.string()),
  }),
})

type TaskState = { statusMessage: string } & (
  | { status: 'working' | 'cancelled' }
  | { status: 'input_required'; inputRequests: InputRequests }
  | { status: 'completed'; result: CallToolResult }
  | { status: 'failed'; error: JSONRPCErrorResponse['error'] }
)

interface TaskMetadata {
  taskId: string
  createdAt: string
  lastUpdatedAt: string
  ttlMs: number
  pollIntervalMs: number
}

type DetailedTask = TaskMetadata & TaskState

interface CreateTaskResult extends TaskMetadata {
  resultType: 'task'
  status: TaskState['status']
  statusMessage: string
}

type JsonRpcMessage = z.infer<typeof jsonRpcMessageSchema>

interface JsonRpcRequest extends JsonRpcMessage {
  id: RequestId
}

interface StoreSubscriber {
  listener: (task: DetailedTask) => void
  taskIds: Set<string>
}

/**
 * Captured Streamable HTTP routing headers for one JSON-RPC request.
 */
export interface TaskHttpRequestObservation {
  /** JSON-RPC method from the request body. */
  method: string
  /** Tool or task name carried by the request body, when present. */
  name?: string
  /** Task identifier carried by the request body, when present. */
  taskId?: string
  /** Raw Mcp-Method request header. */
  mcpMethod?: string
  /** Raw Mcp-Name request header. */
  mcpName?: string
  /** Raw MCP-Protocol-Version request header. */
  protocolVersion?: string
}

/**
 * Information for a running task-enabled HTTP fixture.
 */
export interface TaskHttpServerInfo {
  /** Node HTTP server instance. */
  server: HttpServer
  /** Random loopback port selected by the operating system. */
  port: number
  /** Streamable HTTP endpoint URL. */
  url: string
  /** Requests observed by the HTTP edge, in arrival order. */
  requests: readonly TaskHttpRequestObservation[]
  /** Stops timers, subscriptions, MCP handlers, and the HTTP server. */
  close: () => Promise<void>
}

class InProcessTaskStore {
  private readonly _tasks = new Map<string, DetailedTask>()
  private readonly _timers = new Set<ReturnType<typeof setTimeout>>()
  private readonly _subscribers = new Set<StoreSubscriber>()

  createInstant(value: string): DetailedTask {
    return this._newTask({
      status: 'completed',
      statusMessage: 'Task completed',
      result: textResult(value),
    })
  }

  createLongRunning(duration: number, message: string): DetailedTask {
    const task = this._newTask({ status: 'working', statusMessage: 'Step 1: Initializing' })
    const progressDelay = Math.max(1, Math.floor(duration / 2))

    this._schedule(task.taskId, progressDelay, (current) => {
      if (current.status !== 'working') return current
      return transitionTask(current, { status: 'working', statusMessage: 'Step 2: Processing' })
    })
    this._schedule(task.taskId, duration, (current) => {
      if (current.status !== 'working') return current
      return transitionTask(current, {
        status: 'completed',
        statusMessage: 'Task completed',
        result: textResult(message),
      })
    })
    return task
  }

  createFailing(errorMessage: string): DetailedTask {
    const task = this._newTask({ status: 'working', statusMessage: 'Task is about to fail' })
    this._schedule(task.taskId, 30, (current) => {
      if (current.status !== 'working') return current
      return transitionTask(current, {
        status: 'failed',
        statusMessage: errorMessage,
        error: {
          code: -32603,
          message: errorMessage,
        },
      })
    })
    return task
  }

  createInputRequired(prompt: string): DetailedTask {
    return this._newTask({
      status: 'input_required',
      statusMessage: 'User input is required',
      inputRequests: {
        [ELICITATION_REQUEST_KEY]: inputRequired.elicit({
          mode: 'form',
          message: prompt,
          requestedSchema: {
            type: 'object',
            properties: {
              value: {
                type: 'string',
                description: 'Value returned to the task',
              },
            },
            required: ['value'],
          },
        }),
      },
    })
  }

  createCancellable(message: string): DetailedTask {
    return this._newTask({ status: 'working', statusMessage: message })
  }

  createCancelled(reason: string): DetailedTask {
    return this._newTask({ status: 'cancelled', statusMessage: reason })
  }

  get(taskId: string): DetailedTask | undefined {
    return this._tasks.get(taskId)
  }

  update(taskId: string, responses: Record<string, unknown>): boolean {
    const task = this._tasks.get(taskId)
    if (!task) return false
    if (task.status !== 'input_required') return true

    const response = inputResponse(responses, ELICITATION_REQUEST_KEY)
    if (response.kind !== 'elicit') return true

    if (response.action !== 'accept') {
      const statusMessage = response.action === 'decline' ? 'Input was declined' : 'Input was cancelled'
      this._replace(transitionTask(task, { status: 'cancelled', statusMessage }))
      return true
    }

    const value = response.content?.value
    if (typeof value !== 'string') return true

    this._replace(transitionTask(task, { status: 'working', statusMessage: 'Input accepted' }))
    this._schedule(taskId, 10, (current) => {
      if (current.status !== 'working') return current
      return transitionTask(current, {
        status: 'completed',
        statusMessage: 'Task completed',
        result: textResult(`Input received: ${value}`),
      })
    })
    return true
  }

  cancel(taskId: string): boolean {
    const task = this._tasks.get(taskId)
    if (!task) return false
    if (task.status === 'working' || task.status === 'input_required') {
      this._replace(transitionTask(task, { status: 'cancelled', statusMessage: 'Task cancelled by client' }))
    }
    return true
  }

  subscribe(taskIds: string[], listener: (task: DetailedTask) => void): () => void {
    const subscriber: StoreSubscriber = {
      listener,
      taskIds: new Set(taskIds),
    }
    this._subscribers.add(subscriber)
    return (): void => {
      this._subscribers.delete(subscriber)
    }
  }

  cleanup(): void {
    for (const timer of this._timers) clearTimeout(timer)
    this._timers.clear()
    this._subscribers.clear()
    this._tasks.clear()
  }

  private _newTask({ statusMessage, ...state }: TaskState): DetailedTask {
    const now = new Date().toISOString()
    const task = {
      taskId: randomUUID(),
      statusMessage,
      createdAt: now,
      lastUpdatedAt: now,
      ttlMs: 60_000,
      pollIntervalMs: 10,
      ...state,
    }
    this._replace(task)
    return task
  }

  private _schedule(taskId: string, delay: number, transition: (current: DetailedTask) => DetailedTask): void {
    const timer = setTimeout(() => {
      this._timers.delete(timer)
      const current = this._tasks.get(taskId)
      if (!current) return
      const next = transition(current)
      if (next !== current) this._replace(next)
    }, delay)
    timer.unref()
    this._timers.add(timer)
  }

  private _replace(task: DetailedTask): void {
    this._tasks.set(task.taskId, task)
    for (const subscriber of this._subscribers) {
      if (subscriber.taskIds.has(task.taskId)) subscriber.listener(task)
    }
  }
}

/**
 * Starts a stable-v2 MCP server plus the fixture-local SEP-2663 extension routes.
 */
export async function startTaskHTTPServer(): Promise<TaskHttpServerInfo> {
  const taskStore = new InProcessTaskStore()
  const requests: TaskHttpRequestObservation[] = []
  const subscriptions = new Set<() => void>()

  const protocolHandler = createMcpHandler(createTaskTestServer, {
    legacy: 'reject',
  })
  const protocolNodeHandler = toNodeHandler(protocolHandler)

  const httpServer = createServer((request, response) => {
    void handleHttpRequest(request, response, taskStore, requests, subscriptions, protocolNodeHandler).catch(
      (error: unknown) => {
        writeUnexpectedError(response, error)
      }
    )
  })

  await once(httpServer.listen(0, '127.0.0.1'), 'listening')
  const address = httpServer.address() as AddressInfo

  return {
    server: httpServer,
    port: address.port,
    url: `http://127.0.0.1:${address.port}/mcp`,
    requests,
    close: async (): Promise<void> => {
      for (const close of subscriptions) close()
      taskStore.cleanup()
      await protocolHandler.close()
      await promisify(httpServer.close.bind(httpServer))()
    },
  }
}

function createTaskTestServer(): McpServer {
  const server = new McpServer(SERVER_INFO, {
    capabilities: {
      extensions: {
        [TASK_EXTENSION_ID]: {},
      },
    },
  })

  server.registerTool(
    'direct_result',
    {
      title: 'Direct Result',
      description: 'Returns a direct CallToolResult without creating a task',
      inputSchema: valueInputSchema,
    },
    ({ value }): CallToolResult => textResult(value ?? 'direct result')
  )

  for (const [name, { title, description, inputSchema }] of Object.entries(taskTools)) {
    // Task calls are intercepted before the SDK, which cannot encode SEP-2663 task results.
    server.registerTool(name, { title, description, inputSchema }, (): never => {
      throw new Error('Task calls must be handled by the HTTP task route')
    })
  }

  return server
}

async function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  taskStore: InProcessTaskStore,
  observations: TaskHttpRequestObservation[],
  subscriptions: Set<() => void>,
  protocolHandler: ReturnType<typeof toNodeHandler>
): Promise<void> {
  const protocolRequest = request as Parameters<typeof protocolHandler>[0]

  if (new URL(request.url ?? '/', 'http://127.0.0.1').pathname !== '/mcp') {
    response.writeHead(404)
    response.end()
    return
  }

  if (request.method !== 'POST') {
    await protocolHandler(protocolRequest, response)
    return
  }

  const bodyText = (await buffer(request)).toString('utf8')
  const body: unknown = bodyText.length > 0 ? JSON.parse(bodyText) : undefined
  const parsedMessage = jsonRpcMessageSchema.safeParse(body)
  if (!parsedMessage.success) {
    writeJsonRpcError(response, null, -32700, 'Parse error')
    return
  }

  const rpcMessage = parsedMessage.data
  observations.push(observeRequest(request, rpcMessage))

  if (!hasRequestId(rpcMessage)) {
    await protocolHandler(protocolRequest, response, body)
    return
  }

  const toolName = rpcMessage.params?.name
  if (rpcMessage.method === 'tools/call' && isTaskToolName(toolName)) {
    handleTaskToolCall(response, rpcMessage, taskStore, toolName)
    return
  }

  if (rpcMessage.method === 'tasks/get') {
    handleGetTask(response, rpcMessage, taskStore)
    return
  }

  if (rpcMessage.method === 'tasks/update') {
    handleUpdateTask(response, rpcMessage, taskStore)
    return
  }

  if (rpcMessage.method === 'tasks/cancel') {
    handleCancelTask(response, rpcMessage, taskStore)
    return
  }

  if (rpcMessage.method === 'subscriptions/listen') {
    const params = taskSubscriptionParamsSchema.safeParse(rpcMessage.params)
    if (params.success) {
      handleTaskSubscription(response, rpcMessage, taskStore, subscriptions, params.data.notifications.taskIds)
      return
    }
  }

  await protocolHandler(protocolRequest, response, body)
}

function handleTaskToolCall(
  response: ServerResponse,
  request: JsonRpcRequest,
  taskStore: InProcessTaskStore,
  name: TaskToolName
): void {
  if (!hasTaskCapability(request.params?._meta)) {
    writeMissingTaskCapability(response, request.id)
    return
  }

  const argumentsValue = request.params?.arguments ?? {}

  try {
    const task = createTaskForTool(taskStore, name, argumentsValue)
    writeJsonRpcResult(response, request.id, toCreateTaskResult(task))
  } catch (error) {
    if (error instanceof z.ZodError) {
      writeJsonRpcError(response, request.id, -32602, 'Invalid tool arguments', error.issues)
      return
    }
    throw error
  }
}

function handleGetTask(response: ServerResponse, request: JsonRpcRequest, taskStore: InProcessTaskStore): void {
  if (!hasTaskCapability(request.params?._meta)) {
    writeMissingTaskCapability(response, request.id)
    return
  }

  const params = taskOperationParamsSchema.safeParse(request.params)
  if (!params.success) {
    writeJsonRpcError(response, request.id, -32602, 'Invalid tasks/get parameters')
    return
  }

  const task = taskStore.get(params.data.taskId)
  if (!task) {
    writeJsonRpcError(response, request.id, -32602, 'Failed to retrieve task: Task not found')
    return
  }

  writeJsonRpcResult(response, request.id, { resultType: 'complete', ...task })
}

function handleUpdateTask(response: ServerResponse, request: JsonRpcRequest, taskStore: InProcessTaskStore): void {
  if (!hasTaskCapability(request.params?._meta)) {
    writeMissingTaskCapability(response, request.id)
    return
  }

  const params = updateTaskParamsSchema.safeParse(request.params)
  if (!params.success) {
    writeJsonRpcError(response, request.id, -32602, 'Invalid tasks/update parameters')
    return
  }

  if (!taskStore.update(params.data.taskId, params.data.inputResponses)) {
    writeJsonRpcError(response, request.id, -32602, 'Failed to update task: Task not found')
    return
  }

  writeJsonRpcResult(response, request.id, { resultType: 'complete' })
}

function handleCancelTask(response: ServerResponse, request: JsonRpcRequest, taskStore: InProcessTaskStore): void {
  if (!hasTaskCapability(request.params?._meta)) {
    writeMissingTaskCapability(response, request.id)
    return
  }

  const params = taskOperationParamsSchema.safeParse(request.params)
  if (!params.success) {
    writeJsonRpcError(response, request.id, -32602, 'Invalid tasks/cancel parameters')
    return
  }

  if (!taskStore.cancel(params.data.taskId)) {
    writeJsonRpcError(response, request.id, -32602, 'Failed to cancel task: Task not found')
    return
  }

  writeJsonRpcResult(response, request.id, { resultType: 'complete' })
}

function handleTaskSubscription(
  response: ServerResponse,
  request: JsonRpcRequest,
  taskStore: InProcessTaskStore,
  subscriptions: Set<() => void>,
  requestedTaskIds: string[]
): void {
  if (!hasTaskCapability(request.params?._meta)) {
    writeMissingTaskCapability(response, request.id)
    return
  }

  const taskIds = requestedTaskIds.filter((taskId) => taskStore.get(taskId) !== undefined)
  response.writeHead(200, {
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Content-Type': 'text/event-stream',
  })
  response.flushHeaders()

  const subscriptionMeta = {
    [SUBSCRIPTION_ID_META_KEY]: request.id,
  }
  writeSseMessage(response, {
    jsonrpc: '2.0',
    method: 'notifications/subscriptions/acknowledged',
    params: {
      _meta: subscriptionMeta,
      notifications: {
        taskIds,
      },
    },
  })

  const notify = (task: DetailedTask): void => {
    writeSseMessage(response, {
      jsonrpc: '2.0',
      method: 'notifications/tasks',
      params: {
        ...task,
        _meta: subscriptionMeta,
      },
    })
  }
  const unsubscribe = taskStore.subscribe(taskIds, notify)

  for (const taskId of taskIds) {
    const task = taskStore.get(taskId)
    if (task) notify(task)
  }

  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    unsubscribe()
    subscriptions.delete(close)
    writeSseMessage(response, {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        resultType: 'complete',
        _meta: subscriptionMeta,
      },
    })
    response.end()
  }
  subscriptions.add(close)
  response.on('close', close)
}

function createTaskForTool(taskStore: InProcessTaskStore, name: TaskToolName, argumentsValue: unknown): DetailedTask {
  switch (name) {
    case 'instant_task': {
      const { value } = taskTools.instant_task.inputSchema.parse(argumentsValue)
      return taskStore.createInstant(value ?? 'instant result')
    }
    case 'long_running_task': {
      const { duration, message } = taskTools.long_running_task.inputSchema.parse(argumentsValue)
      return taskStore.createLongRunning(duration ?? 200, message ?? 'Task completed!')
    }
    case 'failing_task': {
      const { error_message } = taskTools.failing_task.inputSchema.parse(argumentsValue)
      return taskStore.createFailing(error_message ?? 'Task intentionally failed')
    }
    case 'input_required_task': {
      const { prompt } = taskTools.input_required_task.inputSchema.parse(argumentsValue)
      return taskStore.createInputRequired(prompt ?? 'Provide a value for this task')
    }
    case 'cancellable_task': {
      const { message } = taskTools.cancellable_task.inputSchema.parse(argumentsValue)
      return taskStore.createCancellable(message ?? 'Waiting for cancellation')
    }
    case 'cancelled_task': {
      const { reason } = taskTools.cancelled_task.inputSchema.parse(argumentsValue)
      return taskStore.createCancelled(reason ?? 'Task was cancelled')
    }
  }
}

function transitionTask(
  task: DetailedTask,
  { statusMessage, ...state }: Exclude<TaskState, { status: 'input_required' }>
): DetailedTask {
  return {
    taskId: task.taskId,
    statusMessage,
    createdAt: task.createdAt,
    lastUpdatedAt: new Date().toISOString(),
    ttlMs: task.ttlMs,
    pollIntervalMs: task.pollIntervalMs,
    ...state,
  }
}

function toCreateTaskResult(task: DetailedTask): CreateTaskResult {
  return {
    resultType: 'task',
    taskId: task.taskId,
    status: task.status,
    statusMessage: task.statusMessage,
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
    ttlMs: task.ttlMs,
    pollIntervalMs: task.pollIntervalMs,
  }
}

function textResult(text: string): CallToolResult {
  return {
    content: [{ type: 'text', text }],
  }
}

function hasRequestId(message: JsonRpcMessage): message is JsonRpcRequest {
  return message.id !== undefined
}

function isTaskToolName(value: unknown): value is TaskToolName {
  return typeof value === 'string' && Object.hasOwn(taskTools, value)
}

function hasTaskCapability(metaValue: unknown): boolean {
  if (!isRecord(metaValue)) return false
  const capabilities = metaValue[CLIENT_CAPABILITIES_META_KEY]
  if (!isRecord(capabilities)) return false
  const extensions = capabilities.extensions
  if (!isRecord(extensions)) return false
  return isRecord(extensions[TASK_EXTENSION_ID])
}

function observeRequest(request: IncomingMessage, rpcMessage: JsonRpcMessage): TaskHttpRequestObservation {
  const params = rpcMessage.params
  const name = typeof params?.name === 'string' ? params.name : undefined
  const taskId = typeof params?.taskId === 'string' ? params.taskId : undefined
  const mcpMethod = readHeader(request, 'mcp-method')
  const mcpName = readHeader(request, 'mcp-name')
  const protocolVersion = readHeader(request, 'mcp-protocol-version')

  return {
    method: rpcMessage.method,
    ...(name !== undefined && { name }),
    ...(taskId !== undefined && { taskId }),
    ...(mcpMethod !== undefined && { mcpMethod }),
    ...(mcpName !== undefined && { mcpName }),
    ...(protocolVersion !== undefined && { protocolVersion }),
  }
}

function readHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

function writeJsonRpcResult(response: ServerResponse, id: RequestId, result: object): void {
  writeJson(response, {
    jsonrpc: '2.0',
    id,
    result: {
      ...result,
      _meta: {
        [SERVER_INFO_META_KEY]: SERVER_INFO,
      },
    },
  })
}

function writeJsonRpcError(
  response: ServerResponse,
  id: RequestId | null,
  code: number,
  message: string,
  data?: unknown
): void {
  writeJson(response, {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      ...(data !== undefined && { data }),
    },
  })
}

function writeMissingTaskCapability(response: ServerResponse, id: RequestId): void {
  writeJsonRpcError(response, id, -32021, 'Missing required client capability', {
    requiredCapabilities: {
      extensions: {
        [TASK_EXTENSION_ID]: {},
      },
    },
  })
}

function writeJson(response: ServerResponse, body: unknown): void {
  response.writeHead(200, {
    'Content-Type': 'application/json',
  })
  response.end(JSON.stringify(body))
}

function writeSseMessage(response: ServerResponse, message: unknown): void {
  if (response.destroyed || response.writableEnded) return
  response.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`)
}

function writeUnexpectedError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.end()
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  writeJsonRpcError(response, null, -32603, 'Internal server error', { message })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
