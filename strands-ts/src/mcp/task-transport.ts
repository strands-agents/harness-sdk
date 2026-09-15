import { ProtocolError, SdkError, SdkErrorCode } from '@modelcontextprotocol/client'

import type {
  FetchLike,
  JSONRPCErrorResponse,
  JSONRPCMessage,
  JSONRPCRequest,
  JSONRPCResponse,
  MessageExtraInfo,
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/client'

import type { JSONSchema } from '../types/json.js'

const TASK_REQUEST_ID_PREFIX = 'strands-task:'
const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks'
const TASK_METHODS = new Set(['tasks/get', 'tasks/update', 'tasks/cancel'])
const MCP_PARAM_HEADER_PREFIX = 'Mcp-Param-'
const X_MCP_HEADER_KEY = 'x-mcp-header'
const RFC9110_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const PERMITTED_X_MCP_HEADER_TYPES = new Set(['string', 'integer', 'boolean', 'number'])
const NON_REACHABLE_SUBSCHEMA_KEYWORDS = [
  'items',
  'prefixItems',
  'contains',
  'additionalProperties',
  'unevaluatedProperties',
  'unevaluatedItems',
  'propertyNames',
  'patternProperties',
  'dependentSchemas',
  'oneOf',
  'anyOf',
  'allOf',
  'not',
  'if',
  'then',
  'else',
  '$defs',
  'definitions',
] as const
const OBJECT_VALUED_SUBSCHEMA_KEYWORDS = new Set(['patternProperties', 'dependentSchemas', '$defs', 'definitions'])

interface McpParamHeaderDeclaration {
  headerName: string
  path: string[]
}

interface PendingRequest {
  progress?: () => void
  cleanup: () => void
  reject: (error: unknown) => void
  resolve: (result: unknown) => void
}

interface TaskRequestOptions {
  headers?: Readonly<Record<string, string>>
  signal?: AbortSignal
  timeoutMs: number
  maxTotalTimeoutMs?: number
  resetTimeoutOnProgress?: boolean
}

/**
 * Bridges the SEP-2663 extension around stable MCP v2's protocol-era registry.
 *
 * @internal
 */
export class TaskTransport implements Transport {
  private readonly _inner: Transport
  private readonly _getMetadata: () => Record<string, unknown> | undefined
  private readonly _pendingRequests = new Map<string, PendingRequest>()
  private _nextId = 0
  public onTaskNotification: ((params: unknown) => void) | undefined
  public onclose: (() => void) | undefined
  public onerror: ((error: Error) => void) | undefined
  public onmessage: (<Message extends JSONRPCMessage>(message: Message, extra?: MessageExtraInfo) => void) | undefined

  public constructor(inner: Transport, getMetadata: () => Record<string, unknown> | undefined) {
    this._inner = inner
    this._getMetadata = getMetadata
    exposeDisposableStdioProbeShape(this, inner)
  }

  public get sessionId(): string | undefined {
    return this._inner.sessionId
  }

  public get hasPerRequestStream(): boolean {
    return this._inner.hasPerRequestStream ?? false
  }

  public async start(): Promise<void> {
    this._inner.onclose = (): void => {
      const error = new SdkError(SdkErrorCode.ConnectionClosed, 'MCP transport closed')
      for (const pending of this._pendingRequests.values()) {
        pending.cleanup()
        pending.reject(error)
      }
      this._pendingRequests.clear()
      this.onclose?.()
    }
    this._inner.onerror = (error): void => {
      this.onerror?.(error)
    }
    this._inner.onmessage = (message, extra): void => {
      this._routeMessage(message, extra)
    }
    await this._inner.start()
  }

  public async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    await this._inner.send(withoutLegacyTaskCapability(message), options)
  }

  public async close(): Promise<void> {
    await this._inner.close()
  }

  /**
   * Reaps a disposable stdio probe when MCP v2 reflects this method during era negotiation.
   *
   * @internal
   */
  public async _dispose(): Promise<void> {
    const dispose = Reflect.get(this._inner, '_dispose')
    if (typeof dispose === 'function') {
      await dispose.call(this._inner)
      return
    }
    await this._inner.close()
  }

  public setProtocolVersion(version: string): void {
    this._inner.setProtocolVersion?.(version)
  }

  public setSupportedProtocolVersions(versions: string[]): void {
    this._inner.setSupportedProtocolVersions?.(versions)
  }

  public request(
    method: 'tools/call' | 'tasks/get' | 'tasks/update' | 'tasks/cancel',
    params: Record<string, unknown>,
    options: TaskRequestOptions
  ): Promise<unknown> {
    const id = `${TASK_REQUEST_ID_PREFIX}${this._nextId++}`
    const metadata = this._getMetadata()
    const request: JSONRPCRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params: {
        ...params,
        _meta: {
          ...(isRecord(params._meta) ? params._meta : undefined),
          ...metadata,
          ...(options.resetTimeoutOnProgress && { progressToken: id }),
        },
      },
    }

    return new Promise((resolve, reject) => {
      const requestController = this.hasPerRequestStream ? new AbortController() : undefined
      const cancel = (reason: Error): void => {
        if (requestController) {
          requestController.abort(reason)
        } else {
          this._sendCancellation(id, reason, metadata)
        }
        reject(reason)
      }
      const abort = (): void => {
        const pending = this._pendingRequests.get(id)
        if (!pending) return
        this._pendingRequests.delete(id)
        pending.cleanup()
        cancel(abortReason(options.signal))
      }
      const cleanup = (): void => {
        clearTimeout(timeout)
        clearTimeout(totalTimeout)
        options.signal?.removeEventListener('abort', abort)
      }

      if (options.signal?.aborted) {
        reject(abortReason(options.signal))
        return
      }

      const expire = (): void => {
        const pending = this._pendingRequests.get(id)
        if (!pending) return
        this._pendingRequests.delete(id)
        pending.cleanup()
        cancel(
          new SdkError(SdkErrorCode.RequestTimeout, `MCP ${method} request timed out`, {
            method,
            timeoutMs: options.timeoutMs,
          })
        )
      }
      let timeout = setTimeout(expire, options.timeoutMs)
      const totalTimeout =
        options.maxTotalTimeoutMs === undefined ? undefined : setTimeout(expire, options.maxTotalTimeoutMs)
      const progress = options.resetTimeoutOnProgress
        ? (): void => {
            clearTimeout(timeout)
            timeout = setTimeout(expire, options.timeoutMs)
          }
        : undefined
      options.signal?.addEventListener('abort', abort, { once: true })

      this._pendingRequests.set(id, { cleanup, reject, resolve, ...(progress && { progress }) })

      const headers = { ...options.headers }
      const taskId = params.taskId
      if (method !== 'tools/call' && typeof taskId === 'string') {
        headers['Mcp-Method'] = method
        headers['Mcp-Name'] = encodeMcpHeaderValue(taskId)
      }

      void this._inner
        .send(request, {
          ...(Object.keys(headers).length > 0 && { headers }),
          ...(requestController && { requestSignal: requestController.signal }),
        })
        .catch((error: unknown) => {
          const pending = this._pendingRequests.get(id)
          if (!pending) return
          this._pendingRequests.delete(id)
          pending.cleanup()
          pending.reject(error)
        })
    })
  }

  private _sendCancellation(requestId: string, reason: Error, metadata: Record<string, unknown> | undefined): void {
    void this._inner
      .send({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: {
          requestId,
          reason: String(reason),
          _meta: {
            ...metadata,
          },
        },
      })
      .catch((error: unknown) => {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)))
      })
  }

  private _routeMessage(message: JSONRPCMessage, extra?: MessageExtraInfo): void {
    if ('method' in message && message.method === 'notifications/progress' && isRecord(message.params)) {
      const token = message.params.progressToken
      if (
        typeof token === 'string' &&
        typeof message.params.progress === 'number' &&
        Number.isFinite(message.params.progress)
      ) {
        const pending = this._pendingRequests.get(token)
        if (pending?.progress) {
          pending.progress()
          return
        }
      }
    }

    if (isTaskNotification(message)) {
      this.onTaskNotification?.(message.params)
      return
    }

    if (isJsonRpcResponse(message) && typeof message.id === 'string' && message.id.startsWith(TASK_REQUEST_ID_PREFIX)) {
      const pending = this._pendingRequests.get(message.id)
      if (!pending) return

      this._pendingRequests.delete(message.id)
      pending.cleanup()
      if ('error' in message) {
        pending.reject(ProtocolError.fromError(message.error.code, message.error.message, message.error.data))
      } else {
        pending.resolve(message.result)
      }
      return
    }

    this.onmessage?.(message, extra)
  }
}

