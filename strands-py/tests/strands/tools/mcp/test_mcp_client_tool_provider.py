"""Unit tests for MCPClient ToolProvider functionality."""

import re
from unittest.mock import MagicMock, patch

import pytest
from mcp.types import Tool as MCPTool

from strands.tools.mcp import MCPClient
from strands.tools.mcp.mcp_agent_tool import MCPAgentTool
from strands.tools.mcp.mcp_client import ToolFilters
from strands.types import PaginatedList
from strands.types.exceptions import ToolProviderException


@pytest.fixture
def mock_transport():
    """Create a mock transport callable."""

    def transport():
        read_stream = MagicMock()
        write_stream = MagicMock()
        return read_stream, write_stream

    return transport


@pytest.fixture
def mock_mcp_tool():
    """Create a mock MCP tool."""
    tool = MagicMock()
    tool.name = "test_tool"
    return tool


@pytest.fixture
def mock_agent_tool(mock_mcp_tool):
    """Create a mock MCPAgentTool."""
    agent_tool = MagicMock(spec=MCPAgentTool)
    agent_tool.tool_name = "test_tool"
    agent_tool.mcp_tool = mock_mcp_tool
    return agent_tool


def create_mock_tool(tool_name: str, mcp_tool_name: str | None = None) -> MagicMock:
    """Helper to create mock tools with specific names."""
    tool = MagicMock(spec=MCPAgentTool)
    tool.tool_name = tool_name
    tool.tool_spec = {
        "name": tool_name,
        "description": f"Description for {tool_name}",
        "inputSchema": {"json": {"type": "object", "properties": {}}},
    }
    tool.mcp_tool = MagicMock(spec=MCPTool)
    tool.mcp_tool.name = mcp_tool_name or tool_name
    tool.mcp_tool.description = f"Description for {tool_name}"
    return tool


def test_init_with_tool_filters_and_prefix(mock_transport):
    """Test initialization with tool filters and prefix."""
    filters = {"allowed": ["tool1"]}
    prefix = "test_prefix"

    client = MCPClient(mock_transport, tool_filters=filters, prefix=prefix)

    assert client._tool_filters == filters
    assert client._prefix == prefix
    assert client._loaded_tools is None
    assert client._tool_provider_started is False


def test_continue_on_error_and_connection_failed_accessors(mock_transport):
    """The public accessors reflect the configured flag and the sticky failed state."""
    default_client = MCPClient(mock_transport)
    assert default_client.continue_on_error is False
    assert default_client.connection_failed is False

    lenient_client = MCPClient(mock_transport, continue_on_error=True)
    assert lenient_client.continue_on_error is True
    assert lenient_client.connection_failed is False

    lenient_client._connection_failed = True
    assert lenient_client.connection_failed is True


@pytest.mark.asyncio
async def test_connection_failed_accessor_reflects_swallowed_failure(mock_transport):
    """connection_failed flips to True after load_tools swallows a start failure."""
    client = MCPClient(mock_transport, continue_on_error=True)

    with patch.object(client, "start", side_effect=Exception("Client start failed")):
        await client.load_tools()

    assert client.connection_failed is True


@pytest.mark.asyncio
async def test_load_tools_starts_client_when_not_started(mock_transport, mock_agent_tool):
    """Test that load_tools starts the client when not already started."""
    client = MCPClient(mock_transport)

    with patch.object(client, "start") as mock_start, patch.object(client, "list_tools_sync") as mock_list_tools:
        mock_list_tools.return_value = PaginatedList([mock_agent_tool])

        tools = await client.load_tools()

        mock_start.assert_called_once()
        assert client._tool_provider_started is True
        assert len(tools) == 1
        assert tools[0] is mock_agent_tool


@pytest.mark.asyncio
async def test_load_tools_does_not_start_client_when_already_started(mock_transport, mock_agent_tool):
    """Test that load_tools does not start client when already started."""
    client = MCPClient(mock_transport)
    client._tool_provider_started = True

    with patch.object(client, "start") as mock_start, patch.object(client, "list_tools_sync") as mock_list_tools:
        mock_list_tools.return_value = PaginatedList([mock_agent_tool])

        tools = await client.load_tools()

        mock_start.assert_not_called()
        assert len(tools) == 1


