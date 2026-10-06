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
import type { ElicitationCallback } from '../types/elicitation.js'
import { McpTool } from '../tools/mcp-tool.js'
import { MAX_TOOL_NAME_LENGTH } from '../registry/tool-registry.js'
import { ToolValidationError } from '../errors.js'
import { logger } from '../logging/index.js'
import { type McpLoadServersOptions, type McpServerConfig, mcpServerLoader } from './config.js'

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

  /** Polling delay in milliseconds when the server omits its polling interval. Defaults to 1000. */
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

  public constructor(statusMessage?: string) {
    super(statusMessage ? `MCP task failed: ${statusMessage}` : 'MCP task failed')
    this.name = 'McpTaskFailedError'
    this.statusMessage = statusMessage
  }
}

/** Options for MCP tool invocation. */
export interface McpCallToolOptions {
  /** AbortSignal to cancel the in-flight request. */
  signal?: AbortSignal
  /** Overall time limit in milliseconds for this call. Overrides `tasksConfig.pollTimeout` when tasks are configured. */
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
  private _state: McpConnectionState
  private _client: Client
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
    }

    this._transport = McpClient._resolveTransport(args)

    this._client = new Client(
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
   * When `tasksConfig` is set and a legacy (2025-11-25) server executes the tool as a task,
   * this method polls until the task reaches a terminal state and returns the final result.
   * Direct tool results are returned unchanged.
   *
   * @param tool - The McpTool instance to invoke.
   * @param args - The arguments to pass to the tool.
   * @param options - Optional settings for the request.
   * @returns The final tool result.
   * @throws {@link McpTaskCancelledError} When the server reports a cancelled task.
   * @throws {@link McpTaskFailedError} When a legacy task reports the `failed` status.
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

  private async _invokeTool(
    tool: McpTool,
    args: JSONValue,
    options: McpCallToolOptions,
    operation?: TaskOperation,
    completeLegacyTask = false
  ): Promise<McpToolCallOutcome> {
    await this.connect(false, operation ? { signal: operation.signal } : undefined)
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