/** Builds Mcp-Param headers from x-mcp-header schema declarations. @internal */
export function buildMcpParamHeaders(
  inputSchema: JSONSchema | undefined,
  args: Record<string, unknown>
): Record<string, string> {
  if (inputSchema === undefined) return {}
  const declarations = scanMcpParamHeaderDeclarations(inputSchema)
  if (!declarations) return {}

  const headers: Record<string, string> = {}
  for (const declaration of declarations) {
    const stringValue = mcpParamPrimitiveToString(valueAtPath(args, declaration.path))
    if (stringValue === undefined) continue
    headers[`${MCP_PARAM_HEADER_PREFIX}${declaration.headerName}`] = encodeMcpHeaderValue(stringValue)
  }
  return headers
}

/**
 * Adds the SEP-2663 task routing name after the official transport has applied auth and standard headers.
 *
 * @internal
 */
export function createTaskRoutingFetch(fetchImplementation?: FetchLike): FetchLike {
  return async (input, init): Promise<Response> => {
    const taskId = readTaskId(init?.body)
    if (taskId === undefined) {
      return await (fetchImplementation ?? globalThis.fetch)(input, init)
    }

    const headers = new Headers(init?.headers)
    headers.set('Mcp-Name', encodeMcpHeaderValue(taskId))
    return await (fetchImplementation ?? globalThis.fetch)(input, { ...init, headers })
  }
}

