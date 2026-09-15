"""Tests for the vended MCP client tool."""

from __future__ import annotations

import threading
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from mcp.types import Tool as MCPTool

from strands.tools.mcp import MCPAgentTool
from strands.types.collections import PaginatedList
from strands.types.tools import ToolContext
from strands.vended_tools import make_mcp_client
from strands.vended_tools.mcp_client.mcp_client import MCPClientToolError


class _StubAgent:
    """A minimal agent stand-in."""

    def __init__(self, label: str | None = None) -> None:
        self.label = label


def _tool_context(agent: Any | None = None) -> ToolContext:
    """Build a ToolContext with a distinct agent object."""
    if agent is None:
        agent = _StubAgent()
    return ToolContext(
        tool_use={"name": "mcp_client", "toolUseId": "test-id", "input": {}},
        agent=agent,
        invocation_state={},
    )


def _make_mcp_tool(name: str = "test_tool", description: str = "A test tool", **kwargs: Any) -> MCPTool:
    """Build a real MCPTool; delegates to mcp.types.Tool so tool_spec works correctly."""
    return MCPTool(
        name=name,
        description=description,
        inputSchema=kwargs.pop("inputSchema", {"type": "object", "properties": {}}),
        **kwargs,
    )


def _make_agent_tool(name: str = "test_tool", description: str = "A test tool", **kwargs: Any) -> MCPAgentTool:
    """Wrap a real MCPTool in a real MCPAgentTool backed by a MagicMock client."""
    return MCPAgentTool(mcp_tool=_make_mcp_tool(name=name, description=description, **kwargs), mcp_client=MagicMock())


def _fake_mcp_client_class(
    *,
    list_tools_return: list[MCPAgentTool] | None = None,
    call_tool_return: dict[str, Any] | None = None,
) -> tuple[Any, MagicMock]:
    """Return (load_servers patch target, mock client instance) for patching MCPClient."""
    instance = MagicMock()
    instance.start = MagicMock()
    instance.stop = MagicMock()
    instance.list_tools_sync = MagicMock(return_value=PaginatedList(list_tools_return or []))

    async def _call(*args: Any, **kwargs: Any) -> Any:
        return call_tool_return or {"status": "success", "content": [{"text": "ok"}]}

    instance.call_tool_async = MagicMock(side_effect=_call)
    return MagicMock(return_value=[instance]), instance


def _mcp_instance(tools: list[MCPAgentTool] | None = None) -> MagicMock:
    """Return a MagicMock that satisfies load_servers' return contract."""
    instance = MagicMock()
    instance.list_tools_sync = MagicMock(return_value=PaginatedList(tools or []))
    return instance


class TestServerValidation:
    """make_mcp_client rejects invalid configs at construction time."""

    def test_empty_allowlist_is_rejected(self) -> None:
        with pytest.raises(ValueError, match="must not be empty"):
            make_mcp_client(servers={})

    def test_zero_max_connections_is_rejected(self) -> None:
        with pytest.raises(ValueError, match="max_connections"):
            make_mcp_client(servers={"mcp": {"url": "https://mcp.example.com/mcp"}}, max_connections=0)

    def test_description_includes_server_names(self) -> None:
        tool = make_mcp_client(servers={"my-server": {"url": "https://mcp.example.com/mcp"}})
        assert "my-server" in tool.tool_spec["description"]

    def test_stdio_config_is_accepted(self) -> None:
        tool = make_mcp_client(servers={"local": {"command": "node", "args": ["server.js"]}})
        assert tool.tool_name == "mcp_client"
        assert "local" in tool.tool_spec["description"]


