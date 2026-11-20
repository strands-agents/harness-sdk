"""MCP server for programmatic-tool-caller integration testing.

Exposes a few simple tools whose names deliberately cover both valid Python identifiers
(``ptc_echo``) and names that are not (``ptc-dash``, ``ptc.dot``), so tests can verify that
agent-authored code can call MCP tools regardless of how the server names them.
"""

from importlib import import_module
from typing import Any

try:
    from mcp.server import FastMCP
    from mcp.server.fastmcp.exceptions import ToolError
except ImportError:
    mcpserver = import_module("mcp.server.mcpserver")
    FastMCP = mcpserver.MCPServer
    ToolError = mcpserver.exceptions.ToolError


def start_programmatic_tool_caller_server() -> None:
    """Initialize and start the MCP server over stdio transport."""
    mcp = FastMCP("Programmatic Tool Caller Test Server")

    @mcp.tool(description="Echoes the given text back", structured_output=False)
    def ptc_echo(text: str) -> str:
        return f"echo:{text}"

    @mcp.tool(description="Adds two integers", structured_output=False)
    def ptc_add(a: int, b: int) -> int:
        return a + b

    @mcp.tool(name="ptc-dash", description="Tool whose name contains a hyphen", structured_output=False)
    def ptc_dash(value: str) -> str:
        return f"dash:{value}"

    @mcp.tool(name="ptc.dot", description="Tool whose name contains a dot", structured_output=False)
    def ptc_dot(value: str) -> str:
        return f"dot:{value}"

    @mcp.tool(description="Returns structured content", structured_output=True)
    def ptc_info(name: str) -> dict[str, Any]:
        return {"name": name, "size": len(name) + 2}

    @mcp.tool(description="Always raises", structured_output=False)
    def ptc_boom() -> str:
        raise ToolError("mcp tool exploded")

    mcp.run(transport="stdio")


if __name__ == "__main__":
    start_programmatic_tool_caller_server()