function scanMcpParamHeaderDeclarations(inputSchema: JSONSchema): McpParamHeaderDeclaration[] | undefined {
  const declarations: McpParamHeaderDeclaration[] = []
  const seenHeaders = new Set<string>()

  const visit = (node: unknown, path: string[], reachable: boolean): boolean => {
    if (!isRecord(node)) return true

    if (X_MCP_HEADER_KEY in node) {
      const headerName = node[X_MCP_HEADER_KEY]
      const type = node.type
      if (
        !reachable ||
        path.length === 0 ||
        typeof headerName !== 'string' ||
        !RFC9110_TOKEN.test(headerName) ||
        typeof type !== 'string' ||
        !PERMITTED_X_MCP_HEADER_TYPES.has(type) ||
        seenHeaders.has(headerName.toLowerCase())
      ) {
        return false
      }
      seenHeaders.add(headerName.toLowerCase())
      declarations.push({ headerName, path })
    }

    if (isRecord(node.properties)) {
      for (const [key, child] of Object.entries(node.properties)) {
        if (!visit(child, [...path, key], reachable)) return false
      }
    }

    for (const keyword of NON_REACHABLE_SUBSCHEMA_KEYWORDS) {
      const subschema = node[keyword]
      if (subschema === undefined) continue
      const branches = Array.isArray(subschema)
        ? subschema
        : isRecord(subschema) && OBJECT_VALUED_SUBSCHEMA_KEYWORDS.has(keyword)
          ? Object.values(subschema)
          : [subschema]
      for (const branch of branches) {
        if (!visit(branch, path, false)) return false
      }
    }
    return true
  }

  return visit(inputSchema, [], true) ? declarations : undefined
}

