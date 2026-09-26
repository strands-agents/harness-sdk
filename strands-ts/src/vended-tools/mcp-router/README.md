# MCP Router Tool

Connects to Model Context Protocol (MCP) servers at runtime to discover and invoke their tools.

The factory takes a developer-set allowlist of servers; the model can only connect to servers on that list. Connections are scoped per agent and closed on `disconnect` or when the agent is garbage collected.

## ⚠️ Security Warning

**The allowlist controls which servers the model may connect to.**

- For HTTP servers, treat this like any network request — egress control belongs at the encapsulation layer
- For stdio servers, the allowlisted command is spawned as a local process with access to the host filesystem, environment variables, and network
- Only allowlist commands you would run directly on the host
- For production deployments, consider running in a sandboxed environment (containers, VMs, etc.)
- Never expose this tool to untrusted users without additional security measures

## Features

- **Developer-Set Allowlist**: Only servers explicitly listed in the factory config can be connected to
- **Per-Agent Connection Scoping**: Each agent instance maintains its own isolated set of connections
- **Automatic Cleanup**: Open connections are closed on a best-effort basis when the agent is garbage collected via `FinalizationRegistry`
- **Connection Limits**: Configurable cap on simultaneous connections per agent (default: 10)
- **Dynamic Tool Discovery**: List and invoke tools from any connected MCP server at runtime

## Usage

```typescript
import { Agent } from '@strands-agents/sdk'
import { makeMcpRouter } from '@strands-agents/sdk/vended-tools/mcp-router'

const mcpRouter = makeMcpRouter({
  servers: {
    'my-api': { url: 'https://mcp.example.com/mcp' },
  },
})
const agent = new Agent({ tools: [mcpRouter] })
```

Custom name and connection limit:

```typescript
const mcpRouter = makeMcpRouter({
  name: 'my_mcp',
  servers: {
    'server-a': { url: 'https://a.example.com/mcp' },
    'server-b': { url: 'https://b.example.com/mcp' },
  },
  maxConnections: 5,
})
```

## Commands

### `connect`

Opens a connection to an allowlisted server.

**Parameters:**

- `connection_id` (string, required): A unique name for this connection
- `server_name` (string, required): Server to connect to (from allowlist)

Returns `"Successfully connected to <server_name> as \"<connection_id>\""`. Throws if the server is not on the allowlist, the connection ID is already in use, or the connection limit is reached.

### `list_connections`

Lists all active connections for the current agent. No additional parameters.

Returns a comma-separated sorted list of active connection IDs, or an empty string when none are open.

### `list_tools`

Discovers the tools available on a connected server.

**Parameters:**

- `connection_id` (string, required): Connection to query

Returns an array of `ToolSpec` objects with tool names and input schemas.

### `call_tool`

Invokes a tool on a connected server.

**Parameters:**

- `connection_id` (string, required): Connection that hosts the tool
- `tool_name` (string, required): Tool to invoke
- `arguments` (Record<string, unknown>, optional): Arguments passed to the tool

Returns the result from the invoked MCP tool.

### `disconnect`

Closes a connection and releases its resources.

**Parameters:**

- `connection_id` (string, required): Connection to close

Returns `"Successfully disconnected"`.

## API

### `makeMcpRouter(options)`

| Option           | Type                              | Default      | Description                                           |
| ---------------- | --------------------------------- | ------------ | ----------------------------------------------------- |
| `servers`        | `Record<string, McpServerConfig>` | _(required)_ | Allowlisted servers keyed by name. Must not be empty. |
| `name`           | `string`                          | `mcp_router` | Tool name.                                            |
| `description`    | `string`                          | (built-in)   | Description shown to the model.                       |
| `maxConnections` | `number`                          | `10`         | Maximum simultaneous open connections per agent.      |

Throws if `servers` is empty or `maxConnections` is not positive.
