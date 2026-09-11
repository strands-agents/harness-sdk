import type { McpClientConfig, McpClientCredentials, McpClientOptions, TasksConfig } from './client.js'
import { createDefaultSlot } from '../default-slot.js'

/**
 * Tool filters in a serializable form, for an MCP server config entry. Because a config file cannot
 * carry a `RegExp`, each pattern is a string compiled to a regex, matched from the start of the
 * server-side tool name.
 */
export interface SerializableMcpToolFilters {
  /** When present, only tools whose names match one of these patterns are exposed. */
  allowed?: string[]
  /** Tools whose names match one of these patterns are excluded, even when also allowed. */
  rejected?: string[]
}

/**
 * Configuration for a single MCP server entry in a config file or object.
 *
 * Provide either `command` (stdio transport) or `url` (streamable-http/SSE), not both.
 * When `transport` is omitted, it is auto-detected from the fields present.
 */
export interface McpServerConfig {
  /** Command to spawn (stdio transport, supports `${VAR}` or `${env:VAR}` interpolation). */
  command?: string
  /** Arguments passed to the command (supports `${VAR}` or `${env:VAR}` interpolation). */
  args?: string[]
  /** Environment variables passed to the child process (supports `${VAR}` or `${env:VAR}` interpolation). */
  env?: Record<string, string>
  /** Working directory for the spawned process (supports `${VAR}` or `${env:VAR}` interpolation). */
  cwd?: string
  /** Server endpoint URL (streamable-http or SSE transport, supports `${VAR}` or `${env:VAR}` interpolation). */
  url?: string
  /** HTTP headers sent with every request (supports `${VAR}` or `${env:VAR}` interpolation). */
  headers?: Record<string, string>
  /** Explicit transport type. When omitted, auto-detected: `command` → stdio, `url` → streamable-http. */
  transport?: 'stdio' | 'sse' | 'streamable-http'
  /** Client credentials for OAuth machine-to-machine auth (streamable-http only). */
  auth?: McpClientCredentials
  /** Prefix for agent-facing tool names (supports `${VAR}` or `${env:VAR}` interpolation). */
  prefix?: string
  /** Filters applied to tool names (patterns support `${VAR}` or `${env:VAR}` interpolation). */
  toolFilters?: SerializableMcpToolFilters
  /** When true, this server is skipped during loadServers. */
  disabled?: boolean
  /** When true, config or connection failures skip this server instead of throwing. */
  continueOnError?: boolean
  /** Task-augmented tool execution configuration (experimental). */
  tasksConfig?: TasksConfig
}

/** Options controlling how `McpClient.loadServers` translates config entries into clients. */
export interface McpLoadServersOptions {
  /**
   * When true, servers without an explicit `prefix` use their config key as the tool name prefix,
   * so same-named tools from different servers no longer collide. Characters outside `[A-Za-z0-9_-]`
   * in the key (e.g. the dot in `awslabs.foo`) are replaced with `_`. Takes precedence over a
   * default `prefix`; a server can still opt out with `prefix: ''`.
   */
  prefixWithServerName?: boolean
}

/**
 * Translates each declarative MCP server entry into the parameters that instantiate an McpClient.
 *
 * Implemented by the Node-only module `config.node.ts` and registered into {@link mcpServerLoader}
 * when running in a Node environment. Keeping it behind a slot keeps the Node-only filesystem and
 * stdio/SSE transport imports out of the browser bundle graph.
 *
 * @internal
 */
export type McpServerLoader = (
  config: string | Record<string, McpServerConfig>,
  defaults?: McpClientOptions,
  options?: McpLoadServersOptions
) => Promise<McpClientConfig[]>

/**
 * Registry slot holding the Node-only MCP server loader.
 *
 * The Node entry point (`index.node.ts`) fills this slot on import. In environments where it is
 * never filled (e.g. the browser), reading the slot throws a clear, actionable error instead of
 * failing at bundle time with an unresolved `node:fs` import.
 *
 * @internal
 */
export const mcpServerLoader = createDefaultSlot<McpServerLoader>(
  'McpClient.loadServers is only available in Node.js. Construct McpClient instances directly, or import from "@strands-agents/sdk" in a Node entry point.'
)
