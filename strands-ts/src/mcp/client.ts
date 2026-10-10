import {
  Client,
  ClientCredentialsProvider,
  fromJsonSchema,
  ProtocolError,
  ProtocolErrorCode,
  SdkError,
  SdkErrorCode,
  StreamableHTTPClientTransport,
  specTypeSchemas,
} from '@modelcontextprotocol/client'
import { context, propagation, trace } from '@opentelemetry/api'

import type { JSONSchema, JSONValue } from '../types/json.js'
import type { ElicitationCallback, ElicitationContext } from '../types/elicitation.js'
import type { ApplicationElicitResult, TaskEnabledSession, TaskOutcome } from '@modelcontextprotocol/ext-tasks/client'
import type { JsonValue } from '@modelcontextprotocol/ext-tasks/core'
import type {
  McpSubmitToolResult,
  McpCancelTaskResult,
  McpGetTaskResult,
  McpInputResponses,
  McpUpdateTaskResult,
} from './task-types.js'
import { McpTool } from '../tools/mcp-tool.js'
import { MAX_TOOL_NAME_LENGTH } from '../registry/tool-registry.js'
import { ToolValidationError } from '../errors.js'
import {
  createApplicationInputHandler,
  createTaskSessionFromClient,
  resultFromTaskOutcome,
  toolDeclaration,
} from '@modelcontextprotocol/ext-tasks/client'
import {
  CallToolResultV2Schema,
  CancelTaskResultV2Schema,
  CreateTaskResultV2Schema,
  ElicitResultV2Schema,
  GetTaskResultV2Schema,
  isCreateTaskResultV2,
  InputResponsesV2Schema,
  UpdateTaskResultV2Schema,
} from '@modelcontextprotocol/ext-tasks/core/v2'

import { logger } from '../logging/index.js'
import { type McpLoadServersOptions, type McpServerConfig, mcpServerLoader } from './config.js'
import { buildMcpParamHeaders, createTaskRoutingFetch, TaskTransport } from './task-transport.js'

import type {
  CallToolRequestOptions,
  CallToolResult,
  CallToolRequest,
  Implementation,
  JsonSchemaType,
  LoggingMessageNotificationParams,
  OAuthClientProvider,
  ServerCapabilities,
  Tool as McpSdkTool,
  Transport,
} from '@modelcontextprotocol/client'

/**
 * Widened transport type that accepts MCP transport implementations without requiring explicit casts.
 *
 * The `sessionId` member is widened to `string | undefined` so that, under
 * `exactOptionalPropertyTypes`, transport instances whose `sessionId` getter returns
 * `string | undefined` — including transports constructed from the legacy
 * `@modelcontextprotocol/sdk` package — are assignable without `as Transport`. The MCP `Transport`
 * contract's required members (`start`, `send`, `close`) are unchanged between the legacy package
 * and `@modelcontextprotocol/client`, so legacy instances keep working.
 */
export type McpTransport = Omit<Transport, 'sessionId'> & { sessionId?: string | undefined }

/** Temporary placeholder for RuntimeConfig */
export interface RuntimeConfig {
  applicationName?: string
  applicationVersion?: string
}

/** Connection state of an MCP client. */
export type McpConnectionState = 'disconnected' | 'connected' | 'failed'

/** OAuth client credentials for machine-to-machine authentication. */
export interface McpClientCredentials {
  clientId: string
  clientSecret: string
  /** OAuth scopes to request. Joined with spaces before sending to the token endpoint. */
  scopes?: string[]
}

/** Decides whether a tool matches a filter. Receives the tool under its agent-facing name. */
export type McpToolFilterCallback = (tool: McpTool) => boolean

/**
 * Matches a tool for filtering. A string matches the server-side tool name exactly; a `RegExp`
 * matches it from the start (as Python's `Pattern.match` does); a callback receives the tool.
 */
export type McpToolMatcher = string | RegExp | McpToolFilterCallback

/** Filters controlling which MCP tools a client exposes. */
export interface McpToolFilters {
  /** When present, only tools matching at least one matcher are exposed. */
  allowed?: McpToolMatcher[]
  /** Tools matching at least one matcher are excluded, even when also allowed. */
  rejected?: McpToolMatcher[]
}

/** Per-call overrides for {@link McpClient.listTools}. */
export interface McpListToolsOptions {
  /** Prefix for agent-facing tool names. An empty string disables a prefix set on the client. */
  prefix?: string
  /** Tool filters. An empty object disables filters set on the client. */
  toolFilters?: McpToolFilters
}

const MINIMUM_POLL_INTERVAL_MS = 10
const MAX_TIMER_DELAY_MS = 2_147_483_647
const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks'
const TASKS_PROTOCOL_VERSION = '2026-07-28'

/**
 * Configuration for MCP task execution.
 *
 * MCP Tasks are experimental in both the MCP specification and this SDK. The API may
 * change without notice in future versions.
 *
 * `pollTimeout` bounds the complete automatic operation, including polling and input
 * callbacks. `requestTimeout` limits each individual lifecycle request; progress resets
 * it. The first limit reached ends the wait. A call's `options.timeoutMs` overrides
 * `pollTimeout`.
 *
 * Field names and defaults match the Python SDK's `TasksConfig` (milliseconds instead
 * of timedeltas), except that `ttl` is a deprecated alias of `requestTimeout` and no
 * legacy wire time-to-live is sent.
 */
export interface TasksConfig {
  /** Overall deadline in milliseconds for an automatic task operation. Defaults to 300000. */
  pollTimeout?: number

  /** Timeout in milliseconds for each task lifecycle request; progress resets it. Defaults to 60000. */
  requestTimeout?: number

  /** Polling delay in milliseconds when a legacy (2025-11-25) server omits its interval; SEP-2663 servers supply the cadence. Defaults to 1000. */
  pollInterval?: number

  /**
   * Timeout in milliseconds for each task lifecycle request.
   *
   * @deprecated Use `requestTimeout`, which takes precedence when both are set.
   */
  ttl?: number
}

interface ResolvedTasksConfig {
  pollTimeoutMs: number
  requestTimeoutMs: number
  pollIntervalMs: number
}

interface TaskOperation {
  deadline: number
  dispose: () => void
  signal: AbortSignal
}

interface McpServerToolDefinition {
  execution?: McpSdkTool['execution']
  inputSchema?: JSONSchema
  outputSchema?: JSONSchema
}

interface McpToolCallOutcome {
  result: CallToolResult
}

type CompiledToolOutputSchema = ReturnType<typeof fromJsonSchema>

/** Error thrown when a server reports a task as cancelled. */
export class McpTaskCancelledError extends Error {
  /** Optional server-provided context for the cancellation. */
  public readonly statusMessage: string | undefined

