import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { McpClientConfig, McpClientOptions, McpToolFilters, McpTransport } from './client.js'
import type { McpLoadServersOptions, McpServerConfig } from './config.js'
import { logger } from '../logging/index.js'

/**
 * Resolves an MCP servers config into an array of client configurations ready for instantiation.
 *
 * Registered into the `mcpServerLoader` slot by the Node entry point so that `McpClient.loadServers`
 * can reach it without the browser bundle graph importing any of this module's Node-only dependencies.
 *
 * @param config - A file path to a JSON config, or a flat server map object.
 * @param defaults - Options applied to all clients unless overridden per-server.
 * @param options - Loader behavior, such as prefixing tools with the server name.
 * @returns Resolved McpClientConfig array (one per enabled, successfully-resolved server).
 *
 * @internal
 */
export async function resolveServerConfigs(
  config: string | Record<string, McpServerConfig>,
  defaults?: McpClientOptions,
  options?: McpLoadServersOptions
): Promise<McpClientConfig[]> {
  const servers = await loadServersObject(config)
  const results: McpClientConfig[] = []

  for (const [name, server] of Object.entries(servers)) {
    // A non-object entry is a malformed-config error and always throws, unlike per-server failures.
    if (!server || typeof server !== 'object' || Array.isArray(server)) {
      throw new Error(`Server "${name}" must be an object, got ${Array.isArray(server) ? 'array' : typeof server}`)
    }

    if (server.disabled) continue

    const continueOnError = server.continueOnError ?? defaults?.continueOnError ?? false

    try {
      if (server.command && server.url && !server.transport) {
        throw new Error('Server config has both "command" and "url" — set "transport" explicitly or remove one')
      }

      const type = server.transport ?? (server.command ? 'stdio' : server.url ? 'streamable-http' : undefined)
      if (!type) throw new Error('Server config must include either "command" (stdio) or "url" (http)')

      let clientConfig: McpClientConfig
      switch (type) {
        case 'stdio':
          clientConfig = buildStdioConfig(server)
          break
        case 'streamable-http':
          clientConfig = buildHttpConfig(server)
          break
        case 'sse':
          clientConfig = buildSseConfig(server)
          break
        default: {
          const _exhaustive: never = type
          throw new Error(`Unsupported transport type: ${_exhaustive}`)
        }
      }

      results.push({ ...baseOptions(name, server, defaults, options), ...clientConfig })
    } catch (error) {
      if (!continueOnError) throw error
      logger.warn(`server=<${name}>, error=<${error}> | MCP server config failed, skipping (continueOnError)`)
    }
  }

  return results
}

function buildStdioConfig(server: McpServerConfig): McpClientConfig {
  if (!server.command) throw new Error('Stdio transport requires "command" field')

  const opts: ConstructorParameters<typeof StdioClientTransport>[0] = {
    command: interpolateEnv(server.command),
  }
  if (server.args) opts.args = server.args.map(interpolateEnv)
  if (server.env) opts.env = { ...getDefaultEnvironment(), ...interpolateRecord(server.env) }
  if (server.cwd) opts.cwd = interpolateEnv(server.cwd)

  return { transport: new StdioClientTransport(opts) as McpTransport }
}

function buildHttpConfig(server: McpServerConfig): McpClientConfig {
  if (!server.url) throw new Error('Streamable HTTP transport requires "url" field')

  const config: McpClientConfig = { url: interpolateEnv(server.url) }
  if (server.headers) config.headers = interpolateRecord(server.headers)
  if (server.auth) {
    config.auth = {
      clientId: interpolateEnv(server.auth.clientId),
      clientSecret: interpolateEnv(server.auth.clientSecret),
      ...(server.auth.scopes && { scopes: server.auth.scopes.map(interpolateEnv) }),
    }
  }
  return config
}

function buildSseConfig(server: McpServerConfig): McpClientConfig {
  if (!server.url) throw new Error('SSE transport requires "url" field')
  if (server.auth)
    throw new Error('SSE transport does not support auth — use streamable-http or provide a pre-configured transport')

  const headers = server.headers ? interpolateRecord(server.headers) : undefined

  return {
    transport: new SSEClientTransport(
      new URL(interpolateEnv(server.url)),
      headers ? { requestInit: { headers } } : undefined
    ) as McpTransport,
  }
}

function baseOptions(
  name: string,
  server: McpServerConfig,
  defaults?: McpClientOptions,
  options?: McpLoadServersOptions
): McpClientOptions {
  // applicationName is the shared app identity sent in the MCP handshake; honor an explicit
  // default for all clients, falling back to the server's config key when none is given.
  const opts: McpClientOptions = { ...defaults, applicationName: defaults?.applicationName ?? name }
  if (options?.prefixWithServerName) opts.prefix = name.replace(/[^A-Za-z0-9_-]/g, '_')
  if (server.continueOnError != null) opts.continueOnError = server.continueOnError
  if (server.tasksConfig != null) opts.tasksConfig = server.tasksConfig
  if (server.prefix !== undefined) opts.prefix = interpolateEnv(server.prefix)
  if (server.toolFilters !== undefined) opts.toolFilters = compileToolFilters(name, server.toolFilters)
  return opts
}

function compileToolFilters(name: string, filters: NonNullable<McpServerConfig['toolFilters']>): McpToolFilters {
  const compiled: McpToolFilters = {}
  if (filters.allowed !== undefined)
    compiled.allowed = compileFilterMatchers(name, 'allowed', filters.allowed.map(interpolateEnv))
  if (filters.rejected !== undefined)
    compiled.rejected = compileFilterMatchers(name, 'rejected', filters.rejected.map(interpolateEnv))
  return compiled
}

function compileFilterMatchers(name: string, key: 'allowed' | 'rejected', patterns: string[]): RegExp[] {
  return patterns.map((pattern) => {
    try {
      return new RegExp(pattern)
    } catch (error) {
      throw new SyntaxError(`Server "${name}": invalid regex in toolFilters.${key}: "${pattern}": ${String(error)}`, {
        cause: error,
      })
    }
  })
}

/**
 * Replaces `$\{VAR\}` and `$\{env:VAR\}` placeholders with their process.env values.
 * Throws if a referenced variable is not set.
 *
 * @example
 * ```typescript
 * interpolateEnv('Bearer $\{TOKEN\}')       // → 'Bearer ghp_abc123'
 * interpolateEnv('$\{env:HOME\}/config')    // → '/home/user/config'
 * ```
 */
function interpolateEnv(value: string): string {
  return value.replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key: string) => {
    const resolved = process.env[key]
    if (resolved === undefined) throw new Error(`Environment variable "${key}" is not set`)
    return resolved
  })
}

/** Applies {@link interpolateEnv} to every value in a string record. */
function interpolateRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, interpolateEnv(v)]))
}

async function loadServersObject(
  config: string | Record<string, McpServerConfig>
): Promise<Record<string, McpServerConfig>> {
  if (typeof config !== 'string') return config

  const filePath = config.startsWith('~/') ? join(homedir(), config.slice(2)) : config
  const parsed = JSON.parse(await readFile(filePath, 'utf-8'))
  const servers = parsed.mcpServers ?? parsed

  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    throw new Error(
      'MCP config must be a JSON object mapping server names to configs, e.g. { "my-server": { "command": "node" } }'
    )
  }

  return servers
}
