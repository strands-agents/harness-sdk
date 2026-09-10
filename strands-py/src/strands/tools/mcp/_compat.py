"""Compatibility layer over the `mcp` 1.x and 2.x lines.

The official `mcp` package renamed and relocated several public names in 2.0.
Import any version-dependent name from this module instead of from `mcp`
directly so the rest of the codebase stays version-agnostic. Branch on
`MCP_V2` only where behavior differs between the two lines; pure renames are
resolved here once.

mypy note: only one `mcp` line is installed at a time, so each try/except
branch below is an `attr-defined` error when checked against the other line.
The branch-level ignores cover whichever line mypy runs under, and the
per-module `warn_unused_ignores` override in pyproject.toml silences the
ignores the installed line doesn't need.
"""

import asyncio
from collections.abc import AsyncGenerator, AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, AsyncExitStack, asynccontextmanager
from datetime import timedelta
from typing import Any

import httpx
from mcp import ClientSession
from mcp.types import ServerCapabilities, ToolListChangedNotification

__all__ = [
    "MCP_V2",
    "GetSessionIdCallback",
    "MCPError",
    "call_tool",
    "client_credentials_auth",
    "get_prompt",
    "input_schema",
    "is_error",
    "is_tools_list_changed",
    "mime_type",
    "negotiate_session",
    "next_cursor",
    "output_schema",
    "read_resource",
    "read_timeout",
    "resource_templates",
    "server_task_capable",
    "streamable_http_transport",
    "structured_content",
    "task_session_kwargs",
    "task_support",
    "tools_changed_subscription",
]

# Feature-probed rather than version-parsed so pre-releases and backports
# resolve by capability: `ClientSession.discover` is the 2.x replacement for
# the removed initialize handshake.
MCP_V2: bool = hasattr(ClientSession, "discover")

# The official SDKs' shared default for SEP-2322 multi round-trip retries.
_INPUT_REQUIRED_MAX_ROUNDS = 10

_STATE_ONLY_RETRY_DELAY_SECONDS = 0.05

try:
    from mcp.shared.exceptions import MCPError  # type: ignore[attr-defined]
except ImportError:
    # mcp 1.x spells the class McpError
    from mcp.shared.exceptions import McpError as MCPError  # type: ignore[attr-defined, no-redef]

try:
    from mcp.client.streamable_http import GetSessionIdCallback  # type: ignore[attr-defined]
except ImportError:
    # mcp 2.x removed protocol sessions, so its transports never yield a
    # session-id callback; the alias survives only to type 1.x transports.
    GetSessionIdCallback = Callable[[], str | None]  # type: ignore[misc, assignment]


async def _drive_input_required(session: ClientSession, call_once: Callable[[Any, str | None], Any]) -> Any:
    """Retry a 2.x request until it stops returning `InputRequiredResult`.

    The 2026-07-28 spec (SEP-2322) replaced server-initiated requests with multi round-trip requests: instead of
    sending `elicitation/create` back to the client mid-call, the server returns an `InputRequiredResult` from
    `tools/call`, `prompts/get`, or `resources/read`, and the client resolves the embedded input requests and retries
    the call carrying the responses and the echoed opaque `request_state`. Each round resolves the embedded requests
    through `session.dispatch_input_request`, the same callback table that serves 1.x server-initiated requests, so an
    `elicitation_callback` passed to `ClientSession` behaves the same on both lines.

    The `mcp` package ships its own retry loop, but only inside the high-level `mcp.client.Client`, which owns
    connection lifecycle that `MCPClient` manages itself, so the loop is reimplemented here at the session level.

    Args:
        session: An active, negotiated `ClientSession`.
        call_once: Sends one request round, taking the input responses and the request state to carry.

    Returns:
        The terminal result.

    Raises:
        MCPError: An embedded input request's callback answered with an error.
        InputRequiredRoundsExceededError: The server kept returning `InputRequiredResult` past the round cap.
    """
    from mcp.client import ClientRequestContext, InputRequiredRoundsExceededError  # type: ignore[attr-defined]
    from mcp.types import ErrorData, InputRequiredResult  # type: ignore[attr-defined]

    result = await call_once(None, None)
    for _ in range(_INPUT_REQUIRED_MAX_ROUNDS):
        if not isinstance(result, InputRequiredResult):
            return result
        responses: dict[str, Any] = {}
        for key, request in (result.input_requests or {}).items():
            context = ClientRequestContext(
                session=session, request_id=key, meta=request.params.meta if request.params else None
            )
            response = await session.dispatch_input_request(context, request)  # type: ignore[attr-defined]
            if isinstance(response, ErrorData):
                raise MCPError(code=response.code, message=response.message, data=response.data)
            responses[key] = response
        if not responses:
            # A state-only result asks the client to poll: wait a beat so the retry loop cannot hammer the server.
            await asyncio.sleep(_STATE_ONLY_RETRY_DELAY_SECONDS)
        result = await call_once(responses or None, result.request_state)
    if isinstance(result, InputRequiredResult):
        raise InputRequiredRoundsExceededError(_INPUT_REQUIRED_MAX_ROUNDS)
    return result


