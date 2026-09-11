import {
  Client,
  ClientCredentialsProvider,
  fromJsonSchema,
  isSpecType,
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
import { McpTool } from '../tools/mcp-tool.js'
import { logger } from '../logging/index.js'
import { type McpLoadServersOptions, type McpServerConfig, mcpServerLoader } from './config.js'
import { buildMcpParamHeaders, createTaskRoutingFetch, TaskTransport } from './task-transport.js'

import type {
  CallToolRequestOptions,
  CallToolResult,
  CallToolRequest,
  ClientContext,
  Implementation,
  JsonSchemaType,
  LoggingMessageNotificationParams,
  McpSubscription,
  OAuthClientProvider,
  RequestMeta,
  ServerCapabilities,
  SubscriptionFilter,
  Tool as McpSdkTool,
  Transport,
} from '@modelcontextprotocol/client'
import type {
  McpCallToolWithTaskResult,
  McpCancelTaskResult,
  McpCreateTaskResult,
  McpGetTaskResult,
  McpInputRequests,
  McpInputRequiredResult,
  McpInputResponses,
  McpTaskStatus,
  McpUpdateTaskResult,
} from './task-types.js'
import {
  McpInputResponsesSchema,
  McpTaskAcknowledgementSchema,
  McpCallToolWithTaskResultSchema,
  McpGetTaskResultSchema,
  McpTaskStatusNotificationSchema,
} from './task-schemas.js'

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

/** Request timeout options applied to every tool call made by the client. */
export interface McpRequestTimeouts {
  /** Milliseconds to wait for server activity on a request before failing. The MCP client default is 60000. */
  timeout?: number

  /** Upper bound in milliseconds on a whole request, regardless of server activity. */
  maxTotalTimeout?: number

  /** When true, progress notifications reset `timeout`; the client registers an internal progress handler so the progress token goes on the wire. */
  resetTimeoutOnProgress?: boolean
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

const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks'
const TASKS_PROTOCOL_VERSION = '2026-07-28'
const MINIMUM_POLL_INTERVAL_MS = 10
const MAX_INPUT_REQUIRED_ROUNDS = 10
const REQUEST_STATE_ONLY_RETRY_DELAY_MS = 250
const MAX_TIMER_DELAY_MS = 2_147_483_647
const HEADER_MISMATCH_ERROR_CODE = -32_020

/**
 * Configuration for MCP task execution.
 *
 * `ttl` and `pollTimeout` limit individual requests; `timeoutMs` bounds the complete
 * automatic operation, including polling and input callbacks. The first limit reached
 * ends the wait. Progress may reset `ttl` when `requestTimeouts.resetTimeoutOnProgress`
 * is enabled, but never extends `pollTimeout` or `timeoutMs`.
 *
 * To bound total wall-clock time, set `timeoutMs`. A call's `options.timeoutMs`
 * overrides this setting; the individual request limits still apply.
 */
export interface TasksConfig {
  /** Request inactivity timeout in milliseconds. Overrides `requestTimeouts.timeout`; defaults to 60000. */
  ttl?: number

  /** Maximum duration of one request in milliseconds, including progress resets. Overrides `requestTimeouts.maxTotalTimeout`; defaults to 300000. */
  pollTimeout?: number

  /** Overall automatic task timeout in milliseconds. Defaults to 300000 for modern tasks; legacy tasks have no overall limit. */
  timeoutMs?: number

  /** Polling delay used when the server omits its polling interval. Defaults to 1000. */
  pollIntervalMs?: number

  /** Whether to request modern task notifications in addition to polling. Defaults to true. */
  useNotifications?: boolean
}

interface ResolvedTasksConfig {
  timeoutMs: number | undefined
  maxTotalTimeoutMs: number
  requestTimeoutMs: number
  pollIntervalMs: number
  useNotifications: boolean
}

interface TaskOperation {
  deadline: number
  dispose: () => void
  signal: AbortSignal
}

interface TaskNotificationChannel {
  latest?: McpGetTaskResult
  wake?: () => void
}

interface McpServerToolDefinition {
  execution?: McpSdkTool['execution']
  inputSchema?: JSONSchema
  outputSchema?: JSONSchema
}

interface McpToolCallOutcome {
  result: McpCallToolWithTaskResult
  outputSchema?: CompiledToolOutputSchema
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

/** Options for MCP tool invocation. */
export interface McpCallToolOptions {
  /** AbortSignal to cancel the in-flight request. */
  signal?: AbortSignal
  /** Overrides the configured overall timeout in milliseconds for this call. */
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

  /** Enables automatic execution for legacy and SEP-2663 task tools. */
  tasksConfig?: TasksConfig

  /** Request timeouts applied to every tool call. Per-call options take precedence on overlap. */
  requestTimeouts?: McpRequestTimeouts

  /**
   * Callback to handle server-initiated elicitation requests.
   * When provided, the client advertises elicitation support (form + url modes)
   * and routes incoming elicitation requests to this callback.
   */
  elicitationCallback?: ElicitationCallback

  /** When true, connection failures are logged as warnings instead of throwing. */
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
 * MCP client using SDK v2, including SEP-2663 task execution.
 *
 * @example
 * ```typescript
 * const client = new McpClient({ url: 'https://example.com/mcp', tasksConfig: {} })
 * const agent = new Agent({ tools: [client] })
 * ```
 */
export class McpClient {
  /** Default task request timeout in milliseconds. */
  public static readonly DEFAULT_TTL = 60000

  /** Default maximum task request duration and modern overall timeout in milliseconds. */
  public static readonly DEFAULT_POLL_TIMEOUT = 300000

  /** Default polling interval when a task response omits `pollIntervalMs`. */
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
  private _state: McpConnectionState
  private _client: TaskClient
  private _continueOnError: boolean
  private _logHandler: (params: LoggingMessageNotificationParams) => void
  private _disableMcpInstrumentation: boolean
  private _tasksConfig: ResolvedTasksConfig | undefined
  private _requestTimeouts: McpRequestTimeouts | undefined
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
  private _taskNotificationChannels = new Map<string, TaskNotificationChannel>()

  constructor(args: McpClientConfig) {
    this._clientName = args.applicationName || 'strands-agents-ts-sdk'
    this._clientVersion = args.applicationVersion || '0.0.1'
    this._state = 'disconnected'
    this._continueOnError = args.continueOnError ?? false
    this._logHandler = args.logHandler ?? defaultLogHandler
    this._tasksConfig = resolveTasksConfig(args.tasksConfig, args.requestTimeouts)
    this._requestTimeouts = args.requestTimeouts
    this._elicitationCallback = args.elicitationCallback
    this._prefix = args.prefix
    this._toolFilters = args.toolFilters
    const capabilities = {
      ...(this._elicitationCallback ? { elicitation: { form: {}, url: {} } } : undefined),
      ...(this._tasksConfig ? { extensions: { [TASKS_EXTENSION]: {} } } : undefined),
    }

    const transport = McpClient._resolveTransport(args)
    if (this._tasksConfig) {
      this._taskTransport = new TaskTransport(transport, () => this._client.outboundMetadata())
      this._taskTransport.onTaskNotification = (params): void => {
        this._handleTaskNotification(params)
      }
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
      if (args.tasksConfig !== undefined && args.transport instanceof StreamableHTTPClientTransport) {
        throw new Error(
          'McpClientConfig: SEP-2663 tasks require the "url" configuration for Streamable HTTP so Mcp-Name task routing headers can be applied'
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
   * @returns A promise that resolves when the connection is established.
   */
  public async connect(reconnect: boolean = false): Promise<void> {
    const generation = this._connectionGeneration
    if (this._connectionPromise) {
      try {
        await this._connectionPromise
      } catch (error) {
        if (!reconnect) throw error
      }
      this._assertConnectionCurrent(generation)
      if (!reconnect) return
    }

    if (this._state !== 'disconnected' && !reconnect) return

    const connectionPromise = this._connect(reconnect)
    this._connectionPromise = connectionPromise
    try {
      await connectionPromise
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
      await this._client.close()
      this._assertConnectionCurrent(generation)
      this._state = 'disconnected'
    }

    if (this._elicitationCallback) {
      const callback = this._elicitationCallback
      this._client.setRequestHandler('elicitation/create', async (request, requestContext) => {
        return await callback(requestContext, request.params)
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
   * `RegExp` filters, under their server-side name.
   *
   * @param options - Overrides for the prefix and filters set on the client. An omitted field uses
   *                  the client's value; an explicit empty string or empty object disables it.
   * @returns A promise that resolves with an array of McpTool instances.
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

      if (shouldIncludeTool(tool, toolSpec.name, toolFilters)) tools.push(tool)
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
   * When the server returns a SEP-2663 task, this method handles input requests and
   * polls until the task reaches a terminal state. Direct tool results are returned
   * unchanged.
   *
   * @param tool - The McpTool instance to invoke.
   * @param args - The arguments to pass to the tool.
   * @param options - Optional settings for the request.
   * @returns The final tool result.
   * @throws {@link McpTaskCancelledError} When the server reports a cancelled task.
   * @throws {@link ProtocolError} When the task fails with a JSON-RPC error.
   */
  public async callTool(tool: McpTool, args: JSONValue, options?: McpCallToolOptions): Promise<JSONValue> {
    if (!this._tasksConfig) {
      const result = await this.callToolWithTask(tool, args, options)
      if (result.resultType === 'task') {
        throw new SdkError(SdkErrorCode.InvalidResult, 'MCP tools/call returned a task while tasksConfig is disabled')
      }
      return result as JSONValue
    }

    let operation = this._createTaskOperation(options?.signal, options?.timeoutMs ?? this._tasksConfig.timeoutMs)
    try {
      throwIfAborted(operation.signal)
      await raceWithAbort(this.connect(), operation.signal)
      if (this._client.getProtocolEra() === 'modern' && operation.deadline === Infinity) {
        operation.dispose()
        operation = this._createTaskOperation(options?.signal, McpClient.DEFAULT_POLL_TIMEOUT)
      }
      const outcome = await this._callToolWithTask(
        tool,
        args,
        { signal: operation.signal, timeoutMs: this._tasksConfig.requestTimeoutMs },
        operation,
        true
      )
      const initialResult = outcome.result
      if (initialResult.resultType !== 'task') return initialResult as JSONValue

      const result = await this._completeTask(initialResult, operation)
      const toolName = this._serverToolNames.get(tool) ?? tool.name
      await validateToolOutput(toolName, outcome.outputSchema, result)
      return result as JSONValue
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
  public async callToolWithTask(
    tool: McpTool,
    args: JSONValue,
    options?: McpCallToolOptions
  ): Promise<McpCallToolWithTaskResult> {
    const timeoutMs = options?.timeoutMs ?? this._tasksConfig?.requestTimeoutMs
    const operation = this._tasksConfig
      ? this._createTaskOperation(options?.signal, options?.timeoutMs ?? this._tasksConfig.maxTotalTimeoutMs)
      : undefined
    try {
      const signal = operation?.signal ?? options?.signal
      const outcome = await this._callToolWithTask(
        tool,
        args,
        {
          ...(signal && { signal }),
          ...(timeoutMs !== undefined && { timeoutMs }),
        },
        operation
      )
      return outcome.result
    } finally {
      operation?.dispose()
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
    const task = parseTaskResponse(result, McpGetTaskResultSchema.parse, 'tasks/get')
    if (task.taskId !== taskId) {
      throw new SdkError(SdkErrorCode.InvalidResult, 'MCP tasks/get response returned a different taskId')
    }
    return task
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
    if (!isRecord(inputResponses)) {
      throw new TypeError('MCP tasks/update inputResponses must be an object')
    }
    return parseTaskResponse(
      await this._requestTask('tasks/update', { taskId, inputResponses }, options),
      McpTaskAcknowledgementSchema.parse,
      'tasks/update'
    )
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
    return parseTaskResponse(
      await this._requestTask('tasks/cancel', { taskId }, options),
      McpTaskAcknowledgementSchema.parse,
      'tasks/cancel'
    )
  }

  private async _callToolWithTask(
    tool: McpTool,
    args: JSONValue,
    options: McpCallToolOptions,
    operation?: TaskOperation,
    completeLegacyTask = false
  ): Promise<McpToolCallOutcome> {
    if (operation) throwIfAborted(operation.signal)
    await (operation ? raceWithAbort(this.connect(), operation.signal) : this.connect())
    if (this._state === 'failed') throw new Error('MCP server failed to connect. Call connect(true) to retry.')

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
    const toolArgs = enhancedArgs as Record<string, unknown>

    const toolName = this._serverToolNames.get(tool) ?? tool.name
    const params = {
      name: toolName,
      arguments: toolArgs,
    }

    // The upstream codec rejects extension result types before custom result schemas run.
    if (completeLegacyTask && this._supportsLegacyTask(toolName)) {
      const outputSchema = compileToolOutputSchema(toolName, this._serverToolDefinitions.get(toolName)?.outputSchema)
      const result = await this._callLegacyTask(params, operation!)
      await validateToolOutput(toolName, outputSchema, result)
      return { result }
    }

    if (
      this._taskTransport &&
      this._client.getProtocolEra() === 'modern' &&
      this._client.getNegotiatedProtocolVersion() === TASKS_PROTOCOL_VERSION
    ) {
      return await this._invokeTaskTool(tool, params, operation!, options.timeoutMs!)
    }

    return {
      result: await this._client.callTool(params, {
        ...this._buildCallOptions(options),
        ...(options.signal && { signal: options.signal }),
        ...(options.timeoutMs !== undefined && {
          timeout: options.timeoutMs,
          maxTotalTimeout: operation
            ? remainingTime(operation.deadline, this._tasksConfig!.maxTotalTimeoutMs)
            : options.timeoutMs,
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

  private async _callLegacyTask(params: CallToolRequest['params'], operation: TaskOperation): Promise<CallToolResult> {
    const requestOptions = (): CallToolRequestOptions => ({
      ...this._buildCallOptions({ signal: operation.signal }),
      timeout: remainingTime(operation.deadline, this._tasksConfig!.requestTimeoutMs),
      maxTotalTimeout: remainingTime(operation.deadline, this._tasksConfig!.maxTotalTimeoutMs),
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
      if (state.status === 'failed')
        throw new Error(`MCP task failed${state.statusMessage ? `: ${state.statusMessage}` : ''}`)
      // tasks/result delivers queued server requests when a legacy task requires input.
      return await this._client.request(
        { method: 'tasks/result', params: { taskId: task.taskId } },
        specTypeSchemas.CallToolResult,
        requestOptions()
      )
    } catch (error) {
      if (
        state.status !== 'completed' &&
        state.status !== 'failed' &&
        state.status !== 'cancelled' &&
        this._state === 'connected' &&
        this._client.getServerCapabilities()?.tasks?.cancel !== undefined
      ) {
        void this._client
          .request({ method: 'tasks/cancel', params: { taskId: task.taskId } }, specTypeSchemas.CancelTaskResult, {
            timeout: Math.min(1_000, this._tasksConfig!.requestTimeoutMs),
          })
          .catch(() => undefined)
      }
      throw error
    }
  }

  private _buildCallOptions(options?: McpCallToolOptions): CallToolRequestOptions | undefined {
    const timeouts = this._requestTimeouts
    if (timeouts === undefined) return options
    return {
      ...(timeouts.timeout !== undefined && { timeout: timeouts.timeout }),
      ...(timeouts.maxTotalTimeout !== undefined && { maxTotalTimeout: timeouts.maxTotalTimeout }),
      ...(timeouts.resetTimeoutOnProgress !== undefined && {
        resetTimeoutOnProgress: timeouts.resetTimeoutOnProgress,
      }),
      // A progress token only goes on the wire when a progress handler is registered, which is
      // what makes resetTimeoutOnProgress take effect.
      ...(timeouts.resetTimeoutOnProgress && { onprogress: (): void => {} }),
      ...options,
    }
  }

  private async _invokeTaskTool(
    tool: McpTool,
    params: CallToolRequest['params'],
    operation: TaskOperation,
    requestTimeoutMs: number
  ): Promise<McpToolCallOutcome> {
    let toolDefinition: McpServerToolDefinition | undefined = this._serverToolDefinitions.get(params.name) ?? {
      ...(tool.toolSpec.inputSchema !== undefined && { inputSchema: tool.toolSpec.inputSchema }),
      ...(tool.toolSpec.outputSchema !== undefined && { outputSchema: tool.toolSpec.outputSchema }),
    }
    let outputSchema = compileToolOutputSchema(params.name, toolDefinition.outputSchema)
    const invoke = async (requestParams: CallToolRequest['params']): Promise<unknown> => {
      return await this._taskTransport!.request('tools/call', requestParams, {
        headers: isBrowserRuntime() ? {} : buildMcpParamHeaders(toolDefinition?.inputSchema, params.arguments ?? {}),
        signal: operation.signal,
        timeoutMs: remainingTime(operation.deadline, requestTimeoutMs),
        maxTotalTimeoutMs: remainingTime(operation.deadline, this._tasksConfig!.maxTotalTimeoutMs),
        resetTimeoutOnProgress: this._requestTimeouts?.resetTimeoutOnProgress ?? false,
      })
    }

    const invokeWithHeaderRefresh = async (requestParams: CallToolRequest['params']): Promise<unknown> => {
      try {
        return await invoke(requestParams)
      } catch (error) {
        if (isBrowserRuntime() || !(error instanceof ProtocolError) || error.code !== HEADER_MISMATCH_ERROR_CODE) {
          throw error
        }
        toolDefinition = await this._refreshServerToolDefinition(params.name, {
          signal: operation.signal,
          timeoutMs: remainingTime(operation.deadline, requestTimeoutMs),
        })
        outputSchema = compileToolOutputSchema(params.name, toolDefinition?.outputSchema)
        return await invoke(requestParams)
      }
    }

    let result = parseTaskResponse(
      await invokeWithHeaderRefresh(params),
      McpCallToolWithTaskResultSchema.parse,
      'tools/call'
    )
    let inputRequiredRounds = 0
    while (result.resultType === 'input_required') {
      inputRequiredRounds += 1
      if (inputRequiredRounds > MAX_INPUT_REQUIRED_ROUNDS) {
        throw new SdkError(
          SdkErrorCode.InputRequiredRoundsExceeded,
          `Multi-round-trip request 'tools/call' still required input after ${MAX_INPUT_REQUIRED_ROUNDS} rounds (inputRequired.maxRounds)`,
          {
            rounds: MAX_INPUT_REQUIRED_ROUNDS,
            lastResult: {
              inputRequests: result.inputRequests,
              ...(result.requestState !== undefined && { requestState: result.requestState }),
            },
          }
        )
      }

      const inputResponses = await this._fulfillToolInputRequests(result, operation.signal)
      const retryParams: CallToolRequest['params'] = {
        ...params,
        ...(inputResponses !== undefined && { inputResponses }),
        ...(result.requestState !== undefined && { requestState: result.requestState }),
      }
      result = parseTaskResponse(
        await invokeWithHeaderRefresh(retryParams),
        McpCallToolWithTaskResultSchema.parse,
        'tools/call'
      )
    }

    if (result.resultType === 'task') {
      this._assertTaskLifecycleAvailable()
    } else {
      await validateToolOutput(params.name, outputSchema, result)
    }
    return {
      result,
      ...(outputSchema && { outputSchema }),
    }
  }

  private async _refreshServerToolDefinition(
    toolName: string,
    options: McpCallToolOptions
  ): Promise<McpServerToolDefinition | undefined> {
    this._serverToolDefinitions.clear()
    try {
      const result = await this._client.listTools(undefined, {
        cacheMode: 'refresh',
        ...(options.signal && { signal: options.signal }),
        ...(options.timeoutMs !== undefined && { timeout: options.timeoutMs }),
      })
      this._serverToolDefinitions = new Map(result.tools.map((tool) => [tool.name, toMcpServerToolDefinition(tool)]))
    } catch (error) {
      logger.warn(`tool=<${toolName}>, error=<${error}> | failed to refresh tool definition after header mismatch`)
    }
    return this._serverToolDefinitions.get(toolName)
  }

  private async _requestTask(
    method: 'tasks/get' | 'tasks/update' | 'tasks/cancel',
    params: Record<string, unknown>,
    options?: McpTaskRequestOptions
  ): Promise<unknown> {
    const timeoutMs = options?.timeoutMs ?? this._tasksConfig?.requestTimeoutMs ?? McpClient.DEFAULT_TTL
    assertPositiveDuration(timeoutMs, 'MCP task request timeout')
    const operation = this._createTaskOperation(
      options?.signal,
      timeoutMs,
      new SdkError(SdkErrorCode.RequestTimeout, `MCP ${method} request timed out`, { method, timeoutMs })
    )
    try {
      throwIfAborted(operation.signal)
      await raceWithAbort(this.connect(), operation.signal)
      if (this._state === 'failed') throw new Error('MCP server failed to connect. Call connect(true) to retry.')
      this._assertTaskLifecycleAvailable()
      return await this._taskTransport!.request(method, params, {
        signal: operation.signal,
        timeoutMs: remainingTime(operation.deadline, timeoutMs),
      })
    } finally {
      operation.dispose()
    }
  }

  private _assertTaskLifecycleAvailable(): void {
    if (!this._tasksConfig || !this._taskTransport) {
      throw new Error('SEP-2663 task operations require McpClient tasksConfig')
    }
    if (
      this._client.getProtocolEra() !== 'modern' ||
      this._client.getNegotiatedProtocolVersion() !== TASKS_PROTOCOL_VERSION
    ) {
      throw new Error(`SEP-2663 task operations require negotiated MCP protocol ${TASKS_PROTOCOL_VERSION}`)
    }

    const extensions = this._client.getServerCapabilities()?.extensions
    if (!isRecord(extensions) || !isRecord(extensions[TASKS_EXTENSION])) {
      throw new Error(`MCP server did not advertise the ${TASKS_EXTENSION} extension`)
    }
  }

  private async _completeTask(task: McpCreateTaskResult, operation: TaskOperation): Promise<CallToolResult> {
    const channel: TaskNotificationChannel = {}
    this._taskNotificationChannels.set(task.taskId, channel)
    const subscriptionController = new AbortController()
    const forwardAbort = (): void => subscriptionController.abort(operation.signal.reason)
    operation.signal.addEventListener('abort', forwardAbort, { once: true })
    const subscriptionPromise = this._openTaskSubscription(
      task.taskId,
      subscriptionController.signal,
      operation.deadline
    )

    let current: McpCreateTaskResult | McpGetTaskResult = task
    const answeredInputKeys = new Set<string>()

    try {
      while (true) {
        throwIfAborted(operation.signal)

        if (current.resultType === 'complete') {
          if (isTerminalTaskStatus(current.status)) return taskTerminalResult(current)
          if (current.status === 'input_required') {
            current = await this._handleTaskInput(current, answeredInputKeys, operation)
            if (isTerminalTaskStatus(current.status)) return taskTerminalResult(current)
          }
        }

        const shouldPollImmediately = current.resultType === 'task' && current.status !== 'working'
        if (!shouldPollImmediately) {
          const interval = Math.max(
            MINIMUM_POLL_INTERVAL_MS,
            current.pollIntervalMs ?? this._tasksConfig!.pollIntervalMs
          )
          const notification = await this._waitForTaskNotification(task.taskId, interval, operation.signal)
          if (notification) {
            current = reconcileTaskState(current, notification)
            continue
          }
        }

        current = await this._pollTask(current, operation)
      }
    } catch (error) {
      if (!isTerminalTaskStatus(current.status)) void this._cancelAfterFailure(task.taskId)
      throw error
    } finally {
      operation.signal.removeEventListener('abort', forwardAbort)
      subscriptionController.abort()
      channel.wake?.()
      this._taskNotificationChannels.delete(task.taskId)
      const subscription = await subscriptionPromise
      await subscription?.close().catch(() => undefined)
    }
  }

  private async _handleTaskInput(
    task: McpGetTaskResult & { status: 'input_required'; inputRequests: McpInputRequests },
    answeredInputKeys: Set<string>,
    operation: TaskOperation
  ): Promise<McpGetTaskResult> {
    const controller = new AbortController()
    const signal = AbortSignal.any([operation.signal, controller.signal])
    let current: McpGetTaskResult = task
    const waitForTerminalState = async (): Promise<McpGetTaskResult> => {
      while (!isTerminalTaskStatus(current.status)) {
        const interval = Math.max(MINIMUM_POLL_INTERVAL_MS, current.pollIntervalMs ?? this._tasksConfig!.pollIntervalMs)
        const notification = await this._waitForTaskNotification(task.taskId, interval, signal)
        if (notification) {
          current = reconcileTaskState(current, notification)
        } else {
          current = await this._pollTask(current, { ...operation, signal })
        }
      }
      return current
    }

    try {
      return await Promise.race([
        waitForTerminalState(),
        this._respondToTaskInput(task, answeredInputKeys, { ...operation, signal }).then(() => current),
      ])
    } finally {
      controller.abort()
    }
  }

  private async _pollTask(
    task: McpCreateTaskResult | McpGetTaskResult,
    operation: TaskOperation
  ): Promise<McpGetTaskResult> {
    throwIfAborted(operation.signal)
    const controller = new AbortController()
    const signal = AbortSignal.any([operation.signal, controller.signal])
    const channel = this._taskNotificationChannels.get(task.taskId)!
    let current = task
    let notificationTimer: ReturnType<typeof setTimeout> | undefined
    let wake: () => void
    const terminalNotification = new Promise<McpGetTaskResult>((resolve, reject) => {
      wake = (): void => {
        const notification = this._takeTaskNotification(task.taskId)
        if (!notification) return
        try {
          const next = reconcileTaskState(current, notification)
          current = next
          if (isTerminalTaskStatus(next.status) && notificationTimer === undefined) {
            // Reconcile any poll response already being delivered before cancelling that request.
            notificationTimer = setTimeout(() => resolve(next), 0)
          }
        } catch (error) {
          reject(error)
        }
      }
      channel.wake = wake
    })

    try {
      channel.wake?.()
      return await Promise.race([
        this.getTask(task.taskId, {
          signal,
          timeoutMs: remainingTime(operation.deadline, this._tasksConfig!.requestTimeoutMs),
        }).then((polled) => {
          const next = reconcileTaskState(current, polled)
          const queued = this._takeTaskNotification(task.taskId)
          return queued ? reconcileTaskState(next, queued) : next
        }),
        terminalNotification,
      ])
    } finally {
      controller.abort()
      clearTimeout(notificationTimer)
      if (channel.wake === wake!) delete channel.wake
    }
  }

  private async _respondToTaskInput(
    task: McpGetTaskResult & { status: 'input_required'; inputRequests: McpInputRequests },
    answeredInputKeys: Set<string>,
    operation: TaskOperation
  ): Promise<void> {
    for (const [key, request] of Object.entries(task.inputRequests)) {
      if (answeredInputKeys.has(key)) continue
      throwIfAborted(operation.signal)

      const response = await this._fulfillInputRequest(
        request,
        key,
        createInputContext(
          this._client,
          this._transport,
          `task:${task.taskId}:${key}`,
          request.method,
          operation.signal,
          request.params?._meta
        ),
        'task'
      )
      await this.updateTask(
        task.taskId,
        { [key]: response },
        {
          signal: operation.signal,
          timeoutMs: remainingTime(operation.deadline, this._tasksConfig!.requestTimeoutMs),
        }
      )
      answeredInputKeys.add(key)
    }
  }

  private async _fulfillToolInputRequests(
    result: McpInputRequiredResult,
    outerSignal: AbortSignal
  ): Promise<McpInputResponses | undefined> {
    const entries = Object.entries(result.inputRequests ?? {})
    if (entries.length === 0) {
      await abortableDelay(REQUEST_STATE_ONLY_RETRY_DELAY_MS, outerSignal)
      return undefined
    }

    const roundController = new AbortController()
    const signal = AbortSignal.any([outerSignal, roundController.signal])
    const fulfilled = await Promise.all(
      entries.map(async ([key, request]) => {
        try {
          return [
            key,
            await this._fulfillInputRequest(
              request,
              key,
              createInputContext(undefined, this._transport, key, request.method, signal, request.params?._meta),
              'tool call'
            ),
          ] as const
        } catch (error) {
          roundController.abort(error)
          throw error
        }
      })
    )
    return Object.fromEntries(fulfilled)
  }

  private async _fulfillInputRequest(
    request: McpInputRequests[string],
    key: string,
    elicitationContext: ElicitationContext,
    source: 'task' | 'tool call'
  ): Promise<McpInputResponses[string]> {
    throwIfAborted(elicitationContext.mcpReq.signal)
    const response = await raceWithAbort(
      this._client.fulfillInputRequest(request, elicitationContext),
      elicitationContext.mcpReq.signal
    )
    const parsed = McpInputResponsesSchema.safeParse({ [key]: response })
    if (!parsed.success || (request.method === 'roots/list' && !isSpecType.ListRootsResult(response))) {
      throw new SdkError(SdkErrorCode.InvalidResult, `MCP ${source} input callback returned a malformed response`)
    }
    return parsed.data[key]!
  }

  private async _openTaskSubscription(
    taskId: string,
    signal: AbortSignal,
    deadline: number
  ): Promise<McpSubscription | undefined> {
    if (!this._tasksConfig?.useNotifications) return undefined

    try {
      return await this._client.listen({ taskIds: [taskId] } as SubscriptionFilter, {
        signal,
        timeout: remainingTime(deadline, this._tasksConfig.requestTimeoutMs),
      })
    } catch {
      return undefined
    }
  }

  private _handleTaskNotification(params: unknown): void {
    if (!isRecord(params) || typeof params.taskId !== 'string') return
    const channel = this._taskNotificationChannels.get(params.taskId)
    if (!channel) return

    try {
      channel.latest = McpTaskStatusNotificationSchema.parse(params)
      channel.wake?.()
    } catch {
      logger.warn('notification=<notifications/tasks> | ignored malformed MCP task notification')
    }
  }

  private _takeTaskNotification(taskId: string): McpGetTaskResult | undefined {
    const channel = this._taskNotificationChannels.get(taskId)
    const latest = channel?.latest
    if (channel) delete channel.latest
    return latest
  }

  private async _waitForTaskNotification(
    taskId: string,
    delayMs: number,
    signal: AbortSignal
  ): Promise<McpGetTaskResult | undefined> {
    const queued = this._takeTaskNotification(taskId)
    if (queued) return queued

    const channel = this._taskNotificationChannels.get(taskId)
    if (!channel) return await abortableDelay(delayMs, signal)
    const activeChannel = channel

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(finish, Math.min(delayMs, MAX_TIMER_DELAY_MS))
      const abort = (): void => {
        cleanup()
        reject(abortReason(signal))
      }
      function cleanup(): void {
        clearTimeout(timeout)
        signal.removeEventListener('abort', abort)
        delete activeChannel.wake
      }
      function finish(): void {
        cleanup()
        resolve()
      }

      activeChannel.wake = finish
      if (signal.aborted) {
        abort()
      } else {
        signal.addEventListener('abort', abort, { once: true })
      }
    })
    return this._takeTaskNotification(taskId)
  }

  private async _cancelAfterFailure(taskId: string): Promise<void> {
    if (this._state !== 'connected') return
    try {
      await this.cancelTask(taskId, {
        timeoutMs: Math.min(1_000, this._tasksConfig!.requestTimeoutMs),
      })
    } catch {
      // Cleanup must not replace the original failure.
    }
  }

  private _createTaskOperation(
    externalSignal: AbortSignal | undefined,
    timeoutMs: number | undefined,
    timeoutError?: Error
  ): TaskOperation {
    if (timeoutMs !== undefined) assertPositiveDuration(timeoutMs, 'MCP task overall timeout')
    const controller = new AbortController()
    this._taskControllers.add(controller)
    const deadline = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs
    const abortFromExternal = (): void => controller.abort(abortReason(externalSignal))
    const timeout =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            controller.abort(
              timeoutError ??
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

  public async fulfillInputRequest(request: McpInputRequests[string], context: ElicitationContext): Promise<unknown> {
    const handler = this._getRequestHandler(request.method)
    if (!handler) {
      throw new SdkError(
        SdkErrorCode.CapabilityNotSupported,
        `No MCP input handler is registered for "${request.method}"`
      )
    }
    return await handler({ ...request, jsonrpc: '2.0', id: context.mcpReq.id }, context)
  }
}

function resolveTasksConfig(
  config: TasksConfig | undefined,
  requestTimeouts?: McpRequestTimeouts
): ResolvedTasksConfig | undefined {
  if (config === undefined) return undefined

  const resolved = {
    timeoutMs: config.timeoutMs,
    maxTotalTimeoutMs: config.pollTimeout ?? requestTimeouts?.maxTotalTimeout ?? McpClient.DEFAULT_POLL_TIMEOUT,
    requestTimeoutMs: config.ttl ?? requestTimeouts?.timeout ?? McpClient.DEFAULT_TTL,
    pollIntervalMs: config.pollIntervalMs ?? McpClient.DEFAULT_POLL_INTERVAL_MS,
    useNotifications: config.useNotifications ?? true,
  }
  if (resolved.timeoutMs !== undefined) assertPositiveDuration(resolved.timeoutMs, 'MCP task overall timeout')
  assertPositiveDuration(resolved.maxTotalTimeoutMs, 'MCP task request maximum timeout')
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

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal)
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

function reconcileTaskState(
  previous: McpCreateTaskResult | McpGetTaskResult,
  next: McpGetTaskResult
): McpGetTaskResult {
  if (next.taskId !== previous.taskId) {
    throw new SdkError(SdkErrorCode.InvalidResult, 'MCP task response changed taskId')
  }
  if (next.createdAt !== previous.createdAt) {
    throw new SdkError(SdkErrorCode.InvalidResult, 'MCP task response changed createdAt')
  }

  const previousUpdatedAt = Date.parse(previous.lastUpdatedAt)
  const nextUpdatedAt = Date.parse(next.lastUpdatedAt)
  if (nextUpdatedAt < previousUpdatedAt) {
    if (previous.resultType === 'complete') return previous
    throw new SdkError(SdkErrorCode.InvalidResult, 'MCP task response predates the task handle')
  }

  if (isTerminalTaskStatus(previous.status)) {
    if (previous.status !== next.status || (previous.resultType === 'complete' && !sameTaskState(previous, next))) {
      throw new SdkError(SdkErrorCode.InvalidResult, 'MCP task changed after reaching a terminal state')
    }
    if (previous.resultType === 'complete') return previous
  }

  // Task timestamps can have coarser precision than state transitions, so equality alone cannot
  // distinguish a valid transition from a contradiction.
  return next
}

function taskTerminalResult(task: McpGetTaskResult): CallToolResult {
  if (task.status === 'completed') return task.result
  if (task.status === 'cancelled') throw new McpTaskCancelledError(task.statusMessage)
  if (task.status === 'failed') {
    const message = task.statusMessage ? `${task.error.message}: ${task.statusMessage}` : task.error.message
    throw ProtocolError.fromError(task.error.code, message, task.error.data)
  }
  throw new SdkError(SdkErrorCode.InvalidResult, `MCP task status "${task.status}" is not terminal`)
}

function isTerminalTaskStatus(status: McpTaskStatus): status is 'completed' | 'failed' | 'cancelled' {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function sameTaskState(left: McpGetTaskResult, right: McpGetTaskResult): boolean {
  const leftState = { ...left }
  const rightState = { ...right }
  delete leftState._meta
  delete rightState._meta
  return sameJson(leftState, rightState)
}

function sameJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => sameJson(value, right[index]))
  }
  if (!isRecord(left) || !isRecord(right)) return false

  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && sameJson(left[key], right[key]))
  )
}

function assertTaskId(taskId: string): void {
  if (taskId.length === 0) throw new TypeError('MCP taskId must not be empty')
}

function assertPositiveDuration(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
    throw new TypeError(`${name} must be a positive safe integer no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}

function parseTaskResponse<Result>(value: unknown, parse: (value: unknown) => Result, operation: string): Result {
  try {
    return parse(value)
  } catch {
    throw new SdkError(SdkErrorCode.InvalidResult, `MCP ${operation} returned a malformed SEP-2663 response`)
  }
}

function createInputContext(
  client: Client | undefined,
  transport: McpTransport,
  id: string,
  method: string,
  signal: AbortSignal,
  requestMeta: RequestMeta | undefined
): ClientContext {
  const unavailable = async (): Promise<never> => {
    throw new SdkError(SdkErrorCode.SendFailed, 'Related messaging is unavailable for an embedded MCP input request')
  }
  return {
    ...(transport.sessionId && { sessionId: transport.sessionId }),
    mcpReq: {
      id,
      method,
      signal,
      ...(requestMeta && { _meta: requestMeta }),
      requestState: (): undefined => undefined,
      send: client ? client.request.bind(client) : unavailable,
      notify: client ? client.notification.bind(client) : unavailable,
    },
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

function isBrowserRuntime(): boolean {
  return globalThis.window !== undefined && globalThis.document !== undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
