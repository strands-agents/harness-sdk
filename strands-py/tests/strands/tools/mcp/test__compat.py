"""Unit tests for the mcp 1.x/2.x compatibility layer.

The branch-specific tests patch real attributes of the installed `mcp`
package (never `create=True`, which would invent missing names and pass
against any spelling), so each test is gated on the names it patches
actually existing on the installed line. Late 1.x releases backport the
2.x transport names, so the 2.x-branch transport test runs there too with
the `MCP_V2` flag forced.
"""

import importlib
import inspect
import sys
from base64 import b64encode
from collections.abc import Callable
from contextlib import asynccontextmanager
from datetime import timedelta
from types import ModuleType, SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import mcp.client.streamable_http as streamable_http_module
import pytest

from strands.tools.mcp import _compat
from strands.tools.mcp._compat import MCPError, negotiate_session, streamable_http_transport

requires_mcp_v1 = pytest.mark.skipif(_compat.MCP_V2, reason="exercises the mcp 1.x branch")
requires_mcp_v2 = pytest.mark.skipif(not _compat.MCP_V2, reason="exercises the mcp 2.x line")
requires_v2_transport_names = pytest.mark.skipif(
    not hasattr(streamable_http_module, "streamable_http_client"),
    reason="installed mcp line lacks the 2.x transport names",
)


def test_installed_line_exposes_expected_transport_names():
    """Test that the names each branch imports exist on the line the flag selects.

    Directional on purpose: late 1.x releases backport `streamable_http_client`
    as an alias, so only the branch actually taken is asserted against the
    installed module.
    """
    import mcp.client.streamable_http as streamable_http_module

    if _compat.MCP_V2:
        assert hasattr(streamable_http_module, "streamable_http_client")
        assert hasattr(streamable_http_module, "create_mcp_http_client")
    else:
        assert hasattr(streamable_http_module, "streamablehttp_client")


def test_installed_line_list_methods_accept_params():
    """Test that the session list_* methods accept the `params` keyword on the installed line.

    `MCPClient` passes pagination as `params` only: the `cursor` keyword is
    deprecated on 1.x and removed on 2.x, while `params` exists on both lines
    (added in 1.23.0, the dependency floor).
    """
    from mcp import ClientSession

    for method_name in ("list_tools", "list_prompts", "list_resources", "list_resource_templates"):
        method_parameters = inspect.signature(getattr(ClientSession, method_name)).parameters
        assert "params" in method_parameters, method_name


def test_installed_line_spells_the_accessor_read_fields_as_expected():
    """Test that every model field a `_compat` accessor reads exists on the installed line's models."""
    from mcp.types import (
        BlobResourceContents,
        CallToolResult,
        ImageContent,
        ListResourceTemplatesResult,
        ListToolsResult,
        Tool,
        ToolExecution,
    )

    if _compat.MCP_V2:
        assert "next_cursor" in ListToolsResult.model_fields
        assert "resource_templates" in ListResourceTemplatesResult.model_fields
        assert "task_support" in ToolExecution.model_fields
        assert "is_error" in CallToolResult.model_fields
        assert "structured_content" in CallToolResult.model_fields
        assert "input_schema" in Tool.model_fields
        assert "output_schema" in Tool.model_fields
        assert "mime_type" in ImageContent.model_fields
        assert "mime_type" in BlobResourceContents.model_fields
    else:
        assert "nextCursor" in ListToolsResult.model_fields
        assert "resourceTemplates" in ListResourceTemplatesResult.model_fields
        assert "taskSupport" in ToolExecution.model_fields
        assert "isError" in CallToolResult.model_fields
        assert "structuredContent" in CallToolResult.model_fields
        assert "inputSchema" in Tool.model_fields
        assert "outputSchema" in Tool.model_fields
        assert "mimeType" in ImageContent.model_fields
        assert "mimeType" in BlobResourceContents.model_fields


def test_installed_line_call_tool_takes_the_arguments_mcp_client_passes():
    """Test that the session `call_tool` takes what `MCPClient` passes on the installed line.

    `MCPClient` passes the first three arguments positionally and the timeout
    type differs between the lines, so position, kind, and annotation are
    pinned along with the `read_timeout` conversion that must match it.
    """
    from mcp import ClientSession

    call_tool_parameters = inspect.signature(ClientSession.call_tool).parameters
    for parameter_name in ("progress_callback", "meta"):
        assert parameter_name in call_tool_parameters, parameter_name

    positional = list(call_tool_parameters.values())[1:4]
    assert [parameter.name for parameter in positional] == ["name", "arguments", "read_timeout_seconds"]
    assert all(parameter.kind is inspect.Parameter.POSITIONAL_OR_KEYWORD for parameter in positional)

    expected_timeout_type = float if _compat.MCP_V2 else timedelta
    assert expected_timeout_type.__name__ in str(positional[2].annotation)
    assert isinstance(_compat.read_timeout(timedelta(seconds=30)), expected_timeout_type)


@requires_mcp_v2
def test_installed_v2_line_exposes_the_input_required_names():
    """Test that the names the 2.x `call_tool` branch imports exist on the installed line."""
    from mcp import ClientSession
    from mcp.client import ClientRequestContext, InputRequiredRoundsExceededError
    from mcp.types import InputRequiredResult

    assert issubclass(InputRequiredRoundsExceededError, Exception)
    assert callable(ClientSession.dispatch_input_request)
    assert {"session", "request_id", "meta"} <= set(inspect.signature(ClientRequestContext).parameters)
    assert "input_requests" in InputRequiredResult.model_fields
    call_tool_parameters = inspect.signature(ClientSession.call_tool).parameters
    for parameter_name in ("input_responses", "request_state", "allow_input_required"):
        assert parameter_name in call_tool_parameters, parameter_name


def test_next_cursor_v1_reads_the_camel_case_field(monkeypatch):
    """Test that the 1.x branch reads the result's `nextCursor` field."""
    monkeypatch.setattr(_compat, "MCP_V2", False)

    assert _compat.next_cursor(SimpleNamespace(nextCursor="page-2")) == "page-2"


def test_next_cursor_v2_reads_the_snake_case_field(monkeypatch):
    """Test that the 2.x branch reads the result's `next_cursor` field."""
    monkeypatch.setattr(_compat, "MCP_V2", True)

    assert _compat.next_cursor(SimpleNamespace(next_cursor="page-2")) == "page-2"


