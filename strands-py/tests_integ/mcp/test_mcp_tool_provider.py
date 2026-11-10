"""Integration tests for MCPClient ToolProvider functionality with real MCP server."""

import logging
import re

import pytest
from mcp import StdioServerParameters, stdio_client

from strands import Agent
from strands.tools.mcp import MCPClient
from strands.tools.mcp.mcp_client import ToolFilters

logging.basicConfig(level=logging.DEBUG)

logger = logging.getLogger(__name__)


def test_mcp_client_tool_provider_filters():
    """Test MCPClient with various filter combinations."""

    def short_names_only(tool) -> bool:
        return len(tool.tool_name) <= 20

    filters: ToolFilters = {
        "allowed": ["echo", re.compile(r"echo_with_.*"), short_names_only],
        "rejected": ["echo_with_delay"],
    }

    client = MCPClient(
        lambda: stdio_client(StdioServerParameters(command="python", args=["tests_integ/mcp/echo_server.py"])),
        tool_filters=filters,
        prefix="test",
    )

    agent = Agent(tools=[client])
    tool_names = agent.tool_names

    assert "test_echo_with_delay" not in [name for name in tool_names]
    assert all(name.startswith("test_") for name in tool_names)

    agent.cleanup()


def test_mcp_client_tool_provider_execution():
    """Test that MCPClient works with agent execution."""
    filters: ToolFilters = {"allowed": ["echo"]}
    client = MCPClient(
        lambda: stdio_client(StdioServerParameters(command="python", args=["tests_integ/mcp/echo_server.py"])),
        tool_filters=filters,
        prefix="filtered",
    )

    agent = Agent(tools=[client])

    assert "filtered_echo" in agent.tool_names

    tool_result = agent.tool.filtered_echo(to_echo="Hello World")
    assert "Hello World" in str(tool_result)

    result = agent("Use the filtered_echo tool to echo whats inside the tags <>Integration Test</>")
    assert "Integration Test" in str(result)

    assert agent.event_loop_metrics.tool_metrics["filtered_echo"].call_count == 1
    assert agent.event_loop_metrics.tool_metrics["filtered_echo"].success_count == 1

    agent.cleanup()


def test_mcp_client_tool_provider_reuse():
    """Test that a single MCPClient can be used across multiple agents."""
    filters: ToolFilters = {"allowed": ["echo"]}
    client = MCPClient(
        lambda: stdio_client(StdioServerParameters(command="python", args=["tests_integ/mcp/echo_server.py"])),
        tool_filters=filters,
        prefix="shared",
    )

    agent1 = Agent(tools=[client])
    assert "shared_echo" in agent1.tool_names

    result1 = agent1.tool.shared_echo(to_echo="Agent 1")
    assert "Agent 1" in str(result1)

    agent2 = Agent(tools=[client])
    assert "shared_echo" in agent2.tool_names

    result2 = agent2.tool.shared_echo(to_echo="Agent 2")
    assert "Agent 2" in str(result2)

    assert len(agent1.tool_names) == len(agent2.tool_names)
    assert agent1.tool_names == agent2.tool_names

    agent1.cleanup()

    # Agent 1 cleans up - client should still be active for agent 2
    agent1.cleanup()

    # Agent 2 should still be able to use the tool
    result2 = agent2.tool.shared_echo(to_echo="Agent 2 Test")
    assert "Agent 2 Test" in str(result2)

    agent2.cleanup()


def test_mcp_client_multiple_servers():
    """Test MCPClient with multiple MCP servers simultaneously."""
    client1 = MCPClient(
        lambda: stdio_client(StdioServerParameters(command="python", args=["tests_integ/mcp/echo_server.py"])),
        tool_filters={"allowed": ["echo"]},
        prefix="server1",
    )
    client2 = MCPClient(
        lambda: stdio_client(StdioServerParameters(command="python", args=["tests_integ/mcp/echo_server.py"])),
        tool_filters={"allowed": ["echo_with_structured_content"]},
        prefix="server2",
    )

    agent = Agent(tools=[client1, client2])

    assert "server1_echo" in agent.tool_names
    assert "server2_echo_with_structured_content" in agent.tool_names
    assert len(agent.tool_names) == 2

    result1 = agent.tool.server1_echo(to_echo="From Server 1")
    assert "From Server 1" in str(result1)

    result2 = agent.tool.server2_echo_with_structured_content(to_echo="From Server 2")
    assert "From Server 2" in str(result2)

    agent.cleanup()


def test_mcp_client_server_startup_failure():
    """Test that MCPClient handles server startup failure gracefully without hanging."""
    from strands.types.exceptions import ToolProviderException

    failing_client = MCPClient(
        lambda: stdio_client(StdioServerParameters(command="nonexistent_command", args=["--invalid"])),
        startup_timeout=2,
    )

    with pytest.raises(ValueError, match="Failed to load tool") as exc_info:
        Agent(tools=[failing_client])

    assert isinstance(exc_info.value.__cause__, ToolProviderException)


def test_mcp_client_server_connection_timeout():
    """Test that MCPClient times out gracefully when server hangs during startup."""
    from strands.types.exceptions import ToolProviderException

    hanging_client = MCPClient(
        lambda: stdio_client(StdioServerParameters(command="sleep", args=["10"])),
        startup_timeout=1,
    )

    with pytest.raises(ValueError, match="Failed to load tool") as exc_info:
        Agent(tools=[hanging_client])

    assert isinstance(exc_info.value.__cause__, ToolProviderException)
