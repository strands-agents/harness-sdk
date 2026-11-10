import threading
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from mcp.shared.message import SessionMessage
from mcp.types import JSONRPCMessage, JSONRPCRequest
from opentelemetry import context, propagate

from strands.tools.mcp.mcp_client import MCPClient
from strands.tools.mcp.mcp_instrumentation import (
    ItemWithContext,
    SessionContextAttachingReader,
    SessionContextSavingWriter,
    TransportContextExtractingReader,
    inject_trace_context,
    mcp_instrumentation,
)


@pytest.fixture(autouse=True)
def reset_mcp_instrumentation():
    """Reset MCP instrumentation state before each test."""
    import strands.tools.mcp.mcp_instrumentation as mcp_inst

    mcp_inst._instrumentation_applied = False
    yield
    # Reset after test too
    mcp_inst._instrumentation_applied = False


class TestInjectTraceContext:
    def test_injects_context_into_empty_meta(self):
        """Test that trace context is injected when no metadata is supplied."""
        with patch.object(propagate, "get_global_textmap") as mock_textmap:
            mock_textmap.return_value.inject = lambda carrier: carrier.update({"traceparent": "00-abc-def-01"})

            result = inject_trace_context(None)

            assert result == {"traceparent": "00-abc-def-01"}

    def test_preserves_existing_meta_entries(self):
        """Test that caller-supplied metadata survives injection."""
        with patch.object(propagate, "get_global_textmap") as mock_textmap:
            mock_textmap.return_value.inject = lambda carrier: carrier.update({"traceparent": "00-abc-def-01"})

            result = inject_trace_context({"com.example/request_id": "abc-123"})

            assert result == {"com.example/request_id": "abc-123", "traceparent": "00-abc-def-01"}

    def test_does_not_mutate_input(self):
        """Test that the caller's metadata dict is copied, not mutated."""
        original = {"com.example/request_id": "abc-123"}

        with patch.object(propagate, "get_global_textmap") as mock_textmap:
            mock_textmap.return_value.inject = lambda carrier: carrier.update({"traceparent": "00-abc-def-01"})

            inject_trace_context(original)

        assert original == {"com.example/request_id": "abc-123"}

    def test_returns_none_when_nothing_to_send(self):
        """Test that None is returned when there is no metadata and no active context."""
        with patch.object(propagate, "get_global_textmap") as mock_textmap:
            mock_textmap.return_value.inject = lambda carrier: None

            result = inject_trace_context(None)

            assert result is None

    def test_propagator_error_does_not_raise(self):
        """Test that a failing propagator never escapes to fail the tool call.

        Guards https://github.com/strands-agents/harness-sdk/pull/3611#discussion_r3706469408: custom
        propagators (configurable via OTEL_PROPAGATORS) may raise, and telemetry must not break calls.
        """

        def broken_inject(carrier):
            raise RuntimeError("propagator boom")

        with patch.object(propagate, "get_global_textmap") as mock_textmap:
            mock_textmap.return_value.inject = broken_inject

            result = inject_trace_context({"com.example/request_id": "abc-123"})

            assert result == {"com.example/request_id": "abc-123"}


class TestItemWithContext:
    def test_item_with_context_creation(self):
        """Test that ItemWithContext correctly stores item and context."""
        test_item = {"test": "data"}
        test_context = context.get_current()

        wrapped = ItemWithContext(test_item, test_context)

        assert wrapped.item == test_item
        assert wrapped.ctx == test_context