def test_resource_templates_v1_reads_the_camel_case_field(monkeypatch):
    """Test that the 1.x branch reads the result's `resourceTemplates` field."""
    monkeypatch.setattr(_compat, "MCP_V2", False)

    assert _compat.resource_templates(SimpleNamespace(resourceTemplates=["template"])) == ["template"]


def test_resource_templates_v2_reads_the_snake_case_field(monkeypatch):
    """Test that the 2.x branch reads the result's `resource_templates` field."""
    monkeypatch.setattr(_compat, "MCP_V2", True)

    assert _compat.resource_templates(SimpleNamespace(resource_templates=["template"])) == ["template"]


def test_task_support_v1_reads_the_camel_case_field(monkeypatch):
    """Test that the 1.x branch reads the tool's `execution.taskSupport` field."""
    monkeypatch.setattr(_compat, "MCP_V2", False)

    assert _compat.task_support(SimpleNamespace(execution=SimpleNamespace(taskSupport="optional"))) == "optional"


def test_task_support_v2_reads_the_snake_case_field(monkeypatch):
    """Test that the 2.x branch reads the tool's `execution.task_support` field."""
    monkeypatch.setattr(_compat, "MCP_V2", True)

    assert _compat.task_support(SimpleNamespace(execution=SimpleNamespace(task_support="optional"))) == "optional"


def test_task_support_returns_none_for_a_tool_without_execution():
    """Test that a tool with no execution block declares no task support level."""
    assert _compat.task_support(SimpleNamespace(execution=None)) is None


def test_is_error_v1_reads_the_camel_case_field(monkeypatch):
    """Test that the 1.x branch reads the result's `isError` field."""
    monkeypatch.setattr(_compat, "MCP_V2", False)

    assert _compat.is_error(SimpleNamespace(isError=True)) is True


def test_is_error_v2_reads_the_snake_case_field(monkeypatch):
    """Test that the 2.x branch reads the result's `is_error` field."""
    monkeypatch.setattr(_compat, "MCP_V2", True)

    assert _compat.is_error(SimpleNamespace(is_error=True)) is True


def test_structured_content_v1_reads_the_camel_case_field(monkeypatch):
    """Test that the 1.x branch reads the result's `structuredContent` field."""
    monkeypatch.setattr(_compat, "MCP_V2", False)

    assert _compat.structured_content(SimpleNamespace(structuredContent={"answer": 42})) == {"answer": 42}


def test_structured_content_v2_reads_the_snake_case_field(monkeypatch):
    """Test that the 2.x branch reads the result's `structured_content` field."""
    monkeypatch.setattr(_compat, "MCP_V2", True)

    assert _compat.structured_content(SimpleNamespace(structured_content={"answer": 42})) == {"answer": 42}


def test_mime_type_v1_reads_the_camel_case_field(monkeypatch):
    """Test that the 1.x branch reads the content's `mimeType` field."""
    monkeypatch.setattr(_compat, "MCP_V2", False)

    assert _compat.mime_type(SimpleNamespace(mimeType="image/png")) == "image/png"


def test_mime_type_v2_reads_the_snake_case_field(monkeypatch):
    """Test that the 2.x branch reads the content's `mime_type` field."""
    monkeypatch.setattr(_compat, "MCP_V2", True)

    assert _compat.mime_type(SimpleNamespace(mime_type="image/png")) == "image/png"


def test_input_schema_v1_reads_the_camel_case_field(monkeypatch):
    """Test that the 1.x branch reads the tool's `inputSchema` field."""
    monkeypatch.setattr(_compat, "MCP_V2", False)

    assert _compat.input_schema(SimpleNamespace(inputSchema={"type": "object"})) == {"type": "object"}


def test_input_schema_v2_reads_the_snake_case_field(monkeypatch):
    """Test that the 2.x branch reads the tool's `input_schema` field."""
    monkeypatch.setattr(_compat, "MCP_V2", True)

    assert _compat.input_schema(SimpleNamespace(input_schema={"type": "object"})) == {"type": "object"}


def test_output_schema_v1_reads_the_camel_case_field(monkeypatch):
    """Test that the 1.x branch reads the tool's `outputSchema` field."""
    monkeypatch.setattr(_compat, "MCP_V2", False)

    assert _compat.output_schema(SimpleNamespace(outputSchema={"type": "object"})) == {"type": "object"}


def test_output_schema_v2_reads_the_snake_case_field(monkeypatch):
    """Test that the 2.x branch reads the tool's `output_schema` field."""
    monkeypatch.setattr(_compat, "MCP_V2", True)

    assert _compat.output_schema(SimpleNamespace(output_schema={"type": "object"})) == {"type": "object"}


def test_read_timeout_v1_passes_the_timedelta_through(monkeypatch):
    """Test that the 1.x branch keeps the timeout as the `timedelta` the session takes."""
    monkeypatch.setattr(_compat, "MCP_V2", False)
    timeout = timedelta(seconds=30)

    assert _compat.read_timeout(timeout) is timeout


def test_read_timeout_v2_converts_to_seconds(monkeypatch):
    """Test that the 2.x branch converts the timeout to the float of seconds the session takes."""
    monkeypatch.setattr(_compat, "MCP_V2", True)

    assert _compat.read_timeout(timedelta(seconds=30)) == 30.0


def test_read_timeout_passes_none_through():
    """Test that an absent timeout stays absent on either line."""
    assert _compat.read_timeout(None) is None


@pytest.mark.asyncio
async def test_call_tool_v1_sends_a_single_request(monkeypatch):
    """Test that the 1.x branch calls the session once, with the timeout as a `timedelta`."""
    monkeypatch.setattr(_compat, "MCP_V2", False)
    terminal_result = MagicMock()
    session = MagicMock()
    session.call_tool = AsyncMock(return_value=terminal_result)
    progress_callback = MagicMock()
    timeout = timedelta(seconds=30)

    result = await _compat.call_tool(session, "echo", {"to_echo": "x"}, timeout, progress_callback, {"trace": "id"})

    assert result is terminal_result
    session.call_tool.assert_awaited_once_with(
        "echo", {"to_echo": "x"}, timeout, progress_callback=progress_callback, meta={"trace": "id"}
    )