class TestConnect:
    """connect enforces the allowlist, validates input, and handles errors."""

    @pytest.mark.asyncio
    async def test_url_not_on_allowlist_is_rejected(self) -> None:
        tool = make_mcp_client(servers={"mcp": {"url": "https://mcp.example.com/mcp"}})
        with pytest.raises(MCPClientToolError, match="not on the allowlist"):
            await tool(command="connect", server_name="evil", connection_id="c1", tool_context=_tool_context())

    @pytest.mark.asyncio
    async def test_missing_connection_id_is_rejected(self) -> None:
        t = make_mcp_client(servers={"mcp": {"url": "https://mcp.example.com/mcp"}})
        with pytest.raises(MCPClientToolError, match="connection_id"):
            await t(command="connect", server_name="mcp", tool_context=_tool_context())

    @pytest.mark.asyncio
    async def test_missing_server_name_is_rejected(self) -> None:
        t = make_mcp_client(servers={"mcp": {"url": "https://mcp.example.com/mcp"}})
        with pytest.raises(MCPClientToolError, match="server_name"):
            await t(command="connect", connection_id="c1", tool_context=_tool_context())

    @pytest.mark.asyncio
    async def test_multiple_connections_simultaneously(self) -> None:
        """Two connections with different IDs can coexist."""
        tool = make_mcp_client(
            servers={
                "server-a": {"url": "https://a.example.com/mcp"},
                "server-b": {"url": "https://b.example.com/mcp"},
            }
        )
        agent = _StubAgent()
        with patch("strands.vended_tools.mcp_client.mcp_client.MCPClient.load_servers") as client_cls:
            client_cls.return_value = [_mcp_instance()]
            await tool(
                command="connect",
                server_name="server-a",
                connection_id="conn-a",
                tool_context=_tool_context(agent),
            )
            await tool(
                command="connect",
                server_name="server-b",
                connection_id="conn-b",
                tool_context=_tool_context(agent),
            )
            # Both connections are live — list_tools works on each.
            await tool(command="list_tools", connection_id="conn-a", tool_context=_tool_context(agent))
            await tool(command="list_tools", connection_id="conn-b", tool_context=_tool_context(agent))

    @pytest.mark.asyncio
    async def test_reconnect_with_same_id_raises(self) -> None:
        """Reusing an existing connection_id raises an error."""
        tool = make_mcp_client(servers={"mcp": {"url": "https://mcp.example.com/mcp"}})
        client_class, instance = _fake_mcp_client_class()
        agent = _StubAgent()
        with patch("strands.vended_tools.mcp_client.mcp_client.MCPClient.load_servers", client_class):
            await tool(command="connect", server_name="mcp", connection_id="c1", tool_context=_tool_context(agent))
            with pytest.raises(MCPClientToolError, match="already exists"):
                await tool(command="connect", server_name="mcp", connection_id="c1", tool_context=_tool_context(agent))
        # Both starts ran; the second was stopped after the duplicate was detected post-start.
        assert instance.start.call_count == 2
        instance.stop.assert_called_once()

    @pytest.mark.asyncio
    async def test_connection_cap_is_enforced(self) -> None:
        """Opening more connections than max_connections raises with active IDs listed."""
        tool = make_mcp_client(
            servers={"mcp": {"url": "https://mcp.example.com/mcp"}},
            max_connections=2,
        )
        agent = _StubAgent()
        with patch("strands.vended_tools.mcp_client.mcp_client.MCPClient.load_servers") as client_cls:
            client_cls.return_value = [_mcp_instance()]
            await tool(command="connect", server_name="mcp", connection_id="c1", tool_context=_tool_context(agent))
            await tool(command="connect", server_name="mcp", connection_id="c2", tool_context=_tool_context(agent))
            with pytest.raises(MCPClientToolError, match="Connection limit of 2"):
                await tool(command="connect", server_name="mcp", connection_id="c3", tool_context=_tool_context(agent))

    @pytest.mark.asyncio
    async def test_agent_isolation(self) -> None:
        """A connection opened by agent A is not visible to agent B."""
        tool = make_mcp_client(servers={"mcp": {"url": "https://mcp.example.com/mcp"}})
        with patch("strands.vended_tools.mcp_client.mcp_client.MCPClient.load_servers") as client_cls:
            client_cls.return_value = [_mcp_instance()]
            agent_a = _StubAgent(label="a")
            agent_b = _StubAgent(label="b")
            await tool(command="connect", server_name="mcp", connection_id="c1", tool_context=_tool_context(agent_a))
            with pytest.raises(MCPClientToolError, match="No active connection"):
                await tool(command="list_tools", connection_id="c1", tool_context=_tool_context(agent_b))

    @pytest.mark.asyncio
    async def test_start_failure_stops_client_and_leaves_no_connection(self) -> None:
        """If start() raises, the client is stopped and no connection is registered."""
        t = make_mcp_client(servers={"mcp": {"url": "https://mcp.example.com/mcp"}})
        client_class, instance = _fake_mcp_client_class()
        instance.start = MagicMock(side_effect=RuntimeError("connection refused"))
        agent = _StubAgent()

        with patch("strands.vended_tools.mcp_client.mcp_client.MCPClient.load_servers", client_class):
            with pytest.raises(RuntimeError, match="connection refused"):
                await t(command="connect", server_name="mcp", connection_id="c1", tool_context=_tool_context(agent))

        instance.stop.assert_called_once()
        with pytest.raises(MCPClientToolError, match="connection_id.*required|No active connection"):
            await t(command="list_tools", tool_context=_tool_context(agent))