class TestTransportContextExtractingReader:
    @pytest.fixture
    def mock_wrapped_reader(self):
        """Create a mock wrapped reader."""
        mock_reader = AsyncMock()
        mock_reader.__aenter__ = AsyncMock(return_value=mock_reader)
        mock_reader.__aexit__ = AsyncMock()
        return mock_reader

    def test_init(self, mock_wrapped_reader):
        """Test reader initialization."""
        reader = TransportContextExtractingReader(mock_wrapped_reader)
        assert reader.__wrapped__ == mock_wrapped_reader

    @pytest.mark.asyncio
    async def test_context_manager_methods(self, mock_wrapped_reader):
        """Test async context manager methods delegate correctly."""
        reader = TransportContextExtractingReader(mock_wrapped_reader)

        await reader.__aenter__()
        mock_wrapped_reader.__aenter__.assert_called_once()

        await reader.__aexit__(None, None, None)
        mock_wrapped_reader.__aexit__.assert_called_once_with(None, None, None)

    @pytest.mark.asyncio
    async def test_aiter_with_session_message_and_dict_meta(self, mock_wrapped_reader):
        """Test context extraction from SessionMessage with dict params containing _meta."""
        # Create mock message with dict params containing _meta
        mock_request = MagicMock(spec=JSONRPCRequest)
        mock_request.params = {"_meta": {"traceparent": "test-trace-id"}, "other": "data"}

        mock_message = MagicMock()
        mock_message.root = mock_request

        mock_session_message = MagicMock(spec=SessionMessage)
        mock_session_message.message = mock_message

        async def async_iter():
            for item in [mock_session_message]:
                yield item

        mock_wrapped_reader.__aiter__ = lambda self: async_iter()

        reader = TransportContextExtractingReader(mock_wrapped_reader)

        with (
            patch.object(propagate, "extract") as mock_extract,
            patch.object(context, "attach") as mock_attach,
            patch.object(context, "detach") as mock_detach,
        ):
            mock_context = MagicMock()
            mock_extract.return_value = mock_context
            mock_token = MagicMock()
            mock_attach.return_value = mock_token

            items = []
            async for item in reader:
                items.append(item)

            assert len(items) == 1
            assert items[0] == mock_session_message

            mock_extract.assert_called_once_with({"traceparent": "test-trace-id"})
            mock_attach.assert_called_once_with(mock_context)
            mock_detach.assert_called_once_with(mock_token)

    @pytest.mark.asyncio
    async def test_aiter_with_session_message_and_pydantic_meta(self, mock_wrapped_reader):
        """Test context extraction from SessionMessage with Pydantic params having _meta attribute."""
        # Create mock message with Pydantic-style params
        mock_request = MagicMock(spec=JSONRPCRequest)

        # Create a mock params object that doesn't have 'get' method but has '_meta' attribute
        mock_params = MagicMock()
        # Remove the get method to simulate Pydantic model behavior
        del mock_params.get
        mock_params._meta = {"traceparent": "test-trace-id"}
        mock_request.params = mock_params

        mock_message = MagicMock()
        mock_message.root = mock_request

        mock_session_message = MagicMock(spec=SessionMessage)
        mock_session_message.message = mock_message

        async def async_iter():
            for item in [mock_session_message]:
                yield item

        mock_wrapped_reader.__aiter__ = lambda self: async_iter()

        reader = TransportContextExtractingReader(mock_wrapped_reader)

        with (
            patch.object(propagate, "extract") as mock_extract,
            patch.object(context, "attach") as mock_attach,
            patch.object(context, "detach") as mock_detach,
        ):
            mock_context = MagicMock()
            mock_extract.return_value = mock_context
            mock_token = MagicMock()
            mock_attach.return_value = mock_token

            items = []
            async for item in reader:
                items.append(item)

            assert len(items) == 1
            assert items[0] == mock_session_message

            mock_extract.assert_called_once_with({"traceparent": "test-trace-id"})
            mock_attach.assert_called_once_with(mock_context)
            mock_detach.assert_called_once_with(mock_token)

    @pytest.mark.asyncio
    async def test_aiter_with_jsonrpc_message_no_meta(self, mock_wrapped_reader):
        """Test handling JSONRPCMessage without _meta."""
        mock_request = MagicMock(spec=JSONRPCRequest)
        mock_request.params = {"other": "data"}

        mock_message = MagicMock(spec=JSONRPCMessage)
        mock_message.root = mock_request

        async def async_iter():
            for item in [mock_message]:
                yield item

        mock_wrapped_reader.__aiter__ = lambda self: async_iter()

        reader = TransportContextExtractingReader(mock_wrapped_reader)

        items = []
        async for item in reader:
            items.append(item)

        assert len(items) == 1
        assert items[0] == mock_message

    @pytest.mark.asyncio
    async def test_aiter_with_non_message_item(self, mock_wrapped_reader):
        """Test handling non-message items."""
        other_item = {"not": "a message"}

        async def async_iter():
            for item in [other_item]:
                yield item

        mock_wrapped_reader.__aiter__ = lambda self: async_iter()

        reader = TransportContextExtractingReader(mock_wrapped_reader)

        items = []
        async for item in reader:
            items.append(item)

        assert len(items) == 1
        assert items[0] == other_item