@requires_mcp_v2
@pytest.mark.asyncio
async def test_call_tool_v2_returns_a_terminal_result_without_retrying():
    """Test that the 2.x branch opts into input-required results and returns a terminal result as-is."""
    from mcp.types import CallToolResult, TextContent

    terminal_result = CallToolResult(content=[TextContent(type="text", text="done")])
    session = MagicMock()
    session.call_tool = AsyncMock(return_value=terminal_result)
    progress_callback = MagicMock()

    result = await _compat.call_tool(
        session, "echo", {"to_echo": "x"}, timedelta(seconds=30), progress_callback, {"trace": "id"}
    )

    assert result is terminal_result
    session.call_tool.assert_awaited_once_with(
        "echo",
        {"to_echo": "x"},
        30.0,
        progress_callback=progress_callback,
        meta={"trace": "id"},
        input_responses=None,
        request_state=None,
        allow_input_required=True,
    )


@requires_mcp_v2
@pytest.mark.asyncio
async def test_call_tool_v2_resolves_input_required_through_the_callback_table():
    """Test that the 2.x branch resolves an `InputRequiredResult` and retries with the responses.

    The embedded elicit request must reach `dispatch_input_request` (the same
    callback table that serves 1.x server-initiated requests), and the retry
    must carry the collected responses and the echoed `request_state`.
    """
    from mcp.types import (
        CallToolResult,
        ElicitRequest,
        ElicitRequestFormParams,
        ElicitResult,
        InputRequiredResult,
        TextContent,
    )

    elicit_request = ElicitRequest(
        method="elicitation/create",
        params=ElicitRequestFormParams(
            mode="form",
            message="need a value",
            requested_schema={"type": "object", "properties": {"value": {"type": "string"}}},
        ),
    )
    input_required = InputRequiredResult(input_requests={"q1": elicit_request}, request_state="state-1")
    terminal_result = CallToolResult(content=[TextContent(type="text", text="done")])
    elicit_result = ElicitResult(action="accept", content={"value": "x"})
    session = MagicMock()
    session.call_tool = AsyncMock(side_effect=[input_required, terminal_result])
    session.dispatch_input_request = AsyncMock(return_value=elicit_result)

    result = await _compat.call_tool(session, "ask", None, None, None, None)

    assert result is terminal_result
    dispatched_request = session.dispatch_input_request.await_args.args[1]
    assert dispatched_request is elicit_request
    retry_kwargs = session.call_tool.await_args_list[1].kwargs
    assert retry_kwargs["input_responses"] == {"q1": elicit_result}
    assert retry_kwargs["request_state"] == "state-1"


@requires_mcp_v2
@pytest.mark.asyncio
async def test_call_tool_v2_retries_without_request_state_when_the_server_sent_none():
    """Test that a retry carries no `request_state` when the `InputRequiredResult` had none.

    The MRTR spec: "If the `InputRequiredResult` does not contain a
    `requestState` field, the client MUST NOT include one in the retry."
    """
    from mcp.types import (
        CallToolResult,
        ElicitRequest,
        ElicitRequestFormParams,
        ElicitResult,
        InputRequiredResult,
        TextContent,
    )

    elicit_request = ElicitRequest(
        method="elicitation/create",
        params=ElicitRequestFormParams(
            mode="form",
            message="need a value",
            requested_schema={"type": "object", "properties": {"value": {"type": "string"}}},
        ),
    )
    input_required = InputRequiredResult(input_requests={"q1": elicit_request})
    terminal_result = CallToolResult(content=[TextContent(type="text", text="done")])
    session = MagicMock()
    session.call_tool = AsyncMock(side_effect=[input_required, terminal_result])
    session.dispatch_input_request = AsyncMock(return_value=ElicitResult(action="accept", content={"value": "x"}))

    result = await _compat.call_tool(session, "ask", None, None, None, None)

    assert result is terminal_result
    retry_kwargs = session.call_tool.await_args_list[1].kwargs
    assert retry_kwargs["request_state"] is None


@requires_mcp_v2
@pytest.mark.asyncio
async def test_call_tool_v2_polls_after_a_state_only_result(monkeypatch):
    """Test that a result with only a `request_state` waits, then retries carrying no responses.

    A state-only `InputRequiredResult` asks the client to poll: there is nothing
    to dispatch, so the retry must send `input_responses=None` rather than an
    empty map, and must not hammer the server.
    """
    from mcp.types import CallToolResult, InputRequiredResult, TextContent

    terminal_result = CallToolResult(content=[TextContent(type="text", text="done")])
    session = MagicMock()
    session.call_tool = AsyncMock(side_effect=[InputRequiredResult(request_state="state-1"), terminal_result])
    session.dispatch_input_request = AsyncMock()
    sleep = AsyncMock()
    monkeypatch.setattr("asyncio.sleep", sleep)

    result = await _compat.call_tool(session, "ask", None, None, None, None)

    assert result is terminal_result
    session.dispatch_input_request.assert_not_awaited()
    sleep.assert_awaited_once_with(_compat._STATE_ONLY_RETRY_DELAY_SECONDS)
    retry_kwargs = session.call_tool.await_args_list[1].kwargs
    assert retry_kwargs["input_responses"] is None
    assert retry_kwargs["request_state"] == "state-1"


@requires_mcp_v2
@pytest.mark.asyncio
async def test_call_tool_v2_dispatches_each_request_under_its_own_key():
    """Test that each embedded request dispatches with its server key and its own `_meta`, if any."""
    from mcp.types import (
        CallToolResult,
        ElicitRequest,
        ElicitRequestFormParams,
        ElicitResult,
        InputRequiredResult,
        ListRootsRequest,
        ListRootsResult,
        TextContent,
    )

    elicit_request = ElicitRequest(
        method="elicitation/create",
        params=ElicitRequestFormParams(
            mode="form",
            message="need a value",
            requested_schema={"type": "object", "properties": {}},
            _meta={"traceparent": "tp"},
        ),
    )
    roots_request = ListRootsRequest(method="roots/list")
    input_required = InputRequiredResult(input_requests={"q1": elicit_request, "r1": roots_request})
    terminal_result = CallToolResult(content=[TextContent(type="text", text="done")])
    session = MagicMock()
    session.call_tool = AsyncMock(side_effect=[input_required, terminal_result])
    session.dispatch_input_request = AsyncMock(
        side_effect=lambda context, request: (
            ElicitResult(action="accept", content={"value": "x"})
            if isinstance(request, ElicitRequest)
            else ListRootsResult(roots=[])
        )
    )

    result = await _compat.call_tool(session, "ask", None, None, None, None)

    assert result is terminal_result
    dispatched = {call.args[0].request_id: call.args[0] for call in session.dispatch_input_request.await_args_list}
    assert dispatched.keys() == {"q1", "r1"}
    assert dispatched["q1"].meta == {"traceparent": "tp"}
    assert dispatched["r1"].meta is None