async def call_tool(
    session: ClientSession,
    name: str,
    arguments: dict[str, Any] | None,
    read_timeout_seconds: timedelta | None,
    progress_callback: Any,
    meta: Any,
    *,
    allow_claimed: bool = False,
) -> Any:
    """Call a tool on an active session, on either `mcp` major line.

    On the 2.x branch the server may answer with an `InputRequiredResult` mid-call. `_drive_input_required`
    resolves the embedded input requests and retries until the call reaches a terminal result.

    Args:
        session: An active, negotiated `ClientSession`.
        name: The tool name as the server knows it.
        arguments: Arguments to pass to the tool.
        read_timeout_seconds: Timeout for each request round, if any.
        progress_callback: Callback for progress notifications, if any.
        meta: Request metadata (`_meta`) to send with the call, if any.
        allow_claimed: Return extension-claimed results without resolving them.

    Returns:
        The terminal `CallToolResult`, or an unresolved extension result when
        ``allow_claimed`` is enabled.

    Raises:
        MCPError: An embedded input request's callback answered with an error.
        InputRequiredRoundsExceededError: The server kept returning `InputRequiredResult` past the round cap.
    """
    if not MCP_V2:
        return await session.call_tool(
            name,
            arguments,
            read_timeout_seconds,  # type: ignore[arg-type]
            progress_callback=progress_callback,
            meta=meta,
        )

    timeout = read_timeout(read_timeout_seconds)
    claim_options = {"allow_claimed": True} if allow_claimed else {}

    async def call_once(input_responses: Any, request_state: str | None) -> Any:
        return await session.call_tool(  # type: ignore[call-arg]
            name,
            arguments,
            timeout,  # type: ignore[arg-type]
            progress_callback=progress_callback,
            meta=meta,
            input_responses=input_responses,
            request_state=request_state,
            allow_input_required=True,
            **claim_options,
        )

    return await _drive_input_required(session, call_once)


def client_credentials_auth(
    server_url: str, storage: Any, client_id: str, client_secret: str, scope: str | None
) -> httpx.Auth:
    """Construct the OAuth client_credentials provider, on either `mcp` major line.

    `mcp` 2.x renamed the provider's `scopes` keyword to `scope`. The import
    path and the space-joined scope string value are the same on both lines.

    Args:
        server_url: The MCP server endpoint URL the grant authenticates against.
        storage: The provider's token storage.
        client_id: The OAuth client identifier.
        client_secret: The OAuth client secret.
        scope: Space-joined OAuth scopes to request, if any.

    Returns:
        The provider, an HTTPX auth implementation.
    """
    from mcp.client.auth.extensions.client_credentials import ClientCredentialsOAuthProvider

    if MCP_V2:
        return ClientCredentialsOAuthProvider(  # type: ignore[return-value]
            server_url=server_url,
            storage=storage,
            client_id=client_id,
            client_secret=client_secret,
            scope=scope,  # type: ignore[call-arg]
        )
    return ClientCredentialsOAuthProvider(  # type: ignore[return-value]
        server_url=server_url,
        storage=storage,
        client_id=client_id,
        client_secret=client_secret,
        scopes=scope,  # type: ignore[call-arg]
    )


