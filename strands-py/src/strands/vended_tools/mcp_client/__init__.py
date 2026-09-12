"""Agent-callable MCP client tool for connecting to Model Context Protocol servers at runtime.

Provides :func:`make_mcp_client` (a factory that returns a tool bound to a developer-set
server allowlist) for use cases where the agent, not the developer, decides which server to
talk to at runtime. Developer-wired MCP clients remain the primary path
(``strands.tools.mcp.MCPClient``); this tool is the agent-facing shim.

Example Usage:
    ```python
    from strands import Agent
    from strands.vended_tools import make_mcp_client

    mcp_client_tool = make_mcp_client(servers={
        "my-api": {"url": "https://mcp.example.com/mcp"},
    })
    agent = Agent(tools=[mcp_client_tool])
    ```
"""

from .mcp_client import make_mcp_client

__all__ = [
    "make_mcp_client",
]