@requires_mcp_v2
@pytest.mark.asyncio
async def test_call_tool_v2_raises_when_a_callback_declines_an_input_request():
    """Test that a declined embedded request aborts the call as an `MCPError`."""
    from mcp.types import ElicitRequest, ElicitRequestFormParams, ErrorData, InputRequiredResult

    elicit_request = ElicitRequest(
        method="elicitation/create",
        params=ElicitRequestFormParams(
            mode="form",
            message="need a value",
            requested_schema={"type": "object", "properties": {}},
        ),
    )
    session = MagicMock()
    session.call_tool = AsyncMock(return_value=InputRequiredResult(input_requests={"q1": elicit_request}))
    session.dispatch_input_request = AsyncMock(return_value=ErrorData(code=-32601, message="Elicitation not supported"))

    with pytest.raises(MCPError, match="Elicitation not supported"):
        await _compat.call_tool(session, "ask", None, None, None, None)

    session.call_tool.assert_awaited_once()


@requires_mcp_v2
@pytest.mark.asyncio
async def test_call_tool_v2_stops_after_the_round_cap():
    """Test that a server returning `InputRequiredResult` forever fails instead of looping."""
    from mcp.client import InputRequiredRoundsExceededError
    from mcp.types import ElicitRequest, ElicitRequestFormParams, ElicitResult, InputRequiredResult

    elicit_request = ElicitRequest(
        method="elicitation/create",
        params=ElicitRequestFormParams(
            mode="form",
            message="need a value",
            requested_schema={"type": "object", "properties": {}},
        ),
    )
    session = MagicMock()
    session.call_tool = AsyncMock(return_value=InputRequiredResult(input_requests={"q1": elicit_request}))
    session.dispatch_input_request = AsyncMock(return_value=ElicitResult(action="accept", content={}))

    with pytest.raises(InputRequiredRoundsExceededError):
        await _compat.call_tool(session, "ask", None, None, None, None)

    # The initial call plus one retry for each allowed round.
    assert session.call_tool.await_count == 11


@requires_mcp_v2
@pytest.mark.asyncio
async def test_call_tool_v2_returns_a_terminal_result_from_the_last_allowed_round():
    """Test that a terminal result on the last allowed retry is returned, not read as an overrun."""
    from mcp.types import (
        CallToolResult,
        ElicitRequest,
        ElicitRequestFormParams,
        ElicitResult,
        InputRequiredResult,
        TextContent,
    )

    elicit_request = ElicitRequest(
        method="elicitation/create",
        params=ElicitRequestFormParams(
            mode="form", message="need a value", requested_schema={"type": "object", "properties": {}}
        ),
    )
    input_required = InputRequiredResult(input_requests={"q1": elicit_request})
    terminal_result = CallToolResult(content=[TextContent(type="text", text="done")])
    session = MagicMock()
    # Input-required for every allowed round, terminal on the last retry.
    session.call_tool = AsyncMock(side_effect=[input_required] * 10 + [terminal_result])
    session.dispatch_input_request = AsyncMock(return_value=ElicitResult(action="accept", content={}))

    result = await _compat.call_tool(session, "ask", None, None, None, None)

    assert result is terminal_result
    assert session.call_tool.await_count == 11


@pytest.mark.asyncio
async def test_get_prompt_v1_sends_a_single_request(monkeypatch):
    """Test that the 1.x branch calls the session once, with no retry keywords."""
    monkeypatch.setattr(_compat, "MCP_V2", False)
    terminal_result = MagicMock()
    session = MagicMock()
    session.get_prompt = AsyncMock(return_value=terminal_result)

    result = await _compat.get_prompt(session, "greet", {"name": "x"})

    assert result is terminal_result
    session.get_prompt.assert_awaited_once_with("greet", arguments={"name": "x"})


@pytest.mark.asyncio
async def test_read_resource_v1_sends_a_single_request(monkeypatch):
    """Test that the 1.x branch calls the session once, passing the URI object through untouched."""
    monkeypatch.setattr(_compat, "MCP_V2", False)
    terminal_result = MagicMock()
    session = MagicMock()
    session.read_resource = AsyncMock(return_value=terminal_result)
    resource_uri = MagicMock()

    result = await _compat.read_resource(session, resource_uri)

    assert result is terminal_result
    session.read_resource.assert_awaited_once_with(resource_uri)


@requires_mcp_v2
@pytest.mark.asyncio
async def test_get_prompt_v2_resolves_input_required_through_the_callback_table():
    """Test that the 2.x branch resolves an `InputRequiredResult` from `prompts/get` and retries."""
    from mcp.types import (
        ElicitRequest,
        ElicitRequestFormParams,
        ElicitResult,
        GetPromptResult,
        InputRequiredResult,
    )

    elicit_request = ElicitRequest(
        method="elicitation/create",
        params=ElicitRequestFormParams(
            mode="form",
            message="need a value",
            requested_schema={"type": "object", "properties": {"value": {"type": "string"}}},
        ),
    )
    input_required = InputRequiredResult(input_requests={"q1": elicit_request}, request_state="state-1")
    terminal_result = GetPromptResult(messages=[])
    elicit_result = ElicitResult(action="accept", content={"value": "x"})
    session = MagicMock()
    session.get_prompt = AsyncMock(side_effect=[input_required, terminal_result])
    session.dispatch_input_request = AsyncMock(return_value=elicit_result)

    result = await _compat.get_prompt(session, "greet", {"name": "x"})

    assert result is terminal_result
    first_kwargs = session.get_prompt.await_args_list[0].kwargs
    assert first_kwargs["allow_input_required"] is True
    retry_kwargs = session.get_prompt.await_args_list[1].kwargs
    assert retry_kwargs["input_responses"] == {"q1": elicit_result}
    assert retry_kwargs["request_state"] == "state-1"