  public constructor(statusMessage?: string) {
    super(statusMessage ? `MCP task was cancelled: ${statusMessage}` : 'MCP task was cancelled')
    this.name = 'McpTaskCancelledError'
    this.statusMessage = statusMessage
  }
}

/** Error thrown when a server reports a task as failed. */
export class McpTaskFailedError extends Error {
  /** Optional server-provided context for the failure. */
  public readonly statusMessage: string | undefined
  /** JSON-RPC error code reported by a failed SEP-2663 task. */
  public readonly code: number | undefined
  /** Sender-defined error details reported by a failed SEP-2663 task. */
  public readonly data: unknown

  public constructor(statusMessage?: string, details?: { code?: number; data?: unknown }) {
    super(statusMessage ? `MCP task failed: ${statusMessage}` : 'MCP task failed')
    this.name = 'McpTaskFailedError'
    this.statusMessage = statusMessage
    this.code = details?.code
    this.data = details?.data
  }
}

/** Options for MCP tool invocation. */
export interface McpCallToolOptions {
  /** AbortSignal to cancel the in-flight request. */
  signal?: AbortSignal
  /** Overall time limit in milliseconds for this call. Overrides `tasksConfig.pollTimeout` when tasks are configured. */
  timeoutMs?: number
}

/** Options for an explicit SEP-2663 lifecycle request. */
export interface McpTaskRequestOptions {
  /** AbortSignal to cancel the lifecycle request. */
  signal?: AbortSignal
  /** Overrides the configured per-request timeout in milliseconds. */
  timeoutMs?: number
}

/** Behavioral options shared by all MCP client configurations. */
export interface McpClientOptions extends RuntimeConfig {
  /** Disable OpenTelemetry MCP instrumentation. */
  disableMcpInstrumentation?: boolean

  /** Prefix for agent-facing tool names, applied as `<prefix>_<toolName>`. */
  prefix?: string

  /** Filters controlling which tools this client exposes. */
  toolFilters?: McpToolFilters

  /** Enables automatic execution for legacy task tools. Experimental: subject to change. */
  tasksConfig?: TasksConfig

  /**
   * Callback to handle server-initiated elicitation requests.
   * When provided, the client advertises elicitation support (form + url modes)
   * and routes incoming elicitation requests to this callback.
   */
  elicitationCallback?: ElicitationCallback

  /** When true, connection failures and overlong prefixed names during tool listing are skipped with warnings. */
  continueOnError?: boolean

  /** Called when the server emits a log message. Defaults to routing through the Strands logger. */
  logHandler?: (params: LoggingMessageNotificationParams) => void
}

/** Arguments for configuring an MCP Client. */
export type McpClientConfig = McpClientOptions & {
  /** Pre-constructed transport. Mutually exclusive with `url`. */
  transport?: McpTransport

  /** Server URL. When provided, a StreamableHTTP transport is constructed automatically. */
  url?: string | URL

  /** Client credentials for OAuth machine-to-machine auth. Requires `url`. */
  auth?: McpClientCredentials

  /** Custom OAuth provider for advanced auth flows. Requires `url`. Mutually exclusive with `auth`. */
  authProvider?: OAuthClientProvider

  /** Custom headers to include on every request to the server. Requires `url`. */
  headers?: Record<string, string>
}

/**
 * MCP client using SDK v2, including legacy task execution.
 *
 * @example
 * ```typescript
 * const client = new McpClient({ url: 'https://example.com/mcp', tasksConfig: {} })
 * const agent = new Agent({ tools: [client] })
 * ```
 */
export class McpClient {
  /**
   * Default task lifecycle request timeout in milliseconds.
   *
   * @deprecated Use {@link McpClient.DEFAULT_REQUEST_TIMEOUT}.
   */
  public static readonly DEFAULT_TTL = 60000

  /** Default overall task operation deadline in milliseconds. */
  public static readonly DEFAULT_POLL_TIMEOUT = 300000

  /** Default task lifecycle request timeout in milliseconds. */
  public static readonly DEFAULT_REQUEST_TIMEOUT = 60000

  /** Default polling interval when a legacy task response omits `pollInterval`. */
  public static readonly DEFAULT_POLL_INTERVAL_MS = 1000

  /**
   * Parses an MCP servers config (file path or object) and returns McpClient instances.
   *
   * @param config - A file path to a JSON config, or a flat server map object.
   * @param defaults - Options applied to all clients unless overridden per-server.
   * @param options - Loader behavior, such as prefixing tools with the server name.
   * @returns An array of McpClient instances ready to be passed to an Agent.
   */
  public static async loadServers(
    config: string | Record<string, McpServerConfig>,
    defaults?: McpClientOptions,
    options?: McpLoadServersOptions
  ): Promise<McpClient[]> {
    const configs = await mcpServerLoader.get()(config, defaults, options)
    const clients: McpClient[] = []
    for (const resolved of configs) {
      try {
        clients.push(new McpClient(resolved))
      } catch (error) {
        if (!resolved.continueOnError) throw error
        logger.warn(
          `server=<${resolved.applicationName}>, error=<${error}> | MCP client config failed, skipping (continueOnError)`
        )
      }
    }
    return clients
  }

  private _clientName: string
  private _clientVersion: string
  private _transport: McpTransport
  private _taskTransport: TaskTransport | undefined
  private _taskSession: TaskEnabledSession | undefined
  /** Caller-supplied Streamable HTTP transports cannot carry the Mcp-Name task routing headers. */
  private _taskRoutingUnavailable = false
  private _taskRoutingWarned = false
  private _state: McpConnectionState
  private _client: TaskClient
  private _continueOnError: boolean
  private _logHandler: (params: LoggingMessageNotificationParams) => void
  private _disableMcpInstrumentation: boolean
  private _tasksConfig: ResolvedTasksConfig | undefined
  private _elicitationCallback: ElicitationCallback | undefined
  private _prefix: string | undefined
  private _toolFilters: McpToolFilters | undefined
  /** Server-side name of each listed tool, which differs from `tool.name` when a prefix is set. */
  private _serverToolNames = new WeakMap<McpTool, string>()
  private _serverToolDefinitions = new Map<string, McpServerToolDefinition>()
  private _registeredToolNames = new Set<string>()
  private _onToolsChanged: ((oldTools: string[], newTools: McpTool[]) => void) | undefined
  private _refreshingTools = false
  private _pendingRefresh = false
  private _connectionPromise: Promise<void> | undefined
  private _connectionGeneration = 0
  private readonly _taskControllers = new Set<AbortController>()