@pytest.mark.asyncio
async def test_load_tools_raises_exception_on_client_start_failure(mock_transport):
    """Test that load_tools raises ToolProviderException when client start fails."""
    client = MCPClient(mock_transport)

    with patch.object(client, "start") as mock_start:
        mock_start.side_effect = Exception("Client start failed")

        with pytest.raises(ToolProviderException, match="Failed to start MCP client: Client start failed"):
            await client.load_tools()


@pytest.mark.asyncio
async def test_load_tools_returns_empty_when_continue_on_error_and_start_fails(mock_transport):
    """With continue_on_error, a start failure yields no tools instead of raising."""
    client = MCPClient(mock_transport, continue_on_error=True)

    with patch.object(client, "start") as mock_start:
        mock_start.side_effect = Exception("Client start failed")

        tools = await client.load_tools()

    assert tools == []


@pytest.mark.asyncio
async def test_continue_on_error_isolates_connection_failure_from_sibling_clients(mock_transport, mock_agent_tool):
    """A client whose connection fails yields no tools while a sibling client still loads its own.

    Covers the "other servers stay usable" guarantee at connection time (not just config resolution):
    one server's failed start() does not affect a separate, healthy client.
    """
    failing = MCPClient(mock_transport, continue_on_error=True)
    healthy = MCPClient(mock_transport)

    with (
        patch.object(failing, "start", side_effect=Exception("connection refused")),
        patch.object(healthy, "start"),
        patch.object(healthy, "list_tools_sync", return_value=PaginatedList([mock_agent_tool])),
    ):
        assert await failing.load_tools() == []
        healthy_tools = await healthy.load_tools()

    assert len(healthy_tools) == 1
    assert healthy_tools[0] is mock_agent_tool


@pytest.mark.asyncio
async def test_load_tools_logs_warning_when_continue_on_error_swallows_failure(mock_transport, caplog):
    client = MCPClient(mock_transport, continue_on_error=True)

    with patch.object(client, "start") as mock_start:
        mock_start.side_effect = Exception("Client start failed")
        with caplog.at_level("WARNING", logger="strands.tools.mcp.mcp_client"):
            await client.load_tools()

    assert "MCP server failed to start" in caplog.text


@pytest.mark.asyncio
async def test_load_tools_does_not_retry_start_after_continue_on_error_failure(mock_transport):
    """A swallowed failure is not retried: a second load_tools call doesn't re-run start()."""
    client = MCPClient(mock_transport, continue_on_error=True)

    with patch.object(client, "start") as mock_start:
        mock_start.side_effect = Exception("Client start failed")

        await client.load_tools()  # first call swallows the failure
        tools = await client.load_tools()  # second must short-circuit, not retry start()

        assert tools == []
        mock_start.assert_called_once()


@pytest.mark.asyncio
async def test_load_tools_caches_tools(mock_transport, mock_agent_tool):
    """Test that load_tools caches tools and doesn't reload them."""
    client = MCPClient(mock_transport)
    client._tool_provider_started = True

    with patch.object(client, "list_tools_sync") as mock_list_tools:
        mock_list_tools.return_value = PaginatedList([mock_agent_tool])

        # First call
        tools1 = await client.load_tools()
        # Second call
        tools2 = await client.load_tools()

        # Client should only be called once
        mock_list_tools.assert_called_once()
        assert tools1 is tools2


@pytest.mark.asyncio
async def test_load_tools_handles_pagination(mock_transport):
    """Test that load_tools handles pagination correctly."""
    tool1 = create_mock_tool("tool1")
    tool2 = create_mock_tool("tool2")

    client = MCPClient(mock_transport)
    client._tool_provider_started = True

    with patch.object(client, "list_tools_sync") as mock_list_tools:
        # Mock pagination: first page returns tool1 with next token, second page returns tool2 with no token
        mock_list_tools.side_effect = [
            PaginatedList([tool1], token="page2"),
            PaginatedList([tool2], token=None),
        ]

        tools = await client.load_tools()

        # Should have called list_tools_sync twice
        assert mock_list_tools.call_count == 2
        # First call with no token, second call with "page2" token
        mock_list_tools.assert_any_call(None, prefix=None, tool_filters=None)
        mock_list_tools.assert_any_call("page2", prefix=None, tool_filters=None)

        assert len(tools) == 2
        assert tools[0] is tool1
        assert tools[1] is tool2