@requires_mcp_v2
@pytest.mark.asyncio
async def test_read_resource_v2_resolves_input_required_and_sends_a_string_uri():
    """Test that the 2.x branch retries an `InputRequiredResult` from `resources/read` with a plain-string URI."""
    from mcp.types import (
        ElicitRequest,
        ElicitRequestFormParams,
        ElicitResult,
        InputRequiredResult,
        ReadResourceResult,
    )
    from pydantic import AnyUrl

    elicit_request = ElicitRequest(
        method="elicitation/create",
        params=ElicitRequestFormParams(
            mode="form", message="need a value", requested_schema={"type": "object", "properties": {}}
        ),
    )
    input_required = InputRequiredResult(input_requests={"q1": elicit_request}, request_state="state-1")
    terminal_result = ReadResourceResult(contents=[])
    elicit_result = ElicitResult(action="accept", content={})
    session = MagicMock()
    session.read_resource = AsyncMock(side_effect=[input_required, terminal_result])
    session.dispatch_input_request = AsyncMock(return_value=elicit_result)
    resource_uri = AnyUrl("resource://server/thing")

    result = await _compat.read_resource(session, resource_uri)

    assert result is terminal_result
    first_call = session.read_resource.await_args_list[0]
    assert first_call.args[0] == str(resource_uri)
    assert first_call.kwargs["allow_input_required"] is True
    retry_kwargs = session.read_resource.await_args_list[1].kwargs
    assert retry_kwargs["input_responses"] == {"q1": elicit_result}
    assert retry_kwargs["request_state"] == "state-1"


def test_mcp_error_resolves_to_installed_exception():
    """Test that MCPError is the mcp package's error type regardless of its spelling."""
    import mcp.shared.exceptions as mcp_exceptions

    installed = getattr(mcp_exceptions, "MCPError", None) or mcp_exceptions.McpError
    assert MCPError is installed


def test_get_session_id_callback_falls_back_to_plain_callable(monkeypatch):
    """Test that `GetSessionIdCallback` degrades to a plain callable alias when the name is absent.

    Reloads `_compat` with the name deleted from the installed transport
    module to exercise the 2.x fallback on either line, then reloads again so
    later tests see the module as built against the real environment.
    """
    monkeypatch.delattr(streamable_http_module, "GetSessionIdCallback", raising=False)
    try:
        reloaded = importlib.reload(_compat)
        assert reloaded.GetSessionIdCallback == Callable[[], str | None]
    finally:
        monkeypatch.undo()
        importlib.reload(_compat)


@requires_mcp_v2
def test_installed_v2_line_exposes_negotiate_auto():
    """Test that the negotiation policy `negotiate_session` imports exists on the 2.x line."""
    from mcp.client.client import negotiate_auto

    assert callable(negotiate_auto)


@requires_mcp_v2
def test_installed_v2_session_exposes_negotiation_attributes():
    """Test that the session attributes the 2.x negotiation branch reads exist on the real ClientSession."""
    from mcp import ClientSession

    assert hasattr(ClientSession, "instructions")
    assert hasattr(ClientSession, "server_capabilities")


@pytest.mark.asyncio
async def test_negotiate_session_v1_runs_the_initialize_handshake(monkeypatch):
    """Test that the 1.x handshake is initialize(), with instructions read from its result."""
    monkeypatch.setattr(_compat, "MCP_V2", False)
    server_capabilities = MagicMock()
    session = MagicMock()
    session.initialize = AsyncMock(return_value=MagicMock(instructions="use the tools"))
    session.get_server_capabilities = MagicMock(return_value=server_capabilities)

    instructions, capabilities = await negotiate_session(session)

    session.initialize.assert_awaited_once_with()
    assert instructions == "use the tools"
    assert capabilities is server_capabilities


@pytest.mark.asyncio
async def test_negotiate_session_v2_negotiates_and_reads_session_properties(monkeypatch):
    """Test that the 2.x handshake delegates to negotiate_auto and reads the session properties.

    The `mcp.client.client` module exists only on the 2.x line, so a stub
    module stands in for it to exercise this branch under the 1.x pin.
    """
    monkeypatch.setattr(_compat, "MCP_V2", True)
    negotiate_auto = AsyncMock()
    client_module = ModuleType("mcp.client.client")
    client_module.negotiate_auto = negotiate_auto  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "mcp.client.client", client_module)
    server_capabilities = MagicMock()
    session = MagicMock()
    session.instructions = "use the tools"
    session.server_capabilities = server_capabilities

    instructions, capabilities = await negotiate_session(session)

    negotiate_auto.assert_awaited_once_with(session)
    session.initialize.assert_not_called()
    assert instructions == "use the tools"
    assert capabilities is server_capabilities


@requires_mcp_v1
def test_streamable_http_transport_v1_call_shape():
    """Test that the 1.x transport receives url, headers, and auth as loose kwargs."""
    headers = {"Authorization": "Bearer token"}
    auth = MagicMock()

    with patch("mcp.client.streamable_http.streamablehttp_client") as mock_client:
        result = streamable_http_transport("https://example.com/mcp", headers=headers, auth=auth)

        mock_client.assert_called_once_with(url="https://example.com/mcp", headers=headers, auth=auth)
        assert result is mock_client.return_value


