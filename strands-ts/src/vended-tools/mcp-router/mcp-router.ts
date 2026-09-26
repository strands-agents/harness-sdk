import { tool } from '../../tools/tool-factory.js'
import { z } from 'zod'
import type { InvokableTool, ToolContext } from '../../tools/tool.js'
import type { ToolSpec } from '../../tools/types.js'
import type { JSONValue } from '../../types/json.js'
import type { ToolResultContent } from '../../types/messages.js'
import { McpClient, type McpServerConfig } from '../../mcp/index.js'
import { McpTool } from '../../tools/mcp-tool.js'
import { logger } from '../../logging/logger.js'
import { MCP_ROUTER_DESCRIPTION, McpRouterToolError } from './types.js'
import type { McpRouterInput } from './types.js'

const DEFAULT_MAX_CONNECTIONS = 10

/**
 * Zod schema for mcp_router input validation.
 */
const mcpRouterInputSchema = z.object({
  command: z
    .enum(['connect', 'list_connections', 'list_tools', 'call_tool', 'disconnect'])
    .describe("The operation to perform: 'connect', 'list_connections', 'list_tools', 'call_tool', 'disconnect'."),
  connection_id: z
    .string()
    .optional()
    .describe(
      'A descriptive name for this connection. Required for all commands except list_connections. ' +
        'Must be unique per agent. Reusing an active id is rejected.'
    ),
  server_name: z.string().optional().describe("Server name to connect to. Required for 'connect'."),
  tool_name: z.string().optional().describe("Tool name to invoke. Required for 'call_tool'."),
  arguments: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Arguments to pass to the invoked tool. Used with 'call_tool'."),
})

export interface MakeMcpRouterOptions {
  name?: string
  description?: string
  servers: Record<string, McpServerConfig>
  maxConnections?: number
}

/**
 * Creates an MCP router tool bound to a developer-set server allowlist.
 *
 * Connections are scoped per agent and persist across invocations. They are closed
 * when the model calls `disconnect` or when the agent is garbage collected.
 *
 * @param options - Configuration options.
 * @returns A tool that manages MCP connections.
 * @throws Error if `servers` is empty or `maxConnections` is not positive.
 *
 * @example
 * ```typescript
 * const mcpRouter = makeMcpRouter({ servers: { 'my-api': { url: 'https://mcp.example.com/mcp' } } })
 * const agent = new Agent({ tools: [mcpRouter] })
 * ```
 */
export function makeMcpRouter(options: MakeMcpRouterOptions): InvokableTool<McpRouterInput, JSONValue> {
  const { servers, maxConnections = DEFAULT_MAX_CONNECTIONS } = options

  if (Object.keys(servers).length === 0) {
    throw new Error('`servers` must not be empty; the mcp_router tool requires at least one server')
  }
  if (maxConnections < 1) {
    throw new Error('`maxConnections` must be at least 1')
  }

  const description =
    options.description ??
    `${MCP_ROUTER_DESCRIPTION} Permitted server names: ${Object.keys(servers)
      .sort()
      .map((s) => `'${s}'`)
      .join(', ')}.`

  // Per-agent connections with WeakMap so agents can be garbage collected.
  const connectionsMap = new WeakMap<object, Map<string, McpClient>>()

  // Cleans up open connections when an agent is garbage collected without calling disconnect.
  const registry = new FinalizationRegistry<Map<string, McpClient>>((connections) => {
    stopClientsInBackground(connections)
  })

  return tool({
    name: options.name ?? 'mcp_router',
    description,
    inputSchema: mcpRouterInputSchema,
    callback: async (input, context) => {
      if (!context) {
        throw new McpRouterToolError('mcp_router requires an agent context')
      }
      const { agent } = context

      const { command, connection_id: connectionId, server_name: serverName, tool_name: toolName } = input
      const args = (input.arguments ?? {}) as JSONValue

      if (command === 'list_connections') {
        const connections = connectionsMap.get(agent)
        const ids = connections ? [...connections.keys()] : []
        return ids.sort().join(', ')
      }

      if (!connectionId) {
        throw new McpRouterToolError("`connection_id` is required for all commands except 'list_connections'")
      }

      if (command === 'connect') {
        if (!serverName) {
          throw new McpRouterToolError("`server_name` is required for command='connect'")
        }
        return await handleConnect(connectionsMap, registry, agent, servers, serverName, connectionId, maxConnections)
      }

      const connections = connectionsMap.get(agent)
      const client = connections?.get(connectionId)
      if (!client) {
        throw new McpRouterToolError(`No active connection for id ${JSON.stringify(connectionId)}`)
      }

      if (command === 'list_tools') {
        return (await handleListTools(client)) as unknown as JSONValue
      }

      if (command === 'call_tool') {
        if (!toolName) {
          throw new McpRouterToolError("`tool_name` is required for command='call_tool'")
        }
        return await handleCallTool(client, toolName, args, context)
      }

      if (command === 'disconnect') {
        return await handleDisconnect(connections!, connectionId)
      }

      throw new McpRouterToolError(`Unknown command: ${command as string}`)
    },
  })
}