  constructor(args: McpClientConfig) {
    this._clientName = args.applicationName || 'strands-agents-ts-sdk'
    this._clientVersion = args.applicationVersion || '0.0.1'
    this._state = 'disconnected'
    this._continueOnError = args.continueOnError ?? false
    this._logHandler = args.logHandler ?? defaultLogHandler
    this._tasksConfig = resolveTasksConfig(args.tasksConfig)
    this._elicitationCallback = args.elicitationCallback
    this._prefix = args.prefix
    this._toolFilters = args.toolFilters
    const capabilities = {
      ...(this._elicitationCallback ? { elicitation: { form: {}, url: {} } } : undefined),
      ...(this._tasksConfig ? { extensions: { [TASKS_EXTENSION]: {} } } : undefined),
    }

    const transport = McpClient._resolveTransport(args)
    this._taskRoutingUnavailable = args.transport instanceof StreamableHTTPClientTransport
    if (this._tasksConfig) {
      this._taskTransport = new TaskTransport(transport, () => this._client.outboundMetadata())
      this._transport = this._taskTransport
    } else {
      this._transport = transport
    }

    this._client = new TaskClient(
      {
        name: this._clientName,
        version: this._clientVersion,
      },
      {
        capabilities,
        versionNegotiation: { mode: 'auto' },
        listChanged: {
          tools: {
            autoRefresh: false,
            debounceMs: 300,
            onChanged: (): void => {
              this._handleToolsChanged()
            },
          },
        },
      }
    )

    this._client.setNotificationHandler('notifications/message', (notification) => {
      this._logHandler(notification.params)
    })

    this._disableMcpInstrumentation = args.disableMcpInstrumentation ?? false
  }

  private static _resolveTransport(args: McpClientConfig): McpTransport {
    if (args.transport && args.url) {
      throw new Error('McpClientConfig: provide either "transport" or "url", not both')
    }
    if (!args.transport && !args.url) {
      throw new Error('McpClientConfig: either "transport" or "url" must be provided')
    }
    if (args.transport) {
      if (args.auth || args.authProvider || args.headers) {
        throw new Error(
          'McpClientConfig: "auth", "authProvider", and "headers" require "url" (not compatible with "transport")'
        )
      }
      return args.transport
    }
    if (args.auth && args.authProvider) {
      throw new Error('McpClientConfig: provide either "auth" or "authProvider", not both')
    }

    const authProvider = args.auth
      ? new ClientCredentialsProvider({
          clientId: args.auth.clientId,
          clientSecret: args.auth.clientSecret,
          ...(args.auth.scopes && { scope: args.auth.scopes.join(' ') }),
        })
      : args.authProvider

    const url = args.url instanceof URL ? args.url : new URL(args.url!)
    return new StreamableHTTPClientTransport(url, {
      ...(authProvider && { authProvider }),
      ...(args.headers && { requestInit: { headers: args.headers } }),
      ...(args.tasksConfig !== undefined && { fetch: createTaskRoutingFetch() }),
    })
  }

  get client(): Client {
    return this._client
  }

  get serverCapabilities(): ServerCapabilities | undefined {
    return this._client.getServerCapabilities()
  }

  get serverVersion(): Implementation | undefined {
    return this._client.getServerVersion()
  }

  get serverInstructions(): string | undefined {
    return this._client.getInstructions()
  }

  get connectionState(): McpConnectionState {
    return this._state
  }

  get clientName(): string {
    return this._clientName
  }

  get continueOnError(): boolean {
    return this._continueOnError
  }

  /**
   * Connects the MCP client to the server.
   *
   * Called lazily before any operation that requires a connection. When `continueOnError` is true,
   * connection failures are swallowed and the client enters a `'failed'` state — subsequent
   * calls are no-ops until `connect(true)` is called explicitly to retry.
   *
   * @param reconnect - When true, forces a reconnect even if already connected or failed.
   * @param options - Optional abort signal that stops this caller's wait. The connection attempt
   *                  itself continues for other callers awaiting it.
   * @returns A promise that resolves when the connection is established.
   */
  public async connect(reconnect: boolean = false, options?: { signal?: AbortSignal }): Promise<void> {
    const signal = options?.signal
    if (signal?.aborted) throw abortReason(signal)
    const generation = this._connectionGeneration
    if (this._connectionPromise) {
      try {
        await (signal ? raceWithAbort(this._connectionPromise, signal) : this._connectionPromise)
      } catch (error) {
        if (!reconnect || signal?.aborted) throw error
      }
      this._assertConnectionCurrent(generation)
      if (!reconnect) return
    }

    if (this._state !== 'disconnected' && !reconnect) return

    const connectionPromise = this._connect(reconnect)
    this._connectionPromise = connectionPromise
    try {
      await (signal ? raceWithAbort(connectionPromise, signal) : connectionPromise)
      this._assertConnectionCurrent(generation)
    } finally {
      if (this._connectionPromise === connectionPromise) {
        this._connectionPromise = undefined
      }
    }
  }

  private async _connect(reconnect: boolean): Promise<void> {
    const generation = this._connectionGeneration
    if (this._state === 'connected' && reconnect) {
      await this._closeTaskSession()
      await this._client.close()
      this._assertConnectionCurrent(generation)
      this._state = 'disconnected'
    }

    if (this._elicitationCallback) {
      const callback = this._elicitationCallback
      this._client.setRequestHandler('elicitation/create', async (request, requestContext) => {
        // The top-level `signal` mirrors `mcpReq.signal` for callbacks written against the
        // deprecated ElicitationContext.signal field.
        return await callback({ ...requestContext, signal: requestContext.mcpReq.signal }, request.params)
      })
    }

    try {
      await this._client.connect(this._transport as Transport)
      this._assertConnectionCurrent(generation)
      this._state = 'connected'
    } catch (error) {
      if (generation !== this._connectionGeneration) {
        await this._client.close()
        this._assertConnectionCurrent(generation)
      }
      if (!this._continueOnError) throw error
      this._state = 'failed'
      logger.warn(
        `client=<${this._clientName}>, error=<${error}> | MCP server failed to connect, continuing (continueOnError)`
      )
    }
  }

  private _assertConnectionCurrent(generation: number): void {
    if (generation !== this._connectionGeneration) {
      throw new SdkError(SdkErrorCode.ConnectionClosed, 'MCP client disconnected')
    }
  }

  /**
   * Disconnects the MCP client from the server and cleans up resources.
   *
   * @returns A promise that resolves when the disconnection is complete.
   */
  public async disconnect(): Promise<void> {
    this._connectionGeneration++
    this._state = 'disconnected'
    for (const controller of this._taskControllers) {
      controller.abort(new SdkError(SdkErrorCode.ConnectionClosed, 'MCP client disconnected'))
    }
    await this._closeTaskSession()
    // Must be done sequentially
    await this._client.close()
    await this._transport.close()
    this._state = 'disconnected'
  }

