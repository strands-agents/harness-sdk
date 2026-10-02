import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { McpClient, type McpServerConfig, type McpToolFilters } from '@strands-agents/sdk'

import { sanitizeTerminalText } from './terminal/sanitize.js'
import { HARNESS_VERSION } from './package-version.js'
import { readMcpDefinitions, type LoadMcpOptions } from './mcp/config.js'

export { defaultMcpPaths, projectMcpPaths, readMcpDefinitions, type LoadMcpOptions } from './mcp/config.js'

interface McpServerInfo {
  name: string
  transport: 'stdio' | 'sse' | 'streamable-http'
  target: string
  state: 'disconnected' | 'connected' | 'failed'
  toolCount?: number
}

export interface LoadedMcp {
  readonly clients: readonly McpClient[]
  readonly paths: readonly string[]
  /** Configuration the harness skipped rather than failed on: problems in another tool's files. */
  readonly warnings: readonly string[]
  list(connect?: boolean): Promise<readonly McpServerInfo[]>
  dispose(): Promise<void>
}

export async function loadMcp(options: LoadMcpOptions = {}): Promise<LoadedMcp> {
  const { definitions, paths, warnings } = await readMcpDefinitions(options)
  const clientsByName = new Map(
    await Promise.all(
      Object.entries(definitions).map(
        async ([name, definition]) => [name, await createClient(name, definition)] as const
      )
    )
  )
  const clients = [...clientsByName.values()].filter((client) => client !== undefined)
  return {
    clients,
    paths: paths.map(sanitizeTerminalText),
    warnings: warnings.map(sanitizeTerminalText),
    async list(connect = false): Promise<readonly McpServerInfo[]> {
      return Promise.all(
        Object.entries(definitions).map(async ([name, definition]) => {
          const client = clientsByName.get(name)
          if (connect && client) {
            await client.connect()
          }
          const tools = connect && client?.connectionState === 'connected' ? await client.listTools() : undefined
          return {
            name: sanitizeTerminalText(name),
            transport: transportType(definition),
            target: sanitizeTerminalText(definition.command ?? definition.url ?? 'invalid configuration'),
            state: client?.connectionState ?? 'failed',
            ...(tools ? { toolCount: tools.length } : {}),
          }
        })
      )
    },
    async dispose(this: LoadedMcp): Promise<void> {
      await Promise.allSettled(this.clients.map((client) => client.disconnect()))
    },
  }
}

const CLIENT_DEFAULTS = { applicationVersion: HARNESS_VERSION }

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
  if (transportType(definition) !== 'stdio' || !definition.command) {
    const [client] = await McpClient.loadServers({ [name]: definition }, CLIENT_DEFAULTS, {
      prefixWithServerName: true,
    })
    return client
  }
  try {
    return new McpClient({
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
  } catch (error) {
    if (definition.continueOnError) {
      return undefined
    }
    throw error
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
