Connect your agent to tools that live outside your codebase: databases, SaaS APIs, and internal services exposed over the [Model Context Protocol (MCP)](https://modelcontextprotocol.io), an open standard for providing context to language models. Strands loads an MCP server’s tools and hands them to the agent like any other tool, in both Python and TypeScript.

## Quickstart

(( tab "Python" ))
```python
from mcp import stdio_client, StdioServerParameters
from strands import Agent
from strands.tools.mcp import MCPClient

# Create MCP client with stdio transport
mcp_client = MCPClient(lambda: stdio_client(
    StdioServerParameters(
        command="uvx",
        args=["awslabs.aws-documentation-mcp-server@latest"]
    )
))

# Pass MCP client directly to agent - lifecycle managed automatically
agent = Agent(tools=[mcp_client])
agent("What is AWS Lambda?")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
// Create MCP client with stdio transport
const mcpClient = new McpClient({
  transport: new StdioClientTransport({
    command: 'uvx',
    args: ['awslabs.aws-documentation-mcp-server@latest'],
  }),
})

// Pass MCP client directly to agent
const agent = new Agent({
  tools: [mcpClient],
})

await agent.invoke('What is AWS Lambda?')
```
(( /tab "TypeScript" ))

## Integration Approaches

(( tab "Python" ))
**Managed Integration (Recommended)**

The `MCPClient` implements the `ToolProvider` interface, enabling direct usage in the Agent constructor with automatic lifecycle management:

```python
from mcp import stdio_client, StdioServerParameters
from strands import Agent
from strands.tools.mcp import MCPClient

mcp_client = MCPClient(lambda: stdio_client(
    StdioServerParameters(
        command="uvx",
        args=["awslabs.aws-documentation-mcp-server@latest"]
    )
))

# Direct usage - connection lifecycle managed automatically
agent = Agent(tools=[mcp_client])
response = agent("What is AWS Lambda?")
```

**Manual Context Management**

For cases requiring explicit control over the MCP session lifecycle, use context managers:

```python
with mcp_client:
    tools = mcp_client.list_tools_sync()
    agent = Agent(tools=tools)
    agent("What is AWS Lambda?")  # Must be within context
```
(( /tab "Python" ))

(( tab "TypeScript" ))
**Direct Integration**

`McpClient` instances are passed directly to the agent. The client connects lazily on first use:

```typescript
const mcpClientDirect = new McpClient({
  transport: new StdioClientTransport({
    command: 'uvx',
    args: ['awslabs.aws-documentation-mcp-server@latest'],
  }),
})

// MCP client passed directly - connects on first tool use
const agentDirect = new Agent({
  tools: [mcpClientDirect],
})

await agentDirect.invoke('What is AWS Lambda?')
```

Tools can also be listed explicitly if needed:

```typescript
// Explicit tool listing
const tools = await mcpClient.listTools()
const agentExplicit = new Agent({ tools })
```
(( /tab "TypeScript" ))

## Choose a Transport

The connection pattern above works for any transport: only the transport object you pass to the client changes. Strands supports three:

-   **stdio** for local processes and command-line servers that speak MCP over standard I/O.
-   **Streamable HTTP** for remote servers reachable over HTTP, including servers behind OAuth or AWS IAM authentication.
-   **Server-Sent Events (SSE)** for HTTP servers that use the older SSE transport.

For the configuration of each transport, including authentication, see [MCP transports](/docs/user-guide/sdk/tools/mcp-transports/index.md).

## Using Multiple MCP Servers

Combine tools from multiple MCP servers in a single agent:

(( tab "Python" ))
```python
from mcp import stdio_client, StdioServerParameters
from mcp.client.sse import sse_client
from strands import Agent
from strands.tools.mcp import MCPClient

# Create multiple clients
sse_mcp_client = MCPClient(lambda: sse_client("http://localhost:8000/sse"))
stdio_mcp_client = MCPClient(lambda: stdio_client(
    StdioServerParameters(command="python", args=["path/to/mcp_server.py"])
))

# Manual approach - explicit context management
with sse_mcp_client, stdio_mcp_client:
    tools = sse_mcp_client.list_tools_sync() + stdio_mcp_client.list_tools_sync()
    agent = Agent(tools=tools)

# Managed approach
agent = Agent(tools=[sse_mcp_client, stdio_mcp_client])
```

**Load from configuration**

Use `load_servers` to create clients from a dictionary or JSON file. Transport types are detected from `command` or `url`, and environment placeholders keep credentials out of the configuration:

```python
from strands import Agent
from strands.tools.mcp import MCPClient

clients = MCPClient.load_servers(
    {
        "mcpServers": {
            "documentation": {
                "command": "uvx",
                "args": ["awslabs.aws-documentation-mcp-server@latest"],
            },
            "protected-api": {
                "url": "https://api.example.com/mcp/",
                "auth": {
                    "client_id": "${OAUTH_CLIENT_ID}",
                    "client_secret": "${OAUTH_CLIENT_SECRET}",
                    "scopes": ["mcp:tools"],
                },
            },
        }
    },
    prefix_with_server_name=True,
)

agent = Agent(tools=clients)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
const localClient = new McpClient({
  transport: new StdioClientTransport({
    command: 'uvx',
    args: ['awslabs.aws-documentation-mcp-server@latest'],
  }),
})

const remoteClient = new McpClient({
  transport: new StreamableHTTPClientTransport(
    new URL('https://api.example.com/mcp/')
  ) as Transport,
})

// Pass multiple MCP clients to the agent
const agentMultiple = new Agent({
  tools: [localClient, remoteClient],
})
```

**Load from configuration**

In Node.js, use `loadServers` to create clients from an object or JSON file. Transport types are detected from `command` or `url`, and environment placeholders keep credentials out of the configuration:

```typescript
import { Agent, McpClient } from '@strands-agents/sdk'

const clients = await McpClient.loadServers(
  {
    documentation: {
      command: 'uvx',
      args: ['awslabs.aws-documentation-mcp-server@latest'],
    },
    protectedApi: {
      url: 'https://api.example.com/mcp/',
      auth: {
        clientId: '${OAUTH_CLIENT_ID}',
        clientSecret: '${OAUTH_CLIENT_SECRET}',
        scopes: ['mcp:tools'],
      },
    },
  },
  undefined, // Skip optional client defaults
  { prefixWithServerName: true }
)

const agent = new Agent({ tools: clients })
```

Set `prefixWithServerName` when servers expose tools with overlapping names. A server-level `prefix` overrides the generated prefix, and `prefix: ''` disables it.
(( /tab "TypeScript" ))

## Client Configuration

(( tab "Python" ))
Python’s `MCPClient` supports tool filtering and name prefixing to manage tools from multiple servers.

**Tool Filtering**

Control which tools are loaded using the `tool_filters` parameter:

```python
from mcp import stdio_client, StdioServerParameters
from strands.tools.mcp import MCPClient
import re

# String matching - loads only specified tools
filtered_client = MCPClient(
    lambda: stdio_client(StdioServerParameters(
        command="uvx",
        args=["awslabs.aws-documentation-mcp-server@latest"]
    )),
    tool_filters={"allowed": ["search_documentation", "read_documentation"]}
)

# Regex patterns
regex_client = MCPClient(
    lambda: stdio_client(StdioServerParameters(
        command="uvx",
        args=["awslabs.aws-documentation-mcp-server@latest"]
    )),
    tool_filters={"allowed": [re.compile(r"^search_.*")]}
)

# Combined filters - applies allowed first, then rejected
combined_client = MCPClient(
    lambda: stdio_client(StdioServerParameters(
        command="uvx",
        args=["awslabs.aws-documentation-mcp-server@latest"]
    )),
    tool_filters={
        "allowed": [re.compile(r".*documentation$")],
        "rejected": ["read_documentation"]
    }
)
```

**Tool Name Prefixing**

Prevent name conflicts when using multiple MCP servers:

```python
aws_docs_client = MCPClient(
    lambda: stdio_client(StdioServerParameters(
        command="uvx",
        args=["awslabs.aws-documentation-mcp-server@latest"]
    )),
    prefix="aws_docs"
)

other_client = MCPClient(
    lambda: stdio_client(StdioServerParameters(
        command="uvx",
        args=["other-mcp-server@latest"]
    )),
    prefix="other"
)

# Tools will be named: aws_docs_search_documentation, other_search, etc.
agent = Agent(tools=[aws_docs_client, other_client])
```
(( /tab "Python" ))

(( tab "TypeScript" ))
TypeScript’s `McpClient` supports tool filtering and name prefixing to manage tools from multiple servers.

**Tool Filtering**

Control which tools are loaded using the `toolFilters` option:

```typescript
// String matching - loads only specified tools
const filteredClient = new McpClient({
  transport: new StdioClientTransport({
    command: 'uvx',
    args: ['awslabs.aws-documentation-mcp-server@latest'],
  }),
  toolFilters: { allowed: ['search_documentation', 'read_documentation'] },
})

// Regex patterns
const regexClient = new McpClient({
  transport: new StdioClientTransport({
    command: 'uvx',
    args: ['awslabs.aws-documentation-mcp-server@latest'],
  }),
  toolFilters: { allowed: [/^search_.*/] },
})

// Callbacks receive the tool itself
const callbackClient = new McpClient({
  transport: new StdioClientTransport({
    command: 'uvx',
    args: ['awslabs.aws-documentation-mcp-server@latest'],
  }),
  toolFilters: { rejected: [(tool) => tool.name.endsWith('_internal')] },
})

// Combined filters - applies allowed first, then rejected
const combinedClient = new McpClient({
  transport: new StdioClientTransport({
    command: 'uvx',
    args: ['awslabs.aws-documentation-mcp-server@latest'],
  }),
  toolFilters: {
    allowed: [/.*documentation$/],
    rejected: ['read_documentation'],
  },
})
```

String matchers match the server-side tool name exactly, and `RegExp` matchers match it from the start. Callback matchers receive the `McpTool` under its agent-facing name, so they see the prefix when one is set. An `allowed` list is applied first, then `rejected`, so rejection wins when both match.

**Tool Name Prefixing**

Prevent name conflicts when using multiple MCP servers:

```typescript
const awsDocsClient = new McpClient({
  transport: new StdioClientTransport({
    command: 'uvx',
    args: ['awslabs.aws-documentation-mcp-server@latest'],
  }),
  prefix: 'aws_docs',
})

const otherClient = new McpClient({
  transport: new StdioClientTransport({
    command: 'uvx',
    args: ['other-mcp-server@latest'],
  }),
  prefix: 'other',
})

// Tools will be named: aws_docs_search_documentation, other_search, etc.
const agent = new Agent({ tools: [awsDocsClient, otherClient] })
```

A prefix only renames the tool for the agent: calls still send the original server tool name.

Constructor defaults can be overridden per listing with `listTools({ prefix, toolFilters })`. Omitted fields inherit the constructor defaults; `prefix: ''` disables a default prefix and `toolFilters: {}` disables default filters. Declarative `McpClient.loadServers()` config accepts `prefix` and `toolFilters` too, where filter strings are regexes.
(( /tab "TypeScript" ))

## Direct Tool Invocation

While tools are typically invoked by the agent based on user requests, MCP tools can also be called directly:

(( tab "Python" ))
```python
result = mcp_client.call_tool_sync(
    tool_use_id="tool-123",
    name="calculator",
    arguments={"x": 10, "y": 20}
)
print(f"Result: {result['content'][0]['text']}")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
// Get tools and find the target tool
const tools = await mcpClient.listTools()
const calcTool = tools.find(t => t.name === 'calculator')

// Call directly through the client
const result = await mcpClient.callTool(calcTool, { x: 10, y: 20 })
```
(( /tab "TypeScript" ))

## Implementing an MCP Server

Custom MCP servers can be created to extend agent capabilities:

(( tab "Python" ))
```python
from mcp.server import FastMCP

# Create an MCP server
mcp = FastMCP("Calculator Server")

# Define a tool
@mcp.tool(description="Calculator tool which performs calculations")
def calculator(x: int, y: int) -> int:
    return x + y

# Run the server with SSE transport
mcp.run(transport="sse")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({
  name: 'Calculator Server',
  version: '1.0.0',
})

server.tool(
  'calculator',
  'Calculator tool which performs calculations',
  {
    x: z.number(),
    y: z.number(),
  },
  async ({ x, y }) => {
    return {
      content: [{ type: 'text', text: String(x + y) }],
    }
  }
)

const transport = new StdioServerTransport()
await server.connect(transport)
```
(( /tab "TypeScript" ))

For more information on implementing MCP servers, see the [MCP documentation](https://modelcontextprotocol.io).

## Advanced Usage

### Elicitation

An MCP server can pause a tool call to request additional input from the user. Configure an elicitation callback on the client to respond to these requests:

(( tab "Python" ))
The server declares the schema it wants back, and the client returns a matching response:

server.py

```python
from mcp.server import FastMCP
from pydantic import BaseModel, Field

class ApprovalSchema(BaseModel):
    username: str = Field(description="Who is approving?")

server = FastMCP("mytools")

@server.tool()
async def delete_files(paths: list[str]) -> str:
    result = await server.get_context().elicit(
        message=f"Do you want to delete {paths}",
        schema=ApprovalSchema,
    )
    if result.action != "accept":
        return f"User {result.data.username} rejected deletion"

    # Perform deletion...
    return f"User {result.data.username} approved deletion"

server.run()
```

client.py

```python
from mcp import stdio_client, StdioServerParameters
from mcp.types import ElicitResult
from strands import Agent
from strands.tools.mcp import MCPClient

async def elicitation_callback(context, params):
    print(f"ELICITATION: {params.message}")
    # Get user confirmation...
    return ElicitResult(
        action="accept",
        content={"username": "myname"}
    )

client = MCPClient(
    lambda: stdio_client(
        StdioServerParameters(command="python", args=["/path/to/server.py"])
    ),
    elicitation_callback=elicitation_callback,
)

with client:
    agent = Agent(tools=client.list_tools_sync())
    result = agent("Delete 'a/b/c.txt' and share the name of the approver")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
Pass an `elicitationCallback` when constructing the client. The callback receives the request context and the server’s elicitation params, and returns an `ElicitResult`:

```typescript
const client = new McpClient({
  transport: new StdioClientTransport({
    command: 'python',
    args: ['/path/to/server.py'],
  }),
  elicitationCallback: async (_context, params): Promise<ElicitResult> => {
    console.log(`ELICITATION: ${params.message}`)
    // Get user confirmation...
    return {
      action: 'accept',
      content: { username: 'myname' },
    }
  },
})

const agent = new Agent({ tools: [client] })
await agent.invoke("Delete 'a/b/c.txt' and share the name of the approver")
```
(( /tab "TypeScript" ))

For more information on elicitation, see the [MCP specification](https://modelcontextprotocol.io/specification/draft/client/elicitation).

### Progress Notifications

MCP servers can report incremental progress during long-running tool calls. Configure a `progress_callback` on the client to receive these updates:

(( tab "Python" ))
```python
from mcp import stdio_client, StdioServerParameters
from strands import Agent
from strands.tools.mcp import MCPClient

async def progress_callback(progress, total, message):
    pct = f"{progress}/{total}" if total is not None else str(progress)
    label = f" - {message}" if message else ""
    print(f"Progress: {pct}{label}")

client = MCPClient(
    lambda: stdio_client(
        StdioServerParameters(command="python", args=["/path/to/server.py"])
    ),
    progress_callback=progress_callback,
)

with client:
    agent = Agent(tools=client.list_tools_sync())
    agent("Run the long-running task")
```

The callback receives three arguments:

| Argument | Type | Description |
| --- | --- | --- |
| `progress` | `float` | Current progress value reported by the server |
| `total` | `float | None` | Total value (may be `None` if the server doesn’t report it) |
| `message` | `str | None` | Optional human-readable status message from the server |

You can also pass a `progress_callback` directly to `call_tool_sync` or `call_tool_async` to override the instance-level callback for a single call:

```python
result = client.call_tool_sync(
    tool_use_id="tool-123",
    name="long_running_tool",
    arguments={"input": "data"},
    progress_callback=my_one_off_callback,
)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
Progress notifications are not yet supported in the TypeScript SDK.
(( /tab "TypeScript" ))

## Best Practices

-   **Tool Descriptions**: Provide clear descriptions for tools to help the agent understand when and how to use them
-   **Error Handling**: Return informative error messages when tools fail to execute properly
-   **Security**: Consider security implications when exposing tools via MCP, especially for network-accessible servers
-   **Connection Management**: In Python, always use context managers (`with` statements) to ensure proper cleanup of MCP connections
-   **Timeouts**: Set appropriate timeouts for tool calls to prevent hanging on long-running operations

## Troubleshooting

### MCPClientInitializationError (Python)

Tools relying on an MCP connection must be used within a context manager. Operations will fail when the agent is used outside the `with` statement block.

```python
# Correct
with mcp_client:
    agent = Agent(tools=mcp_client.list_tools_sync())
    response = agent("Your prompt")  # Works

# Incorrect
with mcp_client:
    agent = Agent(tools=mcp_client.list_tools_sync())
response = agent("Your prompt")  # Fails - outside context
```

### Connection Failures

Connection failures occur when there are problems establishing a connection with the MCP server. Verify that:

-   The MCP server is running and accessible
-   Network connectivity is available and firewalls allow the connection
-   The URL or command is correct and properly formatted

### Tool Discovery Issues

If tools aren’t being discovered:

-   Confirm the MCP server implements the `list_tools` method correctly
-   Verify all tools are registered with the server

### Tool Execution Errors

When tool execution fails:

-   Verify tool arguments match the expected schema
-   Check server logs for detailed error information

## Related pages

- [Add tools to your agent](/docs/user-guide/sdk/tools/index.md) (2 shared tags)
- [MCP Transports](/docs/user-guide/sdk/tools/mcp-transports/index.md) (2 shared tags)
- [A2A Client](/docs/user-guide/sdk/tools/vended-tools/a2a-client/index.md) (1 shared tag)
- [Attach and invoke tools](/docs/user-guide/sdk/tools/using-tools/index.md) (1 shared tag)
- [Bash / shell](/docs/user-guide/sdk/tools/vended-tools/shell/index.md) (1 shared tag)
- [Community tools package](/docs/user-guide/sdk/tools/community-tools-package/index.md) (1 shared tag)
- [Create custom tools](/docs/user-guide/sdk/tools/custom-tools/index.md) (1 shared tag)
- [Edit](/docs/user-guide/sdk/tools/vended-tools/edit/index.md) (1 shared tag)
- [File editor](/docs/user-guide/sdk/tools/vended-tools/file-editor/index.md) (1 shared tag)
- [Graph](/docs/user-guide/sdk/tools/vended-tools/graph/index.md) (1 shared tag)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/tools/mcp/mcp_client.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/mcp/mcp_client.py)
- [harness-sdk/strands-py/src/strands/tools/mcp/mcp_agent_tool.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/mcp/mcp_agent_tool.py)

### TypeScript

- [harness-sdk/strands-ts/src/mcp/client.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/client.ts)
- [harness-sdk/strands-ts/src/mcp/config.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/config.ts)
- [harness-sdk/strands-ts/src/mcp/config.node.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/mcp/config.node.ts)
- [harness-sdk/strands-ts/src/tools/mcp-tool.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/tools/mcp-tool.ts)
