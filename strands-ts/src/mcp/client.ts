import {
  Client,
  ClientCredentialsProvider,
  StreamableHTTPClientTransport,
  type CallToolRequestOptions,
  type Transport,
  type OAuthClientProvider,
  type ServerCapabilities,
  type Implementation,
  type LoggingMessageNotificationParams,
} from '@modelcontextprotocol/client'
import { context, propagation, trace } from '@opentelemetry/api'
import type { JSONSchema, JSONValue } from '../types/json.js'
import type { ElicitationCallback } from '../types/elicitation.js'
import { McpTool } from '../tools/mcp-tool.js'
import { logger } from '../logging/index.js'
import { type McpLoadServersOptions, type McpServerConfig, mcpServerLoader } from './config.js'

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

/**
 * Configuration for MCP task-augmented tool execution.
 *
 * WARNING: MCP Tasks is an experimental feature in both the MCP specification and this SDK.
 * The API may change without notice in future versions.
 *
 * Task-augmented execution is temporarily unavailable while task support is rebuilt on the
 * MCP tasks extension (https://github.com/strands-agents/harness-sdk/issues/1659). A client
 * constructed with `tasksConfig` throws from {@link McpClient.callTool}. Use
 * {@link McpClientOptions.requestTimeouts} to keep long-running tool calls alive meanwhile.
 */
export interface TasksConfig {
  /** Time-to-live in milliseconds for task polling. */
  ttl?: number

  /** Maximum time in milliseconds to wait for task completion during polling. */
  pollTimeout?: number
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

/** A progress update reported by an MCP server during a tool call. */
export interface McpProgress {
  /** Amount of work completed so far. Increases even when the total is unknown. */
  progress: number

  /** Total amount of work, when the server reports one. */
  total?: number | undefined

  /** Human-readable description of the current progress, when the server provides one. */
  message?: string | undefined
}

/** Callback receiving progress notifications during a tool call. May be async. A throw or rejection is logged as a warning. */
export type McpProgressCallback = (progress: McpProgress) => void

/** Options for MCP tool invocation. */
export interface McpCallToolOptions {
  /** AbortSignal to cancel the in-flight request. */
  signal?: AbortSignal

  /** Callback for progress notifications during this call. Takes precedence over the client's callback. */
  progressCallback?: McpProgressCallback
}

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

/** Behavioral options shared by all MCP client configurations. */
export interface McpClientOptions extends RuntimeConfig {
  /** Disable OpenTelemetry MCP instrumentation. */
  disableMcpInstrumentation?: boolean

  /** Prefix for agent-facing tool names, applied as `<prefix>_<toolName>`. */
  prefix?: string

  /** Filters controlling which tools this client exposes. */
  toolFilters?: McpToolFilters

  /**
   * Configuration for task-augmented tool execution (experimental).
   *
   * Temporarily unavailable while task support is rebuilt on the MCP tasks extension
   * (https://github.com/strands-agents/harness-sdk/issues/1659). When set, `callTool` throws.
   * Use `requestTimeouts` to keep long-running tool calls alive meanwhile.
   */
  tasksConfig?: TasksConfig

  /** Request timeouts applied to every tool call. Per-call options take precedence on overlap. */
  requestTimeouts?: McpRequestTimeouts

  /**
   * Callback for progress notifications during tool calls. Fires for every tool call this
   * client runs, including calls an agent makes, not only direct `callTool` calls. The
   * `total` and `message` fields may be absent when the server does not provide them. A
   * per-call `progressCallback` takes precedence.
   */
  progressCallback?: McpProgressCallback

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

/** MCP Client for interacting with Model Context Protocol servers. */
export class McpClient {
  /**
   * Default TTL for task polling in milliseconds (60 seconds).
   *
   * Unused while task support is rebuilt on the MCP tasks extension (#1659). See `requestTimeouts`.
   */
  public static readonly DEFAULT_TTL = 60000

  /**
   * Default poll timeout for task completion in milliseconds (5 minutes).
   *
   * Unused while task support is rebuilt on the MCP tasks extension (#1659). See `requestTimeouts`.
   */
  public static readonly DEFAULT_POLL_TIMEOUT = 300000

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
    return (await mcpServerLoader.get()(config, defaults, options)).map((c) => new McpClient(c))
  }

  private _clientName: string
  private _clientVersion: string
  private _transport: Transport
  private _state: McpConnectionState
  private _client: Client
  private _continueOnError: boolean
  private _logHandler: (params: LoggingMessageNotificationParams) => void
  private _disableMcpInstrumentation: boolean
  private _tasksConfig: TasksConfig | undefined
  private _requestTimeouts: McpRequestTimeouts | undefined
  private _progressCallback: McpProgressCallback | undefined
  private _elicitationCallback: ElicitationCallback | undefined
  private _prefix: string | undefined
  private _toolFilters: McpToolFilters | undefined
  /** Server-side name of each listed tool, which differs from `tool.name` when a prefix is set. */
  private _serverToolNames = new WeakMap<McpTool, string>()
  private _registeredToolNames = new Set<string>()
  private _onToolsChanged: ((oldTools: string[], newTools: McpTool[]) => void) | undefined
  private _refreshingTools = false
  private _pendingRefresh = false