@pytest.mark.asyncio
async def test_allowed_filter_string_match(mock_transport):
    """Test allowed filter with string matching."""
    tool1 = create_mock_tool("allowed_tool")

    filters: ToolFilters = {"allowed": ["allowed_tool"]}
    client = MCPClient(mock_transport, tool_filters=filters)
    client._tool_provider_started = True

    with patch.object(client, "list_tools_sync") as mock_list_tools:
        # Mock list_tools_sync to return filtered results (simulating the filtering)
        mock_list_tools.return_value = PaginatedList([tool1])  # Only allowed tool

        tools = await client.load_tools()

        assert len(tools) == 1
        assert tools[0].tool_name == "allowed_tool"


@pytest.mark.asyncio
async def test_allowed_filter_regex_match(mock_transport):
    """Test allowed filter with regex matching."""
    tool1 = create_mock_tool("echo_tool")

    filters: ToolFilters = {"allowed": [re.compile(r"echo_.*")]}
    client = MCPClient(mock_transport, tool_filters=filters)
    client._tool_provider_started = True

    with patch.object(client, "list_tools_sync") as mock_list_tools:
        # Mock list_tools_sync to return filtered results
        mock_list_tools.return_value = PaginatedList([tool1])  # Only echo tool

        tools = await client.load_tools()

        assert len(tools) == 1
        assert tools[0].tool_name == "echo_tool"


@pytest.mark.asyncio
async def test_allowed_filter_callable_match(mock_transport):
    """Test allowed filter with callable matching."""
    tool1 = create_mock_tool("short")

    def short_names_only(tool) -> bool:
        return len(tool.tool_name) <= 10

    filters: ToolFilters = {"allowed": [short_names_only]}
    client = MCPClient(mock_transport, tool_filters=filters)
    client._tool_provider_started = True

    with patch.object(client, "list_tools_sync") as mock_list_tools:
        # Mock list_tools_sync to return filtered results
        mock_list_tools.return_value = PaginatedList([tool1])  # Only short tool

        tools = await client.load_tools()

        assert len(tools) == 1
        assert tools[0].tool_name == "short"


@pytest.mark.asyncio
async def test_rejected_filter_string_match(mock_transport):
    """Test rejected filter with string matching."""
    tool1 = create_mock_tool("good_tool")

    filters: ToolFilters = {"rejected": ["bad_tool"]}
    client = MCPClient(mock_transport, tool_filters=filters)
    client._tool_provider_started = True

    with patch.object(client, "list_tools_sync") as mock_list_tools:
        # Mock list_tools_sync to return filtered results
        mock_list_tools.return_value = PaginatedList([tool1])  # Only good tool

        tools = await client.load_tools()

        assert len(tools) == 1
        assert tools[0].tool_name == "good_tool"


@pytest.mark.asyncio
async def test_prefix_renames_tools(mock_transport):
    """Test that prefix properly renames tools."""
    # Create a mock MCP tool (not MCPAgentTool)
    mock_mcp_tool = MagicMock()
    mock_mcp_tool.name = "original_name"

    client = MCPClient(mock_transport, prefix="prefix")
    client._tool_provider_started = True

    # Mock the session active state
    mock_thread = MagicMock()
    mock_thread.is_alive.return_value = True
    client._background_thread = mock_thread

    with (
        patch.object(client, "_invoke_on_background_thread") as mock_invoke,
        patch("strands.tools.mcp.mcp_client.MCPAgentTool") as mock_agent_tool_class,
    ):
        # Mock the MCP server response
        mock_list_tools_result = MagicMock()
        mock_list_tools_result.tools = [mock_mcp_tool]
        mock_list_tools_result.nextCursor = None

        mock_future = MagicMock()
        mock_future.result.return_value = mock_list_tools_result
        mock_invoke.return_value = mock_future

        # Mock MCPAgentTool creation
        mock_agent_tool = MagicMock(spec=MCPAgentTool)
        mock_agent_tool.tool_name = "prefix_original_name"
        mock_agent_tool_class.return_value = mock_agent_tool

        # Call list_tools_sync directly to test prefix functionality
        result = client.list_tools_sync(prefix="prefix")

        # Should create MCPAgentTool with prefixed name
        mock_agent_tool_class.assert_called_once_with(mock_mcp_tool, client, name_override="prefix_original_name")

        assert len(result) == 1
        assert result[0] is mock_agent_tool


def test_add_consumer(mock_transport):
    """Test adding a provider consumer."""
    client = MCPClient(mock_transport)

    client.add_consumer("consumer1")

    assert "consumer1" in client._consumers
    assert len(client._consumers) == 1


