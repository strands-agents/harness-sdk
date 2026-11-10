import type { Transport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { McpClient, type McpServerConfig, type McpToolFilters } from '@strands-agents/sdk'

import { readMcpDefinitions, type LoadMcpOptions } from '../config/mcp.js'
import { HARNESS_VERSION, SDK_VERSION } from '../package-version.js'
import { errorMessage, sanitizeTerminalText } from '../terminal/text.js'

export { defaultMcpPaths, projectMcpPaths, readMcpDefinitions, type LoadMcpOptions } from '../config/mcp.js'

export interface McpServerInfo {
  name: string
  transport: 'stdio' | 'sse' | 'streamable-http'
  target: string
  state: 'disconnected' | 'connected' | 'failed' | 'disabled'
  toolCount?: number
  /** Why the last connection attempt failed. */
  error?: string
  source?: string
  /** A client exists that can reconnect using the loaded configuration. */
  canRetry?: boolean
}

export interface McpStartupProgress {
  total: number
  connected: number
  failed: number
}

/** Live progress of the background connections `backgroundConnect` started. */
export interface McpStartup {
  progress(): McpStartupProgress
  subscribe(listener: () => void): () => void
}

export interface LoadedMcp {
  readonly clients: readonly McpClient[]
  readonly paths: readonly string[]
  /** Configuration the harness skipped rather than failed on: problems in another tool's files. */
  readonly warnings: readonly string[]
  /** Present when `backgroundConnect` deferred the connections. */
  readonly startup?: McpStartup
  /** Observes deferred and server-initiated tool changes after the agent registry updates. */
  subscribeTools?(listener: () => void): () => void
  list(connect?: boolean): Promise<readonly McpServerInfo[]>
  /**
   * Connects or disconnects a server and registers/withdraws its tools on the live agent.
   * Resolves to an error message when enabling fails. Only available with `backgroundConnect`.
   */
  setEnabled?(name: string, enabled: boolean): Promise<string | undefined>
  dispose(): Promise<void>
}

export async function loadMcp(
  options: LoadMcpOptions & { backgroundConnect?: boolean; disabledServers?: readonly string[] } = {}
): Promise<LoadedMcp> {
  const { definitions, sources, paths, warnings } = await readMcpDefinitions(options)
  const clientErrors = new Map<string, string>()
  const clientsByName = new Map(
    await Promise.all(
      Object.entries(definitions).map(async ([name, definition]) => {
        try {
          return [name, await createClient(name, definition)] as const
        } catch (error) {
          if (!definition.continueOnError) {
            throw error
          }
          clientErrors.set(name, errorMessage(error))
          return [name, undefined] as const
        }
      })
    )
  )
  const disabledServers = new Set(options.disabledServers ?? [])
  const clients = [...clientsByName.entries()]
    .filter(([name, client]) => client !== undefined && (options.backgroundConnect || !disabledServers.has(name)))
    .map(([, client]) => client!)
  let startup: McpStartup | undefined
  const toolListeners = new Set<() => void>()
  const notifyTools = (): void => {
    for (const listener of toolListeners) listener()
  }
  const deferredByName = new Map<string, DeferredConnection>()
  if (options.backgroundConnect) {
    const listeners = new Set<() => void>()
    const notify = (): void => {
      for (const listener of listeners) {
        listener()
      }
    }
    const progress: McpStartupProgress = { total: 0, connected: 0, failed: 0 }
    for (const [name, client] of clientsByName) {
      if (!client) {
        // A server whose client could not be constructed failed before connecting.
        if (!disabledServers.has(name)) {
          progress.total += 1
          progress.failed += 1
        }
        continue
      }
      const definition = definitions[name]!
      const deferred = deferConnection(
        client,
        !disabledServers.has(name),
        notifyTools,
        transportType(definition) === 'stdio'
          ? undefined
          : (): Promise<void> => refreshRemoteTransport(client, name, definition)
      )
      deferredByName.set(name, deferred)
      if (!deferred.settled) {
        continue
      }
      progress.total += 1
      void deferred.settled.then((connected) => {
        progress[connected ? 'connected' : 'failed'] += 1
        notify()
      })
    }
    startup = {
      progress: (): McpStartupProgress => ({ ...progress }),
      subscribe: (listener): (() => void) => {
        listeners.add(listener)
        return (): void => {
          listeners.delete(listener)
        }
      },
    }
  }
  return {
    clients,
    ...(startup
      ? {
          startup,
          subscribeTools(listener: () => void): () => void {
            toolListeners.add(listener)
            return (): void => {
              toolListeners.delete(listener)
            }
          },
        }
      : {}),
    paths: paths.map(sanitizeTerminalText),
    warnings: warnings.map(sanitizeTerminalText),
    async list(connect = false): Promise<readonly McpServerInfo[]> {
      return Promise.all(
        Object.entries(definitions).map(async ([name, definition]) => {
          const client = clientsByName.get(name)
          const deferred = deferredByName.get(name)
          const disabled = deferred ? deferred.disabled() : disabledServers.has(name)
          if (connect && client && !disabled) {
            await client.connect().catch(() => undefined)
          }
          const tools =
            !disabled && connect && client?.connectionState === 'connected' ? await client.listTools() : undefined
          const error = deferred?.lastError() ?? clientErrors.get(name)
          return {
            name,
            transport: transportType(definition),
            target: sanitizeTerminalText(definition.command ?? definition.url ?? 'invalid configuration'),
            state: disabled ? 'disabled' : (client?.connectionState ?? 'failed'),
            source: sanitizeTerminalText(sources[name]!),
            canRetry: deferred !== undefined,
            ...(tools ? { toolCount: tools.length } : {}),
            ...(error && !disabled && client?.connectionState !== 'connected'
              ? { error: sanitizeTerminalText(error) }
              : {}),
          }
        })
      )
    },
    async setEnabled(name, enabled): Promise<string | undefined> {
      const deferred = deferredByName.get(name)
      if (!deferred) {
        if (name in definitions) {
          if (!enabled) {
            disabledServers.add(name)
            return undefined
          }
          disabledServers.delete(name)
          return clientErrors.get(name) ?? `Restart Strands to reconnect ${name}.`
        }
        return `No connection for ${name}.`
      }
      return enabled ? deferred.enable() : deferred.disable()
    },
    async dispose(): Promise<void> {
      toolListeners.clear()
      await Promise.allSettled(
        [...clientsByName].map(([name, client]) => deferredByName.get(name)?.disable() ?? client?.disconnect())
      )
    },
  }
}

const CLIENT_DEFAULTS = { applicationVersion: HARNESS_VERSION }

type McpTools = Awaited<ReturnType<McpClient['listTools']>>
type ToolsChangedCallback = (oldTools: string[], newTools: McpTools) => void

interface DeferredConnection {
  /** Settles with whether the launch connection ended up connected. Absent for a disabled server. */
  settled?: Promise<boolean>
  disabled(): boolean
  lastError(): string | undefined
  /** Connects and registers the server's tools; resolves to an error message on failure. */
  enable(): Promise<string | undefined>
  /** Disconnects and withdraws the server's tools. */
  disable(): Promise<undefined>
}

/**
 * `Agent.initialize()` awaits `listTools()` on every MCP client, so one unresponsive server (for
 * example a stdio server waiting on a companion app) stalls startup until the MCP request timeout.
 * Deferral starts the connection immediately, answers `listTools()` with no tools while the
 * connection is in flight, and delivers the real list through `onToolsChanged` when it lands —
 * the same callback the agent's tool registry already tracks for server-initiated tool changes.
 */
function deferConnection(
  client: McpClient,
  autoConnect: boolean,
  notifyTools: () => void,
  refreshTransport?: () => Promise<void>
): DeferredConnection {
  const baseListTools = client.listTools.bind(client)
  const baseConnect = client.connect.bind(client)
  const baseDisconnect = client.disconnect.bind(client)
  let connecting: Promise<void> | undefined
  let connectionAttempted = false
  let connectionGeneration = 0
  let toolsChanged: ToolsChangedCallback | undefined
  let pendingTools: McpTools | undefined
  let delivered: string[] = []
  let disabled = !autoConnect
  let lastError: string | undefined

  const recordFailure = (error: unknown): void => {
    if (disabled) return
    lastError = errorMessage(error)
  }
  const observeErrors = (protocol: McpClient['client']): McpClient['client'] => {
    const connect = protocol.connect.bind(protocol)
    protocol.connect = async (...args): Promise<void> => {
      try {
        await connect(...args)
      } catch (error) {
        recordFailure(error)
        throw error
      }
    }
    return protocol
  }
  observeErrors(client.client)
  // URL retries rebuild the SDK's protocol client; keep reporting failures after each rebuild.
  const createProtocolClient = Reflect.get(client, '_createClient').bind(client) as () => McpClient['client']
  Reflect.set(client, '_createClient', () => observeErrors(createProtocolClient()))

  client.connect = (reconnect = false, options): Promise<void> => {
    const signal = options?.signal
    if (signal?.aborted) {
      return baseConnect(reconnect, options)
    }
    if (!connecting) {
      if (!reconnect && client.connectionState !== 'disconnected') {
        return baseConnect(false, options)
      }
      const generation = connectionGeneration
      connecting = (async (): Promise<void> => {
        if (connectionAttempted && refreshTransport) {
          if (client.connectionState !== 'disconnected') await baseDisconnect()
          await refreshTransport()
        }
        if (generation !== connectionGeneration) return
        connectionAttempted = true
        try {
          await baseConnect(reconnect)
        } finally {
          if (generation !== connectionGeneration) await baseDisconnect()
        }
      })().finally(() => {
        connecting = undefined
      })
    }
    if (!signal) return connecting
    return new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        signal.removeEventListener('abort', abort)
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new globalThis.DOMException('The operation was aborted', 'AbortError')
        )
      }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      void connecting!.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
  }

  client.disconnect = async (): Promise<void> => {
    connectionGeneration += 1
    const pending = connecting
    await baseDisconnect()
    await pending?.catch(() => undefined)
  }

  // Capture the agent's subscription so tools that arrive before it exists are not dropped.
  Object.defineProperty(client, 'onToolsChanged', {
    configurable: true,
    set(callback: ToolsChangedCallback | undefined) {
      toolsChanged = callback
        ? (oldTools, newTools): void => {
            callback(oldTools, newTools)
            delivered = newTools.map((tool) => tool.name)
            notifyTools()
          }
        : undefined
      Reflect.set(McpClient.prototype, 'onToolsChanged', toolsChanged, client)
      if (toolsChanged && pendingTools) {
        const tools = pendingTools
        pendingTools = undefined
        toolsChanged([], tools)
      }
    },
  })

  const deliver = (tools: McpTools): void => {
    if (disabled) {
      return
    }
    const previous = delivered
    if (toolsChanged) {
      toolsChanged(previous, tools)
    } else {
      pendingTools = tools
    }
  }

  // Reading through a function keeps TypeScript from narrowing the state across awaits.
  const connectionState = (): McpClient['connectionState'] => client.connectionState
  client.listTools = async (listOptions?: Parameters<McpClient['listTools']>[0]): Promise<McpTools> => {
    if (disabled) {
      return []
    }
    if (connectionState() === 'connected') {
      const generation = connectionGeneration
      const tools = await baseListTools(listOptions)
      if (disabled || generation !== connectionGeneration) return []
      delivered = tools.map((tool) => tool.name)
      return tools
    }
    if (connectionState() !== 'disconnected') {
      return []
    }
    void client
      .connect()
      .then(async () => {
        if (connectionState() === 'connected') {
          deliver(await baseListTools(listOptions))
        }
      })
      .catch(recordFailure)
    return []
  }

  const settled = autoConnect
    ? client
        .connect()
        .then(() => connectionState() === 'connected')
        .catch((error: unknown) => {
          recordFailure(error)
          return false
        })
    : undefined

  return {
    ...(settled ? { settled } : {}),
    disabled: () => disabled,
    lastError: () => lastError,
    async enable(): Promise<string | undefined> {
      disabled = false
      try {
        await client.connect(connectionState() === 'failed')
        if (connectionState() !== 'connected') {
          return lastError ?? 'The server did not reach a connected state.'
        }
        lastError = undefined
        deliver(await baseListTools())
        return undefined
      } catch (error) {
        recordFailure(error)
        return lastError
      }
    },
    async disable(): Promise<undefined> {
      disabled = true
      pendingTools = undefined
      const withdrawn = delivered
      delivered = []
      await client.disconnect().catch(() => undefined)
      if (toolsChanged && withdrawn.length > 0) {
        toolsChanged(withdrawn, [])
      }
      return undefined
    },
  }
}