@requires_v2_transport_names
@pytest.mark.asyncio
async def test_streamable_http_transport_v2_owns_client_lifecycle(monkeypatch):
    """Test that the 2.x transport closes the HTTPX client it creates.

    Guards https://github.com/strands-agents/harness-sdk/pull/3708: 2.x's
    `streamable_http_client` only closes a client it created itself, so the
    adapter must bind the client's lifetime to the transport's.
    """
    monkeypatch.setattr(_compat, "MCP_V2", True)
    lifecycle_events = []
    transport_streams = MagicMock()
    auth = MagicMock()

    @asynccontextmanager
    async def fake_http_client(headers=None, auth=None):
        lifecycle_events.append(("client_enter", headers, auth))
        yield MagicMock()
        lifecycle_events.append(("client_exit", headers, auth))

    @asynccontextmanager
    async def fake_transport(url, http_client):
        lifecycle_events.append(("transport_enter", url))
        yield transport_streams
        lifecycle_events.append(("transport_exit", url))

    headers = {"Authorization": "Bearer token"}
    with (
        patch("mcp.client.streamable_http.create_mcp_http_client", fake_http_client),
        patch("mcp.client.streamable_http.streamable_http_client", fake_transport),
    ):
        async with streamable_http_transport("https://example.com/mcp", headers=headers, auth=auth) as streams:
            assert streams is transport_streams

    assert lifecycle_events == [
        ("client_enter", headers, auth),
        ("transport_enter", "https://example.com/mcp"),
        ("transport_exit", "https://example.com/mcp"),
        ("client_exit", headers, auth),
    ]


@requires_mcp_v2
@requires_v2_transport_names
@pytest.mark.asyncio
async def test_streamable_http_transport_v2_adapts_httpx_auth(monkeypatch):
    """Test that the 2.x transport hands its HTTPX client an `httpx2.Auth` when given an `httpx.Auth`.

    The 2.x transport names alone don't imply httpx2 is installed: late 1.x wheels expose them too, so wrapping a
    real `httpx.Auth` here also needs the 2.x install.
    """
    import httpx2

    monkeypatch.setattr(_compat, "MCP_V2", True)
    captured = {}

    @asynccontextmanager
    async def fake_http_client(headers=None, auth=None):
        captured["auth"] = auth
        yield MagicMock()

    @asynccontextmanager
    async def fake_transport(url, http_client):
        yield MagicMock()

    with (
        patch("mcp.client.streamable_http.create_mcp_http_client", fake_http_client),
        patch("mcp.client.streamable_http.streamable_http_client", fake_transport),
    ):
        async with streamable_http_transport("https://example.com/mcp", auth=httpx.BasicAuth("user", "pass")):
            pass

    assert isinstance(captured["auth"], httpx2.Auth)


def test_is_tools_list_changed_accepts_both_delivery_shapes():
    """Test that both message-handler delivery shapes are recognized.

    The 1.x session wraps the notification in `ServerNotification`; the 2.x
    session delivers it bare, including events teed from a
    `subscriptions/listen` stream. The wrapper is constructible only on the
    1.x line (2.x spells `ServerNotification` as a plain union), so the real
    wrapped shape is asserted there and a stand-in with the same `root`
    attribute everywhere.
    """
    from mcp.types import ToolListChangedNotification

    notification = ToolListChangedNotification(method="notifications/tools/list_changed")

    assert _compat.is_tools_list_changed(notification)
    assert _compat.is_tools_list_changed(SimpleNamespace(root=notification))
    if not _compat.MCP_V2:
        from mcp.types import ServerNotification

        assert _compat.is_tools_list_changed(ServerNotification(notification))


def test_is_tools_list_changed_rejects_other_messages():
    """Test that unrelated messages and exceptions are not treated as tool list changes."""
    assert not _compat.is_tools_list_changed("normal message")
    assert not _compat.is_tools_list_changed(Exception("boom"))
    assert not _compat.is_tools_list_changed(SimpleNamespace(root="not a notification"))


@requires_mcp_v2
def test_installed_v2_line_exposes_the_subscriptions_names():
    """Test that the names the 2.x subscription branch imports exist on the installed line."""
    from contextlib import AbstractAsyncContextManager

    from mcp.client.subscriptions import ListenNotSupportedError, listen

    assert issubclass(ListenNotSupportedError, Exception)
    assert "tools_list_changed" in inspect.signature(listen).parameters
    # Creating the context manager defers the body, so no session traffic happens here.
    assert isinstance(listen(MagicMock(), tools_list_changed=True), AbstractAsyncContextManager)


@pytest.mark.asyncio
async def test_tools_changed_subscription_v1_yields_none(monkeypatch):
    """Test that the 1.x branch holds no subscription: the server pushes notifications unprompted."""
    monkeypatch.setattr(_compat, "MCP_V2", False)

    async with _compat.tools_changed_subscription(MagicMock()) as subscription:
        assert subscription is None


@pytest.mark.asyncio
async def test_tools_changed_subscription_v2_holds_the_listen_stream(monkeypatch):
    """Test that the 2.x branch opens `subscriptions/listen` for tool changes and closes it on exit.

    The `mcp.client.subscriptions` module exists only on the 2.x line, so a
    stub module stands in for it to exercise this branch under the 1.x pin.
    """
    monkeypatch.setattr(_compat, "MCP_V2", True)
    lifecycle_events = []
    stream = MagicMock()
    session = MagicMock()

    @asynccontextmanager
    async def fake_listen(listen_session, *, tools_list_changed):
        lifecycle_events.append(("enter", listen_session, tools_list_changed))
        yield stream
        lifecycle_events.append(("exit",))

    subscriptions_module = ModuleType("mcp.client.subscriptions")
    subscriptions_module.listen = fake_listen  # type: ignore[attr-defined]
    subscriptions_module.ListenNotSupportedError = type("ListenNotSupportedError", (RuntimeError,), {})  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "mcp.client.subscriptions", subscriptions_module)

    async with _compat.tools_changed_subscription(session) as subscription:
        assert subscription is stream
        assert lifecycle_events == [("enter", session, True)]

    assert lifecycle_events == [("enter", session, True), ("exit",)]


@pytest.mark.asyncio
async def test_tools_changed_subscription_v2_degrades_on_a_legacy_connection(monkeypatch):
    """Test that a connection whose negotiated version predates `subscriptions/listen` yields None."""
    monkeypatch.setattr(_compat, "MCP_V2", True)

    listen_not_supported = type("ListenNotSupportedError", (RuntimeError,), {})

    @asynccontextmanager
    async def fake_listen(listen_session, *, tools_list_changed):
        raise listen_not_supported("negotiated version predates 2026-07-28")
        yield

    subscriptions_module = ModuleType("mcp.client.subscriptions")
    subscriptions_module.listen = fake_listen  # type: ignore[attr-defined]
    subscriptions_module.ListenNotSupportedError = listen_not_supported  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "mcp.client.subscriptions", subscriptions_module)

    async with _compat.tools_changed_subscription(MagicMock()) as subscription:
        assert subscription is None