async def get_prompt(session: ClientSession, name: str, arguments: dict[str, str] | None) -> Any:
    """Get a prompt on an active session, on either `mcp` major line.

    On the 2.x branch the server may answer with an `InputRequiredResult` mid-call. `_drive_input_required`
    resolves the embedded input requests and retries until the call reaches a terminal result.

    Args:
        session: An active, negotiated `ClientSession`.
        name: The prompt name as the server knows it.
        arguments: Arguments to pass to the prompt.

    Returns:
        The terminal `GetPromptResult`.

    Raises:
        MCPError: An embedded input request's callback answered with an error.
        InputRequiredRoundsExceededError: The server kept returning `InputRequiredResult` past the round cap.
    """
    if not MCP_V2:
        return await session.get_prompt(name, arguments=arguments)

    async def call_once(input_responses: Any, request_state: str | None) -> Any:
        return await session.get_prompt(  # type: ignore[call-arg]
            name,
            arguments=arguments,
            input_responses=input_responses,
            request_state=request_state,
            allow_input_required=True,
        )

    return await _drive_input_required(session, call_once)


async def read_resource(session: ClientSession, uri: Any) -> Any:
    """Read a resource on an active session, on either `mcp` major line.

    On the 2.x branch the server may answer with an `InputRequiredResult` mid-call. `_drive_input_required`
    resolves the embedded input requests and retries until the call reaches a terminal result.

    Args:
        session: An active, negotiated `ClientSession`.
        uri: The resource URI. 1.x takes the pydantic `AnyUrl` model. 2.x takes a plain string, so anything
            `str()` accepts works there.

    Returns:
        The terminal `ReadResourceResult`.

    Raises:
        MCPError: An embedded input request's callback answered with an error.
        InputRequiredRoundsExceededError: The server kept returning `InputRequiredResult` past the round cap.
    """
    if not MCP_V2:
        return await session.read_resource(uri)

    async def call_once(input_responses: Any, request_state: str | None) -> Any:
        return await session.read_resource(  # type: ignore[call-arg]
            str(uri),  # type: ignore[arg-type]
            input_responses=input_responses,
            request_state=request_state,
            allow_input_required=True,
        )

    return await _drive_input_required(session, call_once)


def input_schema(tool: Any) -> dict[str, Any]:
    """Read a tool's input schema, on either `mcp` major line.

    `mcp` 2.x renamed the pydantic model fields to snake_case, so the field
    is `input_schema` there and `inputSchema` on 1.x.

    Args:
        tool: A `Tool` from a list tools result.

    Returns:
        The tool's JSON input schema.
    """
    schema: dict[str, Any] = tool.input_schema if MCP_V2 else tool.inputSchema
    return schema


def is_error(call_tool_result: Any) -> bool | None:
    """Read a tool call result's error flag, on either `mcp` major line.

    `mcp` 2.x renamed the pydantic result models' camelCase fields to
    snake_case, so the field is `is_error` there and `isError` on 1.x.

    Args:
        call_tool_result: A `CallToolResult` returned by the session.

    Returns:
        The tool's application-level error flag.
    """
    error: bool | None = call_tool_result.is_error if MCP_V2 else call_tool_result.isError
    return error


def is_tools_list_changed(message: Any) -> bool:
    """Return whether a message-handler message is a tools list-changed notification.

    The 1.x session hands the message handler a `ServerNotification` wrapper
    whose `root` holds the notification; the 2.x session hands it the
    notification itself, including events it tees from a
    `subscriptions/listen` stream on a 2026-07-28 connection. Both shapes are
    accepted unconditionally, so no version branch is needed.

    Args:
        message: A message delivered to the session's `message_handler`.

    Returns:
        Whether the message announces a change to the server's tool list.
    """
    if isinstance(message, ToolListChangedNotification):
        return True
    return isinstance(getattr(message, "root", None), ToolListChangedNotification)


def mime_type(content: Any) -> str | None:
    """Read a content or resource block's MIME type, on either `mcp` major line.

    `mcp` 2.x renamed the pydantic model fields to snake_case, so the field
    is `mime_type` there and `mimeType` on 1.x.

    Args:
        content: An `ImageContent`, `AudioContent`, or `*ResourceContents` model.

    Returns:
        The block's MIME type, or None when the model leaves it unset.
    """
    mime: str | None = content.mime_type if MCP_V2 else content.mimeType
    return mime