async function refreshRemoteTransport(client: McpClient, name: string, definition: McpServerConfig): Promise<void> {
  const replacement = await createClient(name, { ...definition, continueOnError: false })
  if (!replacement) {
    throw new Error(`Could not recreate the connection for ${name}.`)
  }
  // The SDK loader owns auth parsing. Its URL retry rebuilds must use the refreshed credentials.
  Reflect.set(client, '_transport', Reflect.get(replacement, '_transport'))
  Reflect.set(client, '_urlConfig', Reflect.get(replacement, '_urlConfig'))
}

/**
 * Tool names are only unique within one server, so each client's tools are namespaced by its config
 * key (`<server>_<tool>`) unless the server sets its own `prefix`, the SDK's `prefixWithServerName`
 * rule. Each client is named by its config key (`clientName`), which the library's subagent uses as
 * the server's name on its `mcp_servers` axis. Stdio servers are built here instead of through
 * `McpClient.loadServers` so their stderr can be discarded (the SDK's transport inherits the parent's
 * stderr, which would print server diagnostics over the terminal UI), so this path derives the prefix
 * itself with the SDK's `[^A-Za-z0-9_-]` -> `_` sanitization.
 */
async function createClient(name: string, definition: McpServerConfig): Promise<McpClient | undefined> {
  let client: McpClient | undefined
  if (transportType(definition) !== 'stdio' || !definition.command) {
    ;[client] = await McpClient.loadServers({ [name]: definition }, CLIENT_DEFAULTS, {
      prefixWithServerName: true,
    })
  } else {
    // Construction failures propagate: loadMcp owns the continueOnError catch so the reason survives for /mcp.
    client = new McpClient({
      ...CLIENT_DEFAULTS,
      applicationName: name,
      transport: new StdioClientTransport({
        command: interpolateEnv(definition.command),
        ...(definition.args ? { args: definition.args.map(interpolateEnv) } : {}),
        ...(definition.env ? { env: interpolateRecord(definition.env) } : {}),
        ...(definition.cwd ? { cwd: interpolateEnv(definition.cwd) } : {}),
        stderr: 'ignore',
      }),
      prefix:
        definition.prefix !== undefined ? interpolateEnv(definition.prefix) : name.replace(/[^A-Za-z0-9_-]/g, '_'),
      ...(definition.continueOnError !== undefined ? { continueOnError: definition.continueOnError } : {}),
      ...(definition.tasksConfig ? { tasksConfig: definition.tasksConfig } : {}),
      ...(definition.toolFilters ? { toolFilters: compileToolFilters(definition.toolFilters) } : {}),
    })
  }
  if (client) {
    assertMcpCompatibility(client)
    if (transportType(definition) === 'sse') settleSseStartOnClose(client)
  }
  return client
}

