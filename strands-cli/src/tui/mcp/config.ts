import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { McpServerConfig } from '@strands-agents/sdk'
import { parse as parseToml } from 'smol-toml'

import { errorMessage } from '../terminal/sanitize.js'

export interface LoadMcpOptions {
  cwd?: string
  paths?: readonly string[]
  strictPaths?: readonly string[]
  expectedDigests?: Readonly<Record<string, string>>
  servers?: string | Record<string, unknown>
}

export async function readMcpDefinitions(options: LoadMcpOptions = {}): Promise<{
  definitions: Record<string, McpServerConfig>
  paths: string[]
  warnings: string[]
}> {
  const cwd = options.cwd ?? process.cwd()
  const requestedPaths = options.paths ?? defaultMcpPaths()
  const paths = [...new Set(requestedPaths.map((path) => expandPath(path, cwd)))]
  const strictPaths = new Set((options.strictPaths ?? []).map((path) => expandPath(path, cwd)))
  const definitions: Record<string, McpServerConfig> = {}
  const warnings: string[] = []

  const merge = (config: Record<string, McpServerConfig> | undefined): void => {
    for (const [name, server] of Object.entries(config ?? {})) {
      if (server.disabled) {
        delete definitions[name]
      } else {
        definitions[name] = server
      }
    }
  }

  for (const path of paths) {
    merge(await readMcpConfig(path, cwd, options.expectedDigests?.[path], strictPaths.has(path), warnings))
  }

  if (options.servers) {
    if (typeof options.servers === 'string') {
      const path = expandPath(options.servers, cwd)
      paths.push(path)
      merge(await readMcpConfig(path, cwd, undefined, true, warnings))
    } else {
      merge(parseMcpConfig(JSON.stringify({ mcpServers: options.servers }), 'harness configuration', cwd))
    }
  }

  return { definitions, paths, warnings }
}

export function defaultMcpPaths(): string[] {
  const home = homedir()
  return [
    join(home, '.claude.json'),
    join(home, '.kiro', 'settings', 'mcp.json'),
    join(home, '.gemini', 'settings.json'),
    join(home, '.codex', 'config.toml'),
    join(home, '.config', 'strands', 'mcp.json'),
  ]
}

export function projectMcpPaths(cwd = process.cwd()): string[] {
  return [
    join(cwd, '.mcp.json'),
    join(cwd, '.kiro', 'settings', 'mcp.json'),
    join(cwd, '.gemini', 'settings.json'),
    join(cwd, '.codex', 'config.toml'),
    join(cwd, '.strands', 'mcp.json'),
  ]
}

async function readMcpConfig(
  path: string,
  cwd: string,
  expectedDigest: string | undefined,
  strict: boolean,
  warnings: string[]
): Promise<Record<string, McpServerConfig> | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (isMissing(error)) {
      return undefined
    }
    throw error
  }
  if (expectedDigest && createHash('sha256').update(text).digest('hex') !== expectedDigest) {
    throw new Error(`MCP configuration changed after workspace approval: ${path}`)
  }
  // Automatically discovered files from another tool can carry shapes the harness does not model, and
  // their quirks must never stop the harness from starting. The harness's own and explicitly requested files
  // stay strict.
  if (strict || !isForeignToolPath(path)) {
    return parseMcpConfig(text, path, cwd)
  }
  try {
    return parseMcpConfig(text, path, cwd, warnings)
  } catch (error) {
    warnings.push(errorMessage(error))
    return undefined
  }
}

/** When `warnings` is given, an invalid server is reported there and skipped instead of thrown. */
function parseMcpConfig(text: string, path: string, cwd: string, warnings?: string[]): Record<string, McpServerConfig> {
  const gemini = isGeminiSettingsPath(path)
  let value: unknown
  try {
    value = path.endsWith('.toml') ? parseToml(text) : JSON.parse(gemini ? stripJsonComments(text) : text)
  } catch (error) {
    throw new Error(`Invalid MCP configuration at ${path}: ${errorMessage(error)}`, { cause: error })
  }
  if (!isRecord(value)) {
    throw new Error(`Invalid MCP configuration at ${path}: expected an object.`)
  }
  const servers = path.endsWith('.toml') ? codexMcpServers(value, path) : jsonMcpServers(value, path, cwd)

  const result: Record<string, McpServerConfig> = {}
  for (const [name, server] of Object.entries(servers)) {
    try {
      if (!isRecord(server)) {
        throw new Error(`Invalid MCP configuration at ${path}: server ${JSON.stringify(name)} must be an object.`)
      }
      result[name] = validateServer(path, name, gemini ? geminiServer(server) : server)
    } catch (error) {
      if (!warnings) {
        throw error
      }
      warnings.push(errorMessage(error))
    }
  }
  return result
}