def test_remove_consumer_without_cleanup(mock_transport):
    """Test removing a provider consumer without triggering cleanup."""
    client = MCPClient(mock_transport)
    client._consumers.add("consumer1")
    client._consumers.add("consumer2")
    client._tool_provider_started = True

    client.remove_consumer("consumer1")

    assert "consumer1" not in client._consumers
    assert "consumer2" in client._consumers
    assert client._tool_provider_started is True  # Should not cleanup yet


def test_remove_consumer_with_cleanup(mock_transport):
    """Test removing the last provider consumer triggers cleanup."""
    client = MCPClient(mock_transport)
    client._consumers.add("consumer1")
    client._tool_provider_started = True
    client._loaded_tools = [MagicMock()]

    with patch.object(client, "stop") as mock_stop:
        client.remove_consumer("consumer1")

        assert len(client._consumers) == 0
        assert client._tool_provider_started is False
        assert client._loaded_tools is None
        mock_stop.assert_called_once_with(None, None, None)


def test_remove_consumer_cleanup_failure(mock_transport):
    """Test that remove_consumer raises ToolProviderException when cleanup fails."""
    client = MCPClient(mock_transport)
    client._consumers.add("consumer1")
    client._tool_provider_started = True

    with patch.object(client, "stop") as mock_stop:
        mock_stop.side_effect = Exception("Cleanup failed")

        with pytest.raises(ToolProviderException, match="Failed to cleanup MCP client: Cleanup failed"):
            client.remove_consumer("consumer1")


def test_remove_consumer_with_cleanup_after_continue_on_error_failure(mock_transport):
    """A swallowed start failure still triggers cleanup on the last consumer so the sticky flag resets."""
    client = MCPClient(mock_transport, continue_on_error=True)
    client._consumers.add("consumer1")
    client._connection_failed = True  # swallowed failure leaves _tool_provider_started False

    with patch.object(client, "stop") as mock_stop:
        client.remove_consumer("consumer1")

        # stop() runs despite _tool_provider_started being False, because a failed client needs teardown too
        mock_stop.assert_called_once_with(None, None, None)


@pytest.mark.asyncio
async def test_load_tools_reconnects_for_new_consumer_after_continue_on_error_failure(mock_transport):
    """A failed client that loses all consumers resets and reconnects for the next consumer.

    Guarantees the failure is sticky only within a connection lifecycle, not for the object's life:
    successful and failed clients both reset on zero consumers so a recovered server is usable again.
    """
    client = MCPClient(mock_transport, continue_on_error=True)

    with patch.object(client, "start") as mock_start, patch.object(client, "list_tools_sync") as mock_list_tools:
        # First consumer: server is down, failure is swallowed
        mock_start.side_effect = Exception("Client start failed")
        client.add_consumer("consumer1")
        assert await client.load_tools() == []
        assert client._connection_failed is True

        # Last consumer leaves: real stop() resets _connection_failed (and other reuse state)
        client.remove_consumer("consumer1")
        assert client._connection_failed is False
        assert client._tool_provider_started is False

        # New consumer: server has recovered, start() now succeeds and tools load
        tool = create_mock_tool(tool_name="recovered_tool")
        mock_start.side_effect = None
        mock_list_tools.return_value = PaginatedList([tool])
        client.add_consumer("consumer2")
        tools = await client.load_tools()

        assert len(tools) == 1
        assert tools[0].tool_name == "recovered_tool"
        assert mock_start.call_count == 2


def test_mcp_client_reuse_across_multiple_agents(mock_transport):
    """Test that a single MCPClient can be used across multiple agents."""
    from strands import Agent

    tool1 = create_mock_tool(tool_name="shared_echo", mcp_tool_name="echo")
    client = MCPClient(mock_transport, tool_filters={"allowed": ["echo"]}, prefix="shared")

    with (
        patch.object(client, "list_tools_sync") as mock_list_tools,
        patch.object(client, "start") as mock_start,
        patch.object(client, "stop") as mock_stop,
    ):
        mock_list_tools.return_value = PaginatedList([tool1])

        # Create two agents with the same client
        agent_1 = Agent(tools=[client])
        agent_2 = Agent(tools=[client])

        # Both agents should have the same tool
        assert "shared_echo" in agent_1.tool_names
        assert "shared_echo" in agent_2.tool_names
        assert agent_1.tool_names == agent_2.tool_names

        # Client should only be started once
        mock_start.assert_called_once()

        # First agent cleanup - client should remain active
        agent_1.cleanup()
        mock_stop.assert_not_called()  # Should not stop yet

        # Second agent should still work
        assert "shared_echo" in agent_2.tool_names

        # Final cleanup when last agent is removed
        agent_2.cleanup()
        mock_stop.assert_called_once()  # Now it should stop