  constructor(args: McpClientConfig) {
    this._clientName = args.applicationName || 'strands-agents-ts-sdk'
    this._clientVersion = args.applicationVersion || '0.0.1'
    this._transport = McpClient._resolveTransport(args)
    this._state = 'disconnected'
    this._continueOnError = args.continueOnError ?? false
    this._logHandler = args.logHandler ?? defaultLogHandler
    this._tasksConfig = args.tasksConfig
    this._requestTimeouts = args.requestTimeouts
    this._progressCallback = args.progressCallback
    this._elicitationCallback = args.elicitationCallback
    this._prefix = args.prefix
    this._toolFilters = args.toolFilters
    this._client = new Client(
      {
        name: this._clientName,
        version: this._clientVersion,
      },
      {
        ...(this._elicitationCallback ? { capabilities: { elicitation: { form: {}, url: {} } } } : undefined),
        // Probe for protocol revision 2026-07-28 and fall back to the legacy initialize
        // handshake, mirroring the Python SDK's negotiate_auto posture.
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

    if (this._tasksConfig !== undefined) {
      logger.warn(
        `client=<${this._clientName}> | tasksConfig is set but task-augmented execution is temporarily unavailable (#1659), callTool will throw | use requestTimeouts for long-running tools`
      )
    }
  }

  private static _resolveTransport(args: McpClientConfig): Transport {
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
      return args.transport as Transport
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
    }) as Transport
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
    if (this._state !== 'disconnected' && !reconnect) return

    if (this._state === 'connected' && reconnect) {
      await this._client.close()
      this._state = 'disconnected'
    }

    if (this._elicitationCallback) {
      const callback = this._elicitationCallback
      this._client.setRequestHandler('elicitation/create', async (request, requestContext) => {
        return await callback(requestContext, request.params)
      })
    }

    try {
      await this._client.connect(this._transport)
      this._state = 'connected'
    } catch (error) {
      if (!this._continueOnError) throw error
      this._state = 'failed'
      logger.warn(
        `client=<${this._clientName}>, error=<${error}> | MCP server failed to connect, continuing (continueOnError)`
      )
    }
  }

  /**
   * Disconnects the MCP client from the server and cleans up resources.
   *
   * @returns A promise that resolves when the disconnection is complete.
   */
  public async disconnect(): Promise<void> {
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
    let cursor: string | undefined

    do {
      const result = await this._client.listTools(cursor ? { cursor } : undefined)

      for (const toolSpec of result.tools) {
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

      cursor = result.nextCursor
    } while (cursor)

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
   * The client's `requestTimeouts` apply to the call; per-call options take precedence on overlap.
   *
   * @param tool - The McpTool instance to invoke.
   * @param args - The arguments to pass to the tool.
   * @param options - Optional settings for the request.
   * @returns A promise that resolves with the result of the tool invocation.
   * @throws Error when the client was constructed with `tasksConfig`: task-augmented execution
   *         is temporarily unavailable while task support is rebuilt on the MCP tasks extension
   *         (https://github.com/strands-agents/harness-sdk/issues/1659).
   */
  public async callTool(tool: McpTool, args: JSONValue, options?: McpCallToolOptions): Promise<JSONValue> {
    if (this._tasksConfig !== undefined) {
      throw new Error(
        'MCP task-augmented execution is temporarily unavailable while task support is rebuilt ' +
          'on the MCP tasks extension (https://github.com/strands-agents/harness-sdk/issues/1659). ' +
          'Unset tasksConfig to call tools now. Use requestTimeouts to keep long-running tool calls alive.'
      )
    }

    await this.connect()
    if (this._state === 'failed') throw new Error('MCP server failed to connect. Call connect(true) to retry.')

    if (args === null || args === undefined) {
      return await this.callTool(tool, {}, options)
    }

    if (typeof args !== 'object' || Array.isArray(args)) {
      throw new Error(
        `MCP Protocol Error: Tool arguments must be a JSON Object (named parameters). Received: ${Array.isArray(args) ? 'Array' : typeof args}`
      )
    }

    // Inject OpenTelemetry trace context into tool arguments for distributed tracing
    const enhancedArgs = this._disableMcpInstrumentation ? args : injectTraceContext(args)
    const toolArgs = enhancedArgs as Record<string, unknown>

    // When tasksConfig is undefined, call tools directly without task management
    // Use the server-side name for server communication; tool.name may carry a prefix.
    const toolName = this._serverToolNames.get(tool) ?? tool.name

    return (await this._client.callTool(
      { name: toolName, arguments: toolArgs },
      this._buildCallOptions(options)
    )) as JSONValue
  }

  private _buildCallOptions(options?: McpCallToolOptions): CallToolRequestOptions | undefined {
    const timeouts = this._requestTimeouts
    const onprogress = this._buildProgressHandler(options)
    const callOptions: CallToolRequestOptions = {
      ...(timeouts?.timeout !== undefined && { timeout: timeouts.timeout }),
      ...(timeouts?.maxTotalTimeout !== undefined && { maxTotalTimeout: timeouts.maxTotalTimeout }),
      ...(timeouts?.resetTimeoutOnProgress !== undefined && {
        resetTimeoutOnProgress: timeouts.resetTimeoutOnProgress,
      }),
      ...(onprogress && { onprogress }),
      ...(options?.signal && { signal: options.signal }),
    }
    return Object.keys(callOptions).length > 0 ? callOptions : undefined
  }

  private _buildProgressHandler(options?: McpCallToolOptions): ((progress: McpProgress) => void) | undefined {
    const progressCallback = options?.progressCallback ?? this._progressCallback
    if (!progressCallback) {
      // A progress token only goes on the wire when a progress handler is registered, which is
      // what makes resetTimeoutOnProgress take effect. Without a user callback a no-op stands in.
      return this._requestTimeouts?.resetTimeoutOnProgress ? (): void => {} : undefined
    }
    // The vendor client discards handler failures (a sync throw goes to the unset onerror and a
    // rejected promise becomes an unhandled rejection), so failures are logged here instead.
    return (progress: McpProgress): void => {
      void Promise.resolve()
        .then(() => progressCallback(progress))
        .catch((error: unknown) => {
          logger.warn(`client=<${this._clientName}>, error=<${String(error)}> | progress callback failed`)
        })
    }
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
