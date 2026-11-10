"""Trace-continuity tests for `MCPClient` on the `mcp` 2.x line.

The 2.x line carries OpenTelemetry natively: the client dispatcher injects
W3C trace context into every request's `_meta` inside a CLIENT span (SEP-414),
and servers extract it in their own middleware, so `mcp_instrumentation`
applies no patches there. These tests prove that the native path actually
connects a caller's trace across the client-server boundary, guarding the
decision to not patch on 2.x.

Every test is gated on the installed line via `MCP_V2`. Fresh installs
resolve mcp 2.x, so the regular unit-test matrix runs this file against the
real package, with a real in-process server: no external endpoint or
credentials are required. The `unit-test-mcp-v1` CI job force-installs the
1.x line, and there the gate skips the whole file.
"""

import socket
import threading
import time

import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from strands.tools.mcp import MCPClient
from strands.tools.mcp._compat import MCP_V2, streamable_http_transport

pytestmark = pytest.mark.skipif(not MCP_V2, reason="exercises the mcp 2.x line's native OpenTelemetry")

_SERVER_READY_TIMEOUT_SECONDS = 10
_SPAN_EXPORT_TIMEOUT_SECONDS = 5


@pytest.fixture(scope="module")
def span_exporter() -> InMemorySpanExporter:
    """Export spans from the global tracer provider shared by the client and the in-process server.

    The provider has to be the global one: `mcp.shared._otel` creates its tracer from the global provider at
    import time, so a test-local `Tracer` cannot capture the dispatcher's or the server's spans. Because
    `set_tracer_provider` is one-way, the fixture attaches its exporter to an SDK provider another test already
    installed rather than replacing it, and installs its own only when none is set. The attached processor has
    no public detach API and stays on the provider for the rest of the pytest process. It only records to an
    in-memory exporter, so later tests are unaffected.
    """
    exporter = InMemorySpanExporter()
    provider = trace.get_tracer_provider()
    if not isinstance(provider, TracerProvider):
        trace.set_tracer_provider(TracerProvider())
        provider = trace.get_tracer_provider()
    if not isinstance(provider, TracerProvider):
        pytest.fail("the global tracer provider is not an SDK TracerProvider, so these spans cannot be captured")
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    return exporter


@pytest.fixture(scope="module")
def server_url():
    """Run `mcp` 2.x's own MCPServer in-process and return its endpoint."""
    # Imported lazily: the module exists only on the 2.x line, and module-level
    # test imports must succeed on 1.x for the skip marker to apply.
    import uvicorn
    from mcp.server.mcpserver import MCPServer

    mcp_server = MCPServer(name="otel-echo-server")

    @mcp_server.tool(description="Echoes the input back")
    def echo(to_echo: str) -> str:
        return to_echo

    # Hand uvicorn the already-bound socket so no other process can take the port in between.
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]

    app = mcp_server.streamable_http_app(streamable_http_path="/mcp", host="127.0.0.1")
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True)
    thread.start()

    deadline = time.time() + _SERVER_READY_TIMEOUT_SECONDS
    while not server.started:
        if time.time() > deadline:
            raise RuntimeError("in-process MCP server did not start")
        time.sleep(0.1)

    yield f"http://127.0.0.1:{port}/mcp"

    # A leaked uvicorn loop keeps awaiting asyncio.sleep(0.1), which breaks later tests that patch asyncio.sleep.
    server.should_exit = True
    thread.join(timeout=_SERVER_READY_TIMEOUT_SECONDS)


def _spans_named(span_exporter: InMemorySpanExporter, name: str) -> list:
    """Read exported spans by name, waiting out the server's response-side export race."""
    deadline = time.time() + _SPAN_EXPORT_TIMEOUT_SECONDS
    while True:
        matches = [span for span in span_exporter.get_finished_spans() if span.name == name]
        if matches or time.time() > deadline:
            return matches
        time.sleep(0.1)


def test_tool_call_trace_is_continuous_across_the_boundary(span_exporter, server_url):
    """Test that a caller's span, the dispatcher's CLIENT span, and the server's SERVER span form one trace."""
    tracer = trace.get_tracer(__name__)

    client = MCPClient(lambda: streamable_http_transport(url=server_url))
    with client:
        with tracer.start_as_current_span("caller") as caller_span:
            caller_context = caller_span.get_span_context()
            result = client.call_tool_sync("test-otel-1", "echo", {"to_echo": "hello"})

    assert result["status"] == "success"

    client_spans = _spans_named(span_exporter, "MCP send tools/call echo")
    server_spans = _spans_named(span_exporter, "tools/call echo")
    assert len(client_spans) == 1
    assert len(server_spans) == 1

    client_span, server_span = client_spans[0], server_spans[0]
    assert client_span.kind == trace.SpanKind.CLIENT
    assert server_span.kind == trace.SpanKind.SERVER
    assert client_span.get_span_context().trace_id == caller_context.trace_id
    assert client_span.parent.span_id == caller_context.span_id
    assert server_span.get_span_context().trace_id == caller_context.trace_id
    assert server_span.parent.span_id == client_span.get_span_context().span_id
