"""
Echo Server for MCP Integration Testing

This module implements a simple echo server using the Model Context Protocol (MCP).
It provides basic tools that echo back input strings and structured content, which is useful for
testing the MCP communication flow and validating that messages are properly
transmitted between the client and server.

The server runs with stdio transport, making it suitable for integration tests
where the client can spawn this process and communicate with it through standard
input/output streams.

Usage:
    Run this file directly to start the echo server:
    $ python echo_server.py
"""

import base64
import json
from typing import Literal

from mcp.server import FastMCP
from mcp.server.fastmcp import Context
from mcp.types import BlobResourceContents, CallToolResult, EmbeddedResource, TextContent, TextResourceContents
from pydantic import BaseModel

TEST_IMAGE_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="


class EchoResponse(BaseModel):
    """Response model for echo with structured content."""

    echoed: str
    message_length: int


def start_echo_server():
    """
    Initialize and start the MCP echo server.

    Creates a FastMCP server instance with tools that return
    input strings and structured content back to the caller. The server uses stdio transport
    for communication.

    """
    mcp = FastMCP("Echo Server")

    @mcp.tool(description="Echos response back to the user", structured_output=False)
    def echo(to_echo: str) -> str:
        return to_echo

    @mcp.tool(description="Echos back the _meta received in the request", structured_output=False)
    def echo_meta(ctx: Context) -> str:
        meta = ctx.request_context.meta
        if meta is None:
            return json.dumps(None)
        return json.dumps(meta.model_dump(exclude_none=True))

    # FastMCP automatically constructs structured output schema from method signature
    @mcp.tool(description="Echos response back with structured content", structured_output=True)
    def echo_with_structured_content(to_echo: str) -> EchoResponse:
        return EchoResponse(echoed=to_echo, message_length=len(to_echo))

    @mcp.tool(description="Echos response back with metadata")
    def echo_with_metadata(to_echo: str):
        """Return structured content and metadata in the tool result."""

        return CallToolResult(
            content=[TextContent(type="text", text=to_echo)],
            isError=False,
            _meta={"metadata": {"nested": 1}, "shallow": "val"},
        )

    @mcp.tool(description="Get current weather information for a location")
    def get_weather(location: Literal["New York", "London", "Tokyo"] = "New York"):
        """Get weather data including forecasts and alerts for the specified location"""
        if location.lower() == "new york":
            return [
                EmbeddedResource(
                    type="resource",
                    resource=TextResourceContents(
                        uri="https://weather.api/forecast/nyc",
                        mimeType="text/plain",
                        text="Current weather in New York: 72°F, partly cloudy with light winds.",
                    ),
                )
            ]
        elif location.lower() == "london":
            return [
                EmbeddedResource(
                    type="resource",
                    resource=BlobResourceContents(
                        uri="https://weather.api/data/london.json",
                        mimeType="application/json",
                        blob=base64.b64encode(b'{"temperature": 18, "condition": "rainy", "humidity": 85}').decode(),
                    ),
                )
            ]
        elif location.lower() == "tokyo":
            # Read yellow.png file for weather icon
            with open("tests_integ/resources/yellow.png", "rb") as image_file:
                png_data = image_file.read()
            return [
                EmbeddedResource(
                    type="resource",
                    resource=BlobResourceContents(
                        uri="https://weather.api/icons/sunny.png",
                        mimeType="image/png",
                        blob=base64.b64encode(png_data).decode(),
                    ),
                )
            ]

    # Resources
    @mcp.resource("test://static-text")
    def static_text_resource() -> str:
        """A static text resource for testing"""
        return "This is the content of the static text resource."

    @mcp.resource("test://static-binary")
    def static_binary_resource() -> bytes:
        """A static binary resource (image) for testing"""
        return base64.b64decode(TEST_IMAGE_BASE64)

    @mcp.resource("test://template/{id}/data")
    def template_resource(id: str) -> str:
        """A resource template with parameter substitution"""
        return json.dumps({"id": id, "templateTest": True, "data": f"Data for ID: {id}"})

    mcp.run(transport="stdio")


if __name__ == "__main__":
    start_echo_server()