/** Gemini CLI spells the transport by field: `httpUrl` is streamable HTTP and `url` is SSE. */
function geminiServer(value: Record<string, unknown>): Record<string, unknown> {
  const { httpUrl, url, includeTools, excludeTools, ...rest } = value
  return {
    ...rest,
    ...(httpUrl !== undefined
      ? { url: httpUrl, transport: 'streamable-http' }
      : url !== undefined
        ? { url, transport: rest.type ?? 'sse' }
        : {}),
    ...(includeTools !== undefined ? { enabled_tools: includeTools } : {}),
    ...(excludeTools !== undefined ? { disabled_tools: excludeTools } : {}),
  }
}

// Gemini CLI reads its settings as JSON with line and block comments. Strings are left intact.
function stripJsonComments(text: string): string {
  return text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_match, string?: string) => string ?? '')
}

function validateServer(path: string, name: string, value: Record<string, unknown>): McpServerConfig {
  const command = optionalString(value.command, path, name, 'command')
  const url = optionalString(value.url, path, name, 'url')
  const transport = normalizeTransport(value.transport ?? value.type, path, name)
  const headers = mcpHeaders(value, path, name)
  const toolFilters = mcpToolFilters(value, path, name)
  if (!command && !url && value.disabled !== true && value.enabled !== false) {
    throw configError(path, name, 'provide either "command" or "url".')
  }
  if (command && url && transport === undefined) {
    throw configError(path, name, 'contains both "command" and "url"; set "transport" explicitly.')
  }

  return {
    ...(command ? { command } : {}),
    ...(url ? { url } : {}),
    ...(transport ? { transport } : {}),
    ...(value.args !== undefined ? { args: stringArray(value.args, path, name, 'args') } : {}),
    ...(value.env !== undefined ? { env: stringRecord(value.env, path, name, 'env') } : {}),
    ...(headers ? { headers } : {}),
    ...(value.auth !== undefined ? { auth: mcpAuth(value.auth, path, name) } : {}),
    ...(value.cwd !== undefined ? { cwd: requiredString(value.cwd, path, name, 'cwd') } : {}),
    ...(value.prefix !== undefined ? { prefix: stringValue(value.prefix, path, name, 'prefix') } : {}),
    ...(value.disabled !== undefined
      ? { disabled: booleanValue(value.disabled, path, name, 'disabled') }
      : value.enabled !== undefined
        ? { disabled: !booleanValue(value.enabled, path, name, 'enabled') }
        : {}),
    ...(value.continueOnError !== undefined
      ? { continueOnError: booleanValue(value.continueOnError, path, name, 'continueOnError') }
      : { continueOnError: true }),
    ...(toolFilters ? { toolFilters } : {}),
    ...(isRecord(value.tasksConfig)
      ? {
          tasksConfig: {
            ...(value.tasksConfig.ttl !== undefined
              ? { ttl: positiveNumber(value.tasksConfig.ttl, path, name, 'tasksConfig.ttl') }
              : {}),
            ...(value.tasksConfig.pollTimeout !== undefined
              ? {
                  pollTimeout: positiveNumber(value.tasksConfig.pollTimeout, path, name, 'tasksConfig.pollTimeout'),
                }
              : {}),
          },
        }
      : {}),
  }
}

function jsonMcpServers(value: Record<string, unknown>, path: string, cwd: string): Record<string, unknown> {
  const merged: Record<string, unknown> = {}
  let foundContainer = false

  if ('mcpServers' in value) {
    if (!isRecord(value.mcpServers)) {
      throw new Error(`Invalid MCP configuration at ${path}: "mcpServers" must be an object.`)
    }
    Object.assign(merged, value.mcpServers)
    foundContainer = true
  }

  if ('projects' in value) {
    if (!isRecord(value.projects)) {
      throw new Error(`Invalid MCP configuration at ${path}: "projects" must be an object.`)
    }
    foundContainer = true
    const workspace = canonicalPath(cwd)
    for (const [projectPath, project] of Object.entries(value.projects)) {
      if (canonicalPath(projectPath) !== workspace || !isRecord(project)) {
        continue
      }
      if (project.mcpServers !== undefined) {
        if (!isRecord(project.mcpServers)) {
          throw new Error(
            `Invalid MCP configuration at ${path}: project ${JSON.stringify(projectPath)} "mcpServers" must be an object.`
          )
        }
        Object.assign(merged, project.mcpServers)
      }
      // Claude Code records per-project opt-outs of user-scope servers as a name list.
      if (Array.isArray(project.disabledMcpServers)) {
        for (const name of project.disabledMcpServers) {
          if (typeof name === 'string') {
            merged[name] = { disabled: true }
          }
        }
      }
    }
  }

  return foundContainer || isApplicationSettingsPath(path) ? merged : value
}

function isApplicationSettingsPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/')
  return (
    normalized.endsWith('/.claude.json') ||
    normalized.endsWith('/.kiro/settings/mcp.json') ||
    isGeminiSettingsPath(path)
  )
}

function isGeminiSettingsPath(path: string): boolean {
  return path.replaceAll('\\', '/').endsWith('/.gemini/settings.json')
}

function isForeignToolPath(path: string): boolean {
  return isApplicationSettingsPath(path) || path.replaceAll('\\', '/').endsWith('/.codex/config.toml')
}

