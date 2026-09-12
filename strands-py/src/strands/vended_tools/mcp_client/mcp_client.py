"""Agent-callable MCP client tool.

Provides :func:`make_mcp_client` (a factory bound to a developer-set server allowlist).

The tool exposes four commands — ``connect``, ``list_tools``, ``call_tool``,
``disconnect`` — letting an agent open named connections to MCP servers, discover their
tools, invoke them, and close the connections. Each server is configured with a
:class:`~strands.tools.mcp.MCPServerConfig`; all fields are forwarded to
:class:`~strands.tools.mcp.MCPClient`. Connections are isolated per agent.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import weakref
from typing import TYPE_CHECKING, Any, Literal, cast
from uuid import uuid4

from ...tools.decorator import tool
from ...tools.mcp.mcp_agent_tool import MCPAgentTool
from ...tools.mcp.mcp_client import MCPClient, MCPServerConfig
from ...tools.mcp.mcp_types import MCPToolResult
from ...types.tools import ToolContext, ToolSpec
from .types import MCP_CLIENT_DESCRIPTION

if TYPE_CHECKING:
    from ...tools.decorator import DecoratedFunctionTool

logger = logging.getLogger(__name__)

_DEFAULT_MAX_CONNECTIONS = 10


class MCPClientToolError(RuntimeError):
    """Raised when an mcp_client tool operation fails."""


def make_mcp_client(
    *,
    name: str = "mcp_client",
    description: str | None = None,
    servers: dict[str, MCPServerConfig],
    max_connections: int = _DEFAULT_MAX_CONNECTIONS,
) -> DecoratedFunctionTool:
    """Create an agent-callable MCP client tool bound to a developer-set server allowlist.

    Args:
        name: Tool name. Defaults to ``"mcp_client"``.
        description: Tool description shown to the model. Defaults to a description
            that includes the list of permitted server names.
        servers: Allowlisted servers keyed by name. The name is passed to ``connect``; the config
            is forwarded to :class:`~strands.tools.mcp.MCPClient`. Must not be empty.
        max_connections: Maximum simultaneous open connections per agent. Defaults to ``10``.

    Returns:
        A decorated tool that manages MCP connections.

    Raises:
        ValueError: If ``servers`` is empty or ``max_connections`` is not positive.
    """
    if not servers:
        raise ValueError("`servers` must not be empty; the mcp_client tool requires at least one server")
    if max_connections < 1:
        raise ValueError("`max_connections` must be at least 1")

    if description is None:
        permitted = ", ".join(f"'{s}'" for s in sorted(servers))
        description = f"{MCP_CLIENT_DESCRIPTION} Permitted server names: {permitted}."

    # Per-agent connections with WeakKeyDictionary so agents can be garbage collected.
    connections_map: weakref.WeakKeyDictionary[Any, dict[str, MCPClient]] = weakref.WeakKeyDictionary()

    @tool(name=name, description=description, context="tool_context")
    async def mcp_client_tool(
        command: Literal["connect", "list_tools", "call_tool", "disconnect"],
        tool_context: ToolContext,
        connection_id: str | None = None,
        server_name: str | None = None,
        tool_name: str | None = None,
        arguments: dict[str, Any] | None = None,
    ) -> list[ToolSpec] | MCPToolResult | str:
        """Manage runtime MCP client connections.

        Args:
            command: The operation to perform: ``connect``, ``list_tools``, ``call_tool``, ``disconnect``.
            tool_context: Injected by the framework. Not user-facing.
            server_name: Server name to connect to, required for ``connect``.
            connection_id: A descriptive name for this connection, required for all commands.
                Must be unique per agent. Reusing an active id is rejected.
            tool_name: Tool name to invoke, required for ``call_tool``.
            arguments: Arguments to pass to the invoked tool, for ``call_tool``.

        Raises:
            MCPClientToolError: If a required argument is missing, the server is not on
                the allowlist, the connection cap is reached, no matching connection exists,
                or the connection fails to start.
        """
        agent = tool_context.agent

        if not connection_id:
            raise MCPClientToolError("`connection_id` is required for all commands")

        if command == "connect":
            if not server_name:
                raise MCPClientToolError("`server_name` is required for command='connect'")
            return await _handle_connect(connections_map, agent, servers, server_name, connection_id, max_connections)

        connections = connections_map.get(agent, {})
        client = connections.get(connection_id)
        if client is None:
            raise MCPClientToolError(f"No active connection for id {connection_id!r}")

        if command == "list_tools":
            return await asyncio.to_thread(_handle_list_tools, client)

        if command == "call_tool":
            if not tool_name:
                raise MCPClientToolError("`tool_name` is required for command='call_tool'")
            return await client.call_tool_async(
                tool_use_id=str(uuid4()),
                name=tool_name,
                arguments=arguments,
                cancel_signal=tool_context.cancel_signal,
            )

        if command == "disconnect":
            return await _handle_disconnect(connections, connection_id)

        raise MCPClientToolError(f"Unknown command: {command}")

    return mcp_client_tool


# ---- Internals ----------------------------------------------------------------


def _stop_client(client: MCPClient) -> None:
    try:
        client.stop(None, None, None)
    except Exception:
        logger.debug("failed to stop MCP client", exc_info=True)


def _cleanup(connections: dict[str, MCPClient]) -> None:
    threads = []
    for connection_id, client in list(connections.items()):
        logger.debug("connection_id=<%s> | closing MCP connection during GC", connection_id)
        thread = threading.Thread(target=_stop_client, args=(client,), daemon=True)
        thread.start()
        threads.append(thread)
    for thread in threads:
        thread.join(timeout=1.0)


async def _handle_connect(
    connections_map: weakref.WeakKeyDictionary[Any, dict[str, MCPClient]],
    agent: Any,
    servers: dict[str, MCPServerConfig],
    server_name: str,
    connection_id: str,
    max_connections: int,
) -> str:
    if server_name not in servers:
        permitted = ", ".join(sorted(servers))
        raise MCPClientToolError(f"Server {server_name!r} is not on the allowlist. Permitted servers: {permitted}")

    config = cast(dict[str, Any], servers[server_name])
    loaded = MCPClient.load_servers({server_name: config})
    if not loaded:
        raise MCPClientToolError(f"Server {server_name!r} failed to initialise; check the server config")
    client = loaded[0]

    try:
        # start() blocks until the MCP background thread signals ready — run it off the event loop.
        await asyncio.to_thread(client.start)
    except BaseException:
        _stop_client(client)
        raise

    # Cap and duplicate checks after all awaits to avoid race conditions.
    connections = connections_map.get(agent)
    if connections is None:
        connections = {}
        connections_map[agent] = connections
        # Stop all open connections if the agent is garbage collected without calling disconnect.
        weakref.finalize(agent, _cleanup, connections)

    if len(connections) >= max_connections:
        _stop_client(client)
        active_ids = ", ".join(sorted(connections))
        raise MCPClientToolError(
            f"Connection limit of {max_connections} reached. "
            f"Disconnect one of the active connections before opening a new one. "
            f"Active connection_ids: {active_ids}"
        )

    if connection_id in connections:
        _stop_client(client)
        raise MCPClientToolError(
            f"Connection {connection_id!r} already exists. Disconnect it first or use a different connection_id."
        )

    connections[connection_id] = client

    logger.debug("connection_id=<%s>, server_name=<%s> | opened MCP connection", connection_id, server_name)
    return f"Successfully connected to {server_name} as {connection_id!r}"


def _handle_list_tools(client: MCPClient) -> list[ToolSpec]:
    all_tools: list[MCPAgentTool] = []
    pagination_token: str | None = None
    while True:
        page = client.list_tools_sync(pagination_token)
        all_tools.extend(page)
        pagination_token = page.pagination_token
        if pagination_token is None:
            break
    # Get mcp_tool.name instead of tool_name (may be prefixed) so call_tool works verbatim.
    return [{**t.tool_spec, "name": t.mcp_tool.name} for t in all_tools]


async def _handle_disconnect(connections: dict[str, MCPClient], connection_id: str) -> str:
    client = connections.pop(connection_id, None)
    if client is not None:
        await asyncio.to_thread(_stop_client, client)
    return "Successfully disconnected"
