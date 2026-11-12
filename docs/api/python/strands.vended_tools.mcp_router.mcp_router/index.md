Agent-callable MCP router tool.

Provides :func:`make_mcp_router` (a factory bound to a developer-set server allowlist).

The tool exposes five commands — `connect`, `list_connections`, `list_tools`, `call_tool`, `disconnect` — letting an agent open named connections to MCP servers, inspect active connections, discover their tools, invoke them, and close the connections. Each server is configured with a :class:`~strands.tools.mcp.MCPServerConfig`; all fields are forwarded to :class:`~strands.tools.mcp.MCPClient`. A server’s `tool_filters` limit both `list_tools` and `call_tool`. Connections are isolated per agent.

## MCPRouterToolError

```python
class MCPRouterToolError(RuntimeError)
```

Defined in: [src/strands/vended\_tools/mcp\_router/mcp\_router.py:37](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_tools/mcp_router/mcp_router.py#L37)

Raised when an mcp\_router tool operation fails.

#### make\_mcp\_router

```python
def make_mcp_router(
        *,
        name: str = "mcp_router",
        description: str | None = None,
        servers: dict[str, MCPServerConfig],
        max_connections: int = _DEFAULT_MAX_CONNECTIONS
) -> DecoratedFunctionTool
```

Defined in: [src/strands/vended\_tools/mcp\_router/mcp\_router.py:41](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_tools/mcp_router/mcp_router.py#L41)

Create an agent-callable MCP router tool bound to a developer-set server allowlist.

MCP connections are scoped per agent and persist across invocations. They are closed when the model calls `disconnect` explicitly or when the agent is garbage collected. Connections remain open otherwise.

**Arguments**:

-   `name` - Tool name shown to the model.
-   `description` - Tool description shown to the model. Defaults to a description that includes the permitted server names.
-   `servers` - Allowlisted servers keyed by name. The model identifies servers to connect to by name; the config is forwarded to :class:`~strands.tools.mcp.MCPClient`. A server’s `tool_filters` decide which tools `list_tools` returns and `call_tool` accepts. Must not be empty.
-   `max_connections` - Maximum simultaneous open connections per agent. Defaults to `10`.

**Returns**:

A decorated tool that manages MCP connections.

**Raises**:

-   `ValueError` - If `servers` is empty or `max_connections` is not positive.