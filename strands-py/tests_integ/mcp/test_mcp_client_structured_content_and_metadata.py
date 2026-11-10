"""Integration test for MCP client structured content and metadata support.

This test verifies that MCP tools can return structured content and metadata,
and that the MCP client properly handles and exposes these fields in tool results.
"""

import json

from mcp import StdioServerParameters, stdio_client

from strands import Agent
from strands.hooks import AfterToolCallEvent, HookProvider, HookRegistry
from strands.tools.mcp.mcp_client import MCPClient


class ToolResultCapture(HookProvider):
    """Captures tool results for inspection."""

    def __init__(self):
        self.captured_results = {}

    def register_hooks(self, registry: HookRegistry) -> None:
        """Register callback for after tool invocation events."""
        registry.add_callback(AfterToolCallEvent, self.on_after_tool_invocation)

    def on_after_tool_invocation(self, event: AfterToolCallEvent) -> None:
        """Capture tool results by tool name."""
        tool_name = event.tool_use["name"]
        self.captured_results[tool_name] = event.result


def test_structured_content():
    """Test that MCP tools can return structured content."""
    # Set up result capture
    result_capture = ToolResultCapture()

    # Set up MCP client for echo server
    stdio_mcp_client = MCPClient(
        lambda: stdio_client(StdioServerParameters(command="python", args=["tests_integ/mcp/echo_server.py"]))
    )

    with stdio_mcp_client:
        # Create agent with MCP tools and result capture
        agent = Agent(tools=stdio_mcp_client.list_tools_sync(), hooks=[result_capture])

        # Test structured content functionality
        test_data = "STRUCTURED_TEST"
        agent(f"Use the echo_with_structured_content tool to echo: {test_data}")

        # Verify result was captured
        assert "echo_with_structured_content" in result_capture.captured_results
        result = result_capture.captured_results["echo_with_structured_content"]

        # Verify basic result structure
        assert result["status"] == "success"
        assert len(result["content"]) == 1

        # Verify structured content is present and correct
        assert "structuredContent" in result
        assert result["structuredContent"] == {"echoed": test_data, "message_length": 15}

        # Verify text content matches structured content
        text_content = json.loads(result["content"][0]["text"])
        assert text_content == {"echoed": test_data, "message_length": 15}


def test_metadata():
    """Test that MCP tools can return metadata."""
    # Set up result capture
    result_capture = ToolResultCapture()

    # Set up MCP client for echo server
    stdio_mcp_client = MCPClient(
        lambda: stdio_client(StdioServerParameters(command="python", args=["tests_integ/mcp/echo_server.py"]))
    )

    with stdio_mcp_client:
        # Create agent with MCP tools and result capture
        agent = Agent(tools=stdio_mcp_client.list_tools_sync(), hooks=[result_capture])

        # Test metadata functionality
        test_data = "METADATA_TEST"
        agent(f"Use the echo_with_metadata tool to echo: {test_data}")

        # Verify result was captured
        assert "echo_with_metadata" in result_capture.captured_results
        result = result_capture.captured_results["echo_with_metadata"]

        # Verify basic result structure
        assert result["status"] == "success"

        # Verify metadata is present and correct
        assert "metadata" in result
        expected_metadata = {"metadata": {"nested": 1}, "shallow": "val"}
        assert result["metadata"] == expected_metadata
