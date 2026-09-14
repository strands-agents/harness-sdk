"""Integration tests for `MCPClient` against a server speaking the 2026-07-28 protocol.

The `mcp` 2.x line is the only one that can serve or negotiate the 2026-07-28 protocol version, so every test here is
gated on the installed line via `MCP_V2` and skips under the 1.x dependency pin. The `unit-test-mcp-v2` CI job
force-installs the 2.x line over the pin and runs this file against the real package.

The server is `mcp` 2.x's own `MCPServer` running in-process, so no external endpoint or credentials are required:
any 2.x server negotiates 2026-07-28 natively, which is exactly the path `_compat.negotiate_session` exists for.
The 2.x-only server imports stay inside `_build_server` so this module imports cleanly on 1.x and the skip marker
applies.
"""

import itertools
import json
import socket
import threading
import time
from dataclasses import dataclass

import pytest
from mcp.types import ElicitResult

from strands.tools.mcp import MCPClient
from strands.tools.mcp._compat import MCP_V2, streamable_http_transport

pytestmark = pytest.mark.skipif(not MCP_V2, reason="negotiating 2026-07-28 requires the mcp 2.x line")

SERVER_INSTRUCTIONS = "echo tools for integration testing"


@dataclass
class EchoPayload:
    """Typed tool return so the server emits structured content."""

    echoed: str


def _build_server():
    from mcp.server.mcpserver import Context, MCPServer
    from mcp.server.mcpserver.exceptions import ToolError
    from mcp.types import ElicitRequest, ElicitRequestFormParams, InputRequiredResult

    server = MCPServer(name="echo-server", instructions=SERVER_INSTRUCTIONS)

    @server.tool(description="Echoes the input back")
    def echo(to_echo: str) -> str:
        return to_echo

    @server.tool(description="Echoes the input into a structured payload")
    def echo_structured(to_echo: str) -> EchoPayload:
        return EchoPayload(echoed=to_echo)

    @server.tool(description="Always fails")
    def always_fail() -> str:
        # ToolError is the deliberate-failure type whose message the server keeps in the error result; an unexpected
        # exception's text is masked with a generic message.
        raise ToolError("intentional failure")

    def _approval_request() -> ElicitRequest:
        return ElicitRequest(
            method="elicitation/create",
            params=ElicitRequestFormParams(
                mode="form",
                message="Do you approve",
                requested_schema={"type": "object", "properties": {"message": {"type": "string"}}},
            ),
        )

    def _approval_result() -> InputRequiredResult:
        return InputRequiredResult(inputRequests={"approval": _approval_request()}, requestState="approval-round")

    @server.tool(description="Asks the client for approval before answering")
    def ask_approval(ctx: Context):
        if not ctx.input_responses:
            return _approval_result()
        approval = ctx.input_responses["approval"]
        if approval.action != "accept":
            return "not approved"
        return f"approved: {approval.content['message']}"

    @server.prompt(description="Greets a person by name")
    def greeting(name: str) -> str:
        return f"Hello {name}"

    @server.prompt(description="Asks the client for approval before greeting")
    def guarded_greeting(ctx: Context):
        if not ctx.input_responses:
            return _approval_result()
        approval = ctx.input_responses["approval"]
        return f"greeting approved: {approval.content['message']}"

    @server.resource("resource://greeting/{name}", description="Greets a person by name")
    def greeting_resource(name: str) -> str:
        return f"resource for {name}"

    @server.resource("resource://motd", description="A fixed message")
    def motd_resource() -> str:
        return "message of the day"

    @server.resource("resource://guarded/{name}", description="Asks the client for approval before reading")
    def guarded_resource(name: str, ctx: Context):
        if not ctx.input_responses:
            return _approval_result()
        approval = ctx.input_responses["approval"]
        return f"resource approved: {approval.content['message']}"

    grown_tool_ids = itertools.count()

    @server.tool(description="Registers a new tool and announces the change")
    async def grow(ctx: Context) -> str:
        def extra_echo(to_echo: str) -> str:
            return to_echo

        # A unique name each call keeps the test idempotent when the module-scoped server outlives one run.
        grown_name = f"extra_echo_{next(grown_tool_ids)}"
        server.add_tool(extra_echo, name=grown_name, description="Echoes the input back")
        await ctx.notify_tools_changed()
        return grown_name

    return server


