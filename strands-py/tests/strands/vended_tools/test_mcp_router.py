"""Tests for the vended mcp_router tool."""

from __future__ import annotations

import gc
import threading
import time
from collections.abc import Callable
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from mcp.types import CallToolResult as MCPCallToolResult
from mcp.types import ListToolsResult
from mcp.types import TextContent as MCPTextContent
from mcp.types import Tool as MCPTool

from strands.tools.mcp import MCPClient
from strands.types.tools import ToolContext
from strands.vended_tools import make_mcp_router
from strands.vended_tools.mcp_router.mcp_router import MCPRouterToolError


def _wait_until(pred: Callable[[], bool], timeout: float = 2.0, interval: float = 0.01) -> None:
    """Poll pred() until it returns True or timeout expires."""
    deadline = time.monotonic() + timeout
    while not pred() and time.monotonic() < deadline:
        time.sleep(interval)


class _StubAgent:
    """A minimal agent stand-in."""

    def __init__(self, label: str | None = None) -> None:
        self.label = label


def _tool_context(agent: Any | None = None) -> ToolContext:
    """Build a ToolContext with a distinct agent object."""
    if agent is None:
        agent = _StubAgent()
    return ToolContext(
        tool_use={"name": "mcp_router", "toolUseId": "test-id", "input": {}},
        agent=agent,
        invocation_state={},
    )


@pytest.fixture
def _mock_transport():
    """A mock MCP transport callable that yields fake read/write streams."""
    mock_transport_cm = AsyncMock()
    mock_transport_cm.__aenter__.return_value = (AsyncMock(), AsyncMock())
    return MagicMock(return_value=mock_transport_cm)


@pytest.fixture
def _mock_session():
    """A mock ClientSession injected via patch so MCPClient uses it internally."""
    session = AsyncMock()
    init_result = MagicMock()
    init_result.instructions = None
    session.initialize = AsyncMock(return_value=init_result)
    session.instructions = None
    session.get_server_capabilities = MagicMock(return_value=None)

    session_cm = AsyncMock()
    session_cm.__aenter__.return_value = session

    with patch("strands.tools.mcp.mcp_client.ClientSession", return_value=session_cm):
        yield session


@pytest.fixture
def _mcp_instance(_mock_transport, _mock_session):
    """An unstarted MCPClient backed by _mock_transport/_mock_session.

    The router's connect command calls start() itself. Teardown is best-effort.
    """
    client = MCPClient(_mock_transport)
    yield client
    try:
        client.stop(None, None, None)
    except Exception:
        pass


class TestServerValidation:
    """make_mcp_router rejects invalid configs at construction time."""

    def test_empty_allowlist_is_rejected(self) -> None:
        with pytest.raises(ValueError, match="must not be empty"):
            make_mcp_router(servers={})

    def test_zero_max_connections_is_rejected(self) -> None:
        with pytest.raises(ValueError, match="max_connections"):
            make_mcp_router(servers={"mcp": {"url": "https://mcp.example.com/mcp"}}, max_connections=0)

    def test_description_includes_server_names(self) -> None:
        tool = make_mcp_router(servers={"my-server": {"url": "https://mcp.example.com/mcp"}})
        assert "my-server" in tool.tool_spec["description"]