  /**
   * Enables the `await using` pattern for automatic resource cleanup.
   * Delegates to {@link McpClient.disconnect}.
   */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.disconnect()
  }

  /**
   * Lists the tools available on the server and returns them as executable McpTool instances.
   *
   * A prefix renames tools for the agent only; tools are always invoked, and matched by string and
   * `RegExp` filters, under their server-side name. Overlong prefixed names are skipped with a warning
   * when `continueOnError` is true; otherwise, listing throws. Unprefixed names are not length-checked.
   *
   * @param options - Overrides for the prefix and filters set on the client. An omitted field uses
   *                  the client's value; an explicit empty string or empty object disables it.
   * @returns A promise that resolves with an array of McpTool instances.
   * @throws ToolValidationError When a prefixed name exceeds the registry limit and `continueOnError` is false.
   */
  public async listTools(options?: McpListToolsOptions): Promise<McpTool[]> {
    await this.connect()
    if (this._state === 'failed') return []

    const prefix = options?.prefix === undefined ? this._prefix : options.prefix
    const toolFilters = options?.toolFilters === undefined ? this._toolFilters : options.toolFilters
    const tools: McpTool[] = []
    const toolDefinitions = new Map<string, McpServerToolDefinition>()
    const result = await this._client.listTools()

    for (const toolSpec of result.tools) {
      toolDefinitions.set(toolSpec.name, toMcpServerToolDefinition(toolSpec))
      const toolName = prefix ? `${prefix}_${toolSpec.name}` : toolSpec.name
      if (prefix) {
        logger.debug(`tool_rename=<${toolSpec.name}->${toolName}> | renamed tool`)
      }

      const tool = new McpTool({
        name: toolName,
        description: toolSpec.description || `Tool which performs ${toolSpec.name}`,
        inputSchema: toolSpec.inputSchema as JSONSchema,
        ...(toolSpec.outputSchema !== undefined && { outputSchema: toolSpec.outputSchema as JSONSchema }),
        // Pass through only the annotation keys the MCP SDK's Zod schema recognizes
        // (title, readOnlyHint, destructiveHint, idempotentHint, openWorldHint). The SDK strips
        // unknown keys before this code runs, so new annotation vocabulary won't surface here
        // until the SDK dependency updates. The MCP spec treats these as untrusted hints.
        // An empty annotations object is treated the same as no annotations.
        ...(toolSpec.annotations !== undefined &&
          Object.keys(toolSpec.annotations).length > 0 && {
            annotations: toolSpec.annotations,
          }),
        client: this,
      })
      this._serverToolNames.set(tool, toolSpec.name)

      if (!shouldIncludeTool(tool, toolSpec.name, toolFilters)) continue

      if (prefix && toolName.length > MAX_TOOL_NAME_LENGTH) {
        const message =
          `server=<${this.serverVersion?.name ?? 'unknown'}>, tool=<${toolSpec.name}>, ` +
          `name=<${toolName}>, length=<${toolName.length}>, limit=<${MAX_TOOL_NAME_LENGTH}> | ` +
          'tool name exceeds registry limit | use a shorter prefix or tool name'
        if (!this._continueOnError) throw new ToolValidationError(message)

        logger.warn(`${message} | skipping tool (continueOnError)`)
        continue
      }
      tools.push(tool)
    }

    this._serverToolDefinitions = toolDefinitions

    // Per-call overrides are transient, so they must not become the baseline that a later
    // tools-changed refresh reports as the previously registered names.
    if (options?.prefix === undefined && options?.toolFilters === undefined) {
      this._registeredToolNames = new Set(tools.map((tool) => tool.name))
    }

    return tools
  }

  /**
   * Sets a callback invoked when the MCP server's tool list changes at runtime.
   *
   * @param callback - Handler receiving the previous tool names and the refreshed tool instances,
   *                   or undefined to remove the callback.
   */
  set onToolsChanged(callback: ((oldTools: string[], newTools: McpTool[]) => void) | undefined) {
    this._onToolsChanged = callback
  }

  private async _handleToolsChanged(): Promise<void> {
    if (this._refreshingTools) {
      this._pendingRefresh = true
      return
    }
    this._refreshingTools = true
    try {
      do {
        this._pendingRefresh = false
        const oldTools = [...this._registeredToolNames]
        const newTools = await this.listTools()
        this._onToolsChanged?.(oldTools, newTools)
      } while (this._pendingRefresh)
    } catch (err) {
      logger.warn(
        `client=<${this._clientName}>, error=<${err}> | failed to refresh tools after toolsChanged notification`
      )
    } finally {
      this._refreshingTools = false
    }
  }

  /**
   * Invoke a tool on the connected MCP server using an McpTool instance.
   *
   * When `tasksConfig` is set, task-backed execution is completed automatically on both
   * server generations: SEP-2663 tasks on servers that advertise the tasks extension, and the
   * legacy 2025-11-25 task protocol. Direct tool results are returned unchanged.
   *
   * @param tool - The McpTool instance to invoke.
   * @param args - The arguments to pass to the tool.
   * @param options - Optional settings for the request.
   * @returns The final tool result.
   * @throws {@link McpTaskCancelledError} When the server reports a cancelled task.
   * @throws {@link McpTaskFailedError} When the server reports a failed task.
   */
  public async callTool(tool: McpTool, args: JSONValue, options?: McpCallToolOptions): Promise<JSONValue> {
    if (options?.timeoutMs !== undefined) assertPositiveDuration(options.timeoutMs, 'MCP call timeout')
    if (!this._tasksConfig) {
      const outcome = await this._invokeTool(tool, args, {
        ...(options?.signal && { signal: options.signal }),
        ...(options?.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
      })
      return outcome.result as JSONValue
    }

    const operation = this._createTaskOperation(options?.signal, options?.timeoutMs ?? this._tasksConfig.pollTimeoutMs)
    try {
      const outcome = await this._invokeTool(
        tool,
        args,
        { signal: operation.signal, timeoutMs: this._tasksConfig.requestTimeoutMs },
        operation,
        true
      )
      return outcome.result as JSONValue
    } catch (error) {
      throw operation.signal.aborted ? abortReason(operation.signal) : error
    } finally {
      operation.dispose()
    }
  }

  /**
   * Invokes a tool once and returns either its direct result or a server-created task handle.
   *
   * This operation never polls or consumes a returned task handle. Task creation is controlled
   * by the server; the client only advertises support when `tasksConfig` is configured.
   *
   * @param tool - The McpTool instance to invoke.
   * @param args - The arguments to pass to the tool.
   * @param options - Optional settings for the request.
   * @returns The direct tool result or task handle returned by the server.
   */
  public async submitTool(tool: McpTool, args: JSONValue, options?: McpCallToolOptions): Promise<McpSubmitToolResult> {
    if (options?.timeoutMs !== undefined) assertPositiveDuration(options.timeoutMs, 'MCP call timeout')
    if (!this._tasksConfig) {
      throw new Error('SEP-2663 task operations require McpClient tasksConfig')
    }

    const operation = this._createTaskOperation(options?.signal, options?.timeoutMs ?? this._tasksConfig.pollTimeoutMs)
    try {
      await this.connect(false, { signal: operation.signal })
      if (this._state === 'failed') throw new Error('MCP server failed to connect. Call connect(true) to retry.')
      this._assertTaskLifecycleAvailable()

      const params = this._prepareToolCall(tool, args)
      const definition = this._serverToolDefinitions.get(params.name)
      const response = await this._taskTransport!.request('tools/call', params as Record<string, unknown>, {
        signal: operation.signal,
        timeoutMs: remainingTime(operation.deadline, this._tasksConfig.requestTimeoutMs),
        maxTotalTimeoutMs: remainingTime(operation.deadline, this._tasksConfig.pollTimeoutMs),
        resetTimeoutOnProgress: true,
        ...(!isBrowserRuntime() && { headers: buildMcpParamHeaders(definition?.inputSchema, params.arguments ?? {}) }),
      })
      if (isCreateTaskResultV2(response)) {
        return parseTaskResponse(
          response,
          (value) => CreateTaskResultV2Schema.parse(value),
          'tools/call'
        ) as unknown as McpSubmitToolResult
      }
      const direct = parseTaskResponse(
        response,
        (value) => CallToolResultV2Schema.parse(value),
        'tools/call'
      ) as Record<string, unknown>
      delete direct.resultType
      return direct as McpSubmitToolResult
    } catch (error) {
      throw operation.signal.aborted ? abortReason(operation.signal) : error
    } finally {
      operation.dispose()
    }
  }

  /**
   * Retrieves the current state of a SEP-2663 task.
   *
   * @param taskId - Server-issued task identifier.
   * @param options - Optional lifecycle request settings.
   * @returns The validated task state, including terminal result or error data when present.
   */
  public async getTask(taskId: string, options?: McpTaskRequestOptions): Promise<McpGetTaskResult> {
    assertTaskId(taskId)
    const result = await this._requestTask('tasks/get', { taskId }, options)
    const task = parseTaskResponse(result, (value) => GetTaskResultV2Schema.parse(value), 'tasks/get')
    if (task.taskId !== taskId) {
      throw new SdkError(SdkErrorCode.InvalidResult, 'MCP tasks/get response returned a different taskId')
    }
    return task as unknown as McpGetTaskResult
  }

  /**
   * Supplies one or more responses to outstanding task input requests.
   *
   * Partial response sets are supported; the server may keep the task in `input_required`
   * until every outstanding request has been answered.
   *
   * @param taskId - Server-issued task identifier.
   * @param inputResponses - Responses keyed by the corresponding input request key.
   * @param options - Optional lifecycle request settings.
   * @returns The server's validated acknowledgement.
   */
  public async updateTask(
    taskId: string,
    inputResponses: McpInputResponses,
    options?: McpTaskRequestOptions
  ): Promise<McpUpdateTaskResult> {
    assertTaskId(taskId)
    const outbound = parseTaskResponse(
      inputResponses,
      (value) => InputResponsesV2Schema.parse(value),
      'tasks/update input'
    )
    const result = await this._requestTask('tasks/update', { taskId, inputResponses: outbound }, options)
    return parseTaskResponse(
      result,
      (value) => UpdateTaskResultV2Schema.parse(value),
      'tasks/update'
    ) as unknown as McpUpdateTaskResult
  }

  /**
   * Requests cooperative cancellation of a SEP-2663 task.
   *
   * A successful acknowledgement does not guarantee that the server stopped the work or that
   * the task will eventually report `cancelled`.
   *
   * @param taskId - Server-issued task identifier.
   * @param options - Optional lifecycle request settings.
   * @returns The server's validated acknowledgement.
   */
  public async cancelTask(taskId: string, options?: McpTaskRequestOptions): Promise<McpCancelTaskResult> {
    assertTaskId(taskId)
    const result = await this._requestTask('tasks/cancel', { taskId }, options)
    return parseTaskResponse(
      result,
      (value) => CancelTaskResultV2Schema.parse(value),
      'tasks/cancel'
    ) as unknown as McpCancelTaskResult
  }

  private async _invokeTool(
    tool: McpTool,
    args: JSONValue,
    options: McpCallToolOptions,
    operation?: TaskOperation,
    completeLegacyTask = false
  ): Promise<McpToolCallOutcome> {
    await this.connect(false, operation ? { signal: operation.signal } : undefined)
    if (this._state === 'failed') throw new Error('MCP server failed to connect. Call connect(true) to retry.')

    const params = this._prepareToolCall(tool, args)

    // The upstream codec rejects extension result types before custom result schemas run.
    if (completeLegacyTask && this._supportsLegacyTask(params.name)) {
      const outputSchema = compileToolOutputSchema(
        params.name,
        this._serverToolDefinitions.get(params.name)?.outputSchema
      )
      const result = await this._callLegacyTask(params, operation!)
      await validateToolOutput(params.name, outputSchema, result)
      return { result }
    }

    if (operation && this._supportsTaskExtension()) {
      if (!this._taskRoutingUnavailable) {
        return await this._invokeTaskTool(tool, params, operation, options.timeoutMs!)
      }
      if (!this._taskRoutingWarned) {
        this._taskRoutingWarned = true
        logger.warn(
          `client=<${this._clientName}> | server advertises SEP-2663 tasks but a caller-supplied Streamable HTTP transport cannot carry Mcp-Name routing headers, calling tools directly | use the url configuration for task execution`
        )
      }
    }

    return {
      result: await this._client.callTool(params, {
        ...(options.signal && { signal: options.signal }),
        ...(options.timeoutMs !== undefined && {
          timeout: options.timeoutMs,
          maxTotalTimeout: operation
            ? remainingTime(operation.deadline, this._tasksConfig!.pollTimeoutMs)
            : options.timeoutMs,
          resetTimeoutOnProgress: true,
          // A progress token only goes on the wire when a progress handler is registered, which is
          // what makes resetTimeoutOnProgress take effect.
          onprogress: (): void => {},
        }),
      }),
    }
  }

  private _supportsLegacyTask(toolName: string): boolean {
    if (this._client.getNegotiatedProtocolVersion() !== '2025-11-25') return false
    const tasks = this._client.getServerCapabilities()?.tasks
    const support = this._serverToolDefinitions.get(toolName)?.execution?.taskSupport
    return tasks?.requests?.tools?.call !== undefined && (support === 'optional' || support === 'required')
  }

  private _prepareToolCall(tool: McpTool, args: JSONValue): CallToolRequest['params'] {
    if (args === null || args === undefined) {
      args = {}
    }
    if (typeof args !== 'object' || Array.isArray(args)) {
      throw new Error(
        `MCP Protocol Error: Tool arguments must be a JSON Object (named parameters). Received: ${Array.isArray(args) ? 'Array' : typeof args}`
      )
    }
    // Inject OpenTelemetry trace context into tool arguments for distributed tracing
    const enhancedArgs = this._disableMcpInstrumentation ? args : injectTraceContext(args)
    return {
      name: this._serverToolNames.get(tool) ?? tool.name,
      arguments: enhancedArgs as Record<string, unknown>,
    }
  }

  private _supportsTaskExtension(): boolean {
    if (!this._taskTransport || this._client.getProtocolEra() !== 'modern') return false
    const extensions = this._client.getServerCapabilities()?.extensions
    return isRecord(extensions) && isRecord(extensions[TASKS_EXTENSION])
  }

  private async _invokeTaskTool(
    tool: McpTool,
    params: CallToolRequest['params'],
    operation: TaskOperation,
    requestTimeoutMs: number
  ): Promise<McpToolCallOutcome> {
    const session = this._ensureTaskSession()
    const definition = this._serverToolDefinitions.get(params.name) ?? {
      ...(tool.toolSpec.inputSchema !== undefined && { inputSchema: tool.toolSpec.inputSchema }),
      ...(tool.toolSpec.outputSchema !== undefined && { outputSchema: tool.toolSpec.outputSchema }),
    }
    const outputSchema = compileToolOutputSchema(params.name, definition.outputSchema)
    const execution = await session.callTool(params.name, (params.arguments ?? {}) as Record<string, JsonValue>, {
      signal: operation.signal,
      requestTimeoutMs: remainingTime(operation.deadline, requestTimeoutMs),
      resetTimeoutOnProgress: true,
      ...(!isBrowserRuntime() && { headers: buildMcpParamHeaders(definition.inputSchema, params.arguments ?? {}) }),
    })
    try {
      const { outcome } = await execution.settle()
      const result = taskOutcomeResult(outcome)
      await validateToolOutput(params.name, outputSchema, result)
      return { result }
    } finally {
      // An aborted lifecycle signal settles the execution locally, so close() alone would skip
      // the cooperative cancel and leave the server-side task running until its TTL.
      if (operation.signal.aborted) await execution.cancel().catch(() => undefined)
      await execution.close()
    }
  }

  private _ensureTaskSession(): TaskEnabledSession {
    if (this._taskSession) return this._taskSession
    const taskTransport = this._taskTransport!
    this._taskSession = createTaskSessionFromClient(this._client, {
      endpointId: this._clientName,
      tools: {
        currentTool: (name) => {
          const definition = this._serverToolDefinitions.get(name)
          if (!definition) return undefined
          return toolDeclaration({
            name,
            inputSchema: (definition.inputSchema ?? {}) as Readonly<Record<string, JsonValue>>,
            ...(definition.outputSchema !== undefined && {
              outputSchema: definition.outputSchema as Readonly<Record<string, JsonValue>>,
            }),
            ...(definition.execution?.taskSupport !== undefined && {
              execution: { taskSupport: definition.execution.taskSupport },
            }),
          })
        },
      },
      rawDispatch: async (request, options) => {
        const { method, params } = request as { method: string; params?: Record<string, unknown> }
        try {
          const result = await taskTransport.request(method as Parameters<TaskTransport['request']>[0], params ?? {}, {
            timeoutMs: options?.context?.requestTimeoutMs ?? this._tasksConfig!.requestTimeoutMs,
            ...(options?.context?.resetTimeoutOnProgress !== undefined && {
              resetTimeoutOnProgress: options.context.resetTimeoutOnProgress,
            }),
            ...(options?.signal && { signal: options.signal }),
            ...(options?.context?.headers && { headers: options.context.headers }),
          })
          return { kind: 'result', result: result as JsonValue }
        } catch (error) {
          if (error instanceof ProtocolError) {
            return {
              kind: 'error',
              error: {
                code: error.code,
                message: error.message,
                ...(error.data !== undefined && { data: error.data as JsonValue }),
              },
            }
          }
          throw error
        }
      },
      v2RequestFraming: {
        protocolVersion: this._client.getNegotiatedProtocolVersion() ?? TASKS_PROTOCOL_VERSION,
        clientInfo: { name: this._clientName, version: this._clientVersion },
        clientCapabilities: { extensions: { [TASKS_EXTENSION]: {} } },
      },
      onInputRequest: createApplicationInputHandler({
        elicitation: async (request, context) => {
          const callback = this._elicitationCallback
          if (!callback) {
            throw new SdkError(
              SdkErrorCode.CapabilityNotSupported,
              'No MCP input handler is registered for "elicitation/create"'
            )
          }
          const inputId =
            context.taskId !== undefined ? `task:${context.taskId}:${context.inputId ?? ''}` : context.inputId
          const wireParams = request.params as Parameters<ElicitationCallback>[1] & { elicitationId?: string }
          // Modern URL elicitation omits the legacy elicitationId; synthesize the task-scoped id so
          // existing callbacks typed against ElicitRequestParams keep working.
          const params =
            wireParams.mode === 'url' && wireParams.elicitationId === undefined
              ? { ...wireParams, elicitationId: inputId ?? 'task-input' }
              : wireParams
          const response = await callback(this._createTaskInputContext(inputId, context.signal), params)
          const validated = ElicitResultV2Schema.safeParse(response)
          if (!validated.success) {
            throw new SdkError(SdkErrorCode.InvalidResult, 'MCP elicitation callback returned a malformed response')
          }
          return validated.data as ApplicationElicitResult
        },
        sampling: () => {
          throw new SdkError(
            SdkErrorCode.CapabilityNotSupported,
            'No MCP input handler is registered for "sampling/createMessage"'
          )
        },
        roots: () => {
          throw new SdkError(SdkErrorCode.CapabilityNotSupported, 'No MCP input handler is registered for "roots/list"')
        },
      }),
      onError: (error) => {
        logger.warn(`client=<${this._clientName}>, error=<${error}> | mcp task session error`)
      },
    })
    return this._taskSession
  }

  private async _closeTaskSession(): Promise<void> {
    const session = this._taskSession
    this._taskSession = undefined
    await session?.close().catch(() => undefined)
  }

  private _createTaskInputContext(inputId: string | undefined, signal: AbortSignal | undefined): ElicitationContext {
    const inputSignal = signal ?? new AbortController().signal
    const unavailable = async (): Promise<never> => {
      throw new SdkError(SdkErrorCode.SendFailed, 'Related messaging is unavailable for an embedded MCP input request')
    }
    return {
      ...(this._transport.sessionId && { sessionId: this._transport.sessionId }),
      // The top-level `signal` mirrors `mcpReq.signal` for callbacks written against the
      // deprecated ElicitationContext.signal field.
      signal: inputSignal,
      mcpReq: {
        id: inputId ?? 'task-input',
        method: 'elicitation/create',
        signal: inputSignal,
        requestState: (): undefined => undefined,
        send: unavailable,
        notify: unavailable,
      },
    } as unknown as ElicitationContext
  }

  private async _requestTask(
    method: 'tasks/get' | 'tasks/update' | 'tasks/cancel',
    params: Record<string, unknown>,
    options?: McpTaskRequestOptions
  ): Promise<unknown> {
    const timeoutMs = options?.timeoutMs ?? this._tasksConfig?.requestTimeoutMs ?? McpClient.DEFAULT_REQUEST_TIMEOUT
    assertPositiveDuration(timeoutMs, 'MCP task request timeout')
    const operation = this._createTaskOperation(options?.signal, timeoutMs)
    try {
      await this.connect(false, { signal: operation.signal })
      if (this._state === 'failed') throw new Error('MCP server failed to connect. Call connect(true) to retry.')
      this._assertTaskLifecycleAvailable()
      return await this._taskTransport!.request(method, params, {
        signal: operation.signal,
        timeoutMs: remainingTime(operation.deadline, timeoutMs),
      })
    } catch (error) {
      throw operation.signal.aborted ? abortReason(operation.signal) : error
    } finally {
      operation.dispose()
    }
  }

  private _assertTaskLifecycleAvailable(): void {
    if (!this._tasksConfig || !this._taskTransport) {
      throw new Error('SEP-2663 task operations require McpClient tasksConfig')
    }
    if (this._taskRoutingUnavailable) {
      throw new Error(
        'SEP-2663 tasks over Streamable HTTP require the "url" configuration so Mcp-Name task routing headers can be applied'
      )
    }
    if (!this._supportsTaskExtension()) {
      throw new Error(`MCP server did not advertise the ${TASKS_EXTENSION} extension`)
    }
  }

  private async _callLegacyTask(params: CallToolRequest['params'], operation: TaskOperation): Promise<CallToolResult> {
    const requestOptions = (): CallToolRequestOptions => ({
      signal: operation.signal,
      timeout: remainingTime(operation.deadline, this._tasksConfig!.requestTimeoutMs),
      maxTotalTimeout: remainingTime(operation.deadline, this._tasksConfig!.pollTimeoutMs),
      resetTimeoutOnProgress: true,
      // A progress token only goes on the wire when a progress handler is registered, which is
      // what makes resetTimeoutOnProgress take effect.
      onprogress: (): void => {},
    })
    const { task } = await this._client.request(
      { method: 'tools/call', params: { ...params, task: {} } },
      specTypeSchemas.CreateTaskResult,
      requestOptions()
    )
    let state = task
    try {
      while (state.status === 'working') {
        await abortableDelay(
          Math.max(MINIMUM_POLL_INTERVAL_MS, state.pollInterval ?? this._tasksConfig!.pollIntervalMs),
          operation.signal
        )
        state = await this._client.request(
          { method: 'tasks/get', params: { taskId: task.taskId } },
          specTypeSchemas.GetTaskResult,
          requestOptions()
        )
      }
      if (state.status === 'cancelled') throw new McpTaskCancelledError(state.statusMessage)
      if (state.status === 'failed') throw new McpTaskFailedError(state.statusMessage)
      // tasks/result delivers queued server requests when a legacy task requires input. The server
      // holds this request while input is pending and sends no progress, so the wait is bounded by
      // the overall operation deadline instead of the per-request inactivity timeout.
      return await this._client.request(
        { method: 'tasks/result', params: { taskId: task.taskId } },
        specTypeSchemas.CallToolResult,
        state.status === 'input_required'
          ? { ...requestOptions(), timeout: remainingTime(operation.deadline, this._tasksConfig!.pollTimeoutMs) }
          : requestOptions()
      )
    } catch (error) {
      if (
        state.status !== 'completed' &&
        state.status !== 'failed' &&
        state.status !== 'cancelled' &&
        this._state === 'connected' &&
        this._client.getServerCapabilities()?.tasks?.cancel !== undefined
      ) {
        // Cleanup is best-effort and tightly bounded so a stalled server cannot delay surfacing
        // the original failure.
        void this._client
          .request({ method: 'tasks/cancel', params: { taskId: task.taskId } }, specTypeSchemas.CancelTaskResult, {
            timeout: Math.min(1_000, this._tasksConfig!.requestTimeoutMs),
          })
          .catch(() => undefined)
      }
      throw error
    }
  }

  private _createTaskOperation(externalSignal: AbortSignal | undefined, timeoutMs: number): TaskOperation {
    const controller = new AbortController()
    this._taskControllers.add(controller)
    const deadline = Date.now() + timeoutMs
    const abortFromExternal = (): void => controller.abort(abortReason(externalSignal))
    const timeout = setTimeout(() => {
      controller.abort(
        new SdkError(SdkErrorCode.RequestTimeout, `MCP task did not complete within ${timeoutMs}ms`, {
          timeoutMs,
        })
      )
    }, timeoutMs)

    if (externalSignal?.aborted) {
      abortFromExternal()
    } else {
      externalSignal?.addEventListener('abort', abortFromExternal, { once: true })
    }

    return {
      deadline,
      signal: controller.signal,
      dispose: (): void => {
        clearTimeout(timeout)
        externalSignal?.removeEventListener('abort', abortFromExternal)
        this._taskControllers.delete(controller)
      },
    }
  }
}