function assertMcpCompatibility(client: McpClient): void {
  const transport: unknown = Reflect.get(client, '_transport')
  let prototype: object | null = client
  while (prototype && !Object.hasOwn(prototype, 'onToolsChanged')) {
    prototype = Object.getPrototypeOf(prototype) as object | null
  }
  if (
    typeof Reflect.get(client, '_createClient') !== 'function' ||
    !('_urlConfig' in client) ||
    typeof transport !== 'object' ||
    transport === null ||
    typeof Reflect.get(transport, 'start') !== 'function' ||
    typeof Reflect.get(transport, 'close') !== 'function' ||
    !prototype ||
    typeof Object.getOwnPropertyDescriptor(prototype, 'onToolsChanged')?.set !== 'function'
  ) {
    throw new Error(
      `MCP is incompatible with SDK ${SDK_VERSION}. Update the Strands CLI before connecting this server.`
    )
  }
}

function settleSseStartOnClose(client: McpClient): void {
  const transport = Reflect.get(client, '_transport') as Transport
  const start = transport.start.bind(transport)
  const close = transport.close.bind(transport)
  let rejectStart: ((error: Error) => void) | undefined
  // SSE close cancels EventSource without settling start() while it waits for an endpoint.
  transport.start = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      rejectStart = reject
      void start()
        .then(resolve, reject)
        .finally(() => {
          rejectStart = undefined
        })
    })
  transport.close = async (): Promise<void> => {
    rejectStart?.(new Error('MCP connection closed before the server became ready.'))
    rejectStart = undefined
    await close()
  }
}

function compileToolFilters(filters: NonNullable<McpServerConfig['toolFilters']>): McpToolFilters {
  return {
    ...(filters.allowed ? { allowed: filters.allowed.map((pattern) => new RegExp(interpolateEnv(pattern))) } : {}),
    ...(filters.rejected ? { rejected: filters.rejected.map((pattern) => new RegExp(interpolateEnv(pattern))) } : {}),
  }
}

function transportType(definition: McpServerConfig): McpServerInfo['transport'] {
  return definition.transport ?? (definition.command ? 'stdio' : 'streamable-http')
}

function interpolateEnv(value: string): string {
  return value.replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, key: string) => {
    const resolved = process.env[key]
    if (resolved === undefined) {
      throw new Error(`Environment variable ${JSON.stringify(key)} is not set.`)
    }
    return resolved
  })
}

function interpolateRecord(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, interpolateEnv(value)]))
}
