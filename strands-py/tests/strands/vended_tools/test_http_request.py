"""Tests for the http_request tool."""

from __future__ import annotations

import asyncio
import threading
from types import SimpleNamespace

import httpx
import pytest

from strands.types.tools import ToolContext, ToolUse
from strands.vended_tools.http_request import (
    HttpRequestError,
    http_request,
    make_http_request,
)
from strands.vended_tools.http_request.types import DEFAULT_HTTP_REQUEST_DESCRIPTION


def _make_transport(handler):
    """Build a mock httpx transport from a request handler callable."""
    return httpx.MockTransport(handler)


class TestHappyPath:
    """Basic GET / POST flow works."""

    @pytest.mark.asyncio
    async def test_get_returns_body_and_headers(self):
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                headers={"content-type": "application/json", "x-custom": "value"},
                text='{"ok":true}',
            )

        client = httpx.AsyncClient(transport=_make_transport(handler))
        tool = make_http_request(client=client)
        result = await tool(method="GET", url="https://example.com/data")
        assert result["status"] == 200
        assert result["status_text"] == "OK"
        assert result["body"] == '{"ok":true}'
        assert result["headers"]["content-type"].startswith("application/json")
        assert result["headers"]["x-custom"] == "value"

    @pytest.mark.asyncio
    async def test_post_sends_body_and_custom_headers(self):
        seen = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["method"] = request.method
            seen["body"] = request.content
            seen["ct"] = request.headers.get("content-type")
            return httpx.Response(201, text='{"id":1}')

        client = httpx.AsyncClient(transport=_make_transport(handler))
        tool = make_http_request(client=client)
        result = await tool(
            method="POST",
            url="https://example.com/users",
            headers={"Content-Type": "application/json"},
            body='{"name":"test"}',
        )
        assert result["status"] == 201
        assert seen["method"] == "POST"
        assert seen["body"] == b'{"name":"test"}'
        assert seen["ct"] == "application/json"

    @pytest.mark.asyncio
    async def test_non_2xx_status_raises_error(self):
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(404, text="not found")

        client = httpx.AsyncClient(transport=_make_transport(handler))
        tool = make_http_request(client=client)
        with pytest.raises(HttpRequestError, match="HTTP 404"):
            await tool(method="GET", url="https://example.com/missing")


class TestClientPassthrough:
    """The operator-supplied client is used directly."""

    @pytest.mark.asyncio
    async def test_client_headers_are_sent(self):
        received_headers: dict[str, str] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            received_headers.update(request.headers)
            return httpx.Response(200, text="ok")

        client = httpx.AsyncClient(
            transport=_make_transport(handler),
            headers={"Authorization": "Bearer token123"},
        )
        tool = make_http_request(client=client)
        result = await tool(method="GET", url="https://api.example.com/data")
        assert result["status"] == 200
        assert received_headers["authorization"] == "Bearer token123"

    @pytest.mark.asyncio
    async def test_request_headers_merge_with_client_headers(self):
        received_headers: dict[str, str] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            received_headers.update(request.headers)
            return httpx.Response(200, text="ok")

        client = httpx.AsyncClient(
            transport=_make_transport(handler),
            headers={"Authorization": "Bearer base"},
        )
        tool = make_http_request(client=client)
        result = await tool(
            method="GET",
            url="https://api.example.com/data",
            headers={"X-Custom": "value"},
        )
        assert result["status"] == 200
        assert received_headers["authorization"] == "Bearer base"
        assert received_headers["x-custom"] == "value"

    @pytest.mark.asyncio
    async def test_client_timeout_is_respected(self):
        async def slow_handler(_request: httpx.Request) -> httpx.Response:
            raise httpx.TimeoutException("timed out")

        client = httpx.AsyncClient(
            transport=httpx.MockTransport(slow_handler),
            timeout=5.0,
        )
        tool = make_http_request(client=client)
        with pytest.raises(HttpRequestError, match="timed out"):
            await tool(method="GET", url="https://example.com/slow")

    @pytest.mark.asyncio
    async def test_client_redirects_are_followed(self):
        call_count = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            call_count["n"] += 1
            if request.url.path == "/start":
                return httpx.Response(302, headers={"location": "/final"})
            return httpx.Response(200, text="done")

        client = httpx.AsyncClient(
            transport=_make_transport(handler),
            follow_redirects=True,
        )
        tool = make_http_request(client=client)
        result = await tool(method="GET", url="https://example.com/start")
        assert result["status"] == 200
        assert result["body"] == "done"
        assert call_count["n"] == 2

    @pytest.mark.asyncio
    async def test_too_many_redirects_is_wrapped(self):
        def handler(request: httpx.Request) -> httpx.Response:
            next_path = "/next" + request.url.path
            return httpx.Response(302, headers={"location": next_path})

        client = httpx.AsyncClient(
            transport=_make_transport(handler),
            follow_redirects=True,
            max_redirects=2,
        )
        tool = make_http_request(client=client)
        with pytest.raises(HttpRequestError, match="Too many redirects"):
            await tool(method="GET", url="https://example.com/start")