// ---- Internals ----------------------------------------------------------------

async function stopClient(client: McpClient): Promise<void> {
  try {
    await client.disconnect()
  } catch {
    logger.debug('failed to stop MCP client')
  }
}

function stopClientsInBackground(connections: Map<string, McpClient>): void {
  for (const [connectionId, client] of connections) {
    logger.debug(`connection_id=<${connectionId}> | closing MCP connection during garbage collection`)
    void stopClient(client)
  }
}

async function handleConnect(
  connectionsMap: WeakMap<object, Map<string, McpClient>>,
  registry: FinalizationRegistry<Map<string, McpClient>>,
  agent: object,
  servers: Record<string, McpServerConfig>,
  serverName: string,
  connectionId: string,
  maxConnections: number
): Promise<string> {
  if (!Object.hasOwn(servers, serverName)) {
    const permitted = Object.keys(servers).sort().join(', ')
    throw new McpRouterToolError(
      `Server ${JSON.stringify(serverName)} is not on the MCP server allowlist: ${permitted}`
    )
  }

  const serverConfig = servers[serverName]!
  const loaded = await McpClient.loadServers({ [serverName]: serverConfig })
  if (loaded.length === 0) {
    throw new McpRouterToolError(`Server ${JSON.stringify(serverName)} failed to initialise; check the server config`)
  }
  const client = loaded[0]!

  try {
    await client.connect()
  } catch (error) {
    await stopClient(client)
    throw error
  }

  // McpClient.connect() swallows failures when continueOnError is set in the server config.
  if (client.connectionState === 'failed') {
    await stopClient(client)
    throw new McpRouterToolError(`Server ${JSON.stringify(serverName)} failed to connect; check the server config`)
  }

  // Cap and duplicate checks after all awaits to avoid race conditions.
  let connections = connectionsMap.get(agent)
  if (!connections) {
    connections = new Map()
    connectionsMap.set(agent, connections)
    // Stop all open connections if the agent is garbage collected without calling disconnect.
    registry.register(agent, connections)
  }

  if (connections.size >= maxConnections) {
    await stopClient(client)
    const activeIds = [...connections.keys()].sort().join(', ')
    throw new McpRouterToolError(
      `Connection limit of ${maxConnections} reached. ` +
        `Disconnect one of the active connections before opening a new one. ` +
        `Active connection_ids: ${activeIds}`
    )
  }

  if (connections.has(connectionId)) {
    await stopClient(client)
    throw new McpRouterToolError(
      `Connection ${JSON.stringify(connectionId)} already exists. Disconnect it first or use a different connection_id.`
    )
  }

  connections.set(connectionId, client)

  logger.debug(`connection_id=<${connectionId}>, server_name=<${serverName}> | opened MCP connection`)
  return `Successfully connected to ${serverName} as ${JSON.stringify(connectionId)}`
}

async function handleListTools(client: McpClient): Promise<ToolSpec[]> {
  const tools = await client.listTools({ prefix: '' })
  // Get tool.name (server-side name without prefix) so call_tool works verbatim.
  return tools.map((t) => ({ ...t.toolSpec, name: t.name }))
}

async function handleCallTool(
  client: McpClient,
  toolName: string,
  args: JSONValue,
  context: ToolContext
): Promise<JSONValue> {
  // Ad-hoc tool uses tool.name, which the model finds from an earlier listTools call.
  const tempTool = new McpTool({
    name: toolName,
    description: '',
    inputSchema: { type: 'object' },
    client,
  })
  // Using McpTool.stream instead of McpClient.callTool to map content to SDK blocks and errors
  const gen = tempTool.stream({
    ...context,
    toolUse: { ...context.toolUse, name: toolName, input: args },
  })
  let next = await gen.next()
  while (!next.done) next = await gen.next()
  const result = next.value
  if (result.status === 'error') {
    const text = result.content.map((c: ToolResultContent) => ('text' in c ? c.text : JSON.stringify(c))).join('\n')
    throw new McpRouterToolError(text || 'MCP tool returned an error')
  }
  return result.content as unknown as JSONValue
}

async function handleDisconnect(connections: Map<string, McpClient>, connectionId: string): Promise<string> {
  const client = connections.get(connectionId)
  connections.delete(connectionId)
  if (client) {
    await stopClient(client)
  }
  return 'Successfully disconnected'
}