/** Claude Code keys projects by the raw working directory, which may be a symlink to the harness's realpath'd workspace. */
function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

function codexMcpServers(value: Record<string, unknown>, path: string): Record<string, unknown> {
  const servers = value.mcp_servers
  if (servers === undefined) {
    return {}
  }
  if (!isRecord(servers)) {
    throw new Error(`Invalid MCP configuration at ${path}: "mcp_servers" must be a table.`)
  }
  return servers
}

function normalizeTransport(value: unknown, path: string, name: string): McpServerConfig['transport'] {
  if (value === undefined) {
    return undefined
  }
  if (value === 'http') {
    return 'streamable-http'
  }
  if (value === 'stdio' || value === 'sse' || value === 'streamable-http') {
    return value
  }
  throw configError(path, name, '"transport" or "type" must be "stdio", "sse", "http", or "streamable-http".')
}

function mcpHeaders(value: Record<string, unknown>, path: string, name: string): Record<string, string> | undefined {
  const headers =
    value.headers === undefined
      ? value.http_headers === undefined
        ? {}
        : stringRecord(value.http_headers, path, name, 'http_headers')
      : stringRecord(value.headers, path, name, 'headers')

  if (value.env_http_headers !== undefined) {
    for (const [header, variable] of Object.entries(
      stringRecord(value.env_http_headers, path, name, 'env_http_headers')
    )) {
      headers[header] = `\${${variable}}`
    }
  }
  if (value.bearer_token_env_var !== undefined) {
    const variable = requiredString(value.bearer_token_env_var, path, name, 'bearer_token_env_var')
    headers.Authorization = `Bearer \${${variable}}`
  }
  return Object.keys(headers).length > 0 ? headers : undefined
}

function mcpAuth(value: unknown, path: string, name: string): NonNullable<McpServerConfig['auth']> {
  if (!isRecord(value)) {
    throw configError(path, name, '"auth" must be an object.')
  }
  return {
    clientId: stringValue(value.clientId, path, name, 'auth.clientId'),
    clientSecret: stringValue(value.clientSecret, path, name, 'auth.clientSecret'),
    ...(value.scopes !== undefined ? { scopes: stringArray(value.scopes, path, name, 'auth.scopes') } : {}),
  }
}

function mcpToolFilters(value: Record<string, unknown>, path: string, name: string): McpServerConfig['toolFilters'] {
  if (value.toolFilters !== undefined) {
    if (!isRecord(value.toolFilters)) {
      throw configError(path, name, '"toolFilters" must be an object.')
    }
    return {
      ...(value.toolFilters.allowed !== undefined
        ? { allowed: stringArray(value.toolFilters.allowed, path, name, 'toolFilters.allowed') }
        : {}),
      ...(value.toolFilters.rejected !== undefined
        ? { rejected: stringArray(value.toolFilters.rejected, path, name, 'toolFilters.rejected') }
        : {}),
    }
  }
  const allowed =
    value.enabled_tools === undefined
      ? undefined
      : stringArray(value.enabled_tools, path, name, 'enabled_tools').map(exactPattern)
  const rejected =
    value.disabled_tools === undefined
      ? undefined
      : stringArray(value.disabled_tools, path, name, 'disabled_tools').map(exactPattern)
  return allowed || rejected ? { ...(allowed ? { allowed } : {}), ...(rejected ? { rejected } : {}) } : undefined
}

function exactPattern(value: string): string {
  return `^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`
}

function expandPath(path: string, cwd: string): string {
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2))
  }
  return isAbsolute(path) ? path : resolve(cwd, path)
}

function optionalString(value: unknown, path: string, name: string, field: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, path, name, field)
}

function stringValue(value: unknown, path: string, name: string, field: string): string {
  if (typeof value !== 'string') {
    throw configError(path, name, `${JSON.stringify(field)} must be a string.`)
  }
  return value
}

function requiredString(value: unknown, path: string, name: string, field: string): string {
  if (typeof value !== 'string' || !value) {
    throw configError(path, name, `${JSON.stringify(field)} must be a non-empty string.`)
  }
  return value
}

function stringArray(value: unknown, path: string, name: string, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw configError(path, name, `${JSON.stringify(field)} must be an array of strings.`)
  }
  return value
}

function stringRecord(value: unknown, path: string, name: string, field: string): Record<string, string> {
  if (!isRecord(value) || !Object.values(value).every((item) => typeof item === 'string')) {
    throw configError(path, name, `${JSON.stringify(field)} must be an object with string values.`)
  }
  return value as Record<string, string>
}

function booleanValue(value: unknown, path: string, name: string, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw configError(path, name, `${JSON.stringify(field)} must be a boolean.`)
  }
  return value
}

function positiveNumber(value: unknown, path: string, name: string, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw configError(path, name, `${JSON.stringify(field)} must be a positive number.`)
  }
  return value
}

function configError(path: string, name: string, message: string): Error {
  return new Error(`Invalid MCP configuration at ${path}: server ${JSON.stringify(name)} ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