class TestSessionContextSavingWriter:
    @pytest.fixture
    def mock_wrapped_writer(self):
        """Create a mock wrapped writer."""
        mock_writer = AsyncMock()
        mock_writer.__aenter__ = AsyncMock(return_value=mock_writer)
        mock_writer.__aexit__ = AsyncMock()
        mock_writer.send = AsyncMock()
        return mock_writer

    def test_init(self, mock_wrapped_writer):
        """Test writer initialization."""
        writer = SessionContextSavingWriter(mock_wrapped_writer)
        assert writer.__wrapped__ == mock_wrapped_writer

    @pytest.mark.asyncio
    async def test_context_manager_methods(self, mock_wrapped_writer):
        """Test async context manager methods delegate correctly."""
        writer = SessionContextSavingWriter(mock_wrapped_writer)

        await writer.__aenter__()
        mock_wrapped_writer.__aenter__.assert_called_once()

        await writer.__aexit__(None, None, None)
        mock_wrapped_writer.__aexit__.assert_called_once_with(None, None, None)

    @pytest.mark.asyncio
    async def test_send_wraps_item_with_context(self, mock_wrapped_writer):
        """Test that send wraps items with current context."""
        writer = SessionContextSavingWriter(mock_wrapped_writer)
        test_item = {"test": "data"}

        with patch.object(context, "get_current") as mock_get_current:
            mock_context = MagicMock()
            mock_get_current.return_value = mock_context

            await writer.send(test_item)

            mock_get_current.assert_called_once()
            mock_wrapped_writer.send.assert_called_once()

            # Verify the item was wrapped with context
            sent_item = mock_wrapped_writer.send.call_args[0][0]
            assert isinstance(sent_item, ItemWithContext)
            assert sent_item.item == test_item
            assert sent_item.ctx == mock_context


class TestSessionContextAttachingReader:
    @pytest.fixture
    def mock_wrapped_reader(self):
        """Create a mock wrapped reader."""
        mock_reader = AsyncMock()
        mock_reader.__aenter__ = AsyncMock(return_value=mock_reader)
        mock_reader.__aexit__ = AsyncMock()
        return mock_reader

    def test_init(self, mock_wrapped_reader):
        """Test reader initialization."""
        reader = SessionContextAttachingReader(mock_wrapped_reader)
        assert reader.__wrapped__ == mock_wrapped_reader

    @pytest.mark.asyncio
    async def test_context_manager_methods(self, mock_wrapped_reader):
        """Test async context manager methods delegate correctly."""
        reader = SessionContextAttachingReader(mock_wrapped_reader)

        await reader.__aenter__()
        mock_wrapped_reader.__aenter__.assert_called_once()

        await reader.__aexit__(None, None, None)
        mock_wrapped_reader.__aexit__.assert_called_once_with(None, None, None)

    @pytest.mark.asyncio
    async def test_aiter_with_item_with_context(self, mock_wrapped_reader):
        """Test context restoration from ItemWithContext."""
        test_item = {"test": "data"}
        test_context = MagicMock()
        wrapped_item = ItemWithContext(test_item, test_context)

        async def async_iter():
            for item in [wrapped_item]:
                yield item

        mock_wrapped_reader.__aiter__ = lambda self: async_iter()

        reader = SessionContextAttachingReader(mock_wrapped_reader)

        with patch.object(context, "attach") as mock_attach, patch.object(context, "detach") as mock_detach:
            mock_token = MagicMock()
            mock_attach.return_value = mock_token

            items = []
            async for item in reader:
                items.append(item)

            assert len(items) == 1
            assert items[0] == test_item

            mock_attach.assert_called_once_with(test_context)
            mock_detach.assert_called_once_with(mock_token)

    @pytest.mark.asyncio
    async def test_aiter_with_regular_item(self, mock_wrapped_reader):
        """Test handling regular items without context."""
        regular_item = {"regular": "item"}

        async def async_iter():
            for item in [regular_item]:
                yield item

        mock_wrapped_reader.__aiter__ = lambda self: async_iter()

        reader = SessionContextAttachingReader(mock_wrapped_reader)

        items = []
        async for item in reader:
            items.append(item)

        assert len(items) == 1
        assert items[0] == regular_item


