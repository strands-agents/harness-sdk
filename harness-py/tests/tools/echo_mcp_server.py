"""MCP server fixture for tests that need a real stdio server.

Exposes an ``echo`` tool and an ``add`` tool so tests can check that a server's tools reach an
agent (and its subagents) under the configured prefix.

Usage:
    $ python echo_mcp_server.py
"""

from importlib import import_module

try:
    from mcp.server import FastMCP
except ImportError:
    FastMCP = import_module("mcp.server.mcpserver").MCPServer


def start_echo_server() -> None:
    """Initialize and start the MCP server over stdio transport."""
    mcp = FastMCP("Echo Test Server")

    @mcp.tool(description="Echoes the given text back", structured_output=False)
    def echo(text: str) -> str:
        return f"echo:{text}"

    @mcp.tool(description="Adds two integers", structured_output=False)
    def add(a: int, b: int) -> int:
        return a + b

    mcp.run(transport="stdio")


if __name__ == "__main__":
    start_echo_server()