function valueAtPath(root: Record<string, unknown>, path: string[]): unknown {
  let value: unknown = root
  for (const key of path) {
    if (!isRecord(value)) return undefined
    value = value[key]
  }
  return value
}

function mcpParamPrimitiveToString(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) return undefined
  return String(value)
}

function readTaskId(body: BodyInit | null | undefined): string | undefined {
  if (typeof body !== 'string') return undefined

  try {
    const message: unknown = JSON.parse(body)
    if (!isRecord(message) || typeof message.method !== 'string' || !TASK_METHODS.has(message.method)) {
      return undefined
    }
    const params = message.params
    if (!isRecord(params) || typeof params.taskId !== 'string') return undefined
    return params.taskId
  } catch {
    return undefined
  }
}

function abortReason(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) return signal.reason
  return new DOMException('The operation was aborted', 'AbortError')
}

function withoutLegacyTaskCapability(message: JSONRPCMessage): JSONRPCMessage {
  if (!isJsonRpcRequest(message) || message.method !== 'initialize' || !isRecord(message.params)) return message

  const capabilities = message.params.capabilities
  if (!isRecord(capabilities) || !isRecord(capabilities.extensions)) return message
  if (!(TASKS_EXTENSION in capabilities.extensions)) return message

  const extensions = { ...capabilities.extensions }
  delete extensions[TASKS_EXTENSION]
  const nextCapabilities = { ...capabilities }
  if (Object.keys(extensions).length === 0) {
    delete nextCapabilities.extensions
  } else {
    nextCapabilities.extensions = extensions
  }

  return {
    ...message,
    params: {
      ...message.params,
      capabilities: nextCapabilities,
    },
  } as JSONRPCMessage
}

function exposeDisposableStdioProbeShape(wrapper: TaskTransport, inner: Transport): void {
  if (!isDisposableSdkStdioTransport(inner)) return

  Object.defineProperties(wrapper, {
    constructor: {
      configurable: true,
      value: inner.constructor,
    },
    stderr: {
      configurable: true,
      get: () => Reflect.get(inner, 'stderr'),
    },
    pid: {
      configurable: true,
      get: () => Reflect.get(inner, 'pid'),
    },
    _serverParams: {
      configurable: true,
      value: Reflect.get(inner, '_serverParams'),
    },
  })
}

function isDisposableSdkStdioTransport(transport: Transport): boolean {
  if (!('stderr' in transport) || !('pid' in transport)) return false

  const prototype = Object.getPrototypeOf(transport)
  const serverParams = Reflect.get(transport, '_serverParams')
  return (
    prototype !== null &&
    Object.hasOwn(prototype, '_dispose') &&
    isRecord(serverParams) &&
    typeof serverParams.command === 'string'
  )
}

function encodeMcpHeaderValue(value: string): string {
  if (
    value === value.trim() &&
    !(value.startsWith('=?base64?') && value.endsWith('?=')) &&
    /^[\t\x20-\x7e]+$/.test(value)
  )
    return value

  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCodePoint(byte)
  return `=?base64?${globalThis.btoa(binary)}?=`
}

function isJsonRpcRequest(message: JSONRPCMessage): message is JSONRPCRequest {
  return 'method' in message && 'id' in message
}

function isJsonRpcResponse(message: JSONRPCMessage): message is JSONRPCResponse | JSONRPCErrorResponse {
  return 'id' in message && ('result' in message || 'error' in message)
}

function isTaskNotification(message: JSONRPCMessage): message is JSONRPCMessage & { params: unknown } {
  return 'method' in message && !('id' in message) && message.method === 'notifications/tasks' && 'params' in message
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