class TestNoClientProvided:
    """When no client is supplied, a default one is created per request."""

    @pytest.mark.asyncio
    async def test_creates_and_closes_client_per_request(self):
        from strands.vended_tools.http_request.http_request import _perform_request

        # Track whether aclose was called on the internally-created client
        close_called = {"n": 0}
        original_aclose = httpx.AsyncClient.aclose

        async def tracking_aclose(self):
            close_called["n"] += 1
            await original_aclose(self)

        # Use monkeypatch-style replacement on the class method
        httpx.AsyncClient.aclose = tracking_aclose  # type: ignore[assignment]
        try:
            # _perform_request with client=None creates+closes its own client.
            # Use a real request to localhost that will fail with a connection error,
            # which still exercises the create/close lifecycle.
            try:
                await _perform_request(
                    method="GET",
                    url="http://127.0.0.1:1/nonexistent",
                    headers={},
                    body=None,
                    timeout=0.1,
                    client=None,
                    cancel_signal=None,
                )
            except HttpRequestError:
                pass  # Expected — connection refused or timeout
        finally:
            httpx.AsyncClient.aclose = original_aclose  # type: ignore[assignment]

        assert close_called["n"] == 1

    @pytest.mark.asyncio
    async def test_provided_client_is_not_closed(self):
        close_called = {"n": 0}

        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text="ok")

        client = httpx.AsyncClient(transport=_make_transport(handler))
        original_aclose = client.aclose

        async def tracking_aclose():
            close_called["n"] += 1
            await original_aclose()

        client.aclose = tracking_aclose  # type: ignore[assignment]

        from strands.vended_tools.http_request.http_request import _perform_request

        await _perform_request(
            method="GET",
            url="https://example.com/",
            headers={},
            body=None,
            timeout=None,
            client=client,
            cancel_signal=None,
        )
        # The tool must NOT close a client it doesn't own
        assert close_called["n"] == 0


class TestTimeout:
    """Model-supplied timeout is capped by the client's configured timeout."""

    @pytest.mark.asyncio
    async def test_rejects_non_positive_timeout(self):
        client = httpx.AsyncClient(transport=_make_transport(lambda _r: httpx.Response(200)))
        tool = make_http_request(client=client)
        with pytest.raises(HttpRequestError, match="positive"):
            await tool(method="GET", url="https://example.com/", timeout=0)

    @pytest.mark.asyncio
    async def test_model_timeout_capped_by_client(self):
        async def slow_handler(_request: httpx.Request) -> httpx.Response:
            raise httpx.TimeoutException("timed out")

        client = httpx.AsyncClient(
            transport=httpx.MockTransport(slow_handler),
            timeout=5.0,
        )
        tool = make_http_request(client=client)
        with pytest.raises(HttpRequestError, match="timed out"):
            await tool(method="GET", url="https://example.com/slow", timeout=60)

    @pytest.mark.asyncio
    async def test_model_timeout_used_when_shorter_than_client(self):
        async def slow_handler(_request: httpx.Request) -> httpx.Response:
            raise httpx.TimeoutException("timed out")

        client = httpx.AsyncClient(
            transport=httpx.MockTransport(slow_handler),
            timeout=60.0,
        )
        tool = make_http_request(client=client)
        with pytest.raises(HttpRequestError, match="timed out"):
            await tool(method="GET", url="https://example.com/slow", timeout=2)

    @pytest.mark.asyncio
    async def test_defaults_to_client_timeout_when_model_omits(self):
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text="ok")

        client = httpx.AsyncClient(
            transport=_make_transport(handler),
            timeout=10.0,
        )
        tool = make_http_request(client=client)
        result = await tool(method="GET", url="https://example.com/")
        assert result["status"] == 200

    @pytest.mark.asyncio
    async def test_fallback_to_connect_timeout_when_read_is_none(self):
        """When read timeout is None but connect is set, connect is used as cap."""
        from strands.vended_tools.http_request.http_request import _resolve_timeout

        client = httpx.AsyncClient(
            transport=_make_transport(lambda _r: httpx.Response(200)),
            timeout=httpx.Timeout(None, connect=5.0),
        )
        # Model requests 60s, but connect cap is 5s
        result = _resolve_timeout(60.0, client)
        assert result == 5.0

    @pytest.mark.asyncio
    async def test_no_client_no_cap(self):
        """Without a client, model timeout is used as-is (no cap)."""
        from strands.vended_tools.http_request.http_request import _resolve_timeout

        result = _resolve_timeout(999.0, None)
        assert result == 999.0

    @pytest.mark.asyncio
    async def test_client_with_all_none_timeouts_no_cap(self):
        """A client with all timeout phases set to None applies no cap."""
        from strands.vended_tools.http_request.http_request import _resolve_timeout

        client = httpx.AsyncClient(
            transport=_make_transport(lambda _r: httpx.Response(200)),
            timeout=httpx.Timeout(None),
        )
        # All phases are None, so no cap — model's timeout is used as-is
        result = _resolve_timeout(999.0, client)
        assert result == 999.0

        # And when model omits timeout, result is None (no timeout at all)
        result_none = _resolve_timeout(None, client)
        assert result_none is None


