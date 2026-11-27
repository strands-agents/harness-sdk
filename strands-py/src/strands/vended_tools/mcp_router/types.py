"""Shared types and constants for the mcp_router tool."""

from __future__ import annotations

MCP_ROUTER_DESCRIPTION = (
    "Connects to Model Context Protocol (MCP) servers at runtime to discover and invoke their tools. "
    "'connect' opens a connection to a permitted server. "
    "'list_connections' returns all currently open connection IDs. "
    "'list_tools' returns the tools the connected server exposes, including their names and input schemas. "
    "'call_tool' invokes a named tool on a connected server and returns its result. "
    "'disconnect' closes a connection. "
    "Multiple servers can be connected simultaneously. "
    "Use connection_id to identify which connection to use for list_tools, call_tool, and disconnect."
)
"""Description for the mcp_router tool shown to the model."""