@requires_mcp_v2
def test_wrap_auth_passes_through_httpx2_auth_and_non_auth_values():
    """Test that httpx2-native auth objects and non-`httpx.Auth` values are not wrapped."""
    import httpx2

    native_auth = httpx2.BasicAuth(username="user", password="pass")
    opaque_auth = MagicMock()

    assert _compat._wrap_auth_for_httpx2(native_auth) is native_auth
    assert _compat._wrap_auth_for_httpx2(opaque_auth) is opaque_auth
    assert _compat._wrap_auth_for_httpx2(None) is None


@requires_mcp_v2
@pytest.mark.asyncio
async def test_wrap_auth_adapts_httpx_auth_to_httpx2_request():
    """Test that a wrapped `httpx.Auth` applies its headers to the httpx2 request it is driven with."""
    import httpx2

    adapted = _compat._wrap_auth_for_httpx2(httpx.BasicAuth(username="user", password="pass"))
    assert isinstance(adapted, httpx2.Auth)

    request = httpx2.Request("POST", "https://example.com/mcp", headers={"x-existing": "kept"})
    flow = adapted.async_auth_flow(request)

    sent_request = await flow.__anext__()
    tru_headers = (sent_request.headers.get("authorization"), sent_request.headers.get("x-existing"))
    exp_headers = (f"Basic {b64encode(b'user:pass').decode()}", "kept")
    assert tru_headers == exp_headers

    with pytest.raises(StopAsyncIteration):
        await flow.asend(httpx2.Response(200, request=sent_request))


@requires_mcp_v2
@pytest.mark.asyncio
async def test_wrap_auth_forwards_responses_to_multi_round_flows():
    """Test that a retry-on-401 `httpx.Auth` flow sees the httpx2 response and re-sends with new headers."""
    import httpx2

    class RetryOn401Auth(httpx.Auth):
        def auth_flow(self, request):
            request.headers["authorization"] = "Bearer stale"
            response = yield request
            if response.status_code == 401:
                request.headers["authorization"] = "Bearer refreshed"
                yield request

    adapted = _compat._wrap_auth_for_httpx2(RetryOn401Auth())
    request = httpx2.Request("POST", "https://example.com/mcp")
    flow = adapted.async_auth_flow(request)

    first_request = await flow.__anext__()
    assert first_request.headers["authorization"] == "Bearer stale"

    second_request = await flow.asend(httpx2.Response(401, request=first_request))
    assert second_request.headers["authorization"] == "Bearer refreshed"

    with pytest.raises(StopAsyncIteration):
        await flow.asend(httpx2.Response(200, request=second_request))


@requires_mcp_v2
@pytest.mark.asyncio
async def test_wrap_auth_feeds_bodies_to_body_hungry_flows():
    """Test that the adapter reads the httpx2 request and response bodies for an auth that requires them."""
    import httpx2

    class SigningAuth(httpx.Auth):
        requires_request_body = True
        requires_response_body = True

        def auth_flow(self, request):
            request.headers["x-request-digest"] = request.content.decode()
            response = yield request
            request.headers["x-response-echo"] = response.content.decode()
            yield request

    adapted = _compat._wrap_auth_for_httpx2(SigningAuth())
    request = httpx2.Request("POST", "https://example.com/mcp", content=b"payload")
    flow = adapted.async_auth_flow(request)

    first_request = await flow.__anext__()
    assert first_request.headers["x-request-digest"] == "payload"

    second_request = await flow.asend(httpx2.Response(401, content=b"denied", request=first_request))
    assert second_request.headers["x-response-echo"] == "denied"

    with pytest.raises(StopAsyncIteration):
        await flow.asend(httpx2.Response(200, request=second_request))


@requires_mcp_v2
@pytest.mark.asyncio
async def test_wrap_auth_sends_flow_issued_requests_as_their_own_requests():
    """Test that a flow step aimed at another URL is sent as that request, not as the original one.

    Guards https://github.com/strands-agents/harness-sdk/pull/4183#issuecomment-5546187576: httpx's token-refresh
    pattern yields a request the flow built itself, which must reach its own target with its own body instead of
    being folded into the request bound for the MCP server.
    """
    import httpx2

    class RefreshAuth(httpx.Auth):
        requires_response_body = True

        def auth_flow(self, request):
            token_response = yield httpx.Request("POST", "https://idp.example.com/token", content=b"grant")
            request.headers["authorization"] = f"Bearer {token_response.text}"
            yield request

    adapted = _compat._wrap_auth_for_httpx2(RefreshAuth())
    request = httpx2.Request("POST", "https://example.com/mcp", content=b'{"jsonrpc": "2.0"}')
    flow = adapted.async_auth_flow(request)

    refresh_request = await flow.__anext__()
    tru_refresh = (refresh_request is request, str(refresh_request.url), refresh_request.read())
    exp_refresh = (False, "https://idp.example.com/token", b"grant")
    assert tru_refresh == exp_refresh

    retried_request = await flow.asend(httpx2.Response(200, content=b"fresh", request=refresh_request))
    tru_retry = (retried_request is request, str(retried_request.url), retried_request.headers["authorization"])
    exp_retry = (True, "https://example.com/mcp", "Bearer fresh")
    assert tru_retry == exp_retry

    with pytest.raises(StopAsyncIteration):
        await flow.asend(httpx2.Response(200, request=retried_request))


@requires_mcp_v2
@pytest.mark.asyncio
async def test_wrap_auth_applies_url_changes_to_the_original_request():
    """Test that a flow that adds a query parameter to the request URL sees it on the outgoing request."""
    import httpx2

    class QueryParamAuth(httpx.Auth):
        def auth_flow(self, request):
            request.url = request.url.copy_add_param("api_key", "secret")
            yield request

    adapted = _compat._wrap_auth_for_httpx2(QueryParamAuth())
    request = httpx2.Request("POST", "https://example.com/mcp")
    flow = adapted.async_auth_flow(request)

    sent_request = await flow.__anext__()
    tru_sent = (sent_request is request, str(sent_request.url))
    exp_sent = (True, "https://example.com/mcp?api_key=secret")
    assert tru_sent == exp_sent

    with pytest.raises(StopAsyncIteration):
        await flow.asend(httpx2.Response(200, request=sent_request))


