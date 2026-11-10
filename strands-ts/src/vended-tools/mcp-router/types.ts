/**
 * Description for the mcp_router tool shown to the model.
 */
export const MCP_ROUTER_DESCRIPTION =
  'Connects to Model Context Protocol (MCP) servers at runtime to discover and invoke their tools. ' +
  "'connect' opens a connection to a permitted server. " +
  "'list_connections' returns all currently open connection IDs. " +
  "'list_tools' returns the tools the connected server exposes, including their names and input schemas. " +
  "'call_tool' invokes a named tool on a connected server and returns its result. " +
  "'disconnect' closes a connection. " +
  'Multiple servers can be connected simultaneously. ' +
  'Use connection_id to identify which connection to use for list_tools, call_tool, and disconnect.'

/**
 * Raised when an mcp_router tool operation fails.
 */
export class McpRouterToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpRouterToolError'
  }
}

/**
 * Input parameters accepted by the mcp_router tool.
 */
export interface McpRouterInput {
  /**
   * The operation to perform: `connect`, `list_connections`, `list_tools`,
   * `call_tool`, `disconnect`.
   */
  command: 'connect' | 'list_connections' | 'list_tools' | 'call_tool' | 'disconnect'

  /**
   * A descriptive name for this connection. Required for all commands except
   * `list_connections`. Must be unique per agent. Reusing an active id is rejected.
   */
  connection_id?: string

  /**
   * Server name to connect to. Required for `connect`.
   */
  server_name?: string

  /**
   * Tool name to invoke. Required for `call_tool`.
   */
  tool_name?: string

  /**
   * Arguments to pass to the invoked tool. Used with `call_tool`.
   */
  arguments?: Record<string, unknown>
}
