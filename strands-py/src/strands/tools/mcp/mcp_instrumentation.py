"""OpenTelemetry instrumentation for Model Context Protocol (MCP) tracing.

Enables distributed tracing across MCP client-server boundaries. The client
side is handled with `inject_trace_context`, which `MCPClient` uses to merge
the current OpenTelemetry context into the `_meta` field of outgoing tool
calls through the public `meta` parameter of the official `mcp` package.

The server side covers MCP servers hosted in the same process. It extracts
client-injected context from incoming messages so server-side spans join the
client's trace. This requires patching private internals of the `mcp` package
and those internals are only stable within the 1.x line, so the patches are
gated to `mcp` 1.x. The `mcp` 2.x line propagates trace context natively.

Based on: https://github.com/traceloop/openllmetry/tree/main/packages/opentelemetry-instrumentation-mcp
Related issue: https://github.com/modelcontextprotocol/modelcontextprotocol/issues/246
"""

import logging
import threading
from collections.abc import AsyncGenerator, Callable
from contextlib import _AsyncGeneratorContextManager, asynccontextmanager
from dataclasses import dataclass
from typing import Any

from mcp.shared.message import SessionMessage
from mcp.types import JSONRPCMessage, JSONRPCRequest
from opentelemetry import context, propagate
from wrapt import ObjectProxy, register_post_import_hook, wrap_function_wrapper

from ._compat import MCP_V2

logger = logging.getLogger(__name__)

# Module-level flag to ensure instrumentation is applied only once. The lock
# makes the check-and-set atomic so concurrent MCPClient construction cannot
# stack duplicate wrappers.
_instrumentation_applied = False
_instrumentation_lock = threading.Lock()


def inject_trace_context(meta: dict[str, Any] | None) -> dict[str, Any] | None:
    """Merge the current OpenTelemetry context into MCP request metadata.

    Injects the active trace context (for example `traceparent` and
    `tracestate`) into a copy of `meta` so it can be sent as the `_meta`
    field of an MCP request. This enables server-side context extraction and
    trace continuation across the client-server boundary.

    Telemetry must never fail the tool call itself, so propagator errors are
    logged and swallowed; the caller's metadata is still returned.

    Args:
        meta: Existing request metadata, or None. The input is not mutated.

    Returns:
        A new dict containing the caller's entries plus the injected trace
        context, or None when there is no metadata to send.
    """
    carrier: dict[str, Any] = dict(meta) if meta else {}
    try:
        propagate.get_global_textmap().inject(carrier)
    except Exception:
        logger.warning("failed to inject trace context into mcp request meta", exc_info=True)
    return carrier or None


@dataclass(slots=True, frozen=True)
class ItemWithContext:
    """Wrapper for items that need to carry OpenTelemetry context.

    Used to preserve tracing context across async boundaries in MCP sessions,
    ensuring that distributed traces remain connected even when messages are
    processed asynchronously.

    Attributes:
        item: The original item being wrapped
        ctx: The OpenTelemetry context associated with the item
    """

    item: Any
    ctx: context.Context


def mcp_instrumentation() -> None:
    """Apply OpenTelemetry instrumentation patches for in-process MCP servers.

    Instruments two areas of server-side MCP communication:
    1. Transport-level: Extracts context from incoming messages
    2. Session-level: Preserves context across async message processing
       boundaries

    Together the patches let an MCP server hosted in the same process join
    the trace of the client that injected context into the request's `_meta`
    field. Client-side injection does not require patching; `MCPClient`
    injects context via `inject_trace_context`.

    The patches wrap private internals of the `mcp` package that are only
    stable within the 1.x line, so they are applied only when `mcp` 1.x is
    installed. The `mcp` 2.x line propagates trace context natively.

    This function is idempotent - multiple calls will not accumulate wrappers.
    """
    global _instrumentation_applied

    with _instrumentation_lock:
        # Return early if instrumentation has already been applied
        if _instrumentation_applied:
            return
        _instrumentation_applied = True

        if MCP_V2:
            return

    def transport_wrapper() -> Callable[
        [Callable[..., Any], Any, Any, Any], _AsyncGeneratorContextManager[tuple[Any, Any]]
    ]:
        """Create a wrapper for MCP transport connections.

        Returns a context manager that wraps transport read/write streams
        with context extraction capabilities. The wrapped reader will
        automatically extract OpenTelemetry context from incoming messages.

        Returns:
            An async context manager that yields wrapped transport streams
        """

        @asynccontextmanager
        async def traced_method(
            wrapped: Callable[..., Any], instance: Any, args: Any, kwargs: Any
        ) -> AsyncGenerator[tuple[Any, Any], None]:
            async with wrapped(*args, **kwargs) as result:
                try:
                    read_stream, write_stream = result
                except ValueError:
                    read_stream, write_stream, _ = result
                yield TransportContextExtractingReader(read_stream), write_stream

        return traced_method

    def session_init_wrapper() -> Callable[[Any, Any, tuple[Any, ...], dict[str, Any]], None]:
        """Create a wrapper for MCP session initialization.

        Wraps session message streams to enable bidirectional context flow.
        The reader extracts and activates context, while the writer preserves
        context for async processing.

        Returns:
            A function that wraps session initialization
        """

        def traced_method(
            wrapped: Callable[..., Any], instance: Any, args: tuple[Any, ...], kwargs: dict[str, Any]
        ) -> None:
            wrapped(*args, **kwargs)
            reader = getattr(instance, "_incoming_message_stream_reader", None)
            writer = getattr(instance, "_incoming_message_stream_writer", None)
            if reader and writer:
                instance._incoming_message_stream_reader = SessionContextAttachingReader(reader)
                instance._incoming_message_stream_writer = SessionContextSavingWriter(writer)

        return traced_method

    # Apply patches
    register_post_import_hook(
        lambda _: wrap_function_wrapper(
            "mcp.server.streamable_http", "StreamableHTTPServerTransport.connect", transport_wrapper()
        ),
        "mcp.server.streamable_http",
    )

    register_post_import_hook(
        lambda _: wrap_function_wrapper("mcp.server.session", "ServerSession.__init__", session_init_wrapper()),
        "mcp.server.session",
    )

    # Mark instrumentation as applied
    _instrumentation_applied = True


