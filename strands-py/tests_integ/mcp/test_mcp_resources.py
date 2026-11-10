"""
Integration tests for MCP client resource functionality.

This module tests the resource-related methods in MCPClient:
- list_resources_sync()
- read_resource_sync()
- list_resource_templates_sync()

The tests use the echo server which has been extended with resource functionality.
"""

import base64
import json

import pytest
from mcp import StdioServerParameters, stdio_client
from mcp.shared.exceptions import McpError
from mcp.types import BlobResourceContents, TextResourceContents
from pydantic import AnyUrl

from strands.tools.mcp.mcp_client import MCPClient


def test_mcp_resources_list_and_read():
    """Test listing and reading various types of resources."""
    mcp_client = MCPClient(
        lambda: stdio_client(StdioServerParameters(command="python", args=["tests_integ/mcp/echo_server.py"]))
    )

    with mcp_client:
        # Test list_resources_sync
        resources_result = mcp_client.list_resources_sync()
        assert len(resources_result.resources) >= 2  # At least our 2 static resources

        # Verify resource URIs exist (only static resources, not templates)
        resource_uris = [str(r.uri) for r in resources_result.resources]
        assert "test://static-text" in resource_uris
        assert "test://static-binary" in resource_uris
        # Template resources are not listed in static resources

        # Test reading text resource
        text_resource = mcp_client.read_resource_sync("test://static-text")
        assert len(text_resource.contents) == 1
        content = text_resource.contents[0]
        assert isinstance(content, TextResourceContents)
        assert "This is the content of the static text resource." in content.text

        # Test reading binary resource
        binary_resource = mcp_client.read_resource_sync("test://static-binary")
        assert len(binary_resource.contents) == 1
        binary_content = binary_resource.contents[0]
        assert isinstance(binary_content, BlobResourceContents)
        # Verify it's valid base64 encoded data
        decoded_data = base64.b64decode(binary_content.blob)
        assert len(decoded_data) > 0


def test_mcp_resources_templates():
    """Test listing resource templates and reading from template resources."""
    mcp_client = MCPClient(
        lambda: stdio_client(StdioServerParameters(command="python", args=["tests_integ/mcp/echo_server.py"]))
    )

    with mcp_client:
        # Test list_resource_templates_sync
        templates_result = mcp_client.list_resource_templates_sync()
        assert len(templates_result.resourceTemplates) >= 1

        # Verify template URIs exist
        template_uris = [t.uriTemplate for t in templates_result.resourceTemplates]
        assert "test://template/{id}/data" in template_uris

        # Test reading from template resource
        template_resource = mcp_client.read_resource_sync("test://template/123/data")
        assert len(template_resource.contents) == 1
        template_content = template_resource.contents[0]
        assert isinstance(template_content, TextResourceContents)

        # Parse the JSON response
        parsed_json = json.loads(template_content.text)
        assert parsed_json["id"] == "123"
        assert parsed_json["templateTest"] is True
        assert "Data for ID: 123" in parsed_json["data"]


def test_mcp_resources_pagination():
    """Test pagination support for resources."""
    mcp_client = MCPClient(
        lambda: stdio_client(StdioServerParameters(command="python", args=["tests_integ/mcp/echo_server.py"]))
    )

    with mcp_client:
        # Test with pagination token (should work even if server doesn't implement pagination)
        resources_result = mcp_client.list_resources_sync(pagination_token=None)
        assert len(resources_result.resources) >= 0

        # Test resource templates pagination
        templates_result = mcp_client.list_resource_templates_sync(pagination_token=None)
        assert len(templates_result.resourceTemplates) >= 0


def test_mcp_resources_error_handling():
    """Test error handling for resource operations."""
    mcp_client = MCPClient(
        lambda: stdio_client(StdioServerParameters(command="python", args=["tests_integ/mcp/echo_server.py"]))
    )

    with mcp_client:
        # Test reading non-existent resource
        with pytest.raises(McpError, match="Unknown resource"):
            mcp_client.read_resource_sync("test://nonexistent")


def test_mcp_resources_uri_types():
    """Test that both string and AnyUrl types work for read_resource_sync."""
    mcp_client = MCPClient(
        lambda: stdio_client(StdioServerParameters(command="python", args=["tests_integ/mcp/echo_server.py"]))
    )

    with mcp_client:
        # Test with string URI
        text_resource_str = mcp_client.read_resource_sync("test://static-text")
        assert len(text_resource_str.contents) == 1

        # Test with AnyUrl URI
        text_resource_url = mcp_client.read_resource_sync(AnyUrl("test://static-text"))
        assert len(text_resource_url.contents) == 1

        # Both should return the same content
        assert text_resource_str.contents[0].text == text_resource_url.contents[0].text