class TaskClient extends Client {
  public outboundMetadata(): Record<string, unknown> | undefined {
    return this._outboundMetaEnvelope()
  }
}

function taskOutcomeResult(outcome: TaskOutcome<unknown>): CallToolResult {
  if (outcome.status === 'cancelled') throw new McpTaskCancelledError(outcome.task?.statusMessage)
  if (outcome.status === 'failed') {
    throw new McpTaskFailedError(outcome.error.message, {
      ...(outcome.error.code !== undefined && { code: outcome.error.code }),
      ...(outcome.error.data !== undefined && { data: outcome.error.data }),
    })
  }
  const result = { ...(resultFromTaskOutcome(outcome) as Record<string, unknown>) }
  delete result.resultType
  return result as CallToolResult
}

function assertTaskId(taskId: string): void {
  if (taskId.length === 0) throw new TypeError('MCP taskId must not be empty')
}

function parseTaskResponse<Result>(value: unknown, parse: (value: unknown) => Result, operation: string): Result {
  try {
    return parse(value)
  } catch {
    throw new SdkError(SdkErrorCode.InvalidResult, `MCP ${operation} returned a malformed SEP-2663 response`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBrowserRuntime(): boolean {
  return globalThis.window !== undefined && globalThis.document !== undefined
}

function resolveTasksConfig(config: TasksConfig | undefined): ResolvedTasksConfig | undefined {
  if (config === undefined) return undefined

  const resolved = {
    pollTimeoutMs: config.pollTimeout ?? McpClient.DEFAULT_POLL_TIMEOUT,
    requestTimeoutMs: config.requestTimeout ?? config.ttl ?? McpClient.DEFAULT_REQUEST_TIMEOUT,
    pollIntervalMs: config.pollInterval ?? McpClient.DEFAULT_POLL_INTERVAL_MS,
  }
  assertPositiveDuration(resolved.pollTimeoutMs, 'MCP task overall timeout')
  assertPositiveDuration(resolved.requestTimeoutMs, 'MCP task request timeout')
  assertPositiveDuration(resolved.pollIntervalMs, 'MCP task poll interval')
  return resolved
}

function remainingTime(deadline: number, limit: number): number {
  const remaining = deadline - Date.now()
  if (remaining <= 0) {
    throw new SdkError(SdkErrorCode.RequestTimeout, 'MCP task operation timed out')
  }
  return Math.max(1, Math.min(limit, remaining))
}

function abortReason(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) return signal.reason
  return new DOMException('The operation was aborted', 'AbortError')
}

async function abortableDelay(delayMs: number, signal: AbortSignal): Promise<undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await raceWithAbort(
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), Math.min(delayMs, MAX_TIMER_DELAY_MS))
      }),
      signal
    )
  } finally {
    clearTimeout(timeout)
  }
}