class TestConnect:
    """connect enforces the allowlist, validates input, and handles errors."""

    @pytest.mark.asyncio
    async def test_url_not_on_allowlist_is_rejected(self) -> None:
        tool = make_mcp_router(servers={"mcp": {"url": "https://mcp.example.com/mcp"}})
        with pytest.raises(MCPRouterToolError, match="not on the MCP server allowlist"):
            await tool(command="connect", server_name="evil", connection_id="c1", tool_context=_tool_context())

    @pytest.mark.asyncio
    async def test_missing_connection_id_is_rejected(self) -> None:
        tool = make_mcp_router(servers={"mcp": {"url": "https://mcp.example.com/mcp"}})
        with pytest.raises(MCPRouterToolError, match="connection_id"):
            await tool(command="connect", server_name="mcp", tool_context=_tool_context())

    @pytest.mark.asyncio
    async def test_missing_server_name_is_rejected(self) -> None:
        tool = make_mcp_router(servers={"mcp": {"url": "https://mcp.example.com/mcp"}})
        with pytest.raises(MCPRouterToolError, match="server_name"):
            await tool(command="connect", connection_id="c1", tool_context=_tool_context())

    @pytest.mark.asyncio
    async def test_multiple_connections_simultaneously(self, _mcp_instance: MCPClient, _mock_session: Any) -> None:
        """Two connections with different IDs can coexist."""
        tool = make_mcp_router(
            servers={
                "server-a": {"url": "https://a.example.com/mcp"},
                "server-b": {"url": "https://b.example.com/mcp"},
            }
        )
        agent = _StubAgent()
        _mock_session.list_tools.return_value = ListToolsResult(tools=[])
        # Two separate real clients, one per connection.
        client_b = MCPClient(_mcp_instance._transport_callable)

        def _load(config: dict[str, Any]) -> list[MCPClient]:
            return [_mcp_instance] if "server-a" in config else [client_b]

        with patch.object(MCPClient, "load_servers", side_effect=_load):
            await tool(
                command="connect", server_name="server-a", connection_id="conn-a", tool_context=_tool_context(agent)
            )
            await tool(
                command="connect", server_name="server-b", connection_id="conn-b", tool_context=_tool_context(agent)
            )
            await tool(command="list_tools", connection_id="conn-a", tool_context=_tool_context(agent))
            await tool(command="list_tools", connection_id="conn-b", tool_context=_tool_context(agent))

        try:
            client_b.stop(None, None, None)
        except Exception:
            pass

    @pytest.mark.asyncio
    async def test_reconnect_with_same_id_raises(self, _mcp_instance: MCPClient, _mock_session: Any) -> None:
        """Reusing an existing connection_id raises an error after the second start."""
        tool = make_mcp_router(servers={"mcp": {"url": "https://mcp.example.com/mcp"}})
        agent = _StubAgent()

        # Second connect needs its own client instance to reach start().
        client_b = MCPClient(_mcp_instance._transport_callable)
        clients = iter([_mcp_instance, client_b])

        def _load(_config: dict[str, Any]) -> list[MCPClient]:
            return [next(clients)]

        with patch.object(MCPClient, "load_servers", side_effect=_load):
            await tool(command="connect", server_name="mcp", connection_id="c1", tool_context=_tool_context(agent))
            with pytest.raises(MCPRouterToolError, match="already exists"):
                await tool(command="connect", server_name="mcp", connection_id="c1", tool_context=_tool_context(agent))

        # client_b was started then stopped by the duplicate-id guard.
        _wait_until(lambda: client_b._background_thread is None)
        assert client_b._background_thread is None

    @pytest.mark.asyncio
    async def test_connection_cap_is_enforced(self, _mcp_instance: MCPClient, _mock_session: Any) -> None:
        """Opening more connections than max_connections raises with active IDs listed."""
        tool = make_mcp_router(
            servers={"mcp": {"url": "https://mcp.example.com/mcp"}},
            max_connections=2,
        )
        agent = _StubAgent()
        extra_clients = [MCPClient(_mcp_instance._transport_callable) for _ in range(2)]
        clients = iter([_mcp_instance] + extra_clients)

        def _load(_config: dict[str, Any]) -> list[MCPClient]:
            return [next(clients)]

        with patch.object(MCPClient, "load_servers", side_effect=_load):
            await tool(command="connect", server_name="mcp", connection_id="c1", tool_context=_tool_context(agent))
            await tool(command="connect", server_name="mcp", connection_id="c2", tool_context=_tool_context(agent))
            with pytest.raises(MCPRouterToolError, match="Connection limit of 2"):
                await tool(command="connect", server_name="mcp", connection_id="c3", tool_context=_tool_context(agent))

        for client in extra_clients:
            try:
                client.stop(None, None, None)
            except Exception:
                pass

    @pytest.mark.asyncio
    async def test_agent_isolation(self, _mcp_instance: MCPClient, _mock_session: Any) -> None:
        """A connection opened by agent A is not visible to agent B."""
        tool = make_mcp_router(servers={"mcp": {"url": "https://mcp.example.com/mcp"}})
        agent_a = _StubAgent(label="a")
        agent_b = _StubAgent(label="b")
        with patch.object(MCPClient, "load_servers", return_value=[_mcp_instance]):
            await tool(command="connect", server_name="mcp", connection_id="c1", tool_context=_tool_context(agent_a))
            with pytest.raises(MCPRouterToolError, match="No active connection"):
                await tool(command="list_tools", connection_id="c1", tool_context=_tool_context(agent_b))

    @pytest.mark.asyncio
    async def test_start_failure_leaves_no_connection(self) -> None:
        """If start() raises, the client is stopped and no connection is registered."""
        tool = make_mcp_router(servers={"mcp": {"url": "https://mcp.example.com/mcp"}})
        agent = _StubAgent()

        broken = MagicMock()
        broken.start = MagicMock(side_effect=RuntimeError("connection refused"))
        broken.stop = MagicMock()

        with patch.object(MCPClient, "load_servers", return_value=[broken]):
            with pytest.raises(RuntimeError, match="connection refused"):
                await tool(command="connect", server_name="mcp", connection_id="c1", tool_context=_tool_context(agent))

        broken.stop.assert_called_once()
        with pytest.raises(MCPRouterToolError, match="connection_id.*required|No active connection"):
            await tool(command="list_tools", tool_context=_tool_context(agent))


