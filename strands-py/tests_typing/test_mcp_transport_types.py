"""Typing contract for `MCPClient` transport callables.

Guards https://github.com/strands-agents/harness-sdk/issues/6560: the callable
passed to `MCPClient` must accept the transports shipped by the installed `mcp`
line itself. Under mcp 2.x those yield `ReadStream`/`WriteStream` protocol pairs;
under 1.x they yield anyio memory object streams.
"""

from mcp.client.sse import sse_client
from mcp.client.stdio import StdioServerParameters, stdio_client
from mcp.client.streamable_http import streamable_http_client

from strands.tools.mcp import MCPClient

_params = StdioServerParameters(command="python", args=["server.py"])

by_streamable_http = MCPClient(lambda: streamable_http_client("http://localhost:8000/mcp"))
by_sse = MCPClient(lambda: sse_client("http://localhost:8000/sse"))
by_stdio = MCPClient(lambda: stdio_client(_params))
