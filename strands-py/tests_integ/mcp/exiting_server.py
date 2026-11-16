"""Stdio MCP server whose process can be made to exit, for testing how the client handles a dead server."""

import os

try:
    from mcp.server.mcpserver import MCPServer as Server
except ImportError:  # mcp 1.x
    from mcp.server import FastMCP as Server

server = Server("exiting-server")


@server.tool(description="Returns the server's process id")
def get_pid() -> str:
    return str(os.getpid())


@server.tool(description="Exits the server process without responding")
def exit_process() -> str:
    os._exit(1)


if __name__ == "__main__":
    server.run(transport="stdio")
