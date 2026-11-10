"""Integration test for MCP tools with output schema."""

from mcp import StdioServerParameters, stdio_client

from strands.tools.mcp.mcp_client import MCPClient

from .echo_server import EchoResponse


def test_mcp_tool_output_schema():
    """Test that MCP tools with output schema include it in tool spec."""
    stdio_mcp_client = MCPClient(
        lambda: stdio_client(StdioServerParameters(command="python", args=["tests_integ/mcp/echo_server.py"]))
    )

    with stdio_mcp_client:
        tools = stdio_mcp_client.list_tools_sync()

        # Find tools with and without output schema
        echo_tool = next(tool for tool in tools if tool.tool_name == "echo")
        structured_tool = next(tool for tool in tools if tool.tool_name == "echo_with_structured_content")

        # Verify echo tool has no output schema
        echo_spec = echo_tool.tool_spec
        assert "outputSchema" not in echo_spec

        # Verify structured tool has output schema
        structured_spec = structured_tool.tool_spec
        assert "outputSchema" in structured_spec

        # Validate output schema matches expected structure
        expected_schema = {
            "description": "Response model for echo with structured content.",
            "properties": {
                "echoed": {"title": "Echoed", "type": "string"},
                "message_length": {"title": "Message Length", "type": "integer"},
            },
            "required": ["echoed", "message_length"],
            "title": "EchoResponse",
            "type": "object",
        }

        assert structured_spec["outputSchema"]["json"] == expected_schema
        assert structured_spec["outputSchema"]["json"] == EchoResponse.model_json_schema()