class TestMCPInstrumentation:
    def test_mcp_instrumentation_called_on_client_init(self):
        """Test that mcp_instrumentation is called when MCPClient is initialized."""
        with patch("strands.tools.mcp.mcp_client.mcp_instrumentation") as mock_instrumentation:
            # Mock transport
            def mock_transport():
                read_stream = AsyncMock()
                write_stream = AsyncMock()
                return read_stream, write_stream

            # Create MCPClient instance - should call mcp_instrumentation
            MCPClient(mock_transport)

            # Verify mcp_instrumentation was called
            mock_instrumentation.assert_called_once()

    def test_mcp_instrumentation_idempotent_with_multiple_clients(self):
        """Test that mcp_instrumentation is only called once even with multiple MCPClient instances."""

        # Mock register_post_import_hook to count calls
        with patch("strands.tools.mcp.mcp_instrumentation.register_post_import_hook") as mock_register:
            # Mock transport
            def mock_transport():
                read_stream = AsyncMock()
                write_stream = AsyncMock()
                return read_stream, write_stream

            # Create first MCPClient instance - should apply instrumentation
            MCPClient(mock_transport)
            first_call_count = mock_register.call_count

            # Create second MCPClient instance - should NOT apply instrumentation again
            MCPClient(mock_transport)

            # register_post_import_hook should not be called again for the second client
            assert mock_register.call_count == first_call_count

    def test_mcp_instrumentation_registers_server_side_hooks(self):
        """Test that mcp_instrumentation registers the transport and session wrappers on the 1.x line."""
        with (
            patch("strands.tools.mcp.mcp_instrumentation.MCP_V2", False),
            patch("strands.tools.mcp.mcp_instrumentation.register_post_import_hook") as mock_register,
        ):
            mcp_instrumentation()

            # Verify register_post_import_hook was called for transport and session wrappers
            assert mock_register.call_count == 2

            # Check that the registered hooks are for the expected modules
            registered_modules = [call[0][1] for call in mock_register.call_args_list]
            assert "mcp.server.streamable_http" in registered_modules
            assert "mcp.server.session" in registered_modules

    def test_mcp_instrumentation_skips_patches_on_mcp_v2(self):
        """Test that the server-side patches are not applied when mcp 2.x is installed."""
        with (
            patch("strands.tools.mcp.mcp_instrumentation.MCP_V2", True),
            patch("strands.tools.mcp.mcp_instrumentation.register_post_import_hook") as mock_register,
        ):
            mcp_instrumentation()

            mock_register.assert_not_called()

    def test_mcp_instrumentation_applies_once_under_concurrency(self):
        """Test that concurrent callers cannot apply the patches more than once.

        Guards https://github.com/strands-agents/harness-sdk/pull/3611#discussion_r3706469411: an
        unlocked check-and-set let concurrent MCPClient construction stack duplicate wrappers.
        """
        with (
            patch("strands.tools.mcp.mcp_instrumentation.MCP_V2", False),
            patch("strands.tools.mcp.mcp_instrumentation.register_post_import_hook") as mock_register,
        ):
            threads = [threading.Thread(target=mcp_instrumentation) for _ in range(8)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=5)

            # Two hooks registered exactly once, regardless of caller count
            assert mock_register.call_count == 2

    def test_mcp_instrumentation_skip_is_sticky(self):
        """Test that a skipped application still marks instrumentation as applied."""
        with patch("strands.tools.mcp.mcp_instrumentation.MCP_V2", True):
            mcp_instrumentation()

        with patch("strands.tools.mcp.mcp_instrumentation.register_post_import_hook") as mock_register:
            mcp_instrumentation()

            mock_register.assert_not_called()