class TestSessionLifecycle:
    """Full connect → list_tools → call_tool → disconnect flow."""

    @pytest.mark.asyncio
    async def test_full_lifecycle(self, _mcp_instance: MCPClient, _mock_session: Any) -> None:
        mcp_tool = MCPTool(name="echo", description="Echoes input", inputSchema={"type": "object", "properties": {}})
        _mock_session.list_tools.return_value = ListToolsResult(tools=[mcp_tool])
        _mock_session.call_tool.return_value = MCPCallToolResult(
            content=[MCPTextContent(type="text", text="hello world")]
        )

        tool = make_mcp_router(servers={"mcp": {"url": "https://mcp.example.com/mcp"}})
        agent = _StubAgent()

        with patch.object(MCPClient, "load_servers", return_value=[_mcp_instance]):
            tru_connect = await tool(
                command="connect", server_name="mcp", connection_id="c1", tool_context=_tool_context(agent)
            )
            assert "mcp" in tru_connect and "c1" in tru_connect
            assert _mcp_instance._background_thread is not None

            tru_tools = await tool(command="list_tools", connection_id="c1", tool_context=_tool_context(agent))
            assert len(tru_tools) == 1
            assert tru_tools[0]["name"] == "echo"
            _mock_session.list_tools.assert_called_once()

            tru_call = await tool(
                command="call_tool",
                connection_id="c1",
                tool_name="echo",
                arguments={"msg": "hi"},
                tool_context=_tool_context(agent),
            )
            assert tru_call["content"][0]["text"] == "hello world"
            tru_call_args = _mock_session.call_tool.call_args
            assert tru_call_args[0][0] == "echo"
            assert tru_call_args[0][1] == {"msg": "hi"}

            tru_disconnect = await tool(command="disconnect", connection_id="c1", tool_context=_tool_context(agent))
            exp_disconnect = "Successfully disconnected"
            assert tru_disconnect == exp_disconnect
            _wait_until(lambda: _mcp_instance._background_thread is None)
            assert _mcp_instance._background_thread is None

            with pytest.raises(MCPRouterToolError, match="No active connection"):
                await tool(command="list_tools", connection_id="c1", tool_context=_tool_context(agent))

    @pytest.mark.asyncio
    async def test_call_tool_without_name_is_rejected(self, _mcp_instance: MCPClient, _mock_session: Any) -> None:
        tool = make_mcp_router(servers={"mcp": {"url": "https://mcp.example.com/mcp"}})
        agent = _StubAgent()
        with patch.object(MCPClient, "load_servers", return_value=[_mcp_instance]):
            await tool(command="connect", server_name="mcp", connection_id="c1", tool_context=_tool_context(agent))
            with pytest.raises(MCPRouterToolError, match="tool_name"):
                await tool(command="call_tool", connection_id="c1", tool_context=_tool_context(agent))

    @pytest.mark.asyncio
    async def test_disconnect_when_stop_raises_still_evicts(self) -> None:
        """RuntimeError from stop() must not prevent connection eviction."""
        tool = make_mcp_router(servers={"mcp": {"url": "https://mcp.example.com/mcp"}})
        agent = _StubAgent()

        broken_stop = MagicMock()
        broken_stop.start = MagicMock()
        broken_stop.stop = MagicMock(side_effect=RuntimeError("already closed"))

        with patch.object(MCPClient, "load_servers", return_value=[broken_stop]):
            await tool(command="connect", server_name="mcp", connection_id="c1", tool_context=_tool_context(agent))
            tru_disconnect = await tool(command="disconnect", connection_id="c1", tool_context=_tool_context(agent))

        exp_disconnect = "Successfully disconnected"
        assert tru_disconnect == exp_disconnect
        with pytest.raises(MCPRouterToolError, match="No active connection"):
            await tool(command="list_tools", connection_id="c1", tool_context=_tool_context(agent))

    @pytest.mark.asyncio
    async def test_cancel_signal_forwarded(self, _mcp_instance: MCPClient, _mock_session: Any) -> None:
        """The agent's cancel signal reaches call_tool_async."""
        captured: dict[str, Any] = {}
        original = _mcp_instance.call_tool_async

        async def _spy(*args: Any, **kwargs: Any) -> Any:
            captured["cancel_signal"] = kwargs.get("cancel_signal")
            return await original(*args, **kwargs)

        _mock_session.call_tool.return_value = MCPCallToolResult(content=[])

        cancel = threading.Event()
        agent = _StubAgent()
        ctx = _tool_context(agent)
        ctx.cancel_signal = cancel

        tool = make_mcp_router(servers={"mcp": {"url": "https://mcp.example.com/mcp"}})
        with patch.object(MCPClient, "load_servers", return_value=[_mcp_instance]):
            with patch.object(_mcp_instance, "call_tool_async", side_effect=_spy):
                await tool(command="connect", server_name="mcp", connection_id="c1", tool_context=ctx)
                await tool(command="call_tool", connection_id="c1", tool_name="slow", tool_context=ctx)

        assert captured["cancel_signal"] is cancel

    @pytest.mark.asyncio
    async def test_open_connection_stopped_on_agent_gc(self, _mcp_instance: MCPClient, _mock_session: Any) -> None:
        tool = make_mcp_router(servers={"mcp": {"url": "https://mcp.example.com/mcp"}})
        agent: _StubAgent | None = _StubAgent()

        with patch.object(MCPClient, "load_servers", return_value=[_mcp_instance]):
            await tool(command="connect", server_name="mcp", connection_id="c1", tool_context=_tool_context(agent))

        assert _mcp_instance._background_thread is not None
        del agent
        gc.collect()
        _wait_until(lambda: _mcp_instance._background_thread is None)
        assert _mcp_instance._background_thread is None