def test_list_tools_sync_prefix_override_constructor_default(mock_transport):
    """Test that list_tools_sync can override constructor prefix."""
    # Create a mock MCP tool
    mock_mcp_tool = MagicMock()
    mock_mcp_tool.name = "original_tool"

    # Client with constructor prefix
    client = MCPClient(mock_transport, prefix="constructor")
    client._tool_provider_started = True

    # Mock the session active state
    mock_thread = MagicMock()
    mock_thread.is_alive.return_value = True
    client._background_thread = mock_thread

    with (
        patch.object(client, "_invoke_on_background_thread") as mock_invoke,
        patch("strands.tools.mcp.mcp_client.MCPAgentTool") as mock_agent_tool_class,
    ):
        # Mock the MCP server response
        mock_list_tools_result = MagicMock()
        mock_list_tools_result.tools = [mock_mcp_tool]
        mock_list_tools_result.nextCursor = None

        mock_future = MagicMock()
        mock_future.result.return_value = mock_list_tools_result
        mock_invoke.return_value = mock_future

        # Mock MCPAgentTool creation
        mock_agent_tool = MagicMock(spec=MCPAgentTool)
        mock_agent_tool.tool_name = "override_original_tool"
        mock_agent_tool_class.return_value = mock_agent_tool

        # Call with override prefix
        result = client.list_tools_sync(prefix="override")

        # Should use override prefix, not constructor prefix
        mock_agent_tool_class.assert_called_once_with(mock_mcp_tool, client, name_override="override_original_tool")

        assert len(result) == 1
        assert result[0] is mock_agent_tool


def test_list_tools_sync_prefix_override_with_empty_string(mock_transport):
    """Test that list_tools_sync can override constructor prefix with empty string."""
    # Create a mock MCP tool
    mock_mcp_tool = MagicMock()
    mock_mcp_tool.name = "original_tool"

    # Client with constructor prefix
    client = MCPClient(mock_transport, prefix="constructor")
    client._tool_provider_started = True

    # Mock the session active state
    mock_thread = MagicMock()
    mock_thread.is_alive.return_value = True
    client._background_thread = mock_thread

    with (
        patch.object(client, "_invoke_on_background_thread") as mock_invoke,
        patch("strands.tools.mcp.mcp_client.MCPAgentTool") as mock_agent_tool_class,
    ):
        # Mock the MCP server response
        mock_list_tools_result = MagicMock()
        mock_list_tools_result.tools = [mock_mcp_tool]
        mock_list_tools_result.nextCursor = None

        mock_future = MagicMock()
        mock_future.result.return_value = mock_list_tools_result
        mock_invoke.return_value = mock_future

        # Mock MCPAgentTool creation
        mock_agent_tool = MagicMock(spec=MCPAgentTool)
        mock_agent_tool.tool_name = "original_tool"
        mock_agent_tool_class.return_value = mock_agent_tool

        # Call with empty string prefix (should override constructor default)
        result = client.list_tools_sync(prefix="")

        # Should use no prefix (empty string overrides constructor)
        mock_agent_tool_class.assert_called_once_with(mock_mcp_tool, client)

        assert len(result) == 1
        assert result[0] is mock_agent_tool


def test_list_tools_sync_prefix_uses_constructor_default_when_none(mock_transport):
    """Test that list_tools_sync uses constructor prefix when None is passed."""
    # Create a mock MCP tool
    mock_mcp_tool = MagicMock()
    mock_mcp_tool.name = "original_tool"

    # Client with constructor prefix
    client = MCPClient(mock_transport, prefix="constructor")
    client._tool_provider_started = True

    # Mock the session active state
    mock_thread = MagicMock()
    mock_thread.is_alive.return_value = True
    client._background_thread = mock_thread

    with (
        patch.object(client, "_invoke_on_background_thread") as mock_invoke,
        patch("strands.tools.mcp.mcp_client.MCPAgentTool") as mock_agent_tool_class,
    ):
        # Mock the MCP server response
        mock_list_tools_result = MagicMock()
        mock_list_tools_result.tools = [mock_mcp_tool]
        mock_list_tools_result.nextCursor = None

        mock_future = MagicMock()
        mock_future.result.return_value = mock_list_tools_result
        mock_invoke.return_value = mock_future

        # Mock MCPAgentTool creation
        mock_agent_tool = MagicMock(spec=MCPAgentTool)
        mock_agent_tool.tool_name = "constructor_original_tool"
        mock_agent_tool_class.return_value = mock_agent_tool

        # Call with None prefix (should use constructor default)
        result = client.list_tools_sync(prefix=None)

        # Should use constructor prefix
        mock_agent_tool_class.assert_called_once_with(mock_mcp_tool, client, name_override="constructor_original_tool")

        assert len(result) == 1
        assert result[0] is mock_agent_tool