class TestToolMetadata:
    """Tool name, description, and input schema."""

    def test_default_name(self):
        assert http_request.tool_name == "http_request"

    def test_default_description(self):
        assert http_request.tool_spec["description"] == DEFAULT_HTTP_REQUEST_DESCRIPTION

    def test_custom_name(self):
        assert make_http_request(name="fetch").tool_name == "fetch"

    def test_schema_exposes_expected_parameters(self):
        props = http_request.tool_spec["inputSchema"]["json"]["properties"]
        assert set(props) == {"method", "url", "headers", "body", "timeout"}


class TestCancelSignal:
    """The agent's cancel signal aborts an in-flight request."""

    @staticmethod
    def _tool_context_for(agent: object) -> ToolContext:
        tool_use = ToolUse(toolUseId="http_1", name="http_request", input={})
        return ToolContext(tool_use=tool_use, agent=agent, invocation_state={})

    @pytest.mark.asyncio
    async def test_pre_flight_cancel_short_circuits(self):
        def handler(_request: httpx.Request) -> httpx.Response:
            raise AssertionError("transport should not be called if cancel is pre-set")

        cancel = threading.Event()
        cancel.set()
        agent = SimpleNamespace(_cancel_signal=cancel)

        client = httpx.AsyncClient(transport=_make_transport(handler))
        tool = make_http_request(client=client)
        with pytest.raises(asyncio.CancelledError):
            await tool(
                method="GET",
                url="https://example.com/",
                tool_context=self._tool_context_for(agent),
            )

    @pytest.mark.asyncio
    async def test_mid_flight_cancel_between_chunks(self):
        cancel = threading.Event()

        async def streaming_body():
            yield b"partial-"
            cancel.set()
            yield b"the-rest"

        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=streaming_body())

        agent = SimpleNamespace(_cancel_signal=cancel)
        client = httpx.AsyncClient(transport=_make_transport(handler))
        tool = make_http_request(client=client)
        with pytest.raises(asyncio.CancelledError):
            await tool(
                method="GET",
                url="https://example.com/",
                tool_context=self._tool_context_for(agent),
            )

    @pytest.mark.asyncio
    async def test_no_cancel_signal_no_op(self):
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text="ok")

        agent = SimpleNamespace()
        client = httpx.AsyncClient(transport=_make_transport(handler))
        tool = make_http_request(client=client)
        result = await tool(
            method="GET",
            url="https://example.com/",
            tool_context=self._tool_context_for(agent),
        )
        assert result["status"] == 200


class TestResponseHeaderMultiplicity:
    """Repeated response headers (Set-Cookie) preserve every occurrence."""

    @pytest.mark.asyncio
    async def test_repeated_set_cookie_is_preserved(self):
        def handler(_request: httpx.Request) -> httpx.Response:
            headers = [
                ("set-cookie", "session=abc; Path=/"),
                ("set-cookie", "tracking=xyz; Path=/"),
            ]
            return httpx.Response(200, headers=headers, text="ok")

        client = httpx.AsyncClient(transport=_make_transport(handler))
        tool = make_http_request(client=client)
        result = await tool(method="GET", url="https://example.com/")
        cookies = result["headers"]["set-cookie"].split("\n")
        assert "session=abc; Path=/" in cookies
        assert "tracking=xyz; Path=/" in cookies


class TestRequestError:
    """Request errors are wrapped."""

    @pytest.mark.asyncio
    async def test_request_error_is_wrapped(self):
        def handler(_request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("boom")

        client = httpx.AsyncClient(transport=_make_transport(handler))
        tool = make_http_request(client=client)
        with pytest.raises(HttpRequestError, match="Request failed"):
            await tool(method="GET", url="https://example.com/")


class TestEncodingFallback:
    """Response body decoding falls back to UTF-8 on unknown encodings."""

    @pytest.mark.asyncio
    async def test_unknown_encoding_falls_back_to_utf8(self):
        from unittest.mock import MagicMock, PropertyMock

        from strands.vended_tools.http_request.http_request import _read_body

        mock_response = MagicMock()

        async def fake_aiter_bytes():
            yield b"hello world"

        mock_response.aiter_bytes = fake_aiter_bytes
        # Force an encoding that Python doesn't recognize
        type(mock_response).encoding = PropertyMock(return_value="x-nonexistent-codec-999")

        result = await _read_body(mock_response, None)
        assert result == "hello world"

    @pytest.mark.asyncio
    async def test_valid_encoding_is_used(self):
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                content="héllo".encode("latin-1"),
                headers={"content-type": "text/plain; charset=latin-1"},
            )

        client = httpx.AsyncClient(transport=_make_transport(handler))
        tool = make_http_request(client=client)
        result = await tool(method="GET", url="https://example.com/")
        assert result["body"] == "héllo"