def next_cursor(list_result: Any) -> str | None:
    """Read a paginated list result's continuation cursor, on either `mcp` major line.

    `mcp` 2.x renamed the pydantic result models' camelCase fields to
    snake_case, so the field is `next_cursor` there and `nextCursor` on 1.x.

    Args:
        list_result: A `List*Result` returned by a session `list_*` method.

    Returns:
        The cursor for the next page, or None on the last page.
    """
    cursor: str | None = list_result.next_cursor if MCP_V2 else list_result.nextCursor
    return cursor


def output_schema(tool: Any) -> dict[str, Any] | None:
    """Read a tool's output schema, on either `mcp` major line.

    `mcp` 2.x renamed the pydantic model fields to snake_case, so the field
    is `output_schema` there and `outputSchema` on 1.x.

    Args:
        tool: A `Tool` from a list tools result.

    Returns:
        The tool's JSON output schema, or None when the tool declares none.
    """
    schema: dict[str, Any] | None = tool.output_schema if MCP_V2 else tool.outputSchema
    return schema


def read_timeout(timeout: timedelta | None) -> float | timedelta | None:
    """Convert a tool call read timeout to the form the installed `mcp` line takes.

    The session `call_tool` takes `read_timeout_seconds` as a `timedelta` on
    1.x and as a `float` of seconds on 2.x.

    Args:
        timeout: The timeout from the `MCPClient` public API, if any.

    Returns:
        The value to pass as the session's `read_timeout_seconds`.
    """
    if timeout is None:
        return None
    return timeout.total_seconds() if MCP_V2 else timeout


def resource_templates(list_result: Any) -> list[Any]:
    """Read a list result's resource templates, on either `mcp` major line.

    `mcp` 2.x renamed the pydantic result models' camelCase fields to
    snake_case, so the field is `resource_templates` there and
    `resourceTemplates` on 1.x.

    Args:
        list_result: A `ListResourceTemplatesResult` returned by the session.

    Returns:
        The resource templates in this page of the result.
    """
    templates: list[Any] = list_result.resource_templates if MCP_V2 else list_result.resourceTemplates
    return templates


def structured_content(call_tool_result: Any) -> Any:
    """Read a tool call result's structured content, on either `mcp` major line.

    `mcp` 2.x renamed the pydantic result models' camelCase fields to
    snake_case, so the field is `structured_content` there and
    `structuredContent` on 1.x.

    The return is `Any` because the lines type the field differently: 1.x
    validates it to `dict[str, Any] | None`, while 2.x allows any JSON value
    (the 2026-07-28 spec lifted the JSON-object restriction). Non-dict values
    pass through unchanged; callers decide how to surface them.

    Args:
        call_tool_result: A `CallToolResult` returned by the session.

    Returns:
        The structured JSON payload, or None when the tool returned none.
    """
    return call_tool_result.structured_content if MCP_V2 else call_tool_result.structuredContent


def task_support(tool: Any) -> str | None:
    """Read a tool's declared task execution support level, on either `mcp` major line.

    `mcp` 2.x renamed the pydantic model fields to snake_case, so the field
    is `execution.task_support` there and `execution.taskSupport` on 1.x.

    Args:
        tool: A `Tool` from a list tools result.

    Returns:
        The declared support level, or None when the tool does not declare one.
    """
    if tool.execution is None:
        return None
    support: str | None = tool.execution.task_support if MCP_V2 else tool.execution.taskSupport
    return support


def server_task_capable(capabilities: ServerCapabilities | None) -> bool:
    """Check whether a server supports the installed line's task protocol.

    MCP 1.x advertises the legacy task capability under ``tasks``. MCP 2.x
    advertises finalized SEP-2663 support through the extension registry.

    Args:
        capabilities: Capabilities negotiated with the server.

    Returns:
        Whether the server advertised compatible task support.
    """
    if capabilities is None:
        return False
    if MCP_V2:
        from .mcp_tasks import _TASKS_EXTENSION

        extensions = getattr(capabilities, "extensions", None)
        return extensions is not None and _TASKS_EXTENSION in extensions
    return (
        capabilities.tasks is not None
        and capabilities.tasks.requests is not None
        and capabilities.tasks.requests.tools is not None
        and capabilities.tasks.requests.tools.call is not None
    )