def test_list_tools_sync_tool_filters_override_constructor_default(mock_transport):
    """Test that list_tools_sync can override constructor tool_filters."""
    # Create mock tools
    tool1 = create_mock_tool("allowed_tool")
    tool2 = create_mock_tool("rejected_tool")

    # Client with constructor filters that would allow both
    constructor_filters: ToolFilters = {"allowed": ["allowed_tool", "rejected_tool"]}
    client = MCPClient(mock_transport, tool_filters=constructor_filters)
    client._tool_provider_started = True

    # Mock the session active state
    mock_thread = MagicMock()
    mock_thread.is_alive.return_value = True
    client._background_thread = mock_thread

    with (
        patch.object(client, "_invoke_on_background_thread") as mock_invoke,
        patch("strands.tools.mcp.mcp_client.MCPAgentTool") as mock_agent_tool_class,
    ):
        # Mock the MCP server response
        mock_list_tools_result = MagicMock()
        mock_list_tools_result.tools = [MagicMock(name="allowed_tool"), MagicMock(name="rejected_tool")]
        mock_list_tools_result.nextCursor = None

        mock_future = MagicMock()
        mock_future.result.return_value = mock_list_tools_result
        mock_invoke.return_value = mock_future

        # Mock MCPAgentTool creation to return our test tools
        mock_agent_tool_class.side_effect = [tool1, tool2]

        # Override filters to only allow one tool
        override_filters: ToolFilters = {"allowed": ["allowed_tool"]}
        result = client.list_tools_sync(tool_filters=override_filters)

        # Should only include the allowed tool based on override filters
        assert len(result) == 1
        assert result[0] is tool1


def test_list_tools_sync_tool_filters_override_with_empty_dict(mock_transport):
    """Test that list_tools_sync can override constructor filters with empty dict."""
    # Create mock tools
    tool1 = create_mock_tool("tool1")
    tool2 = create_mock_tool("tool2")

    # Client with constructor filters that would reject tools
    constructor_filters: ToolFilters = {"rejected": ["tool1", "tool2"]}
    client = MCPClient(mock_transport, tool_filters=constructor_filters)
    client._tool_provider_started = True

    # Mock the session active state
    mock_thread = MagicMock()
    mock_thread.is_alive.return_value = True
    client._background_thread = mock_thread

    with (
        patch.object(client, "_invoke_on_background_thread") as mock_invoke,
        patch("strands.tools.mcp.mcp_client.MCPAgentTool") as mock_agent_tool_class,
    ):
        # Mock the MCP server response
        mock_list_tools_result = MagicMock()
        mock_list_tools_result.tools = [MagicMock(name="tool1"), MagicMock(name="tool2")]
        mock_list_tools_result.nextCursor = None

        mock_future = MagicMock()
        mock_future.result.return_value = mock_list_tools_result
        mock_invoke.return_value = mock_future

        # Mock MCPAgentTool creation to return our test tools
        mock_agent_tool_class.side_effect = [tool1, tool2]

        # Override with empty filters (should allow all tools)
        result = client.list_tools_sync(tool_filters={})

        # Should include both tools since empty filters allow everything
        assert len(result) == 2
        assert result[0] is tool1
        assert result[1] is tool2