class TestSessionLifecycle:
    """Full connect -> list_tools -> call_tool -> disconnect flow."""

    @pytest.mark.asyncio
    async def test_full_lifecycle(self) -> None:
        tool = make_mcp_client(servers={"mcp": {"url": "https://mcp.example.com/mcp"}})
        client_class, instance = _fake_mcp_client_class(
            list_tools_return=[_make_agent_tool(name="echo", description="Echoes input")],
            call_tool_return={"status": "success", "content": [{"text": "hello world"}]},
        )
        agent = _StubAgent()

        with patch("strands.vended_tools.mcp_client.mcp_client.MCPClient.load_servers", client_class):
            connect_result = await tool(
                command="connect", server_name="mcp", connection_id="c1", tool_context=_tool_context(agent)
            )
            assert "mcp" in connect_result
            assert "c1" in connect_result
            instance.start.assert_called_once()

            list_result = await tool(command="list_tools", connection_id="c1", tool_context=_tool_context(agent))
            assert len(list_result) == 1
            assert list_result[0]["name"] == "echo"

            call_result = await tool(
                command="call_tool",
                connection_id="c1",
                tool_name="echo",
                arguments={"msg": "hi"},
                tool_context=_tool_context(agent),
            )
            assert call_result["status"] == "success"
            assert call_result["content"][0]["text"] == "hello world"
            call_kwargs = instance.call_tool_async.call_args.kwargs
            assert call_kwargs["name"] == "echo"
            assert call_kwargs["arguments"] == {"msg": "hi"}

            disconnect_result = await tool(command="disconnect", connection_id="c1", tool_context=_tool_context(agent))
            assert disconnect_result == "Successfully disconnected"
            instance.stop.assert_called_once()

            with pytest.raises(MCPClientToolError, match="No active connection"):
                await tool(command="list_tools", connection_id="c1", tool_context=_tool_context(agent))

    @pytest.mark.asyncio
    async def test_call_tool_without_name_is_rejected(self) -> None:
        t = make_mcp_client(servers={"mcp": {"url": "https://mcp.example.com/mcp"}})
        agent = _StubAgent()
        with patch("strands.vended_tools.mcp_client.mcp_client.MCPClient.load_servers") as client_cls:
            client_cls.return_value = [_mcp_instance()]
            await t(command="connect", server_name="mcp", connection_id="c1", tool_context=_tool_context(agent))
            with pytest.raises(MCPClientToolError, match="tool_name"):
                await t(command="call_tool", connection_id="c1", tool_context=_tool_context(agent))

    @pytest.mark.asyncio
    async def test_disconnect_when_stop_raises_still_evicts(self) -> None:
        """RuntimeError from stop() must not prevent connection eviction."""
        t = make_mcp_client(servers={"mcp": {"url": "https://mcp.example.com/mcp"}})
        agent = _StubAgent()
        client_class, instance = _fake_mcp_client_class()
        instance.stop = MagicMock(side_effect=RuntimeError("already closed"))

        with patch("strands.vended_tools.mcp_client.mcp_client.MCPClient.load_servers", client_class):
            await t(command="connect", server_name="mcp", connection_id="c1", tool_context=_tool_context(agent))
            result = await t(command="disconnect", connection_id="c1", tool_context=_tool_context(agent))

        assert result == "Successfully disconnected"
        with pytest.raises(MCPClientToolError, match="No active connection"):
            await t(command="list_tools", connection_id="c1", tool_context=_tool_context(agent))

    @pytest.mark.asyncio
    async def test_cancel_signal_forwarded_to_call_tool_async(self) -> None:
        tool = make_mcp_client(servers={"mcp": {"url": "https://mcp.example.com/mcp"}})
        captured: dict[str, Any] = {}

        async def _call(*args: Any, **kwargs: Any) -> Any:
            captured["cancel_signal"] = kwargs.get("cancel_signal")
            return {"status": "success", "content": []}

        client_class, instance = _fake_mcp_client_class()
        instance.call_tool_async = _call

        cancel = threading.Event()
        agent = _StubAgent()
        ctx = _tool_context(agent)
        ctx.cancel_signal = cancel

        with patch("strands.vended_tools.mcp_client.mcp_client.MCPClient.load_servers", client_class):
            await tool(command="connect", server_name="mcp", connection_id="c1", tool_context=ctx)
            await tool(command="call_tool", connection_id="c1", tool_name="slow", tool_context=ctx)

        assert captured["cancel_signal"] is cancel

    @pytest.mark.asyncio
    async def test_list_tools_returns_server_side_names(self) -> None:
        """list_tools must return mcp_tool.name (server-side) regardless of prefix config."""
        tool = make_mcp_client(servers={"mcp": {"url": "https://mcp.example.com/mcp"}})
        agent = _StubAgent()
        agent_tool = MCPAgentTool(
            mcp_tool=_make_mcp_tool(name="echo"),
            mcp_client=MagicMock(),
            name_override="fs_echo",
        )
        client_class, _ = _fake_mcp_client_class(list_tools_return=[agent_tool])
        with patch("strands.vended_tools.mcp_client.mcp_client.MCPClient.load_servers", client_class):
            await tool(command="connect", server_name="mcp", connection_id="c1", tool_context=_tool_context(agent))
            tools = await tool(command="list_tools", connection_id="c1", tool_context=_tool_context(agent))
        assert tools[0]["name"] == "echo"