async function raceWithAbort<Result>(promise: Promise<Result>, signal: AbortSignal): Promise<Result> {
  if (signal.aborted) throw abortReason(signal)

  return await new Promise<Result>((resolve, reject) => {
    const abort = (): void => {
      cleanup()
      reject(abortReason(signal))
    }
    const cleanup = (): void => {
      signal.removeEventListener('abort', abort)
    }

    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (result) => {
        cleanup()
        resolve(result)
      },
      (error: unknown) => {
        cleanup()
        reject(error)
      }
    )
  })
}

function assertPositiveDuration(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
    throw new TypeError(`${name} must be a positive safe integer no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}

function toMcpServerToolDefinition(tool: McpSdkTool): McpServerToolDefinition {
  return {
    inputSchema: tool.inputSchema as JSONSchema,
    ...(tool.execution !== undefined && { execution: tool.execution }),
    ...(tool.outputSchema !== undefined && { outputSchema: tool.outputSchema as JSONSchema }),
  }
}

function compileToolOutputSchema(
  toolName: string,
  outputSchema: JSONSchema | undefined
): CompiledToolOutputSchema | undefined {
  if (outputSchema === undefined) return undefined

  try {
    return fromJsonSchema(outputSchema as JsonSchemaType)
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 200)
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `Tool '${toolName}' has an invalid outputSchema: ${message}`
    )
  }
}

async function validateToolOutput(
  toolName: string,
  outputSchema: CompiledToolOutputSchema | undefined,
  result: CallToolResult
): Promise<void> {
  if (outputSchema === undefined) return
  if (result.structuredContent === undefined && !result.isError) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidRequest,
      `Tool ${toolName} has an output schema but did not return structured content`
    )
  }
  if (result.structuredContent === undefined || result.isError) return

  try {
    const validation = await outputSchema['~standard'].validate(result.structuredContent)
    if (validation.issues !== undefined) {
      const message = validation.issues.map((issue) => issue.message).join('; ')
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `Structured content does not match the tool's output schema: ${message}`
      )
    }
  } catch (error) {
    if (error instanceof ProtocolError) throw error
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `Failed to validate structured content: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/**
 * Decides whether a listed tool is exposed: allowed is applied first, then rejected, so a rejected
 * tool is excluded even when also allowed.
 */
function shouldIncludeTool(tool: McpTool, serverToolName: string, filters: McpToolFilters | undefined): boolean {
  if (!filters) return true
  if (filters.allowed !== undefined && !matchesAnyMatcher(tool, serverToolName, filters.allowed)) return false
  if (filters.rejected !== undefined && matchesAnyMatcher(tool, serverToolName, filters.rejected)) return false
  return true
}

function matchesAnyMatcher(tool: McpTool, serverToolName: string, matchers: McpToolMatcher[]): boolean {
  return matchers.some((matcher) => {
    if (typeof matcher === 'function') return matcher(tool)
    if (typeof matcher === 'string') return matcher === serverToolName

    // The sticky flag anchors the match at the start of the name, matching Python's Pattern.match.
    // A fresh RegExp keeps the caller's lastIndex untouched.
    const anchored = new RegExp(matcher.source, matcher.flags.includes('y') ? matcher.flags : `${matcher.flags}y`)
    return anchored.test(serverToolName)
  })
}

function defaultLogHandler(params: LoggingMessageNotificationParams): void {
  const { level, logger: serverLogger, data } = params
  const message = `logger=<${serverLogger ?? 'mcp'}>, data=<${JSON.stringify(data)}> | MCP server log`
  if (level === 'debug') {
    logger.debug(message)
  } else if (level === 'info' || level === 'notice') {
    logger.info(message)
  } else if (level === 'warning') {
    logger.warn(message)
  } else {
    logger.error(message)
  }
}

/**
 * Carrier object for OpenTelemetry context propagation.
 */
interface ContextCarrier {
  [key: string]: string | string[] | undefined
}

/**
 * Injects OpenTelemetry trace context into MCP tool call arguments.
 * Returns the args with a `_meta` field containing W3C traceparent headers.
 * If no active span exists or injection fails, returns the original args unchanged.
 *
 * @param args - The tool call arguments (must be a non-null object)
 * @returns The args with trace context injected, or the original args on failure
 */
function injectTraceContext(args: JSONValue): JSONValue {
  try {
    const currentContext = context.active()
    const currentSpan = trace.getSpan(currentContext)

    if (!currentSpan || !currentSpan.spanContext().traceId) {
      return args
    }

    const carrier: ContextCarrier = {}
    propagation.inject(currentContext, carrier)

    const existingMeta = (args as Record<string, unknown>)._meta
    const mergedMeta =
      existingMeta && typeof existingMeta === 'object' && !Array.isArray(existingMeta)
        ? { ...existingMeta, ...carrier }
        : carrier

    return {
      ...(args as Record<string, unknown>),
      _meta: mergedMeta as unknown as JSONValue,
    }
  } catch (error) {
    logger.warn(`error=<${error}> | failed to inject trace context into mcp tool call args`)
    return args
  }
}