def test_list_tools_sync_tool_filters_uses_constructor_default_when_none(mock_transport):
    """Test that list_tools_sync uses constructor filters when None is passed."""
    # Create mock tools
    tool1 = create_mock_tool("allowed_tool")
    tool2 = create_mock_tool("rejected_tool")

    # Client with constructor filters
    constructor_filters: ToolFilters = {"allowed": ["allowed_tool"]}
    client = MCPClient(mock_transport, tool_filters=constructor_filters)
    client._tool_provider_started = True

    # Mock the session active state
    mock_thread = MagicMock()
    mock_thread.is_alive.return_value = True
    client._background_thread = mock_thread

    with (
        patch.object(client, "_invoke_on_background_thread") as mock_invoke,
        patch("strands.tools.mcp.mcp_client.MCPAgentTool") as mock_agent_tool_class,
    ):
        # Mock the MCP server response
        mock_list_tools_result = MagicMock()
        mock_list_tools_result.tools = [MagicMock(name="allowed_tool"), MagicMock(name="rejected_tool")]
        mock_list_tools_result.nextCursor = None

        mock_future = MagicMock()
        mock_future.result.return_value = mock_list_tools_result
        mock_invoke.return_value = mock_future

        # Mock MCPAgentTool creation to return our test tools
        mock_agent_tool_class.side_effect = [tool1, tool2]

        # Call with None filters (should use constructor default)
        result = client.list_tools_sync(tool_filters=None)

        # Should only include allowed tool based on constructor filters
        assert len(result) == 1
        assert result[0] is tool1


def test_list_tools_sync_combined_prefix_and_filter_overrides(mock_transport):
    """Test that list_tools_sync can override both prefix and filters simultaneously."""
    # Client with constructor defaults
    constructor_filters: ToolFilters = {"allowed": ["echo_tool", "other_tool"]}
    client = MCPClient(mock_transport, tool_filters=constructor_filters, prefix="constructor")

    # Create mock tools
    mock_echo_tool = MagicMock()
    mock_echo_tool.name = "echo_tool"
    mock_other_tool = MagicMock()
    mock_other_tool.name = "other_tool"

    # Mock the MCP response
    mock_result = MagicMock()
    mock_result.tools = [mock_echo_tool, mock_other_tool]
    mock_result.nextCursor = None

    with (
        patch.object(client, "_is_session_active", return_value=True),
        patch.object(client, "_invoke_on_background_thread") as mock_invoke,
        patch("strands.tools.mcp.mcp_client.MCPAgentTool") as mock_agent_tool_class,
    ):
        mock_future = MagicMock()
        mock_future.result.return_value = mock_result
        mock_invoke.return_value = mock_future

        # Create mock agent tools
        mock_agent_tool1 = MagicMock()
        mock_agent_tool1.mcp_tool = mock_echo_tool
        mock_agent_tool2 = MagicMock()
        mock_agent_tool2.mcp_tool = mock_other_tool
        mock_agent_tool_class.side_effect = [mock_agent_tool1, mock_agent_tool2]

        # Override both prefix and filters
        override_filters: ToolFilters = {"allowed": ["echo_tool"]}
        result = client.list_tools_sync(prefix="override", tool_filters=override_filters)

        # Verify prefix override: should use "override" not "constructor"
        calls = mock_agent_tool_class.call_args_list
        assert len(calls) == 2

        # First tool should have override prefix
        args1, kwargs1 = calls[0]
        assert args1 == (mock_echo_tool, client)
        assert kwargs1 == {"name_override": "override_echo_tool"}

        # Second tool should have override prefix
        args2, kwargs2 = calls[1]
        assert args2 == (mock_other_tool, client)
        assert kwargs2 == {"name_override": "override_other_tool"}

        # Verify filter override: should only include echo_tool based on override filters
        assert len(result) == 1
        assert result[0] is mock_agent_tool1


def test_list_tools_sync_direct_usage_without_constructor_defaults(mock_transport):
    """Test direct usage of list_tools_sync without constructor defaults."""
    # Client without constructor defaults
    client = MCPClient(mock_transport)

    # Create mock tools
    mock_tool1 = MagicMock()
    mock_tool1.name = "tool1"
    mock_tool2 = MagicMock()
    mock_tool2.name = "tool2"

    # Mock the MCP response
    mock_result = MagicMock()
    mock_result.tools = [mock_tool1, mock_tool2]
    mock_result.nextCursor = None

    with (
        patch.object(client, "_is_session_active", return_value=True),
        patch.object(client, "_invoke_on_background_thread") as mock_invoke,
        patch("strands.tools.mcp.mcp_client.MCPAgentTool") as mock_agent_tool_class,
    ):
        mock_future = MagicMock()
        mock_future.result.return_value = mock_result
        mock_invoke.return_value = mock_future

        # Create mock agent tools
        mock_agent_tool1 = MagicMock()
        mock_agent_tool1.mcp_tool = mock_tool1
        mock_agent_tool2 = MagicMock()
        mock_agent_tool2.mcp_tool = mock_tool2
        mock_agent_tool_class.side_effect = [mock_agent_tool1, mock_agent_tool2]

        # Direct usage with explicit parameters
        filters: ToolFilters = {"allowed": ["tool1"]}
        result = client.list_tools_sync(prefix="direct", tool_filters=filters)

        # Verify prefix is applied
        calls = mock_agent_tool_class.call_args_list
        assert len(calls) == 2

        # Should create tools with direct prefix
        args1, kwargs1 = calls[0]
        assert args1 == (mock_tool1, client)
        assert kwargs1 == {"name_override": "direct_tool1"}

        args2, kwargs2 = calls[1]
        assert args2 == (mock_tool2, client)
        assert kwargs2 == {"name_override": "direct_tool2"}

        # Verify filtering: should only include tool1
        assert len(result) == 1
        assert result[0] is mock_agent_tool1


