"""Type definitions for MCP integration."""

from collections.abc import Callable
from contextlib import AbstractAsyncContextManager
from typing import TYPE_CHECKING, Any, Literal

from anyio.streams.memory import MemoryObjectReceiveStream, MemoryObjectSendStream
from mcp.shared.memory import MessageStream
from mcp.shared.message import SessionMessage
from typing_extensions import NotRequired, Protocol, TypedDict

from ...types.tools import ToolResult
from ._compat import GetSessionIdCallback

if TYPE_CHECKING:
    from .mcp_agent_tool import MCPAgentTool


class ToolsChangedCallback(Protocol):
    """Called after the server announces a tool list change and the client refreshes it.

    Implemented by a plain function as well — the `**kwargs` tail lets the calling
    convention grow new keyword arguments without breaking existing callbacks.
    """

    def __call__(self, previous_names: list[str], refreshed_tools: list["MCPAgentTool"], **kwargs: Any) -> None:
        """Handle a refresh, given the previous tool names and the refreshed tool instances."""
        ...


ToolsChanged = Callable[[list[str], "list[MCPAgentTool]"], None] | ToolsChangedCallback
"""A tools-changed handler: the `**kwargs`-ready protocol or a plain two-argument callable."""


class MCPClientCredentials(TypedDict):
    """OAuth client credentials for machine-to-machine authentication.

    Used with the `MCPClient` `auth` parameter, or the `auth` key of a server entry in a
    `load_servers` config, to authenticate against a streamable HTTP MCP server with the
    OAuth client_credentials grant.

    Attributes:
        client_id: The OAuth client ID.
        client_secret: The OAuth client secret.
        scopes: OAuth scopes to request, joined with spaces. Advisory only: if the server
            advertises its own scopes (via the `WWW-Authenticate` header or its
            protected-resource / authorization-server metadata), the server's list is used
            instead and this value is ignored.
    """

    client_id: str
    client_secret: str
    scopes: NotRequired[list[str]]


"""
MCPTransport defines the interface for MCP transport implementations. This abstracts
communication with an MCP server, hiding details of the underlying transport mechanism (WebSocket, stdio, etc.).

It represents an async context manager that yields a tuple of read and write streams for MCP communication.
When used with `async with`, it should establish the connection and yield the streams, then clean up
when the context is exited.

The read stream receives messages from the client (or exceptions if parsing fails), while the write
stream sends messages to the client.

Example implementation (simplified):
```python
@contextlib.asynccontextmanager
async def my_transport_implementation():
    # Set up connection
    read_stream_writer, read_stream = anyio.create_memory_object_stream(0)
    write_stream, write_stream_reader = anyio.create_memory_object_stream(0)
    
    # Start background tasks to handle actual I/O
    async with anyio.create_task_group() as tg:
        tg.start_soon(reader_task, read_stream_writer)
        tg.start_soon(writer_task, write_stream_reader)
        
        # Yield the streams to the caller
        yield (read_stream, write_stream)
```
"""
# GetSessionIdCallback was added for HTTP Streaming but was not applied to the MessageStream type
# https://github.com/modelcontextprotocol/python-sdk/blob/ed25167fa5d715733437996682e20c24470e8177/src/mcp/client/streamable_http.py#L418
_MessageStreamWithGetSessionIdCallback = tuple[
    MemoryObjectReceiveStream[SessionMessage | Exception], MemoryObjectSendStream[SessionMessage], GetSessionIdCallback
]
MCPTransport = AbstractAsyncContextManager[MessageStream | _MessageStreamWithGetSessionIdCallback]


class MCPToolResult(ToolResult):
    """Result of an MCP tool execution.

    Extends the base ToolResult with MCP-specific structured content support.
    The structuredContent field contains optional JSON data returned by MCP tools
    that provides structured results beyond the standard text/image/document content.

    Attributes:
        structuredContent: Optional JSON object containing structured data returned
            by the MCP tool. This allows MCP tools to return complex data structures
            that can be processed programmatically by agents or other tools.
        metadata: Optional arbitrary metadata returned by the MCP tool. This field allows
            MCP servers to attach custom metadata to tool results (e.g., token usage,
            performance metrics, or business-specific tracking information).
        isError: Whether the MCP tool reported an application-level error via
            ``CallToolResult.isError``. ``True`` means the tool executed but its logic
            returned a failure. Absent when the tool succeeded or when the error was a
            protocol/client exception rather than a tool-reported failure, letting
            callers distinguish application errors from transport/protocol errors.
        cancelled: ``True`` when the local per-call cancellation signal was observed.
            This confirms local cancellation, not that remote execution stopped.
    """

    structuredContent: NotRequired[dict[str, Any]]
    metadata: NotRequired[dict[str, Any]]
    isError: NotRequired[bool]
    cancelled: NotRequired[Literal[True]]