class TransportContextExtractingReader(ObjectProxy):
    """A proxy reader that extracts OpenTelemetry context from MCP messages.

    Wraps an async message stream reader to automatically extract and activate
    OpenTelemetry context from the _meta field of incoming MCP requests. This
    enables server-side trace continuation from client-injected context.

    The reader handles both SessionMessage and JSONRPCMessage formats, and
    supports both dict and Pydantic model parameter structures.
    """

    def __init__(self, wrapped: Any) -> None:
        """Initialize the context-extracting reader.

        Args:
            wrapped: The original async stream reader to wrap
        """
        super().__init__(wrapped)

    async def __aenter__(self) -> Any:
        """Enter the async context manager by delegating to the wrapped object."""
        return await self.__wrapped__.__aenter__()

    async def __aexit__(self, exc_type: Any, exc_value: Any, traceback: Any) -> Any:
        """Exit the async context manager by delegating to the wrapped object."""
        return await self.__wrapped__.__aexit__(exc_type, exc_value, traceback)

    async def __aiter__(self) -> AsyncGenerator[Any, None]:
        """Iterate over messages, extracting and activating context as needed.

        For each incoming message, checks if it contains tracing context in
        the _meta field. If found, extracts and activates the context for
        the duration of message processing, then properly detaches it.

        Yields:
            Messages from the wrapped stream, processed under the appropriate
            OpenTelemetry context
        """
        async for item in self.__wrapped__:
            if isinstance(item, SessionMessage):
                request = item.message.root  # type: ignore[union-attr]
            elif type(item) is JSONRPCMessage:
                request = item.root  # type: ignore[unreachable]
            else:
                yield item
                continue

            if isinstance(request, JSONRPCRequest) and request.params:
                # Handle both dict and Pydantic model params
                if hasattr(request.params, "get"):
                    # Dict-like access
                    meta = request.params.get("_meta")
                elif hasattr(request.params, "_meta"):
                    # Direct attribute access for Pydantic models
                    meta = getattr(request.params, "_meta", None)
                else:
                    meta = None

                if meta:
                    extracted_context = propagate.extract(meta)
                    restore = context.attach(extracted_context)
                    try:
                        yield item
                        continue
                    finally:
                        context.detach(restore)
            yield item


class SessionContextSavingWriter(ObjectProxy):
    """A proxy writer that preserves OpenTelemetry context with outgoing items.

    Wraps an async message stream writer to capture the current OpenTelemetry
    context and associate it with outgoing items. This enables context
    preservation across async boundaries in MCP session processing.
    """

    def __init__(self, wrapped: Any) -> None:
        """Initialize the context-saving writer.

        Args:
            wrapped: The original async stream writer to wrap
        """
        super().__init__(wrapped)

    async def __aenter__(self) -> Any:
        """Enter the async context manager by delegating to the wrapped object."""
        return await self.__wrapped__.__aenter__()

    async def __aexit__(self, exc_type: Any, exc_value: Any, traceback: Any) -> Any:
        """Exit the async context manager by delegating to the wrapped object."""
        return await self.__wrapped__.__aexit__(exc_type, exc_value, traceback)

    async def send(self, item: Any) -> Any:
        """Send an item while preserving the current OpenTelemetry context.

        Captures the current context and wraps the item with it, enabling
        the receiving side to restore the appropriate tracing context.

        Args:
            item: The item to send through the stream

        Returns:
            Result of sending the wrapped item
        """
        ctx = context.get_current()
        return await self.__wrapped__.send(ItemWithContext(item, ctx))


class SessionContextAttachingReader(ObjectProxy):
    """A proxy reader that restores OpenTelemetry context from wrapped items.

    Wraps an async message stream reader to detect ItemWithContext instances
    and restore their associated OpenTelemetry context during processing.
    This completes the context preservation cycle started by SessionContextSavingWriter.
    """

    def __init__(self, wrapped: Any) -> None:
        """Initialize the context-attaching reader.

        Args:
            wrapped: The original async stream reader to wrap
        """
        super().__init__(wrapped)

    async def __aenter__(self) -> Any:
        """Enter the async context manager by delegating to the wrapped object."""
        return await self.__wrapped__.__aenter__()

    async def __aexit__(self, exc_type: Any, exc_value: Any, traceback: Any) -> Any:
        """Exit the async context manager by delegating to the wrapped object."""
        return await self.__wrapped__.__aexit__(exc_type, exc_value, traceback)

    async def __aiter__(self) -> AsyncGenerator[Any, None]:
        """Iterate over items, restoring context for ItemWithContext instances.

        For items wrapped with context, temporarily activates the associated
        OpenTelemetry context during processing, then properly detaches it.
        Regular items are yielded without context modification.

        Yields:
            Unwrapped items processed under their associated OpenTelemetry context
        """
        async for item in self.__wrapped__:
            if isinstance(item, ItemWithContext):
                restore = context.attach(item.ctx)
                try:
                    yield item.item
                finally:
                    context.detach(restore)
            else:
                yield item