def task_session_kwargs(enabled: bool) -> dict[str, Any]:
    """Build MCP 2.x ``ClientSession`` options for finalized Tasks support.

    The extension claim teaches the 2.x result codec to parse ``resultType:
    task``. Strands consumes the task handle itself, so the claim resolver is
    intentionally unreachable on the low-level ``ClientSession`` path.

    Args:
        enabled: Whether the caller opted into task support.

    Returns:
        Additional keyword arguments for ``ClientSession``.
    """
    if not enabled or not MCP_V2:
        return {}

    from mcp.client.extension import ResultClaim  # type: ignore[import-not-found]

    from .mcp_tasks import _TASKS_EXTENSION, _TASKS_PROTOCOL_VERSION, MCPCreateTaskResult

    async def unexpected_resolver(result: MCPCreateTaskResult, context: Any) -> Any:
        _ = (result, context)
        raise RuntimeError("MCP task claims are resolved by MCPClient")

    claim = ResultClaim(
        result_type="task",
        model=MCPCreateTaskResult,
        resolve=unexpected_resolver,
        protocol_versions=frozenset({_TASKS_PROTOCOL_VERSION}),
    )
    return {
        "extensions": {_TASKS_EXTENSION: {}},
        "result_claims": {_TASKS_EXTENSION: (claim,)},
    }


async def negotiate_session(session: ClientSession) -> tuple[str | None, ServerCapabilities | None]:
    """Negotiate the connection on an entered session, on either `mcp` major line.

    The 2026-07-28 spec (SEP-2575) removed the `initialize` handshake and
    moved negotiation into a per-request `_meta` envelope that the 2.x client
    stamps itself. `server/discover` is the optional up-front probe for the
    server's supported versions and capabilities. `negotiate_auto` is the
    official 2.x client's connect-time policy over it: it probes
    `server/discover` first and falls back to the legacy handshake for
    pre-2026 servers, so either server era works. It is importable from
    `mcp.client.client` but not exported in an `__all__`, so the forced-2.x
    CI job is what catches a relocation.

    Args:
        session: An entered `ClientSession` that has not yet negotiated.

    Returns:
        The server's instructions (if any) and advertised capabilities.
    """
    if MCP_V2:
        from mcp.client.client import negotiate_auto  # type: ignore[import-not-found]

        await negotiate_auto(session)
        return session.instructions, session.server_capabilities  # type: ignore[attr-defined]

    init_result = await session.initialize()
    return init_result.instructions, session.get_server_capabilities()  # type: ignore[attr-defined]


@asynccontextmanager
async def tools_changed_subscription(session: ClientSession) -> AsyncIterator[Any]:
    """Hold open the subscription that makes a 2026-07-28 server publish tools list changes.

    The 2026-07-28 spec (SEP-2575) consolidated server notifications into an
    opt-in `subscriptions/listen` stream: a modern server emits a tools
    list-changed event only while a subscriber holds the stream open. The 2.x
    session tees each event to the `message_handler` as a
    `ToolListChangedNotification`, so holding the stream open is all the
    intake requires. The 1.x line and legacy-negotiated 2.x connections push
    the notification without any subscription; those yield None and hold
    nothing.

    Args:
        session: An active, negotiated `ClientSession`.

    Yields:
        The subscription handle, or None when the connection has no
        subscription to hold.
    """
    if not MCP_V2:
        yield None
        return

    from mcp.client.subscriptions import ListenNotSupportedError, listen  # type: ignore[import-not-found]

    async with AsyncExitStack() as subscription_scope:
        try:
            subscription = await subscription_scope.enter_async_context(listen(session, tools_list_changed=True))
        except ListenNotSupportedError:
            # The connection negotiated a legacy protocol version, so the
            # server pushes list-changed notifications unprompted.
            subscription = None
        yield subscription