@requires_mcp_v2
@pytest.mark.asyncio
async def test_wrap_auth_strips_wire_framing_headers_from_translated_responses():
    """Test that a body-reading flow sees the decoded body without the stale `content-encoding` header.

    Guards https://github.com/strands-agents/harness-sdk/pull/4183#issuecomment-5546187576: the adapter hands the
    flow an already-decoded body, so keeping the framing headers would make httpx decode it a second time.
    """
    import gzip

    import httpx2

    seen_responses = []

    class BodyReadingAuth(httpx.Auth):
        requires_response_body = True

        def auth_flow(self, request):
            response = yield request
            seen_responses.append((response.content, response.headers.get("content-encoding")))
            yield request

    adapted = _compat._wrap_auth_for_httpx2(BodyReadingAuth())
    request = httpx2.Request("POST", "https://example.com/mcp")
    flow = adapted.async_auth_flow(request)

    first_request = await flow.__anext__()
    gzipped_response = httpx2.Response(
        401, headers={"content-encoding": "gzip"}, content=gzip.compress(b"denied"), request=first_request
    )
    second_request = await flow.asend(gzipped_response)

    with pytest.raises(StopAsyncIteration):
        await flow.asend(httpx2.Response(200, request=second_request))

    assert seen_responses == [(b"denied", None)]


@requires_mcp_v2
@pytest.mark.asyncio
async def test_wrap_auth_hands_loaded_request_bodies_to_the_flow():
    """Test that a flow reading `request.content` without `requires_request_body` sees an already-loaded body."""
    import httpx2

    class ContentReadingAuth(httpx.Auth):
        def auth_flow(self, request):
            request.headers["x-content-length"] = str(len(request.content))
            yield request

    adapted = _compat._wrap_auth_for_httpx2(ContentReadingAuth())
    request = httpx2.Request("POST", "https://example.com/mcp", content=b"payload")
    await request.aread()
    flow = adapted.async_auth_flow(request)

    sent_request = await flow.__anext__()
    assert sent_request.headers["x-content-length"] == "7"

    await flow.aclose()


@requires_mcp_v2
@pytest.mark.asyncio
async def test_wrap_auth_leaves_streaming_request_bodies_unread():
    """Test that the adapter does not consume a streaming body for a flow that does not require it."""
    import httpx2

    class HeaderOnlyAuth(httpx.Auth):
        def auth_flow(self, request):
            request.headers["authorization"] = "Bearer token"
            yield request

    async def body_stream():
        yield b"streamed"

    adapted = _compat._wrap_auth_for_httpx2(HeaderOnlyAuth())
    request = httpx2.Request("POST", "https://example.com/mcp", content=body_stream())
    flow = adapted.async_auth_flow(request)

    sent_request = await flow.__anext__()
    tru_sent = (sent_request is request, sent_request.headers["authorization"])
    exp_sent = (True, "Bearer token")
    assert tru_sent == exp_sent

    with pytest.raises(httpx2.RequestNotRead):
        _ = sent_request.content

    with pytest.raises(StopAsyncIteration):
        await flow.asend(httpx2.Response(200, request=sent_request))


@requires_mcp_v2
@pytest.mark.asyncio
async def test_wrap_auth_closes_the_wrapped_flow_on_close():
    """Test that closing the adapter's flow runs the wrapped flow's cleanup immediately."""
    import httpx2

    cleanup_events = []

    class CleanupAuth(httpx.Auth):
        def auth_flow(self, request):
            try:
                yield request
            finally:
                cleanup_events.append("closed")

    adapted = _compat._wrap_auth_for_httpx2(CleanupAuth())
    flow = adapted.async_auth_flow(httpx2.Request("POST", "https://example.com/mcp"))
    await flow.__anext__()
    await flow.aclose()

    assert cleanup_events == ["closed"]


@requires_mcp_v2
@pytest.mark.asyncio
async def test_wrap_auth_drives_a_real_httpx2_client_end_to_end():
    """Test that a wrapped refresh-style auth completes a 401-refresh-retry round through a real httpx2 client."""
    import httpx2

    class RefreshAuth(httpx.Auth):
        requires_response_body = True

        def auth_flow(self, request):
            response = yield request
            if response.status_code == 401:
                token_response = yield httpx.Request("POST", "https://idp.example.com/token")
                request.headers["authorization"] = f"Bearer {token_response.text}"
                yield request

    transport_requests = []

    def transport_handler(mock_request):
        transport_requests.append(mock_request)
        if mock_request.url.host == "idp.example.com":
            return httpx2.Response(200, content=b"fresh")
        if mock_request.headers.get("authorization") == "Bearer fresh":
            return httpx2.Response(200, content=b"ok")
        return httpx2.Response(401)

    async with httpx2.AsyncClient(
        transport=httpx2.MockTransport(transport_handler), auth=_compat._wrap_auth_for_httpx2(RefreshAuth())
    ) as client:
        response = await client.post("https://example.com/mcp", content=b'{"jsonrpc": "2.0"}')

    idp_request = transport_requests[1]
    tru_round_trip = (
        response.status_code,
        [str(sent.url) for sent in transport_requests],
        (dict(idp_request.headers), idp_request.read()),
    )
    exp_round_trip = (
        200,
        ["https://example.com/mcp", "https://idp.example.com/token", "https://example.com/mcp"],
        ({"host": "idp.example.com", "content-length": "0"}, b""),
    )
    assert tru_round_trip == exp_round_trip


@requires_mcp_v2
def test_wrap_auth_mirrors_body_flags_and_rejects_sync_flows():
    """Test that the adapter mirrors the wrapped auth's body flags and refuses sync driving."""

    class BodyHungryAuth(httpx.Auth):
        requires_request_body = True
        requires_response_body = True

    adapted = _compat._wrap_auth_for_httpx2(BodyHungryAuth())
    assert (adapted.requires_request_body, adapted.requires_response_body) == (True, True)

    with pytest.raises(RuntimeError, match="async"):
        adapted.sync_auth_flow(MagicMock())