def _find_available_port() -> int:
    """Find an available port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        sock.listen(1)
        return sock.getsockname()[1]


def _is_legacy_initialize(body: bytes) -> bool:
    try:
        return json.loads(body).get("method") == "initialize"
    except (ValueError, AttributeError):
        return False


def _refuse_legacy_initialize(app):
    """Wrap the server's ASGI app to refuse the 1.x `initialize` handshake.

    A stock 2.x server still answers a legacy `initialize`, so a client that never negotiates would connect
    anyway. Refusing it makes every test in this file run against a server that only speaks 2026-07-28,
    which is the regression shape https://github.com/strands-agents/harness-sdk/issues/4038 guards against.
    """

    async def refuse_or_forward(scope, receive, send):
        if scope["type"] != "http":
            await app(scope, receive, send)
            return
        received = []
        while True:
            message = await receive()
            received.append(message)
            if message["type"] != "http.request" or not message.get("more_body"):
                break
        body = b"".join(message.get("body", b"") for message in received if message["type"] == "http.request")
        if _is_legacy_initialize(body):
            await send({"type": "http.response.start", "status": 405, "headers": []})
            await send({"type": "http.response.body", "body": b""})
            return
        replay = iter(received)

        async def receive_replayed():
            queued = next(replay, None)
            return queued if queued is not None else await receive()

        await app(scope, receive_replayed, send)

    return refuse_or_forward


def _run_server(port: int) -> None:
    import uvicorn

    app = _refuse_legacy_initialize(_build_server().streamable_http_app())
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="error")


@pytest.fixture(scope="module")
def server_url() -> str:
    port = _find_available_port()
    threading.Thread(target=_run_server, args=(port,), daemon=True).start()
    deadline = time.time() + 15
    while True:
        if time.time() >= deadline:
            pytest.fail(f"server on 127.0.0.1:{port} did not accept connections within 15s")
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                break
        except OSError:
            time.sleep(0.1)
    return f"http://127.0.0.1:{port}/mcp"


def _make_client(server_url: str, **kwargs) -> MCPClient:
    return MCPClient(lambda: streamable_http_transport(url=server_url), **kwargs)


def test_negotiate_with_2026_07_28_server(server_url):
    """Test that the client connects to a 2026-07-28 server and reads its instructions.

    Guards https://github.com/strands-agents/harness-sdk/issues/4038: the fixture server refuses the 1.x
    `initialize` handshake, so connecting at all proves the connect path goes through `server/discover`
    negotiation.
    """
    with _make_client(server_url) as client:
        assert client.server_instructions == SERVER_INSTRUCTIONS


def test_list_tools_and_call_tool(server_url):
    """Test that tools list through the 2.x snake_case schema fields and a plain tools/call round-trips."""
    with _make_client(server_url) as client:
        tools = client.list_tools_sync()
        tool_names = [tool.tool_name for tool in tools]
        assert "echo" in tool_names

        structured_spec = next(tool.tool_spec for tool in tools if tool.tool_name == "echo_structured")
        assert "to_echo" in structured_spec["inputSchema"]["json"]["properties"]
        assert "echoed" in structured_spec["outputSchema"]["json"]["properties"]

        result = client.call_tool_sync(tool_use_id="echo-1", name="echo", arguments={"to_echo": "hello 2.x"})

    assert result["status"] == "success"
    assert result["content"][0]["text"] == "hello 2.x"


def test_call_tool_surfaces_structured_content(server_url):
    """Test that a typed tool result arrives as structured content through the snake_case 2.x fields."""
    with _make_client(server_url) as client:
        result = client.call_tool_sync(
            tool_use_id="structured-1", name="echo_structured", arguments={"to_echo": "typed"}
        )

    assert result["status"] == "success"
    assert result["structuredContent"] == {"echoed": "typed"}


def test_call_tool_maps_error_flag(server_url):
    """Test that a failing tool surfaces as an error result through the 2.x `is_error` field."""
    with _make_client(server_url) as client:
        result = client.call_tool_sync(tool_use_id="fail-1", name="always_fail")

    assert result["status"] == "error"
    assert result["isError"] is True
    assert "intentional failure" in result["content"][0]["text"]


def test_call_tool_drives_input_required_rounds(server_url):
    """Test that a tools/call answered with `InputRequiredResult` resolves through the elicitation callback.

    The 2026-07-28 spec (SEP-2322) pauses the call by returning the embedded input requests instead of sending
    `elicitation/create` mid-call, so this proves the client answers them and retries to a terminal result.
    """

    async def elicitation_callback(_context, params):
        return ElicitResult(action="accept", content={"message": f"server_message=<{params.message}>"})

    with _make_client(server_url, elicitation_callback=elicitation_callback) as client:
        result = client.call_tool_sync(tool_use_id="approval-1", name="ask_approval")

    assert result["status"] == "success"
    assert result["content"][0]["text"] == "approved: server_message=<Do you approve>"


def test_call_tool_without_elicitation_callback_surfaces_error(server_url):
    """Test that an input-required round with no elicitation callback resolves to a clean error result."""
    with _make_client(server_url) as client:
        result = client.call_tool_sync(tool_use_id="approval-2", name="ask_approval")

    assert result["status"] == "error"
    assert "Elicitation not supported" in result["content"][0]["text"]


def test_call_tool_forwards_declined_input(server_url):
    """Test that a declined input request is forwarded to the server, which settles the call itself."""

    async def elicitation_callback(_context, _params):
        return ElicitResult(action="decline")

    with _make_client(server_url, elicitation_callback=elicitation_callback) as client:
        result = client.call_tool_sync(tool_use_id="approval-3", name="ask_approval")

    assert result["status"] == "success"
    assert result["content"][0]["text"] == "not approved"


def test_list_prompts_resources_and_templates(server_url):
    """Test that prompts, resources, and resource templates list on a modern connection."""
    with _make_client(server_url) as client:
        prompt_names = [prompt.name for prompt in client.list_prompts_sync().prompts]
        resource_names = [resource.name for resource in client.list_resources_sync().resources]
        template_uris = [template.uri_template for template in client.list_resource_templates_sync().resource_templates]

    assert "greeting" in prompt_names
    assert "motd_resource" in resource_names
    assert "resource://greeting/{name}" in template_uris


def test_get_prompt(server_url):
    """Test that prompts/get round-trips on a modern connection."""
    with _make_client(server_url) as client:
        result = client.get_prompt_sync("greeting", {"name": "Alice"})

    assert "Hello Alice" in result.messages[0].content.text


def test_read_resource_with_plain_string_uri(server_url):
    """Test that resources/read round-trips, exercising the plain-string URI the 2.x session takes."""
    with _make_client(server_url) as client:
        result = client.read_resource_sync("resource://greeting/Alice")

    assert result.contents[0].text == "resource for Alice"


def test_get_prompt_drives_input_required_rounds(server_url):
    """Test that a prompts/get answered with `InputRequiredResult` resolves through the elicitation callback."""

    async def elicitation_callback(_context, params):
        return ElicitResult(action="accept", content={"message": f"server_message=<{params.message}>"})

    with _make_client(server_url, elicitation_callback=elicitation_callback) as client:
        result = client.get_prompt_sync("guarded_greeting", {})

    assert "greeting approved: server_message=<Do you approve>" in result.messages[0].content.text


def test_read_resource_drives_input_required_rounds(server_url):
    """Test that a resources/read answered with `InputRequiredResult` resolves through the elicitation callback."""

    async def elicitation_callback(_context, params):
        return ElicitResult(action="accept", content={"message": f"server_message=<{params.message}>"})

    with _make_client(server_url, elicitation_callback=elicitation_callback) as client:
        result = client.read_resource_sync("resource://guarded/Alice")

    assert result.contents[0].text == "resource approved: server_message=<Do you approve>"


@pytest.mark.asyncio
async def test_on_tools_changed_refreshes_from_listen_stream(server_url):
    """Test that a modern server's tools list-changed event reaches `on_tools_changed` with the refreshed list.

    Modern servers publish list-changed events only to a `subscriptions/listen` subscriber, so this proves the
    client holds the subscription open and refreshes its loaded tools from the event. `previous_names` carries
    the tools cached by `load_tools`, so the test drives the ToolProvider path rather than `with`-managing the
    client.
    """
    changed = threading.Event()
    seen: dict[str, list[str]] = {}

    def on_tools_changed(previous_names, refreshed_tools):
        seen["previous"] = previous_names
        seen["refreshed"] = [tool.tool_name for tool in refreshed_tools]
        changed.set()

    client = _make_client(server_url, on_tools_changed=on_tools_changed)
    client.add_consumer("test-consumer")
    try:
        await client.load_tools()
        result = await client.call_tool_async(tool_use_id="grow-1", name="grow")
        assert result["status"] == "success"
        grown_name = result["content"][0]["text"]
        assert changed.wait(timeout=10)
    finally:
        client.remove_consumer("test-consumer")

    assert "echo" in seen["previous"]
    assert grown_name not in seen["previous"]
    assert grown_name in seen["refreshed"]