class TestConfigForwarding:
    """The matched server config and server name are forwarded correctly to MCPClient.load_servers."""

    @pytest.mark.asyncio
    async def test_config_and_server_name_reach_load_servers(
        self, _mcp_instance: MCPClient, _mock_session: Any
    ) -> None:
        """The full server config and the server_name key both reach load_servers."""
        server_config = {"url": "https://mcp.example.com/mcp", "headers": {"X-Api-Key": "secret"}}
        tool = make_mcp_router(servers={"my-api": server_config})
        agent = _StubAgent()
        captured: dict[str, Any] = {}

        def _load(config: dict[str, Any]) -> list[MCPClient]:
            captured.update(config)
            return [_mcp_instance]

        with patch.object(MCPClient, "load_servers", side_effect=_load):
            await tool(command="connect", server_name="my-api", connection_id="c1", tool_context=_tool_context(agent))

        assert captured == {"my-api": server_config}


class TestListConnections:
    """list_connections returns current open connection IDs for the calling agent."""

    @pytest.mark.asyncio
    async def test_returns_sorted_open_connection_ids(self, _mcp_instance: MCPClient, _mock_session: Any) -> None:
        """Returns a comma-separated sorted string; empty string when no connections exist."""
        tool = make_mcp_router(
            servers={
                "server-a": {"url": "https://a.example.com/mcp"},
                "server-b": {"url": "https://b.example.com/mcp"},
            }
        )
        agent = _StubAgent()

        tru_empty = await tool(command="list_connections", tool_context=_tool_context(agent))
        assert tru_empty == ""

        client_b = MCPClient(_mcp_instance._transport_callable)

        def _load(config: dict[str, Any]) -> list[MCPClient]:
            return [_mcp_instance] if "server-a" in config else [client_b]

        with patch.object(MCPClient, "load_servers", side_effect=_load):
            await tool(
                command="connect", server_name="server-a", connection_id="conn-a", tool_context=_tool_context(agent)
            )
            await tool(
                command="connect", server_name="server-b", connection_id="conn-b", tool_context=_tool_context(agent)
            )

        tru_connections = await tool(command="list_connections", tool_context=_tool_context(agent))
        exp_connections = "conn-a, conn-b"
        assert tru_connections == exp_connections

        try:
            client_b.stop(None, None, None)
        except Exception:
            pass

    @pytest.mark.asyncio
    async def test_agent_isolation(self, _mcp_instance: MCPClient, _mock_session: Any) -> None:
        """list_connections for agent B does not include connections opened by agent A."""
        tool = make_mcp_router(servers={"mcp": {"url": "https://mcp.example.com/mcp"}})
        agent_a = _StubAgent(label="a")
        agent_b = _StubAgent(label="b")
        with patch.object(MCPClient, "load_servers", return_value=[_mcp_instance]):
            await tool(command="connect", server_name="mcp", connection_id="c1", tool_context=_tool_context(agent_a))

        tru_connections = await tool(command="list_connections", tool_context=_tool_context(agent_b))
        exp_connections = ""
        assert tru_connections == exp_connections


class TestToolMetadata:
    """The tool exposes a sensible name, description, and input schema."""

    def test_custom_name(self) -> None:
        tool = make_mcp_router(servers={"mcp": {"url": "https://mcp.example.com/mcp"}}, name="my_mcp")
        assert tool.tool_name == "my_mcp"

    def test_schema_exposes_expected_fields(self) -> None:
        tool = make_mcp_router(servers={"mcp": {"url": "https://mcp.example.com/mcp"}})
        props = tool.tool_spec["inputSchema"]["json"]["properties"]
        assert "command" in props
        assert "server_name" in props
        assert "connection_id" in props
        assert "tool_context" not in props