class TestConfigForwarding:
    """The matched server config is forwarded correctly to MCPClient."""

    @pytest.mark.asyncio
    async def test_matched_config_reaches_load_servers(self) -> None:
        server_config = {"url": "https://mcp.example.com/mcp", "headers": {"X-Api-Key": "secret"}}
        tool = make_mcp_client(servers={"mcp": server_config})
        agent = _StubAgent()

        with patch("strands.vended_tools.mcp_client.mcp_client.MCPClient.load_servers") as mock_load:
            mock_load.return_value = [_mcp_instance()]
            await tool(command="connect", server_name="mcp", connection_id="c1", tool_context=_tool_context(agent))

        mock_load.assert_called_once()
        _, passed_config = mock_load.call_args[0][0].popitem()
        assert passed_config["headers"] == {"X-Api-Key": "secret"}

    @pytest.mark.asyncio
    async def test_server_name_used_as_load_servers_key(self) -> None:
        """server_name flows through as the load_servers key (used as application_name)."""
        tool = make_mcp_client(servers={"my-api": {"url": "https://mcp.example.com/mcp"}})
        agent = _StubAgent()

        with patch("strands.vended_tools.mcp_client.mcp_client.MCPClient.load_servers") as mock_load:
            mock_load.return_value = [_mcp_instance()]
            await tool(command="connect", server_name="my-api", connection_id="c1", tool_context=_tool_context(agent))

        key = list(mock_load.call_args[0][0].keys())[0]
        assert key == "my-api"


class TestToolMetadata:
    """The tool exposes a sensible name, description, and input schema."""

    def test_custom_name(self) -> None:
        t = make_mcp_client(servers={"mcp": {"url": "https://mcp.example.com/mcp"}}, name="my_mcp")
        assert t.tool_name == "my_mcp"

    def test_schema_exposes_expected_fields(self) -> None:
        t = make_mcp_client(servers={"mcp": {"url": "https://mcp.example.com/mcp"}})
        props = t.tool_spec["inputSchema"]["json"]["properties"]
        assert "command" in props
        assert "server_name" in props
        assert "connection_id" in props
        assert "tool_context" not in props