def test_list_tools_sync_regex_filter_override(mock_transport):
    """Test list_tools_sync with regex filter override."""
    # Client without constructor filters
    client = MCPClient(mock_transport)

    # Create mock tools
    mock_echo_tool = MagicMock()
    mock_echo_tool.name = "echo_command"
    mock_list_tool = MagicMock()
    mock_list_tool.name = "list_files"

    # Mock the MCP response
    mock_result = MagicMock()
    mock_result.tools = [mock_echo_tool, mock_list_tool]
    mock_result.nextCursor = None

    with (
        patch.object(client, "_is_session_active", return_value=True),
        patch.object(client, "_invoke_on_background_thread") as mock_invoke,
        patch("strands.tools.mcp.mcp_client.MCPAgentTool") as mock_agent_tool_class,
    ):
        mock_future = MagicMock()
        mock_future.result.return_value = mock_result
        mock_invoke.return_value = mock_future

        # Create mock agent tools
        mock_agent_tool1 = MagicMock()
        mock_agent_tool1.mcp_tool = mock_echo_tool
        mock_agent_tool2 = MagicMock()
        mock_agent_tool2.mcp_tool = mock_list_tool
        mock_agent_tool_class.side_effect = [mock_agent_tool1, mock_agent_tool2]

        # Use regex filter to match only echo tools
        regex_filters: ToolFilters = {"allowed": [re.compile(r"echo_.*")]}
        result = client.list_tools_sync(tool_filters=regex_filters)

        # Should create both tools
        assert mock_agent_tool_class.call_count == 2

        # Should only include echo tool (regex matches "echo_command")
        assert len(result) == 1
        assert result[0] is mock_agent_tool1


def test_list_tools_sync_callable_filter_override(mock_transport):
    """Test list_tools_sync with callable filter override."""
    # Client without constructor filters
    client = MCPClient(mock_transport)

    # Create mock tools
    mock_short_tool = MagicMock()
    mock_short_tool.name = "short"
    mock_long_tool = MagicMock()
    mock_long_tool.name = "very_long_tool_name"

    # Mock the MCP response
    mock_result = MagicMock()
    mock_result.tools = [mock_short_tool, mock_long_tool]
    mock_result.nextCursor = None

    with (
        patch.object(client, "_is_session_active", return_value=True),
        patch.object(client, "_invoke_on_background_thread") as mock_invoke,
        patch("strands.tools.mcp.mcp_client.MCPAgentTool") as mock_agent_tool_class,
    ):
        mock_future = MagicMock()
        mock_future.result.return_value = mock_result
        mock_invoke.return_value = mock_future

        # Create mock agent tools
        mock_agent_tool1 = MagicMock()
        mock_agent_tool1.mcp_tool = mock_short_tool
        mock_agent_tool2 = MagicMock()
        mock_agent_tool2.mcp_tool = mock_long_tool
        mock_agent_tool_class.side_effect = [mock_agent_tool1, mock_agent_tool2]

        # Use callable filter for short names only
        def short_names_only(tool) -> bool:
            return len(tool.mcp_tool.name) <= 10

        callable_filters: ToolFilters = {"allowed": [short_names_only]}
        result = client.list_tools_sync(tool_filters=callable_filters)

        # Should create both tools
        assert mock_agent_tool_class.call_count == 2

        # Should only include short tool (name length <= 10)
        assert len(result) == 1
        assert result[0] is mock_agent_tool1