def _wrap_auth_for_httpx2(auth: httpx.Auth | None) -> Any:
    """Translate an `httpx.Auth` handler into the auth protocol mcp 2.x expects.

    mcp 2.x is built on `httpx2`, whose client rejects `httpx.Auth` instances at request time. The two Auth protocols
    are identical apart from their request and response model classes, so an `httpx.Auth` is driven through an adapter
    that converts the models at each step of the flow. Values that are not `httpx.Auth` instances, which includes the
    `httpx2.Auth` implementations such as the 2.x OAuth providers, pass through unchanged.

    The adapter mutates only the headers of the outgoing httpx2 request, which covers header-based schemes (basic,
    bearer, digest, token refresh). It is async-only because every mcp 2.x transport drives auth through an async
    client.
    """
    # Non-`httpx.Auth` values return before the httpx2 import so this path also
    # works where httpx2 is absent (the mcp 1.x install with `MCP_V2` forced on
    # in unit tests).
    if not isinstance(auth, httpx.Auth):
        return auth

    import httpx2

    wrapped = auth

    class _HttpxAuthAdapter(httpx2.Auth):  # type: ignore[misc]
        """Drives an `httpx.Auth` flow with httpx2 request and response models."""

        requires_request_body = wrapped.requires_request_body
        requires_response_body = wrapped.requires_response_body

        async def async_auth_flow(self, request: Any) -> AsyncGenerator[Any, Any]:
            request_body = None
            if wrapped.requires_request_body:
                await request.aread()
                request_body = request.content
            translated_request = httpx.Request(
                str(request.method), str(request.url), headers=request.headers.raw, content=request_body
            )
            flow = wrapped.async_auth_flow(translated_request)
            step = await flow.__anext__()
            while True:
                request.headers = httpx2.Headers(step.headers.raw)
                response = yield request
                response_body = b""
                if wrapped.requires_response_body:
                    await response.aread()
                    response_body = response.content
                translated_response = httpx.Response(
                    response.status_code, headers=response.headers.raw, content=response_body, request=step
                )
                try:
                    step = await flow.asend(translated_response)
                except StopAsyncIteration:
                    return

        def sync_auth_flow(self, request: Any) -> Any:
            raise RuntimeError("this auth adapter only supports async clients; mcp 2.x transports are async")

    return _HttpxAuthAdapter()


def streamable_http_transport(
    url: str, headers: dict[str, str] | None = None, auth: httpx.Auth | None = None
) -> AbstractAsyncContextManager[Any]:
    """Open a streamable HTTP client transport on either `mcp` major line.

    `mcp` 2.x replaced `streamablehttp_client(url, headers=..., auth=...)` with
    `streamable_http_client(url, http_client=...)`, which takes a
    pre-configured HTTPX client instead of loose header and auth kwargs. This
    adapter keeps the 1.x-style call shape for both lines.

    The imports are resolved at call time because each name exists on only
    one major line.

    Args:
        url: The MCP server endpoint URL.
        headers: Optional HTTP headers to send with each request.
        auth: Optional HTTPX authentication handler for each request.

    Returns:
        An async context manager yielding the transport's read/write streams.
    """
    if MCP_V2:
        from mcp.client.streamable_http import (  # type: ignore[attr-defined]
            create_mcp_http_client,
            streamable_http_client,
        )

        transport_auth = _wrap_auth_for_httpx2(auth)

        # `streamable_http_client` closes an HTTPX client only when it created
        # it (`client_provided` check in mcp 2.x), so a caller-provided client
        # must be closed by the caller: enter both context managers together
        # so the client's lifetime is bound to the transport's.
        @asynccontextmanager
        async def _owned_client_transport() -> AsyncIterator[Any]:
            async with (
                create_mcp_http_client(headers=headers, auth=transport_auth) as http_client,
                streamable_http_client(url=url, http_client=http_client) as transport_streams,
            ):
                yield transport_streams

        return _owned_client_transport()

    from mcp.client.streamable_http import streamablehttp_client  # type: ignore[attr-defined]

    return streamablehttp_client(url=url, headers=headers, auth=auth)  # type: ignore[no-any-return]
