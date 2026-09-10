"""Model Context Protocol (MCP) server connection management module.

This module provides the MCPClient class which handles connections to MCP servers.
It manages the lifecycle of MCP connections, including initialization, tool discovery,
tool invocation, and proper cleanup of resources. The connection runs in a background
thread to avoid blocking the main application thread while maintaining communication
with the MCP service.
"""

import asyncio
import base64
import contextvars
import json
import logging
import os
import re
import sys
import threading
import uuid
from asyncio import AbstractEventLoop
from collections.abc import Callable, Coroutine, Sequence
from concurrent import futures
from contextlib import AsyncExitStack
from datetime import timedelta
from importlib.metadata import version as pkg_version
from pathlib import Path
from re import Pattern
from types import TracebackType
from typing import Any, TypeVar, cast
from urllib.parse import urlparse

import anyio
import httpx
from mcp import ClientSession, ListToolsResult, StdioServerParameters, stdio_client
from mcp.client.session import ElicitationFnT, ProgressFnT
from mcp.client.sse import sse_client
from mcp.shared.auth import OAuthClientInformationFull, OAuthToken
from mcp.types import (
    BlobResourceContents,
    CancelledNotification,
    CancelledNotificationParams,
    ClientNotification,
    ElicitationRequiredErrorData,
    GetPromptResult,
    Implementation,
    ListPromptsResult,
    ListResourcesResult,
    ListResourceTemplatesResult,
    PaginatedRequestParams,
    ReadResourceResult,
    TextResourceContents,
)
from mcp.types import CallToolResult as MCPCallToolResult
from mcp.types import EmbeddedResource as MCPEmbeddedResource
from mcp.types import ImageContent as MCPImageContent
from mcp.types import TextContent as MCPTextContent
from pydantic import AnyUrl
from typing_extensions import Protocol, TypedDict

from ...types import PaginatedList
from ...types.exceptions import MCPClientInitializationError, ToolProviderException
from ...types.media import ImageFormat
from ...types.tools import AgentTool, ToolResultContent, ToolResultStatus
from ..tool_provider import ToolProvider
from ._compat import (
    MCP_V2,
    MCPError,
    client_credentials_auth,
    is_error,
    is_tools_list_changed,
    mime_type,
    negotiate_session,
    next_cursor,
    read_timeout,
    resource_templates,
    server_task_capable,
    streamable_http_transport,
    structured_content,
    task_session_kwargs,
    task_support,
    tools_changed_subscription,
)
from ._compat import call_tool as compat_call_tool
from ._compat import get_prompt as compat_get_prompt
from ._compat import read_resource as compat_read_resource
from .mcp_agent_tool import MCPAgentTool
from .mcp_instrumentation import inject_trace_context, mcp_instrumentation
from .mcp_tasks import (
    _TASKS_EXTENSION,
    _TASKS_PROTOCOL_VERSION,
    DEFAULT_TASK_CONFIG,
    DEFAULT_TASK_POLL_INTERVAL,
    DEFAULT_TASK_POLL_TIMEOUT,
    DEFAULT_TASK_REQUEST_TIMEOUT,
    DEFAULT_TASK_TTL,
    MCPCancelTaskResult,
    MCPCreateTaskResult,
    MCPGetTaskResult,
    MCPInputRequest,
    MCPInputResponses,
    MCPTaskError,
    MCPUpdateTaskResult,
    TasksConfig,
    _CancelTaskRequest,
    _CancelTaskRequestParams,
    _GetTaskRequest,
    _GetTaskRequestParams,
    _parse_task_timestamp,
    _UpdateTaskRequest,
    _UpdateTaskRequestParams,
)
from .mcp_types import MCPClientCredentials, MCPToolResult, MCPTransport, ToolsChanged

logger = logging.getLogger(__name__)

T = TypeVar("T")


def _pagination_params(pagination_token: str | None) -> PaginatedRequestParams | None:
    """Build the params object for a paginated list_* request.

    The session list methods' `cursor` keyword is deprecated on the mcp 1.x
    line and removed on 2.x; `params` is the form both lines accept.
    """
    return PaginatedRequestParams(cursor=pagination_token) if pagination_token is not None else None


class _MCPCallCancelledError(RuntimeError):
    """Raised internally when a per-call MCP cancellation signal is observed."""


class _ToolFilterCallback(Protocol):
    def __call__(self, tool: AgentTool, **kwargs: Any) -> bool: ...


_ToolMatcher = str | Pattern[str] | _ToolFilterCallback


class ToolFilters(TypedDict, total=False):
    """Filters for controlling which MCP tools are loaded and available.

    Tools are filtered in this order:
    1. If 'allowed' is specified, only tools matching these patterns are included
    2. Tools matching 'rejected' patterns are then excluded
    """

    allowed: list[_ToolMatcher]
    rejected: list[_ToolMatcher]


class _CallCancellationState(TypedDict, total=False):
    session: ClientSession
    request_id: int
    task_id: str
    notification_sent: bool


class MCPServerConfig(TypedDict, total=False):
    """Schema for a single MCP server entry in a load_servers config.

    Provide either 'command' (stdio) or 'url' (streamable-http/sse), not both. When 'transport' is
    omitted it is auto-detected from the fields present. String values support '${VAR}' /
    '${env:VAR}' interpolation, and '~' in 'command' and 'cwd' is expanded to the home directory.

    'auth' holds client credentials for OAuth machine-to-machine (client_credentials grant)
    authentication and is only supported for streamable-http transport.

    'disabled' skips the server entirely. 'continue_on_error' keeps the rest of the servers usable
    when this one fails: a config-resolution failure (e.g. a missing env var) skips it during
    load_servers instead of raising, and a connection failure yields no tools instead of raising
    when the agent loads them.
    """

    command: str
    args: list[str]
    env: dict[str, str]
    cwd: str
    url: str
    headers: dict[str, str]
    transport: str
    auth: MCPClientCredentials
    disabled: bool
    continue_on_error: bool
    prefix: str
    tool_filters: ToolFilters
    startup_timeout: int
    application_name: str
    application_version: str


MIME_TO_FORMAT: dict[str, ImageFormat] = {
    "image/jpeg": "jpeg",
    "image/jpg": "jpeg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
}

CLIENT_SESSION_NOT_RUNNING_ERROR_MESSAGE = (
    "the client session is not running. Ensure the agent is used within "
    "the MCP client context manager. For more information see: "
    "https://strandsagents.com/docs/user-guide/concepts/tools/mcp-tools/#mcpclientinitializationerror-python"
)

# Non-fatal error patterns that should not cause connection collapse
_NON_FATAL_ERROR_PATTERNS = [
    # Occurs when client receives response with unrecognized ID
    # Can occur after a client-side timeout
    # See: https://github.com/modelcontextprotocol/python-sdk/blob/c51936f61f35a15f0b1f8fb6887963e5baee1506/src/mcp/shared/session.py#L421
    "unknown request id",
]

_TOOLS_CHANGED_DEBOUNCE_SECONDS = 0.3


class MCPClient(ToolProvider):
    """Represents a connection to a Model Context Protocol (MCP) server.

    This class implements a context manager pattern for efficient connection management,
    allowing reuse of the same connection for multiple tool calls to reduce latency.
    It handles the creation, initialization, and cleanup of MCP connections.

    The connection runs in a background thread to avoid blocking the main application thread
    while maintaining communication with the MCP service. When structured content is available
    from MCP tools, it will be returned as the last item in the content array of the ToolResult.
    """

    @classmethod
    def load_servers(
        cls,
        config: "str | dict[str, Any]",
        *,
        continue_on_error: bool = False,
        prefix_with_server_name: bool = False,
    ) -> "list[MCPClient]":
        """Create MCPClient instances from an ``mcpServers`` JSON config (file path or mapping).

        Returns one client per enabled server. Accepts either a flat mapping of server name to
        config, or that mapping nested under an ``mcpServers`` key. Servers marked
        ``"disabled": true`` are skipped. When a server has ``"continue_on_error": true`` (or the
        ``continue_on_error`` default is set), a failure resolving its config (e.g. a missing env
        var) skips that server instead of raising.

        Transport is auto-detected from the fields present: ``command`` selects stdio and ``url``
        selects streamable-http. Set ``transport`` explicitly (``"stdio"``, ``"sse"``, or
        ``"streamable-http"``) to override. String values support ``${VAR}`` / ``${env:VAR}``
        interpolation against the process environment, and ``~`` in ``command`` and ``cwd`` is
        expanded to the user's home directory.

        Args:
            config: A file path (with optional ``file://`` prefix) to a JSON config, or a
                dictionary mapping server names to configs (optionally under an ``mcpServers`` key).
            continue_on_error: Default ``continue_on_error`` for every server; a server's own
                ``continue_on_error`` key overrides it.
            prefix_with_server_name: When True, servers without an explicit ``prefix`` use their config
                key as the tool name prefix, so same-named tools from different servers no longer
                collide. Characters outside ``[A-Za-z0-9_-]`` in the key (e.g. the dot in
                ``awslabs.foo``) are replaced with ``_``. A server can still opt out with ``"prefix": ""``.

        Returns:
            One MCPClient per enabled server, ready to pass to ``Agent(tools=...)``.

        Raises:
            FileNotFoundError: If the config file does not exist.
            json.JSONDecodeError: If the config file contains invalid JSON.
            ValueError: If the overall config shape is invalid or a server entry is not a mapping.
                These are malformed-config errors and always raise, regardless of
                ``continue_on_error``. A failure building an individual server (e.g. a missing env
                var) also raises unless ``continue_on_error`` applies to that server, in which case
                it is skipped.
        """
        servers = _load_servers_mapping(config)

        clients: list[MCPClient] = []
        for name, server in servers.items():
            # A non-dict entry is a malformed-config error and always raises, unlike per-server failures.
            if not isinstance(server, dict):
                raise ValueError(f"server '{name}' configuration must be a dictionary, got {type(server).__name__}")
            unknown_keys = sorted(server.keys() - MCPServerConfig.__annotations__.keys())
            if unknown_keys:
                logger.warning(
                    "server_name=<%s>, unknown_keys=<%s> | ignoring unrecognized MCP config keys", name, unknown_keys
                )
            if server.get("disabled", False):
                logger.debug("server_name=<%s> | skipping disabled MCP server", name)
                continue
            try:
                clients.append(
                    _build_client_from_config(
                        name,
                        server,
                        continue_on_error=continue_on_error,
                        prefix_with_server_name=prefix_with_server_name,
                    )
                )
            except Exception as e:
                if not server.get("continue_on_error", continue_on_error):
                    raise
                logger.warning("server_name=<%s>, error=<%s> | MCP server config failed, skipping", name, e)

        logger.debug("loaded_servers=<%d> | created MCP clients from config", len(clients))
        return clients

    def __init__(
        self,
        transport_callable: Callable[[], MCPTransport] | None = None,
        *,
        url: str | None = None,
        headers: dict[str, str] | None = None,
        auth: MCPClientCredentials | None = None,
        auth_provider: httpx.Auth | None = None,
        startup_timeout: int = 30,
        tool_filters: ToolFilters | None = None,
        prefix: str | None = None,
        application_name: str | None = None,
        application_version: str | None = None,
        continue_on_error: bool = False,
        elicitation_callback: ElicitationFnT | None = None,
        progress_callback: ProgressFnT | None = None,
        tasks_config: TasksConfig | None = None,
        on_tools_changed: ToolsChanged | None = None,
    ) -> None:
        """Initialize a new MCP Server connection.

        Args:
            transport_callable: A callable that returns an MCPTransport (read_stream, write_stream) tuple.
                Mutually exclusive with `url`.
            url: Server URL. When provided, a streamable HTTP transport is constructed automatically.
                Mutually exclusive with `transport_callable`.
            headers: HTTP headers to include on every request to the server. Requires `url`.
            auth: Client credentials for OAuth machine-to-machine (client_credentials grant)
                authentication. Requires `url`. Mutually exclusive with `auth_provider`.
            auth_provider: Custom `httpx.Auth` for advanced auth flows, passed through to the
                streamable HTTP transport. Requires `url`. Mutually exclusive with `auth`.
            startup_timeout: Timeout after which MCP server initialization should be cancelled.
                Defaults to 30.
            tool_filters: Optional filters to apply to tools.
            prefix: Optional prefix for tool names.
            application_name: Optional name to identify this agent via clientInfo.name.
                If provided, the MCP server will see this name during the initialize handshake.
                Defaults to None (uses the MCP SDK default "mcp").
            application_version: Optional version string to report alongside application_name.
                Defaults to None (uses the Strands SDK version).
            continue_on_error: When True, a connection failure during `load_tools` is logged and
                yields no tools instead of raising, so one unavailable server does not prevent an
                agent from using the others. Only the connection (`start()`) is swallowed; an error
                while listing tools after a successful connect still propagates. Defaults to False.
            elicitation_callback: Optional callback function to handle elicitation requests from the MCP server.
            progress_callback: Optional callback to receive progress notifications during tool execution.
                Called with `(progress, total, message)` as the server reports progress. The `total`
                and `message` parameters may be `None` if the server does not provide them.
            tasks_config: Configuration for MCP task-augmented execution for long-running tools.
                Experimental and subject to change as MCP Tasks evolve. On MCP 2.x, this enables
                finalized SEP-2663 Tasks support. On MCP 1.x, it enables the legacy task
                workflow. See TasksConfig for details.
            on_tools_changed: Optional callback invoked after the server announces a change to its
                tool list and the client refreshes it. Called with the previous tool names and the
                refreshed tool instances. Registering it turns on the refresh: the client listens
                for the server's tools list-changed notifications, re-lists the tools (applying
                the constructor's prefix and filters), and updates the cached tools that
                `load_tools` returns. On a connection that negotiated MCP 2026-07-28, registering
                it also makes `start()` failable: the client must open the server's
                `subscriptions/listen` stream to receive the notifications, and a failure to open
                it (other than the server lacking support) raises `MCPClientInitializationError`
                from `start()`.

        Raises:
            ValueError: If neither or both of `transport_callable` and `url` are provided, if
                `headers`, `auth`, or `auth_provider` is provided without `url`, if both `auth`
                and `auth_provider` are provided, if `url` is not an http:// or https:// URL, or
                if `auth` is missing required keys or a value has the wrong type.
        """
        self._startup_timeout = startup_timeout
        self._tool_filters = tool_filters
        self._prefix = prefix
        self._application_name = application_name
        self._application_version = application_version
        self._continue_on_error = continue_on_error
        # True after a swallowed init failure, so load_tools stops retrying a failed server.
        self._connection_failed = False
        self._elicitation_callback = elicitation_callback
        self._progress_callback = progress_callback
        self._on_tools_changed = on_tools_changed
        self._tools_refresh_in_progress = False
        self._tools_refresh_pending = False
        # Keep refresh tasks alive until they finish; asyncio only retains weak references.
        self._tools_refresh_tasks: set[asyncio.Task[None]] = set()

        mcp_instrumentation()
        self._session_id = uuid.uuid4()
        self._log_debug_with_thread("initializing MCPClient connection")
        # Main thread blocks until future completes
        self._init_future: futures.Future[None] = futures.Future()
        # Set within the inner loop as it needs the asyncio loop
        self._close_future: asyncio.futures.Future[None] | None = None
        self._close_exception: None | Exception = None
        # Do not want to block other threads while close event is false
        self._transport_callable = _resolve_transport_callable(
            transport_callable, url=url, headers=headers, auth=auth, auth_provider=auth_provider
        )

        self._background_thread: threading.Thread | None = None
        self._background_thread_session: ClientSession | None = None
        self._background_thread_event_loop: AbstractEventLoop | None = None
        self._loaded_tools: list[MCPAgentTool] | None = None
        self._tool_provider_started = False
        self.server_instructions: str | None = None
        self._consumers: set[Any] = set()
        # Keep detached cleanup tasks alive until they finish; asyncio only retains weak references.
        self._background_cleanup_tasks: set[asyncio.Task[Any]] = set()
        self._accept_background_cleanup_tasks = True

        # Task support configuration and caching
        self._tasks_config = tasks_config
        self._server_task_capable: bool | None = None

        self._tool_task_support_cache: dict[str, str] = {}

    def __enter__(self) -> "MCPClient":
        """Context manager entry point which initializes the MCP server connection.

        TODO: Refactor to lazy initialization pattern following idiomatic Python.
        Heavy work in __enter__ is non-idiomatic - should move connection logic to first method call instead.
        """
        return self.start()

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        """Context manager exit point that cleans up resources."""
        self.stop(exc_type, exc_val, exc_tb)

    def start(self) -> "MCPClient":
        """Starts the background thread and waits for initialization.

        This method starts the background thread that manages the MCP connection
        and blocks until the connection is ready or times out.

        Returns:
            self: The MCPClient instance

        Raises:
            Exception: If the MCP connection fails to initialize within the timeout period
        """
        if self._is_session_active():
            raise MCPClientInitializationError("the client session is currently running")

        self._log_debug_with_thread("entering MCPClient context")
        self._accept_background_cleanup_tasks = True
        # Copy context vars to propagate to the background thread
        # This ensures that context set in the main thread is accessible in the background thread
        # See: https://github.com/strands-agents/harness-sdk/issues/1440
        ctx = contextvars.copy_context()
        self._background_thread = threading.Thread(target=ctx.run, args=(self._background_task,), daemon=True)
        self._background_thread.start()
        self._log_debug_with_thread("background thread started, waiting for ready event")
        try:
            # Blocking main thread until session is initialized in other thread or if the thread stops
            self._init_future.result(timeout=self._startup_timeout)
            self._log_debug_with_thread("the client initialization was successful")
        except futures.TimeoutError as e:
            logger.exception("client initialization timed out")
            # Pass None for exc_type, exc_val, exc_tb since this isn't a context manager exit
            self.stop(None, None, None)
            raise MCPClientInitializationError(
                f"background thread did not start in {self._startup_timeout} seconds"
            ) from e
        except Exception as e:
            logger.exception("client failed to initialize")
            # Pass None for exc_type, exc_val, exc_tb since this isn't a context manager exit
            self.stop(None, None, None)
            raise MCPClientInitializationError(f"the client initialization failed: {e}") from e
        return self

    @property
    def client_name(self) -> str | None:
        """The ``application_name`` reported to the server, or ``None`` when unset (see ``__init__``).

        Defaults to the config key for ``load_servers`` clients.
        """
        return self._application_name

    @property
    def continue_on_error(self) -> bool:
        """Whether a connection failure is swallowed instead of raised (see ``__init__``)."""
        return self._continue_on_error

    @property
    def connection_failed(self) -> bool:
        """Whether a ``continue_on_error`` connection attempt has failed and not yet been reset.

        Sticky within a connection lifecycle: stays True until teardown (removing the last consumer,
        or ``stop()``) resets the client. Always False when ``continue_on_error`` is not set, since a
        failure raises instead.
        """
        return self._connection_failed

    @property
    def on_tools_changed(self) -> ToolsChanged | None:
        """The registered tools-changed callback, if any (see `__init__`)."""
        return self._on_tools_changed

    @on_tools_changed.setter
    def on_tools_changed(self, callback: ToolsChanged | None) -> None:
        """Register or remove the tools-changed callback.

        On a connection that negotiated MCP 2026-07-28, the `subscriptions/listen`
        stream that makes the server publish list-changed notifications is opened
        at session start only when a callback is registered, so a callback set
        after `start()` receives nothing from such a server until the client is
        restarted. Servers on earlier protocol versions push the notification
        unprompted, so a late-set callback works there immediately.
        """
        self._on_tools_changed = callback

    # ToolProvider interface methods
    async def load_tools(self, **kwargs: Any) -> Sequence[AgentTool]:
        """Load and return tools from the MCP server.

        This method implements the ToolProvider interface by loading tools
        from the MCP server and caching them for reuse.

        Args:
            **kwargs: Additional arguments for future compatibility.

        Returns:
            List of AgentTool instances from the MCP server. Empty when the connection fails and
            ``continue_on_error`` is set; the failure is sticky within a connection lifecycle and is
            not retried on subsequent calls. Teardown (removing the last consumer, or ``stop()``)
            resets the client so a later consumer reconnects.
        """
        logger.debug(
            "started=<%s>, cached_tools=<%s> | loading tools",
            self._tool_provider_started,
            self._loaded_tools is not None,
        )

        # A previously swallowed init failure is not retried on subsequent calls.
        if self._connection_failed:
            return []

        if not self._tool_provider_started:
            try:
                logger.debug("starting MCP client")
                self.start()
                self._tool_provider_started = True
                logger.debug("MCP client started successfully")
            except Exception as e:
                if self._continue_on_error:
                    logger.warning("error=<%s> | MCP server failed to start, continuing with no tools", e)
                    self._connection_failed = True
                    return []
                logger.error("error=<%s> | failed to start MCP client", e)
                raise ToolProviderException(f"Failed to start MCP client: {e}") from e

        if self._loaded_tools is None:
            logger.debug("loading tools from MCP server")
            initial_tools = self._list_all_tools_sync()
            # A refresh may have replaced the cache while this listing ran;
            # the refreshed list is newer, so it wins over the initial load.
            if self._loaded_tools is None:
                self._loaded_tools = initial_tools
            logger.debug("final_tools=<%d> | loading complete", len(self._loaded_tools))

        return self._loaded_tools

    def _list_all_tools_sync(self) -> list[MCPAgentTool]:
        """List every tool page with the constructor's prefix and filters applied."""
        all_tools: list[MCPAgentTool] = []
        pagination_token = None
        page_count = 0

        while True:
            logger.debug("page=<%d>, token=<%s> | fetching tools page", page_count, pagination_token)
            paginated_tools = self.list_tools_sync(
                pagination_token, prefix=self._prefix, tool_filters=self._tool_filters
            )

            # Tools are already filtered by list_tools_sync, so add them all
            all_tools.extend(paginated_tools)

            logger.debug(
                "page=<%d>, page_tools=<%d>, total_filtered=<%d> | processed page",
                page_count,
                len(paginated_tools),
                len(all_tools),
            )

            pagination_token = paginated_tools.pagination_token
            page_count += 1

            if pagination_token is None:
                return all_tools

    def add_consumer(self, consumer_id: Any, **kwargs: Any) -> None:
        """Add a consumer to this tool provider.

        Synchronous to prevent GC deadlocks when called from Agent finalizers.
        """
        self._consumers.add(consumer_id)
        logger.debug("added provider consumer, count=%d", len(self._consumers))

    def remove_consumer(self, consumer_id: Any, **kwargs: Any) -> None:
        """Remove a consumer from this tool provider.

        This method is idempotent - calling it multiple times with the same ID
        has no additional effect after the first call.

        Synchronous to prevent GC deadlocks when called from Agent finalizers.
        Uses existing synchronous stop() method for safe cleanup.
        """
        self._consumers.discard(consumer_id)
        logger.debug("removed provider consumer, count=%d", len(self._consumers))

        # A swallowed continue_on_error failure leaves _tool_provider_started False but still needs
        # teardown so the sticky _connection_failed flag resets and the client can reconnect for a
        # later consumer, matching the reset-on-zero-consumers behavior of a successful client.
        if not self._consumers and (self._tool_provider_started or self._connection_failed):
            logger.debug("no consumers remaining, cleaning up")
            try:
                self.stop(None, None, None)  # Existing sync method - safe for finalizers
                self._tool_provider_started = False
                self._loaded_tools = None
            except Exception as e:
                logger.error("error=<%s> | failed to cleanup MCP client", e)
                raise ToolProviderException(f"Failed to cleanup MCP client: {e}") from e

    # MCP-specific methods

    def stop(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        """Signals the background thread to stop and waits for it to complete, ensuring proper cleanup of all resources.

        This method is defensive and can handle partial initialization states that may occur
        if start() fails partway through initialization.

        Resources to cleanup:
        - _background_thread: Thread running the async event loop
        - _background_thread_session: MCP ClientSession (auto-closed by context manager)
        - _background_thread_event_loop: AsyncIO event loop in background thread
        - _close_future: AsyncIO future to signal thread shutdown
        - _close_exception: Exception that caused the background thread shutdown; None if a normal shutdown occurred.
        - _init_future: Future for initialization synchronization

        Cleanup order:
        1. Signal close future to background thread (if session initialized)
        2. Wait for background thread to complete
        3. Reset all state for reuse

        Args:
            exc_type: Exception type if an exception was raised in the context
            exc_val: Exception value if an exception was raised in the context
            exc_tb: Exception traceback if an exception was raised in the context
        """
        self._log_debug_with_thread("exiting MCPClient context")

        # Skip cleanup during interpreter finalization. On Python 3.14+, joining a
        # non-daemon thread at shutdown raises PythonFinalizationError; even though
        # our background thread is a daemon and will be reclaimed automatically,
        # the join call itself produces noisy tracebacks on stderr when the GC
        # reaches Agent.__del__ during finalization. See issue #2143.
        if sys.is_finalizing():
            self._log_debug_with_thread("interpreter is finalizing, skipping MCPClient cleanup")
            return

        # Only try to signal close future if we have a background thread
        if self._background_thread is not None:
            # Signal close future if event loop exists
            if self._background_thread_event_loop is not None:

                async def _set_close_event() -> None:
                    if self._close_future and not self._close_future.done():
                        self._close_future.set_result(None)

                # Not calling _invoke_on_background_thread since the session does not need to exist
                # we only need the thread and event loop to exist.
                asyncio.run_coroutine_threadsafe(coro=_set_close_event(), loop=self._background_thread_event_loop)

            self._log_debug_with_thread("waiting for background thread to join")
            self._background_thread.join()

        if self._background_thread_event_loop is not None:
            self._background_thread_event_loop.close()

        self._log_debug_with_thread("background thread is closed, MCPClient context exited")

        # Reset fields to allow instance reuse
        self._init_future = futures.Future()
        self._background_thread = None
        self._background_thread_session = None
        self._background_thread_event_loop = None
        self._session_id = uuid.uuid4()
        self._loaded_tools = None
        self._tool_provider_started = False
        self._connection_failed = False
        self._consumers = set()
        self._background_cleanup_tasks.clear()
        self._server_task_capable = None
        self._tool_task_support_cache = {}
        # A refresh task destroyed with the loop never ran its finally, so
        # without this reset a restarted client would skip every refresh.
        self._tools_refresh_in_progress = False
        self._tools_refresh_pending = False
        self._tools_refresh_tasks.clear()

        if self._close_exception:
            exception = self._close_exception
            self._close_exception = None
            raise RuntimeError("Connection to the MCP server was closed") from exception

    def list_tools_sync(
        self,
        pagination_token: str | None = None,
        prefix: str | None = None,
        tool_filters: ToolFilters | None = None,
    ) -> PaginatedList[MCPAgentTool]:
        """Synchronously retrieves the list of available tools from the MCP server.

        This method calls the asynchronous list_tools method on the MCP session
        and adapts the returned tools to the AgentTool interface.

        Args:
            pagination_token: Optional token for pagination
            prefix: Optional prefix to apply to tool names. If None, uses constructor default.
                   If explicitly provided (including empty string), overrides constructor default.
            tool_filters: Optional filters to apply to tools. If None, uses constructor default.
                         If explicitly provided (including empty dict), overrides constructor default.

        Returns:
            List[AgentTool]: A list of available tools adapted to the AgentTool interface
        """
        self._log_debug_with_thread("listing MCP tools synchronously")
        if not self._is_session_active():
            raise MCPClientInitializationError(CLIENT_SESSION_NOT_RUNNING_ERROR_MESSAGE)

        effective_prefix = self._prefix if prefix is None else prefix
        effective_filters = self._tool_filters if tool_filters is None else tool_filters

        async def _list_tools_async() -> ListToolsResult:
            return await cast(ClientSession, self._background_thread_session).list_tools(
                params=_pagination_params(pagination_token)
            )

        list_tools_response: ListToolsResult = self._invoke_on_background_thread(_list_tools_async()).result()
        self._log_debug_with_thread("received %d tools from MCP server", len(list_tools_response.tools))

        mcp_tools = []
        for tool in list_tools_response.tools:
            if self._is_tasks_enabled():
                # Cache taskSupport for task-augmented execution decisions
                self._tool_task_support_cache[tool.name] = task_support(tool) or "forbidden"

            # Apply prefix if specified
            if effective_prefix:
                prefixed_name = f"{effective_prefix}_{tool.name}"
                mcp_tool = MCPAgentTool(tool, self, name_override=prefixed_name)
                logger.debug("tool_rename=<%s->%s> | renamed tool", tool.name, prefixed_name)
            else:
                mcp_tool = MCPAgentTool(tool, self)

            # Apply filters if specified
            if self._should_include_tool_with_filters(mcp_tool, effective_filters):
                mcp_tools.append(mcp_tool)

        self._log_debug_with_thread("successfully adapted %d MCP tools", len(mcp_tools))
        return PaginatedList[MCPAgentTool](mcp_tools, token=next_cursor(list_tools_response))

    def list_prompts_sync(self, pagination_token: str | None = None) -> ListPromptsResult:
        """Synchronously retrieves the list of available prompts from the MCP server.

        This method calls the asynchronous list_prompts method on the MCP session
        and returns the raw ListPromptsResult with pagination support.

        Args:
            pagination_token: Optional token for pagination

        Returns:
            ListPromptsResult: The raw MCP response containing prompts and pagination info
        """
        self._log_debug_with_thread("listing MCP prompts synchronously")
        if not self._is_session_active():
            raise MCPClientInitializationError(CLIENT_SESSION_NOT_RUNNING_ERROR_MESSAGE)

        async def _list_prompts_async() -> ListPromptsResult:
            return await cast(ClientSession, self._background_thread_session).list_prompts(
                params=_pagination_params(pagination_token)
            )

        list_prompts_result: ListPromptsResult = self._invoke_on_background_thread(_list_prompts_async()).result()
        self._log_debug_with_thread("received %d prompts from MCP server", len(list_prompts_result.prompts))
        for prompt in list_prompts_result.prompts:
            self._log_debug_with_thread(prompt.name)

        return list_prompts_result

    def get_prompt_sync(self, prompt_id: str, args: dict[str, Any]) -> GetPromptResult:
        """Synchronously retrieves a prompt from the MCP server.

        Args:
            prompt_id: The ID of the prompt to retrieve
            args: Optional arguments to pass to the prompt

        Returns:
            GetPromptResult: The prompt response from the MCP server
        """
        self._log_debug_with_thread("getting MCP prompt synchronously")
        if not self._is_session_active():
            raise MCPClientInitializationError(CLIENT_SESSION_NOT_RUNNING_ERROR_MESSAGE)

        async def _get_prompt_async() -> GetPromptResult:
            session = cast(ClientSession, self._background_thread_session)
            return cast(GetPromptResult, await compat_get_prompt(session, prompt_id, args))

        get_prompt_result: GetPromptResult = self._invoke_on_background_thread(_get_prompt_async()).result()
        self._log_debug_with_thread("received prompt from MCP server")

        return get_prompt_result

    def list_resources_sync(self, pagination_token: str | None = None) -> ListResourcesResult:
        """Synchronously retrieves the list of available resources from the MCP server.

        This method calls the asynchronous list_resources method on the MCP session
        and returns the raw ListResourcesResult with pagination support.

        Args:
            pagination_token: Optional token for pagination

        Returns:
            ListResourcesResult: The raw MCP response containing resources and pagination info
        """
        self._log_debug_with_thread("listing MCP resources synchronously")
        if not self._is_session_active():
            raise MCPClientInitializationError(CLIENT_SESSION_NOT_RUNNING_ERROR_MESSAGE)

        async def _list_resources_async() -> ListResourcesResult:
            return await cast(ClientSession, self._background_thread_session).list_resources(
                params=_pagination_params(pagination_token)
            )

        list_resources_result: ListResourcesResult = self._invoke_on_background_thread(_list_resources_async()).result()
        self._log_debug_with_thread("received %d resources from MCP server", len(list_resources_result.resources))

        return list_resources_result

    def read_resource_sync(self, uri: AnyUrl | str) -> ReadResourceResult:
        """Synchronously reads a resource from the MCP server.

        Args:
            uri: The URI of the resource to read

        Returns:
            ReadResourceResult: The resource content from the MCP server
        """
        self._log_debug_with_thread("reading MCP resource synchronously: %s", uri)
        if not self._is_session_active():
            raise MCPClientInitializationError(CLIENT_SESSION_NOT_RUNNING_ERROR_MESSAGE)

        async def _read_resource_async() -> ReadResourceResult:
            # Convert string to AnyUrl if needed
            resource_uri = AnyUrl(uri) if isinstance(uri, str) else uri
            session = cast(ClientSession, self._background_thread_session)
            return cast(ReadResourceResult, await compat_read_resource(session, resource_uri))

        read_resource_result: ReadResourceResult = self._invoke_on_background_thread(_read_resource_async()).result()
        self._log_debug_with_thread("received resource content from MCP server")

        return read_resource_result

    def list_resource_templates_sync(self, pagination_token: str | None = None) -> ListResourceTemplatesResult:
        """Synchronously retrieves the list of available resource templates from the MCP server.

        Resource templates define URI patterns that can be used to access resources dynamically.

        Args:
            pagination_token: Optional token for pagination

        Returns:
            ListResourceTemplatesResult: The raw MCP response containing resource templates and pagination info
        """
        self._log_debug_with_thread("listing MCP resource templates synchronously")
        if not self._is_session_active():
            raise MCPClientInitializationError(CLIENT_SESSION_NOT_RUNNING_ERROR_MESSAGE)

        async def _list_resource_templates_async() -> ListResourceTemplatesResult:
            return await cast(ClientSession, self._background_thread_session).list_resource_templates(
                params=_pagination_params(pagination_token)
            )

        list_resource_templates_result: ListResourceTemplatesResult = self._invoke_on_background_thread(
            _list_resource_templates_async()
        ).result()
        self._log_debug_with_thread(
            "received %d resource templates from MCP server", len(resource_templates(list_resource_templates_result))
        )

        return list_resource_templates_result

    def _create_call_tool_coroutine(
        self,
        name: str,
        arguments: dict[str, Any] | None,
        read_timeout_seconds: timedelta | None,
        meta: dict[str, Any] | None = None,
        progress_callback: ProgressFnT | None = None,
        cancellation_state: _CallCancellationState | None = None,
    ) -> Coroutine[Any, Any, MCPCallToolResult]:
        """Create the appropriate coroutine for calling a tool.

        This method encapsulates the decision logic for whether to use task-augmented
        execution or direct call_tool, returning the appropriate coroutine.

        Args:
            name: Name of the tool to call.
            arguments: Optional arguments to pass to the tool.
            read_timeout_seconds: Optional timeout for the tool call. On the mcp 2.x line, the timeout
                bounds each request round of a multi round-trip tool call rather than the call as a
                whole — except with task-augmented execution, where it bounds the whole task
                (polling included) and each lifecycle request uses the ``tasks_config``
                ``request_timeout``.
            meta: Optional metadata to pass to the tool call per MCP spec (_meta).
            progress_callback: Optional callback to receive progress notifications.
                If None, falls back to the instance-level callback set at construction time.
            cancellation_state: Internal state used to cancel the exact MCP request or task.

        Returns:
            A coroutine that will execute the tool call.
        """
        use_task = self._should_use_task(name)
        effective_callback = progress_callback if progress_callback is not None else self._progress_callback

        # Inject once, before branching, so both the task-augmented and direct
        # call paths below carry the same enriched meta. This is safe on the
        # caller's thread: asyncio.run_coroutine_threadsafe, used to hand the
        # resulting coroutine to the background loop, copies the caller's
        # contextvars, so the caller's active span is still current when the
        # coroutine runs on the background thread.
        #
        # Under mcp 2.x this injection becomes redundant rather than wrong: the
        # dispatcher injects its own traceparent, overwriting this one with its
        # own CLIENT span. That span is parented to the caller's span, so the
        # trace stays connected.
        meta = inject_trace_context(meta)

        if use_task:
            self._log_debug_with_thread("tool=<%s> | using task-augmented execution", name)
            if effective_callback is not None and not MCP_V2:
                logger.warning(
                    "tool=<%s> | progress callbacks are ignored when task-augmented execution is enabled",
                    name,
                )

            async def _call_as_task() -> MCPCallToolResult:
                if MCP_V2:
                    return await self._call_tool_with_task_and_poll_async(
                        name,
                        arguments,
                        poll_timeout=read_timeout_seconds,
                        meta=meta,
                        progress_callback=effective_callback,
                        cancellation_state=cancellation_state,
                    )
                # When task-augmented execution is used, use the read_timeout_seconds parameter
                # (which is a timedelta) for the polling timeout.
                return await self._call_tool_as_task_and_poll_async(
                    name,
                    arguments,
                    poll_timeout=read_timeout_seconds,
                    meta=meta,
                    cancellation_state=cancellation_state,
                )

            return _call_as_task()
        else:
            self._log_debug_with_thread("tool=<%s> | using direct call_tool", name)

            async def _call_tool_direct() -> MCPCallToolResult:
                session = cast(ClientSession, self._background_thread_session)
                if cancellation_state is not None:
                    cancellation_state["session"] = session
                    # Only 1.x needs the request id: the client must hand-send notifications/cancelled itself
                    # there. The 2.x dispatcher sends the cancel with the right id when the awaiting task is
                    # cancelled.
                    if not MCP_V2:
                        # MCP assigns the captured private ID synchronously at the start of
                        # send_request(). If that invariant changes, omit remote notification rather
                        # than risk cancelling a different request; local cancellation still works.
                        request_id = getattr(session, "_request_id", None)
                        if isinstance(request_id, int):
                            cancellation_state["request_id"] = request_id
                result = await compat_call_tool(
                    session,
                    name,
                    arguments,
                    read_timeout_seconds,
                    effective_callback,
                    meta,
                )
                return cast(MCPCallToolResult, result)

            return _call_tool_direct()

    def call_tool_sync(
        self,
        tool_use_id: str,
        name: str,
        arguments: dict[str, Any] | None = None,
        read_timeout_seconds: timedelta | None = None,
        meta: dict[str, Any] | None = None,
        progress_callback: ProgressFnT | None = None,
        *,
        cancel_signal: threading.Event | None = None,
    ) -> MCPToolResult:
        """Synchronously calls a tool on the MCP server.

        This method automatically uses task-augmented execution when the client
        opted in via ``tasks_config`` and the server advertises task support (on
        the mcp 1.x line, the tool's ``taskSupport`` setting is also honored).

        Args:
            tool_use_id: Unique identifier for this tool use
            name: Name of the tool to call
            arguments: Optional arguments to pass to the tool
            read_timeout_seconds: Optional timeout for the tool call. On the mcp 2.x line, the timeout
                bounds each request round of a multi round-trip tool call rather than the call as a
                whole — except with task-augmented execution, where it bounds the whole task
                (polling included) and each lifecycle request uses the ``tasks_config``
                ``request_timeout``.
            meta: Optional metadata to pass to the tool call per MCP spec (_meta)
            progress_callback: Optional callback to receive progress notifications for this
                call. Overrides the instance-level callback set at construction time. With
                task-augmented execution, progress can only arrive before the server returns a
                task handle — MCP forbids progress notifications for tasks — and the mcp 1.x
                task flow ignores the callback entirely.
            cancel_signal: Optional caller-owned, thread-safe event for this call. A pre-set event
                cancels before the MCP request starts. If set while the request is in flight,
                cancellation wins over a concurrently arriving result. The returned error result has
                ``cancelled=True``. Remote cancellation is best-effort and bounded; the shared MCP
                session remains reusable. Clear the event before reusing it for another call.

        Returns:
            MCPToolResult: The tool result. Locally observed cancellation returns an error result with
                ``cancelled=True`` rather than raising. Cancelling the outer asyncio task is separate
                and still raises ``asyncio.CancelledError`` for ``call_tool_async``.
        """
        self._log_debug_with_thread("calling MCP tool '%s' synchronously with tool_use_id=%s", name, tool_use_id)
        if not self._is_session_active():
            raise MCPClientInitializationError(CLIENT_SESSION_NOT_RUNNING_ERROR_MESSAGE)

        try:
            cancellation_state = _CallCancellationState()
            coro = self._create_call_tool_coroutine(
                name,
                arguments,
                read_timeout_seconds,
                meta=meta,
                progress_callback=progress_callback,
                cancellation_state=cancellation_state,
            )
            call_tool_result: MCPCallToolResult = self._invoke_on_background_thread(
                coro, cancel_signal=cancel_signal, cancellation_state=cancellation_state
            ).result()
            return self._handle_tool_result(tool_use_id, call_tool_result)
        except Exception as e:
            logger.exception("tool execution failed")
            return self._handle_tool_execution_error(tool_use_id, e)

    async def call_tool_async(
        self,
        tool_use_id: str,
        name: str,
        arguments: dict[str, Any] | None = None,
        read_timeout_seconds: timedelta | None = None,
        meta: dict[str, Any] | None = None,
        progress_callback: ProgressFnT | None = None,
        *,
        cancel_signal: threading.Event | None = None,
    ) -> MCPToolResult:
        """Asynchronously calls a tool on the MCP server.

        This method automatically uses task-augmented execution when the client
        opted in via ``tasks_config`` and the server advertises task support (on
        the mcp 1.x line, the tool's ``taskSupport`` setting is also honored).

        Args:
            tool_use_id: Unique identifier for this tool use
            name: Name of the tool to call
            arguments: Optional arguments to pass to the tool
            read_timeout_seconds: Optional timeout for the tool call. On the mcp 2.x line, the timeout
                bounds each request round of a multi round-trip tool call rather than the call as a
                whole — except with task-augmented execution, where it bounds the whole task
                (polling included) and each lifecycle request uses the ``tasks_config``
                ``request_timeout``.
            meta: Optional metadata to pass to the tool call per MCP spec (_meta)
            progress_callback: Optional callback to receive progress notifications for this
                call. Overrides the instance-level callback set at construction time. With
                task-augmented execution, progress can only arrive before the server returns a
                task handle — MCP forbids progress notifications for tasks — and the mcp 1.x
                task flow ignores the callback entirely.
            cancel_signal: Optional caller-owned, thread-safe event for this call. A pre-set event
                cancels before the MCP request starts. If set while the request is in flight,
                cancellation wins over a concurrently arriving result. The returned error result has
                ``cancelled=True``. Remote cancellation is best-effort and bounded; the shared MCP
                session remains reusable. Clear the event before reusing it for another call.

        Returns:
            MCPToolResult: The tool result. Locally observed cancellation returns an error result with
                ``cancelled=True`` rather than raising. Cancelling the outer asyncio task is separate
                and still raises ``asyncio.CancelledError`` for ``call_tool_async``.
        """
        self._log_debug_with_thread("calling MCP tool '%s' asynchronously with tool_use_id=%s", name, tool_use_id)
        if not self._is_session_active():
            raise MCPClientInitializationError(CLIENT_SESSION_NOT_RUNNING_ERROR_MESSAGE)

        try:
            cancellation_state = _CallCancellationState()
            coro = self._create_call_tool_coroutine(
                name,
                arguments,
                read_timeout_seconds,
                meta=meta,
                progress_callback=progress_callback,
                cancellation_state=cancellation_state,
            )
            future = self._invoke_on_background_thread(
                coro, cancel_signal=cancel_signal, cancellation_state=cancellation_state
            )
            call_tool_result: MCPCallToolResult = await asyncio.wrap_future(future)
            return self._handle_tool_result(tool_use_id, call_tool_result)
        except Exception as e:
            logger.exception("tool execution failed")
            return self._handle_tool_execution_error(tool_use_id, e)

    def submit_tool_sync(
        self,
        name: str,
        arguments: dict[str, Any] | None = None,
        read_timeout_seconds: timedelta | None = None,
        meta: dict[str, Any] | None = None,
        progress_callback: ProgressFnT | None = None,
    ) -> MCPCallToolResult | MCPCreateTaskResult:
        """Submit a tool call once and return its direct result or SEP-2663 task handle.

        This protocol-level operation never polls a returned task.

        Args:
            name: Name of the tool to call.
            arguments: Optional arguments to pass to the tool.
            read_timeout_seconds: Optional timeout for the request.
            meta: Optional MCP request metadata.
            progress_callback: Optional progress callback for the request.

        Returns:
            The direct tool result or server-created task handle.

        Raises:
            MCPClientInitializationError: If the client session is not running.
            RuntimeError: If finalized task support is unavailable (mcp 1.x, missing
                ``tasks_config``, missing server extension, or a protocol mismatch),
                validated before the request is sent.
        """
        if not self._is_session_active():
            raise MCPClientInitializationError(CLIENT_SESSION_NOT_RUNNING_ERROR_MESSAGE)
        self._require_v2_task_lifecycle()
        return self._invoke_on_background_thread(
            self._call_tool_with_task_once_async(
                name,
                arguments,
                read_timeout_seconds or self._get_task_config().get("request_timeout", DEFAULT_TASK_REQUEST_TIMEOUT),
                inject_trace_context(meta),
                progress_callback if progress_callback is not None else self._progress_callback,
            )
        ).result()

    async def submit_tool_async(
        self,
        name: str,
        arguments: dict[str, Any] | None = None,
        read_timeout_seconds: timedelta | None = None,
        meta: dict[str, Any] | None = None,
        progress_callback: ProgressFnT | None = None,
    ) -> MCPCallToolResult | MCPCreateTaskResult:
        """Asynchronously submit a tool call once without polling a returned task.

        Args:
            name: Name of the tool to call.
            arguments: Optional arguments to pass to the tool.
            read_timeout_seconds: Optional timeout for the request.
            meta: Optional MCP request metadata.
            progress_callback: Optional progress callback for the request.

        Returns:
            The direct tool result or server-created task handle.

        Raises:
            MCPClientInitializationError: If the client session is not running.
            RuntimeError: If finalized task support is unavailable (mcp 1.x, missing
                ``tasks_config``, missing server extension, or a protocol mismatch),
                validated before the request is sent.
        """
        if not self._is_session_active():
            raise MCPClientInitializationError(CLIENT_SESSION_NOT_RUNNING_ERROR_MESSAGE)
        self._require_v2_task_lifecycle()
        future = self._invoke_on_background_thread(
            self._call_tool_with_task_once_async(
                name,
                arguments,
                read_timeout_seconds or self._get_task_config().get("request_timeout", DEFAULT_TASK_REQUEST_TIMEOUT),
                inject_trace_context(meta),
                progress_callback if progress_callback is not None else self._progress_callback,
            )
        )
        return await asyncio.wrap_future(future)

    def get_task_sync(self, task_id: str, read_timeout_seconds: timedelta | None = None) -> MCPGetTaskResult:
        """Synchronously retrieve the current state of a SEP-2663 task.

        Args:
            task_id: Server-issued task identifier.
            read_timeout_seconds: Optional timeout for the request.

        Returns:
            The task's validated current state.

        Raises:
            MCPClientInitializationError: If the client session is not running.
            RuntimeError: If finalized task support is unavailable.
            ValueError: If ``task_id`` is empty.
        """
        if not self._is_session_active():
            raise MCPClientInitializationError(CLIENT_SESSION_NOT_RUNNING_ERROR_MESSAGE)
        if not task_id:
            raise ValueError("task_id must not be empty")
        return self._invoke_on_background_thread(self._get_task_async(task_id, read_timeout_seconds)).result()

    async def get_task_async(self, task_id: str, read_timeout_seconds: timedelta | None = None) -> MCPGetTaskResult:
        """Asynchronously retrieve the current state of a SEP-2663 task.

        Args:
            task_id: Server-issued task identifier.
            read_timeout_seconds: Optional timeout for the request.

        Returns:
            The task's validated current state.

        Raises:
            MCPClientInitializationError: If the client session is not running.
            RuntimeError: If finalized task support is unavailable.
            ValueError: If ``task_id`` is empty.
        """
        if not self._is_session_active():
            raise MCPClientInitializationError(CLIENT_SESSION_NOT_RUNNING_ERROR_MESSAGE)
        if not task_id:
            raise ValueError("task_id must not be empty")
        return await asyncio.wrap_future(
            self._invoke_on_background_thread(self._get_task_async(task_id, read_timeout_seconds))
        )

    def update_task_sync(
        self,
        task_id: str,
        input_responses: MCPInputResponses,
        read_timeout_seconds: timedelta | None = None,
    ) -> MCPUpdateTaskResult:
        """Synchronously supply responses to a task's outstanding input requests.

        Args:
            task_id: Server-issued task identifier.
            input_responses: Responses keyed by the corresponding input request keys.
            read_timeout_seconds: Optional timeout for the request.

        Returns:
            The server's validated acknowledgement.

        Raises:
            MCPClientInitializationError: If the client session is not running.
            RuntimeError: If finalized task support is unavailable.
            TypeError: If ``input_responses`` is not a dictionary.
            ValueError: If ``task_id`` is empty.
        """
        if not self._is_session_active():
            raise MCPClientInitializationError(CLIENT_SESSION_NOT_RUNNING_ERROR_MESSAGE)
        if not task_id:
            raise ValueError("task_id must not be empty")
        if not isinstance(input_responses, dict):
            raise TypeError("input_responses must be a dictionary")
        return self._invoke_on_background_thread(
            self._update_task_async(task_id, input_responses, read_timeout_seconds)
        ).result()

    async def update_task_async(
        self,
        task_id: str,
        input_responses: MCPInputResponses,
        read_timeout_seconds: timedelta | None = None,
    ) -> MCPUpdateTaskResult:
        """Asynchronously supply responses to a task's outstanding input requests.

        Args:
            task_id: Server-issued task identifier.
            input_responses: Responses keyed by the corresponding input request keys.
            read_timeout_seconds: Optional timeout for the request.

        Returns:
            The server's validated acknowledgement.

        Raises:
            MCPClientInitializationError: If the client session is not running.
            RuntimeError: If finalized task support is unavailable.
            TypeError: If ``input_responses`` is not a dictionary.
            ValueError: If ``task_id`` is empty.
        """
        if not self._is_session_active():
            raise MCPClientInitializationError(CLIENT_SESSION_NOT_RUNNING_ERROR_MESSAGE)
        if not task_id:
            raise ValueError("task_id must not be empty")
        if not isinstance(input_responses, dict):
            raise TypeError("input_responses must be a dictionary")
        return await asyncio.wrap_future(
            self._invoke_on_background_thread(self._update_task_async(task_id, input_responses, read_timeout_seconds))
        )

    def cancel_task_sync(self, task_id: str, read_timeout_seconds: timedelta | None = None) -> MCPCancelTaskResult:
        """Synchronously request cooperative cancellation of a SEP-2663 task.

        Args:
            task_id: Server-issued task identifier.
            read_timeout_seconds: Optional timeout for the request.

        Returns:
            The server's validated acknowledgement.

        Raises:
            MCPClientInitializationError: If the client session is not running.
            RuntimeError: If finalized task support is unavailable.
            ValueError: If ``task_id`` is empty.
        """
        if not self._is_session_active():
            raise MCPClientInitializationError(CLIENT_SESSION_NOT_RUNNING_ERROR_MESSAGE)
        if not task_id:
            raise ValueError("task_id must not be empty")
        return self._invoke_on_background_thread(self._cancel_task_async(task_id, read_timeout_seconds)).result()

    async def cancel_task_async(
        self, task_id: str, read_timeout_seconds: timedelta | None = None
    ) -> MCPCancelTaskResult:
        """Asynchronously request cooperative cancellation of a SEP-2663 task.

        Args:
            task_id: Server-issued task identifier.
            read_timeout_seconds: Optional timeout for the request.

        Returns:
            The server's validated acknowledgement.

        Raises:
            MCPClientInitializationError: If the client session is not running.
            RuntimeError: If finalized task support is unavailable.
            ValueError: If ``task_id`` is empty.
        """
        if not self._is_session_active():
            raise MCPClientInitializationError(CLIENT_SESSION_NOT_RUNNING_ERROR_MESSAGE)
        if not task_id:
            raise ValueError("task_id must not be empty")
        return await asyncio.wrap_future(
            self._invoke_on_background_thread(self._cancel_task_async(task_id, read_timeout_seconds))
        )

    def _handle_tool_execution_error(self, tool_use_id: str, exception: Exception) -> MCPToolResult:
        """Create error ToolResult with consistent logging and elicitation callback support.

        Args:
            tool_use_id: Unique identifier for this tool use.
            exception: The exception that occurred during tool execution.

        Returns:
            MCPToolResult: Error result containing either the elicitation data or the
                original exception message.
        """
        if isinstance(exception, MCPError) and exception.error.code == -32042:
            try:
                error_data = ElicitationRequiredErrorData.model_validate(exception.error.data)
                elicitations = [e.model_dump(exclude_none=True) for e in error_data.elicitations]

                return MCPToolResult(
                    status="error",
                    toolUseId=tool_use_id,
                    content=[
                        {"text": (f"MCP Elicitation required: [{str(exception)}] with data {json.dumps(elicitations)}")}
                    ],
                )
            except Exception:
                logger.debug("Failed to parse ElicitationRequiredErrorData from -32042 error", exc_info=True)

        if isinstance(exception, _MCPCallCancelledError):
            result = MCPToolResult(
                status="error",
                toolUseId=tool_use_id,
                content=[{"text": "Tool execution cancelled locally; remote execution may have continued"}],
                cancelled=True,
            )
        else:
            result = MCPToolResult(
                status="error",
                toolUseId=tool_use_id,
                content=[{"text": f"Tool execution failed: {str(exception)}"}],
            )
        return result

    def _handle_tool_result(self, tool_use_id: str, call_tool_result: MCPCallToolResult) -> MCPToolResult:
        """Maps MCP tool result to the agent's MCPToolResult format.

        This method processes the content from the MCP tool call result and converts it to the format
        expected by the framework.

        Args:
            tool_use_id: Unique identifier for this tool use
            call_tool_result: The result from the MCP tool call

        Returns:
            MCPToolResult: The converted tool result
        """
        self._log_debug_with_thread("received tool result with %d content items", len(call_tool_result.content))

        # Build a typed list of ToolResultContent.
        mapped_contents: list[ToolResultContent] = [
            mc
            for content in call_tool_result.content
            if (mc := self.map_mcp_content_to_tool_result_content(content)) is not None
        ]

        tool_error = is_error(call_tool_result)
        status: ToolResultStatus = "error" if tool_error else "success"
        self._log_debug_with_thread("tool execution completed with status: %s", status)
        result = MCPToolResult(
            status=status,
            toolUseId=tool_use_id,
            content=mapped_contents,
        )

        # `is not None`, not truthiness: the 2026-07-28 spec allows any JSON
        # value here, so 0, False, "", [], and {} are all valid payloads.
        structured_payload = structured_content(call_tool_result)
        if structured_payload is not None:
            result["structuredContent"] = structured_payload
        if call_tool_result.meta:
            result["metadata"] = call_tool_result.meta
        if tool_error is not None:
            result["isError"] = tool_error

        return result

    async def _async_background_thread(self) -> None:
        """Asynchronous method that runs in the background thread to manage the MCP connection.

        This method establishes the transport connection, creates and initializes the MCP session,
        signals readiness to the main thread, and waits for a close signal.
        """
        self._log_debug_with_thread("starting async background thread for MCP connection")

        # Initialized here so that it has the asyncio loop
        self._close_future = asyncio.Future()

        try:
            async with self._transport_callable() as (read_stream, write_stream, *_):
                self._log_debug_with_thread("transport connection established")
                async with ClientSession(
                    read_stream,
                    write_stream,
                    message_handler=self._handle_session_message,
                    elicitation_callback=self._elicitation_callback,
                    client_info=(
                        Implementation(
                            name=self._application_name,
                            version=self._application_version or pkg_version("strands-agents"),
                        )
                        if self._application_name
                        else None
                    ),
                    **task_session_kwargs(self._is_tasks_enabled()),
                ) as session:
                    self._log_debug_with_thread("initializing MCP session")
                    instructions, caps = await negotiate_session(session)

                    self._log_debug_with_thread("session initialized successfully")
                    # Store server instructions from the handshake for Host applications
                    self.server_instructions = instructions
                    # Store the session for use while we await the close event
                    self._background_thread_session = session

                    # Capabilities are exchanged during the handshake, so this is available now
                    self._server_task_capable = server_task_capable(caps)
                    self._log_debug_with_thread(
                        "server_task_capable=<%s> | cached server task capability", self._server_task_capable
                    )

                    async with AsyncExitStack() as session_scope:
                        if self._on_tools_changed is not None:
                            # Bounded so a server that accepts the listen request but never
                            # acknowledges it cannot hold start() past its startup timeout.
                            try:
                                subscription = await asyncio.wait_for(
                                    session_scope.enter_async_context(tools_changed_subscription(session)),
                                    timeout=self._startup_timeout,
                                )
                            except asyncio.TimeoutError as timeout_error:
                                raise MCPClientInitializationError(
                                    "timed out opening the tools list-changed subscription"
                                ) from timeout_error
                            self._log_debug_with_thread(
                                "subscribed=<%s> | tools list-changed notifications ready", subscription is not None
                            )

                        # Signal that the session has been created and is ready for use
                        self._init_future.set_result(None)

                        self._log_debug_with_thread("waiting for close signal")
                        # Keep background thread running until signaled to close.
                        # Thread is not blocked as this a future
                        await self._close_future

                        self._log_debug_with_thread("close signal received")
                        await self._drain_tools_refresh_tasks()
                        await self._drain_background_cleanup_tasks()
        except Exception as e:
            # If we encounter an exception and the future is still running,
            # it means it was encountered during the initialization phase.
            if not self._init_future.done():
                self._init_future.set_exception(e)
            else:
                # _close_future is automatically cancelled by the framework which doesn't provide us with the useful
                # exception, so instead we store the exception in a different field where stop() can read it
                self._close_exception = e
                if self._close_future and not self._close_future.done():
                    self._close_future.set_result(None)

                self._log_debug_with_thread(
                    "encountered exception on background thread after initialization %s", str(e)
                )

    # Raise an exception if the underlying client raises an exception in a message
    # This happens when the underlying client has an http timeout error
    async def _handle_session_message(self, message: Exception | Any) -> None:
        if isinstance(message, Exception):
            error_msg = str(message).lower()
            if any(pattern in error_msg for pattern in _NON_FATAL_ERROR_PATTERNS):
                self._log_debug_with_thread("ignoring non-fatal MCP session error: %s", message)
            else:
                raise message
        elif is_tools_list_changed(message) and self._on_tools_changed is not None:
            self._log_debug_with_thread("received tools list-changed notification")
            refresh_task = asyncio.create_task(self._handle_tools_changed())
            self._tools_refresh_tasks.add(refresh_task)
            refresh_task.add_done_callback(self._tools_refresh_tasks.discard)
        await anyio.lowlevel.checkpoint()

    async def _handle_tools_changed(self) -> None:
        """Refresh the tool list after a list-changed notification.

        Runs on the background event loop. One refresh runs at a time;
        notifications that arrive while a round is sleeping or refreshing
        fold into a single trailing rerun, so a burst costs at most two
        refreshes.
        """
        if self._tools_refresh_in_progress:
            self._tools_refresh_pending = True
            return
        self._tools_refresh_in_progress = True
        try:
            while True:
                self._tools_refresh_pending = False
                await asyncio.sleep(_TOOLS_CHANGED_DEBOUNCE_SECONDS)
                try:
                    await asyncio.to_thread(self._refresh_loaded_tools)
                except Exception as error:
                    # One failed round must not discard a queued trailing rerun.
                    logger.warning("error=<%s> | failed to refresh tools after list-changed notification", error)
                if not self._tools_refresh_pending:
                    return
        finally:
            self._tools_refresh_in_progress = False

    def _refresh_loaded_tools(self) -> None:
        """Re-list every tool and invoke the change callback.

        Runs off the event loop thread because `list_tools_sync` blocks on
        work it submits back to the background loop.
        """
        previous_names = [tool.tool_name for tool in self._loaded_tools or []]
        refreshed_tools = self._list_all_tools_sync()
        self._loaded_tools = refreshed_tools
        self._log_debug_with_thread("refreshed_tools=<%d> | tools refresh complete", len(refreshed_tools))
        callback = self._on_tools_changed
        if callback is None:
            return
        try:
            callback(previous_names, refreshed_tools)
        except Exception:
            # The cache is already refreshed; only the notification to the
            # consumer failed, so name the callback rather than the refresh.
            logger.warning("the on_tools_changed callback raised", exc_info=True)

    def _background_task(self) -> None:
        """Sets up and runs the event loop in the background thread.

        This method creates a new event loop for the background thread,
        sets it as the current event loop, and runs the async_background_thread
        coroutine until completion. In this case "until completion" means until the _close_future is resolved.
        This allows for a long-running event loop.
        """
        self._log_debug_with_thread("setting up background task event loop")
        # Clear any running-loop state leaked by OpenTelemetry's ThreadingInstrumentor, which wraps Thread.run()
        # and can propagate the parent thread's event loop reference, causing run_until_complete() to fail.
        asyncio._set_running_loop(None)
        self._background_thread_event_loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._background_thread_event_loop)
        self._background_thread_event_loop.run_until_complete(self._async_background_thread())

    def map_mcp_content_to_tool_result_content(
        self,
        content: MCPTextContent | MCPImageContent | MCPEmbeddedResource | Any,
    ) -> ToolResultContent | None:
        """Maps MCP content types to tool result content types.

        This method converts MCP-specific content types to the generic
        ToolResultContent format used by the agent framework. Subclasses can
        override this to intercept or transform specific content blocks before
        they reach the model.

        Args:
            content: The MCP content to convert

        Returns:
            ToolResultContent or None: The converted content, or None if the content type is not supported
        """
        if isinstance(content, MCPTextContent):
            self._log_debug_with_thread("mapping MCP text content")
            return {"text": content.text}
        elif isinstance(content, MCPImageContent):
            image_mime = cast(str, mime_type(content))
            self._log_debug_with_thread("mapping MCP image content with mime type: %s", image_mime)
            return {
                "image": {
                    "format": MIME_TO_FORMAT[image_mime],
                    "source": {"bytes": base64.b64decode(content.data)},
                }
            }
        elif isinstance(content, MCPEmbeddedResource):
            """
            TODO: Include URI information in results.
                Models may find it useful to be aware not only of the information,
                but the location of the information too.

                This may be difficult without taking an opinionated position. For example,
                a content block may need to indicate that the following Image content block
                is of particular URI.
            """

            self._log_debug_with_thread("mapping MCP embedded resource content")

            resource = content.resource
            if isinstance(resource, TextResourceContents):
                return {"text": resource.text}
            elif isinstance(resource, BlobResourceContents):
                try:
                    raw_bytes = base64.b64decode(resource.blob)
                except Exception:
                    self._log_debug_with_thread("embedded resource blob could not be decoded - dropping")
                    return None

                resource_mime = mime_type(resource)
                if resource_mime and (
                    resource_mime.startswith("text/")
                    or resource_mime
                    in (
                        "application/json",
                        "application/xml",
                        "application/javascript",
                        "application/yaml",
                        "application/x-yaml",
                    )
                    or resource_mime.endswith(("+json", "+xml"))
                ):
                    try:
                        return {"text": raw_bytes.decode("utf-8", errors="replace")}
                    except Exception:
                        pass

                if resource_mime in MIME_TO_FORMAT:
                    return {
                        "image": {
                            "format": MIME_TO_FORMAT[resource_mime],
                            "source": {"bytes": raw_bytes},
                        }
                    }

                self._log_debug_with_thread("embedded resource blob with non-textual/unknown mimeType - dropping")
                return None

            return None  # type: ignore[unreachable]  # Defensive: future MCP resource types
        else:
            self._log_debug_with_thread("unhandled content type: %s - dropping content", content.__class__.__name__)
            return None

    def _log_debug_with_thread(self, msg: str, *args: Any, **kwargs: Any) -> None:
        """Logger helper to help differentiate logs coming from MCPClient background thread."""
        formatted_msg = msg % args if args else msg
        logger.debug(
            "[Thread: %s, Session: %s] %s", threading.current_thread().name, self._session_id, formatted_msg, **kwargs
        )

    def _track_background_cleanup_task(self, task: asyncio.Task[Any]) -> None:
        """Retain a detached cleanup task while the MCP session can still service it."""
        if not self._accept_background_cleanup_tasks:
            task.cancel()
            task.add_done_callback(lambda done: done.exception() if not done.cancelled() else None)
            return
        self._background_cleanup_tasks.add(task)
        task.add_done_callback(self._background_cleanup_tasks.discard)

    async def _drain_tools_refresh_tasks(self) -> None:
        """Let in-flight tool refreshes unwind before the background loop stops.

        A refresh worker thread blocks on a future served by this loop; once
        the close signal has fired, that future resolves promptly, so waiting
        here keeps the worker from being stranded on a future a stopped loop
        can never resolve (a stranded worker is a non-daemon thread that
        hangs interpreter exit).
        """
        if not self._tools_refresh_tasks:
            return
        pending_refreshes = set(self._tools_refresh_tasks)
        _, still_pending = await asyncio.wait(pending_refreshes, timeout=1)
        for task in still_pending:
            task.cancel()
        if still_pending:
            await asyncio.wait(still_pending, timeout=1)

    async def _drain_background_cleanup_tasks(self) -> None:
        """Give detached MCP cancellation cleanup a bounded window before session shutdown."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + 1
        while self._background_cleanup_tasks and loop.time() < deadline:
            timeout = max(0, deadline - loop.time())
            await asyncio.wait(set(self._background_cleanup_tasks), timeout=timeout)

        # Stop delayed callbacks from enqueueing work after the session has started closing.
        self._accept_background_cleanup_tasks = False
        pending = set(self._background_cleanup_tasks)
        for task in pending:
            task.cancel()
        if pending:
            done, still_pending = await asyncio.wait(pending, timeout=0.1)
            for task in done:
                if not task.cancelled():
                    task.exception()
            for task in still_pending:
                task.add_done_callback(lambda done: done.exception() if not done.cancelled() else None)
        self._background_cleanup_tasks.clear()

    async def _cancel_tool_call(self, cancellation_state: _CallCancellationState) -> None:
        """Cancel the exact MCP task or request represented by the per-call state.

        Hand-sending `notifications/cancelled` is 1.x-only work: on 2.x no request id is captured, so this returns
        without sending, and the dispatcher sends the cancel itself when the task awaiting the request is cancelled
        (SEP-2575 scopes hand-sent cancellation to STDIO).
        """
        session = cancellation_state.get("session")
        if session is None or cancellation_state.get("notification_sent"):
            return

        try:
            cancellation: Coroutine[Any, Any, Any]
            if task_id := cancellation_state.get("task_id"):
                if MCP_V2:
                    cancellation = self._cancel_task_async(task_id)
                else:
                    cancellation = session.experimental.cancel_task(task_id)  # type: ignore[attr-defined]
            elif (request_id := cancellation_state.get("request_id")) is not None:
                cancellation = session.send_notification(
                    ClientNotification(
                        CancelledNotification(  # type: ignore[operator]
                            params=CancelledNotificationParams(
                                requestId=request_id,  # type: ignore[call-arg]
                                reason="Strands agent invocation cancelled",
                            )
                        )
                    )
                )
            else:
                return
            cancellation_state["notification_sent"] = True
            cancellation_task = asyncio.create_task(cancellation)
            self._track_background_cleanup_task(cancellation_task)
            done, pending = await asyncio.wait({cancellation_task}, timeout=1)
            if done:
                await cancellation_task
            else:
                cancellation_task.cancel()
                cancellation_task.add_done_callback(lambda task: task.exception() if not task.cancelled() else None)
        except Exception as error:
            self._log_debug_with_thread("error=<%s> | failed to notify MCP server of cancellation", str(error))

    def _invoke_on_background_thread(
        self,
        coro: Coroutine[Any, Any, T],
        cancel_signal: threading.Event | None = None,
        cancellation_state: _CallCancellationState | None = None,
    ) -> futures.Future[T]:
        # save a reference to this so that even if it's reset we have the original
        close_future = self._close_future

        if (
            self._background_thread_session is None
            or self._background_thread_event_loop is None
            or close_future is None
        ):
            raise MCPClientInitializationError("the client session was not initialized")

        async def run_async() -> T:
            if cancel_signal is not None and cancel_signal.is_set():
                coro.close()
                raise _MCPCallCancelledError("Tool execution cancelled")

            invoke_event = asyncio.create_task(coro)
            invoke_cancel_requested = False
            cancel_event: asyncio.Task[None] | None = None

            if cancel_signal is not None:

                async def wait_for_cancel() -> None:
                    # threading.Event has no async notification hook. Poll on this loop rather than
                    # running Event.wait() in an executor: cancelling that await cannot stop a worker
                    # already blocked in Event.wait(), so successful calls could strand worker threads.
                    while not cancel_signal.is_set():
                        await asyncio.sleep(0.05)

                cancel_event = asyncio.create_task(wait_for_cancel())

            tasks: list[asyncio.Task[Any] | asyncio.Future[Any]] = [invoke_event, close_future]
            if cancel_event is not None:
                tasks.append(cancel_event)

            try:
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)

                if cancel_signal is not None and cancel_signal.is_set():
                    self._log_debug_with_thread("cancellation detected during MCP invocation")
                    invoke_cancel_requested = True
                    invoke_event.cancel()
                    _, pending = await asyncio.wait({invoke_event}, timeout=1)
                    if pending:
                        self._log_debug_with_thread("timed out cleaning up cancelled MCP invocation")
                    if cancellation_state is not None:
                        await self._cancel_tool_call(cancellation_state)
                    raise _MCPCallCancelledError("Tool execution cancelled")
                if invoke_event in done:
                    return await invoke_event

                self._log_debug_with_thread("event loop for the server closed before the invoke completed")
                invoke_event.cancel()
                await asyncio.wait({invoke_event}, timeout=1)
                raise RuntimeError("Connection to the MCP server was closed")
            finally:
                if not invoke_event.done() and not invoke_cancel_requested:
                    invoke_event.cancel()
                    # asyncio.wait reports expiration through pending; it does not raise TimeoutError.
                    # The original caller cancellation or exception continues after this bounded cleanup.
                    _, pending = await asyncio.wait({invoke_event}, timeout=1)
                    if pending:
                        self._log_debug_with_thread("MCP invocation did not finish within bounded cancellation cleanup")
                    if cancellation_state is not None:
                        await self._cancel_tool_call(cancellation_state)
                else:
                    pending = {invoke_event} if not invoke_event.done() else set()
                if pending:
                    self._track_background_cleanup_task(invoke_event)
                if cancel_event is not None and not cancel_event.done():
                    cancel_event.cancel()
                    await asyncio.gather(cancel_event, return_exceptions=True)

        invoke_future = asyncio.run_coroutine_threadsafe(coro=run_async(), loop=self._background_thread_event_loop)
        return invoke_future

    def _should_include_tool_with_filters(self, tool: MCPAgentTool, filters: ToolFilters | None) -> bool:
        """Check if a tool should be included based on provided filters."""
        if not filters:
            return True

        # Apply allowed filter
        if "allowed" in filters:
            if not self._matches_patterns(tool, filters["allowed"]):
                return False

        # Apply rejected filter
        if "rejected" in filters:
            if self._matches_patterns(tool, filters["rejected"]):
                return False

        return True

    def _matches_patterns(self, tool: MCPAgentTool, patterns: list[_ToolMatcher]) -> bool:
        """Check if tool matches any of the given patterns."""
        for pattern in patterns:
            if callable(pattern):
                if pattern(tool):
                    return True
            elif isinstance(pattern, Pattern):
                if pattern.match(tool.mcp_tool.name):
                    return True
            elif isinstance(pattern, str):
                if pattern == tool.mcp_tool.name:
                    return True
        return False

    def _is_session_active(self) -> bool:
        if self._background_thread is None or not self._background_thread.is_alive():
            return False

        if self._close_future is not None and self._close_future.done():
            return False

        return True

    def _is_tasks_enabled(self) -> bool:
        """Check if tasks feature is enabled.

        Tasks are enabled if tasks config is defined and not None.

        Returns:
            True if task-augmented execution is enabled, False otherwise.
        """
        return self._tasks_config is not None

    def _get_task_config(self) -> TasksConfig:
        """Returns the task execution configuration, configured with defaults if not specified."""
        task_config = self._tasks_config or DEFAULT_TASK_CONFIG
        return TasksConfig(
            ttl=task_config.get("ttl", DEFAULT_TASK_TTL),
            poll_timeout=task_config.get("poll_timeout", DEFAULT_TASK_POLL_TIMEOUT),
            request_timeout=task_config.get("request_timeout", DEFAULT_TASK_REQUEST_TIMEOUT),
            poll_interval=task_config.get("poll_interval", DEFAULT_TASK_POLL_INTERVAL),
        )

    def _has_server_task_support(self) -> bool:
        """Check if the MCP server supports task-augmented tool calls.

        Returns the capability value that was cached immediately after session initialization.
        Server capabilities are exchanged during the MCP handshake, so this is available
        as soon as start() completes.

        Returns:
            True if server supports task-augmented tool calls, False otherwise.
        """
        return self._server_task_capable or False

    def _should_use_task(self, tool_name: str) -> bool:
        """Determine if task-augmented execution should be used for a tool.

        Task-augmented execution requires:
        1. tasks config is enabled (opt-in check)
        2. Server supports tasks (capability check)
        3. Tool taskSupport is 'required' or 'optional'

        Args:
            tool_name: Name of the tool to check.

        Returns:
            True if task-augmented execution should be used, False otherwise.
        """
        # Opt-in check: tasks must be explicitly enabled via tasks config
        if not self._is_tasks_enabled():
            return False

        if MCP_V2:
            return self._has_server_task_support()

        # Local import to avoid errors on old SDK versions that don't support Tasks
        from mcp.types import TASK_OPTIONAL, TASK_REQUIRED  # type: ignore[attr-defined]

        # Server capability check (per MCP spec)
        if not self._has_server_task_support():
            return False

        # Tool-level capability check (cached during list_tools_sync)
        task_support = self._tool_task_support_cache.get(tool_name)

        # Use tasks for TASK_REQUIRED or TASK_OPTIONAL when server supports
        if task_support == TASK_REQUIRED or task_support == TASK_OPTIONAL:
            return True

        # Default: 'forbidden', None, or unknown -> don't use tasks
        return False

    def _create_task_error_result(self, message: str) -> MCPCallToolResult:
        """Create an error MCPCallToolResult with consistent formatting.

        This helper reduces duplication in task error handling paths.

        Args:
            message: The error message to include in the result.

        Returns:
            MCPCallToolResult with isError=True and the message as text content.
        """
        return MCPCallToolResult(  # type: ignore[call-arg]
            isError=True,
            content=[MCPTextContent(type="text", text=message)],
        )

    # ==================================================================================
    # Task-Augmented Tool Execution
    # ==================================================================================
    #
    # MCP 2.x uses finalized SEP-2663: tools/call returns an immediate result or task,
    # followed by tasks/get, tasks/update, and tasks/cancel as needed. MCP 1.x retains
    # the legacy 2025-11-25 workflow implemented below the MCP 2.x lifecycle.
    # ==================================================================================

    def _require_v2_task_lifecycle(self) -> ClientSession:
        """Return the active session after validating SEP-2663 availability."""
        if not MCP_V2:
            raise RuntimeError("SEP-2663 task operations require mcp 2.x")
        if not self._is_tasks_enabled():
            raise RuntimeError("SEP-2663 task operations require MCPClient tasks_config")
        if not self._has_server_task_support():
            raise RuntimeError(f"MCP server did not advertise the {_TASKS_EXTENSION} extension")

        session = cast(ClientSession, self._background_thread_session)
        if getattr(session, "protocol_version", None) != _TASKS_PROTOCOL_VERSION:
            raise RuntimeError(f"SEP-2663 task operations require negotiated MCP protocol {_TASKS_PROTOCOL_VERSION}")
        return session

    async def _call_tool_with_task_once_async(
        self,
        name: str,
        arguments: dict[str, Any] | None,
        read_timeout_seconds: timedelta | None,
        meta: dict[str, Any] | None,
        progress_callback: ProgressFnT | None,
    ) -> MCPCallToolResult | MCPCreateTaskResult:
        """Invoke MCP 2.x ``tools/call`` and resolve any core input-required rounds."""
        if not MCP_V2:
            raise RuntimeError("SEP-2663 task-aware tool calls require mcp 2.x")

        result = await compat_call_tool(
            cast(ClientSession, self._background_thread_session),
            name,
            arguments,
            read_timeout_seconds,
            progress_callback,
            meta,
            allow_claimed=True,
        )
        return cast(MCPCallToolResult | MCPCreateTaskResult, result)

    async def _get_task_async(self, task_id: str, read_timeout_seconds: timedelta | None = None) -> MCPGetTaskResult:
        """Send a finalized ``tasks/get`` request."""
        session = cast(Any, self._require_v2_task_lifecycle())
        timeout = read_timeout_seconds or self._get_task_config().get("request_timeout", DEFAULT_TASK_REQUEST_TIMEOUT)
        result = cast(
            MCPGetTaskResult,
            await session.send_request(
                _GetTaskRequest(params=_GetTaskRequestParams(task_id=task_id)),
                MCPGetTaskResult,
                request_read_timeout_seconds=read_timeout(timeout),
            ),
        )
        if result.task_id != task_id:
            raise ValueError("MCP tasks/get response returned a different taskId")
        return result

    async def _update_task_async(
        self,
        task_id: str,
        input_responses: MCPInputResponses,
        read_timeout_seconds: timedelta | None = None,
    ) -> MCPUpdateTaskResult:
        """Send a finalized ``tasks/update`` request."""
        session = cast(Any, self._require_v2_task_lifecycle())
        timeout = read_timeout_seconds or self._get_task_config().get("request_timeout", DEFAULT_TASK_REQUEST_TIMEOUT)
        return cast(
            MCPUpdateTaskResult,
            await session.send_request(
                _UpdateTaskRequest(params=_UpdateTaskRequestParams(task_id=task_id, input_responses=input_responses)),
                MCPUpdateTaskResult,
                request_read_timeout_seconds=read_timeout(timeout),
            ),
        )

    async def _cancel_task_async(
        self, task_id: str, read_timeout_seconds: timedelta | None = None
    ) -> MCPCancelTaskResult:
        """Send a finalized ``tasks/cancel`` request."""
        session = cast(Any, self._require_v2_task_lifecycle())
        timeout = read_timeout_seconds or self._get_task_config().get("request_timeout", DEFAULT_TASK_REQUEST_TIMEOUT)
        return cast(
            MCPCancelTaskResult,
            await session.send_request(
                _CancelTaskRequest(params=_CancelTaskRequestParams(task_id=task_id)),
                MCPCancelTaskResult,
                request_read_timeout_seconds=read_timeout(timeout),
            ),
        )

    async def _fulfill_task_input(
        self,
        task_id: str,
        key: str,
        request: MCPInputRequest,
        read_timeout_seconds: timedelta,
    ) -> None:
        """Fulfill one input request carried by an input-required task."""
        import mcp.types as mcp_types
        from mcp.client.session import ClientRequestContext  # type: ignore[attr-defined]

        session = cast(Any, self._require_v2_task_lifecycle())
        params = getattr(request, "params", None)
        context = ClientRequestContext(
            session=session,
            request_id=key,
            meta=getattr(params, "meta", None),
        )
        response = await session.dispatch_input_request(context, request)
        error_data_type = mcp_types.ErrorData
        if isinstance(response, error_data_type):
            raise MCPError.from_error_data(response)
        await self._update_task_async(task_id, {key: response}, read_timeout_seconds)

    def _resolve_v2_terminal_state(self, state: MCPGetTaskResult) -> MCPCallToolResult | None:
        """Map a terminal task state to its final tool result, or None when not terminal."""
        if state.status == "completed":
            return cast(MCPCallToolResult, state.result)
        if state.status == "failed":
            error = cast(MCPTaskError, state.error)
            message = f"{error.message}: {state.status_message}" if state.status_message else error.message
            return self._create_task_error_result(message)
        if state.status == "cancelled":
            return self._create_task_error_result(state.status_message or "Task was cancelled")
        return None

    async def _fulfill_v2_input_requests(
        self,
        task_id: str,
        state: MCPGetTaskResult,
        answered_input_keys: set[str],
        request_timeout: timedelta,
    ) -> None:
        """Answer each not-yet-answered input request reported by the task."""
        for key, request in (state.input_requests or {}).items():
            if key in answered_input_keys:
                continue
            await self._fulfill_task_input(task_id, key, request, request_timeout)
            answered_input_keys.add(key)

    async def _complete_v2_task(
        self,
        task: MCPCreateTaskResult,
        cancellation_state: _CallCancellationState | None,
    ) -> MCPCallToolResult:
        """Poll a SEP-2663 task and return its final nested tool result."""
        config = self._get_task_config()
        request_timeout = config.get("request_timeout", DEFAULT_TASK_REQUEST_TIMEOUT)
        default_poll_interval = config.get("poll_interval", DEFAULT_TASK_POLL_INTERVAL)
        current: MCPCreateTaskResult | MCPGetTaskResult = task
        stale_read = False
        answered_input_keys: set[str] = set()

        if cancellation_state is not None:
            cancellation_state["task_id"] = task.task_id

        while True:
            if isinstance(current, MCPGetTaskResult):
                terminal_result = self._resolve_v2_terminal_state(current)
                if terminal_result is not None:
                    return terminal_result
                if current.status == "input_required":
                    await self._fulfill_v2_input_requests(task.task_id, current, answered_input_keys, request_timeout)

            poll_interval_ms = current.poll_interval_ms
            poll_interval = (
                timedelta(milliseconds=poll_interval_ms) if poll_interval_ms is not None else default_poll_interval
            )
            if stale_read or current.status == "working" or isinstance(current, MCPGetTaskResult):
                await asyncio.sleep(max(0.01, poll_interval.total_seconds()))

            next_state = await self._get_task_async(task.task_id, request_timeout)
            current = self._reconcile_v2_task_state(current, next_state)
            stale_read = current is not next_state

    @staticmethod
    def _reconcile_v2_task_state(
        previous: MCPCreateTaskResult | MCPGetTaskResult,
        next_state: MCPGetTaskResult,
    ) -> MCPCreateTaskResult | MCPGetTaskResult:
        """Reject contradictory task updates and keep the newer of two observed states.

        Timestamps are compared as instants, not strings, so a server spelling
        the same moment differently (``Z`` vs ``+00:00``, varying fractional
        precision) is not treated as a contradiction. A stale read returns the
        previous state so the caller re-polls instead of failing.
        """
        if _parse_task_timestamp(next_state.created_at) != _parse_task_timestamp(previous.created_at):
            raise ValueError("MCP task response changed createdAt")

        if _parse_task_timestamp(next_state.last_updated_at) < _parse_task_timestamp(previous.last_updated_at):
            return previous

        return next_state

    async def _create_v2_task(
        self,
        name: str,
        arguments: dict[str, Any] | None,
        meta: dict[str, Any] | None,
        progress_callback: ProgressFnT | None,
        task_state: _CallCancellationState,
    ) -> MCPCallToolResult | MCPCreateTaskResult:
        """Send the SEP-2663 create round without losing a task to cancellation.

        The round is shielded so a cancellation arriving while ``tools/call``
        is in flight cannot discard a task the server already created: a
        handle that lands within the grace period is cancelled immediately,
        and a later-arriving one is cancelled by a detached callback.
        """
        create_task = asyncio.create_task(
            self._call_tool_with_task_once_async(
                name,
                arguments,
                self._get_task_config().get("request_timeout", DEFAULT_TASK_REQUEST_TIMEOUT),
                meta,
                progress_callback,
            )
        )
        try:
            result = await asyncio.shield(create_task)
        except asyncio.CancelledError:
            done, _ = await asyncio.wait({create_task}, timeout=1)
            if done:
                self._record_v2_task_handle(create_task, task_state)
                if task_state.get("task_id") is not None:
                    await self._cancel_tool_call(task_state)
            else:

                def cancel_delayed_create(finished: "asyncio.Task[MCPCallToolResult | MCPCreateTaskResult]") -> None:
                    self._record_v2_task_handle(finished, task_state)
                    if task_state.get("task_id") is not None:
                        cleanup_task = asyncio.create_task(self._cancel_tool_call(task_state))
                        self._track_background_cleanup_task(cleanup_task)

                self._track_background_cleanup_task(create_task)
                create_task.add_done_callback(cancel_delayed_create)
            raise
        if isinstance(result, MCPCreateTaskResult):
            task_state["task_id"] = result.task_id
        return result

    @staticmethod
    def _record_v2_task_handle(
        create_task: "asyncio.Task[MCPCallToolResult | MCPCreateTaskResult]",
        task_state: _CallCancellationState,
    ) -> None:
        """Record the task id from a finished create round, if it produced a task."""
        if create_task.cancelled() or create_task.exception() is not None:
            return
        result = create_task.result()
        if isinstance(result, MCPCreateTaskResult):
            task_state["task_id"] = result.task_id

    async def _call_tool_with_task_and_poll_async(
        self,
        name: str,
        arguments: dict[str, Any] | None = None,
        poll_timeout: timedelta | None = None,
        meta: dict[str, Any] | None = None,
        progress_callback: ProgressFnT | None = None,
        cancellation_state: _CallCancellationState | None = None,
    ) -> MCPCallToolResult:
        """Call a tool and automatically complete a returned SEP-2663 task.

        The lifecycle is validated before the create request is sent, and the
        server task is cancelled on every exit other than success once its
        handle exists.
        """
        timeout = poll_timeout or self._get_task_config().get("poll_timeout", DEFAULT_TASK_POLL_TIMEOUT)
        task_state = cancellation_state if cancellation_state is not None else _CallCancellationState()
        task_state["session"] = cast(ClientSession, self._background_thread_session)

        async def execute() -> MCPCallToolResult:
            self._require_v2_task_lifecycle()
            result = await self._create_v2_task(name, arguments, meta, progress_callback, task_state)
            if isinstance(result, MCPCallToolResult):
                return result
            return await self._complete_v2_task(result, task_state)

        try:
            return await asyncio.wait_for(execute(), timeout=timeout.total_seconds())
        except asyncio.TimeoutError:
            task_id = task_state.get("task_id")
            if task_id is not None:
                await self._cancel_tool_call(task_state)
            return self._create_task_error_result(
                f"Task {task_id or '<pending>'} timed out after {timeout.total_seconds()} seconds"
            )
        except BaseException:
            if task_state.get("task_id") is not None:
                await self._cancel_tool_call(task_state)
            raise

    async def _call_tool_as_task_and_poll_async(
        self,
        name: str,
        arguments: dict[str, Any] | None = None,
        ttl: timedelta | None = None,
        poll_timeout: timedelta | None = None,
        meta: dict[str, Any] | None = None,
        cancellation_state: _CallCancellationState | None = None,
    ) -> MCPCallToolResult:
        """Call a tool using task-augmented execution and poll until completion.

        This method implements the MCP task workflow:
        1. Creates a task via call_tool_as_task
        2. Polls using poll_task until terminal status (with timeout protection)
        3. Gets the final result using get_task_result

        Args:
            name: Name of the tool to call.
            arguments: Optional arguments to pass to the tool.
            ttl: Task time-to-live. Uses configured value if not specified.
            poll_timeout: Timeout for polling. Uses configured value if not specified.
            meta: Optional metadata to pass to the tool call per MCP spec (_meta).
            cancellation_state: Internal state used to cancel the exact MCP request or task.

        Returns:
            MCPCallToolResult: The final tool result after task completion.
        """
        # Local import to avoid errors on old SDK versions that don't support Tasks
        from mcp.types import (  # type: ignore[attr-defined]
            TASK_STATUS_CANCELLED,
            TASK_STATUS_COMPLETED,
            TASK_STATUS_FAILED,
            GetTaskResult,
        )

        session = cast(ClientSession, self._background_thread_session)

        # Precedence: arg > config > default
        timeout = poll_timeout or self._get_task_config().get("poll_timeout", DEFAULT_TASK_POLL_TIMEOUT)
        ttl = ttl or self._get_task_config().get("ttl", DEFAULT_TASK_TTL)
        ttl_ms = int(ttl.total_seconds() * 1000)

        # Step 1: Create the task
        self._log_debug_with_thread("tool=<%s> | calling tool as task with ttl=%d ms", name, ttl_ms)
        if cancellation_state is not None:
            cancellation_state["session"] = session
        create_task = asyncio.create_task(
            session.experimental.call_tool_as_task(  # type: ignore[attr-defined]
                name=name,
                arguments=arguments,
                ttl=ttl_ms,
                meta=meta,
            )
        )
        try:
            create_result = await asyncio.shield(create_task)
        except asyncio.CancelledError:
            done, _ = await asyncio.wait({create_task}, timeout=1)
            if done:
                create_result = create_task.result()
                if cancellation_state is not None:
                    cancellation_state["task_id"] = create_result.task.taskId
                    await self._cancel_tool_call(cancellation_state)
            else:

                def cancel_delayed_task(task: asyncio.Task[Any]) -> None:
                    if task.cancelled():
                        return
                    try:
                        result = task.result()
                    except Exception:
                        return
                    if cancellation_state is not None:
                        cancellation_state["task_id"] = result.task.taskId
                        cleanup_task = asyncio.create_task(self._cancel_tool_call(cancellation_state))
                        self._track_background_cleanup_task(cleanup_task)

                self._track_background_cleanup_task(create_task)
                create_task.add_done_callback(cancel_delayed_task)
            raise
        task_id = create_result.task.taskId
        if cancellation_state is not None:
            cancellation_state["task_id"] = task_id
        self._log_debug_with_thread("tool=<%s>, task_id=<%s> | task created", name, task_id)

        # Step 2: Poll until terminal status (with timeout protection)
        # Note: Using asyncio.wait_for() instead of asyncio.timeout() for Python 3.10 compatibility
        async def _poll_until_terminal() -> GetTaskResult | None:
            """Inner function to poll task status until terminal state."""
            final = None
            async for task in session.experimental.poll_task(task_id):  # type: ignore[attr-defined]
                self._log_debug_with_thread(
                    "tool=<%s>, task_id=<%s>, status=<%s> | task status update",
                    name,
                    task_id,
                    task.status,
                )
                final = task
            return final

        try:
            final_status = await asyncio.wait_for(_poll_until_terminal(), timeout=timeout.total_seconds())
        except asyncio.TimeoutError:
            self._log_debug_with_thread(
                "tool=<%s>, task_id=<%s>, timeout_seconds=<%s> | task polling timed out",
                name,
                task_id,
                timeout.total_seconds(),
            )
            return self._create_task_error_result(
                f"Task {task_id} polling timed out after {timeout.total_seconds()} seconds"
            )

        # Step 3: Handle terminal status
        if final_status is None:
            self._log_debug_with_thread("tool=<%s>, task_id=<%s> | polling completed without status", name, task_id)
            return self._create_task_error_result(f"Task {task_id} polling completed without status")

        if final_status.status == TASK_STATUS_FAILED:
            error_msg = final_status.statusMessage or "Task failed"  # type: ignore[attr-defined]
            self._log_debug_with_thread("tool=<%s>, task_id=<%s>, error=<%s> | task failed", name, task_id, error_msg)
            return self._create_task_error_result(error_msg)

        if final_status.status == TASK_STATUS_CANCELLED:
            self._log_debug_with_thread("tool=<%s>, task_id=<%s> | task was cancelled", name, task_id)
            return self._create_task_error_result("Task was cancelled")

        # Step 4: Get the actual result for completed tasks (with error handling for race conditions)
        if final_status.status == TASK_STATUS_COMPLETED:
            self._log_debug_with_thread("tool=<%s>, task_id=<%s> | task completed, fetching result", name, task_id)
            try:
                experimental_session = session.experimental  # type: ignore[attr-defined]
                result = await experimental_session.get_task_result(task_id, MCPCallToolResult)
                self._log_debug_with_thread("tool=<%s>, task_id=<%s> | task result retrieved", name, task_id)
                return result  # type: ignore[no-any-return]
            except Exception as e:
                # Handle race condition: task completed but result retrieval failed
                # (e.g., result expired, network error, server restarted)
                self._log_debug_with_thread(
                    "tool=<%s>, task_id=<%s>, error=<%s> | failed to retrieve task result", name, task_id, str(e)
                )
                return self._create_task_error_result(f"Task completed but result retrieval failed: {str(e)}")

        # Unexpected status - return as error
        self._log_debug_with_thread(
            "tool=<%s>, task_id=<%s>, status=<%s> | unexpected task status",
            name,
            task_id,
            final_status.status,
        )
        return self._create_task_error_result(f"Unexpected task status: {final_status.status}")


class _InMemoryTokenStorage:
    """Process-lifetime OAuth token storage for machine-to-machine credentials.

    The client_credentials grant re-authenticates with the stored secret whenever the access
    token expires, so tokens only need to live as long as the client instance.
    """

    def __init__(self) -> None:
        self._tokens: OAuthToken | None = None
        self._client_info: OAuthClientInformationFull | None = None

    async def get_tokens(self) -> OAuthToken | None:
        return self._tokens

    async def set_tokens(self, tokens: OAuthToken) -> None:
        self._tokens = tokens

    async def get_client_info(self) -> OAuthClientInformationFull | None:
        return self._client_info

    async def set_client_info(self, client_info: OAuthClientInformationFull) -> None:
        self._client_info = client_info


def _build_client_credentials_auth(url: str, auth: MCPClientCredentials) -> httpx.Auth:
    """Build an httpx.Auth performing the OAuth client_credentials grant against the server.

    Error messages name only the offending keys, never their values, so credentials cannot
    leak into logs.

    Raises:
        ValueError: If `auth` is missing required keys or a value has the wrong type.
    """
    values = cast(dict[str, Any], auth)
    missing_keys = sorted({"client_id", "client_secret"} - values.keys())
    if missing_keys:
        raise ValueError(f"MCPClient: 'auth' is missing required keys: {missing_keys}")
    if not isinstance(values["client_id"], str) or not isinstance(values["client_secret"], str):
        raise ValueError("MCPClient: 'auth' requires 'client_id' and 'client_secret' to be strings")
    scopes = values.get("scopes")
    if scopes is not None and not (isinstance(scopes, list) and all(isinstance(scope, str) for scope in scopes)):
        raise ValueError("MCPClient: 'auth' requires 'scopes' to be a list of strings")
    return client_credentials_auth(
        server_url=url,
        storage=_InMemoryTokenStorage(),
        client_id=values["client_id"],
        client_secret=values["client_secret"],
        scope=" ".join(scopes) if scopes else None,
    )


def _resolve_transport_callable(
    transport_callable: Callable[[], MCPTransport] | None,
    *,
    url: str | None,
    headers: dict[str, str] | None,
    auth: MCPClientCredentials | None,
    auth_provider: httpx.Auth | None,
) -> Callable[[], MCPTransport]:
    """Resolve the MCPClient constructor arguments into a single transport callable.

    Enforces the constructor invariants: exactly one of `transport_callable` and `url`;
    `headers`, `auth`, and `auth_provider` require `url`; `auth` and `auth_provider` are
    mutually exclusive; `url` must be an http:// or https:// URL.
    """
    if transport_callable is not None and url:
        raise ValueError("MCPClient: provide either 'transport_callable' or 'url', not both")
    if transport_callable is None and not url:
        raise ValueError("MCPClient: either 'transport_callable' or 'url' must be provided")
    if transport_callable is not None:
        if auth is not None or auth_provider is not None or headers is not None:
            raise ValueError(
                "MCPClient: 'auth', 'auth_provider', and 'headers' require 'url' "
                "(not compatible with 'transport_callable')"
            )
        return transport_callable
    if auth is not None and auth_provider is not None:
        raise ValueError("MCPClient: provide either 'auth' or 'auth_provider', not both")

    server_url = cast(str, url)
    scheme = urlparse(server_url).scheme
    if scheme not in ("http", "https"):
        raise ValueError(f"MCPClient: 'url' must be an http:// or https:// URL, got '{server_url}'")
    if scheme == "http" and (auth is not None or auth_provider is not None):
        logger.warning("url=<%s> | sending oauth credentials over plaintext http", server_url)
    resolved_auth = _build_client_credentials_auth(server_url, auth) if auth is not None else auth_provider
    return lambda: streamable_http_transport(url=server_url, headers=headers, auth=resolved_auth)


# Matches ${VAR} and ${env:VAR} where VAR is a valid environment variable identifier.
_ENV_VAR_PATTERN = re.compile(r"\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}")


def _load_servers_mapping(config: str | dict[str, Any]) -> dict[str, Any]:
    """Resolve the load_servers input into a mapping of server name to server config.

    Reads and parses the file when config is a path, then unwraps the optional ``mcpServers`` key
    so both wrapped and flat shapes are accepted.
    """
    if isinstance(config, str):
        file_path = config[len("file://") :] if config.startswith("file://") else config
        path = Path(file_path).expanduser()
        if not path.exists():
            raise FileNotFoundError(f"MCP configuration file not found: {file_path}")
        config_dict = json.loads(path.read_text())
    elif isinstance(config, dict):
        config_dict = config
    else:
        raise ValueError("config must be a file path string or a dictionary")

    servers = config_dict.get("mcpServers", config_dict) if isinstance(config_dict, dict) else None
    if not isinstance(servers, dict):
        raise ValueError(
            'MCP config must be a JSON object mapping server names to configs, e.g. {"my-server": {"command": "node"}}'
        )
    return servers


def _build_client_from_config(
    name: str, server: dict[str, Any], continue_on_error: bool, prefix_with_server_name: bool
) -> MCPClient:
    """Build a single MCPClient from one server entry.

    Interpolates ``${VAR}`` references first so secrets can live in the environment, then detects
    the transport and constructs the matching transport callable.
    """
    server = cast(dict[str, Any], _interpolate_env_vars(server))

    if server.get("command") and server.get("url") and not server.get("transport"):
        raise ValueError(f"server '{name}' has both 'command' and 'url' — set 'transport' explicitly or remove one")

    transport = server.get("transport")
    if transport is None:
        transport = "stdio" if server.get("command") else "streamable-http" if server.get("url") else None
    if transport is None:
        raise ValueError(f"server '{name}' must include either 'command' (stdio) or 'url' (http)")

    transport_callable = _config_transport_callable(name, transport, server)

    logger.debug("server_name=<%s>, transport=<%s> | creating MCP client from config", name, transport)
    return MCPClient(
        transport_callable,
        startup_timeout=server.get("startup_timeout", 30),
        tool_filters=_parse_config_tool_filters(name, server.get("tool_filters")),
        prefix=server.get("prefix", _sanitize_prefix(name) if prefix_with_server_name else None),
        application_name=server.get("application_name", name),
        application_version=server.get("application_version"),
        continue_on_error=server.get("continue_on_error", continue_on_error),
    )


def _sanitize_prefix(name: str) -> str:
    """Replace characters that model providers reject in tool names (e.g. the dot in ``awslabs.foo``) with ``_``."""
    return re.sub(r"[^A-Za-z0-9_-]", "_", name)


def _config_transport_callable(name: str, transport: str, server: dict[str, Any]) -> Callable[[], MCPTransport]:
    """Return a zero-arg callable that opens the transport for the given server entry."""
    if transport != "streamable-http" and server.get("auth"):
        raise ValueError(
            f"server '{name}': Strands supports 'auth' for streamable-http transport only — "
            "use streamable-http or provide a pre-configured transport"
        )

    match transport:
        case "stdio":
            command = server.get("command")
            if not command:
                raise ValueError(f"server '{name}': stdio transport requires 'command'")
            params = StdioServerParameters(
                command=os.path.expanduser(command),
                args=server.get("args", []),
                env=server.get("env"),
                cwd=os.path.expanduser(server["cwd"]) if server.get("cwd") else None,
            )
            return lambda: stdio_client(params)  # type: ignore[return-value]

        case "streamable-http":
            url = server.get("url")
            if not url:
                raise ValueError(f"server '{name}': streamable-http transport requires 'url'")
            headers = server.get("headers")
            resolved_auth = _parse_config_auth(name, cast(str, url), server.get("auth"))
            return lambda: streamable_http_transport(url=cast(str, url), headers=headers, auth=resolved_auth)

        case "sse":
            url = server.get("url")
            if not url:
                raise ValueError(f"server '{name}': sse transport requires 'url'")
            headers = server.get("headers")
            return lambda: sse_client(url=cast(str, url), headers=headers)

        case _:
            raise ValueError(f"server '{name}': unsupported transport type '{transport}'")


def _parse_config_auth(name: str, url: str, auth: dict[str, Any] | None) -> httpx.Auth | None:
    """Validate a config 'auth' entry and build the client_credentials httpx.Auth from it."""
    if auth is None:
        return None
    if not isinstance(auth, dict):
        raise ValueError(f"server '{name}': 'auth' must be an object with 'client_id' and 'client_secret'")

    missing_keys = sorted({"client_id", "client_secret"} - auth.keys())
    if missing_keys:
        raise ValueError(f"server '{name}': 'auth' is missing required keys: {missing_keys}")
    unknown_keys = sorted(auth.keys() - MCPClientCredentials.__annotations__.keys())
    if unknown_keys:
        logger.warning("server_name=<%s>, unknown_keys=<%s> | ignoring unrecognized auth keys", name, unknown_keys)

    credentials = MCPClientCredentials(client_id=auth["client_id"], client_secret=auth["client_secret"])
    if auth.get("scopes") is not None:
        credentials["scopes"] = auth["scopes"]
    return _build_client_credentials_auth(url, credentials)


def _parse_config_tool_filters(name: str, config: dict[str, Any] | None) -> ToolFilters | None:
    """Compile a tool-filter config into a ToolFilters mapping of regex patterns.

    Patterns match the server-side (unprefixed) tool name; any ``prefix`` is applied afterwards.
    """
    if not config:
        return None

    result: ToolFilters = {}
    if config.get("allowed") is not None:
        result["allowed"] = _compile_filter_patterns(name, "allowed", config["allowed"])
    if config.get("rejected") is not None:
        result["rejected"] = _compile_filter_patterns(name, "rejected", config["rejected"])

    return result or None


def _compile_filter_patterns(name: str, key: str, patterns: list[str]) -> list[_ToolMatcher]:
    """Compile a list of regex strings into patterns, raising a clear error on an invalid one."""
    compiled: list[_ToolMatcher] = []
    for pattern in patterns:
        try:
            compiled.append(re.compile(pattern))
        except re.error as e:
            raise ValueError(f"server '{name}': invalid regex in tool_filters.{key}: '{pattern}': {e}") from e
    return compiled


def _interpolate_env_vars(value: Any) -> Any:
    """Recursively replace ``${VAR}`` / ``${env:VAR}`` references in strings with env values.

    Strings nested inside lists and dicts are interpolated; other types pass through unchanged.

    Raises:
        ValueError: If a referenced environment variable is not set.
    """
    if isinstance(value, str):

        def _replace(match: re.Match[str]) -> str:
            var = match.group(1)
            if var not in os.environ:
                raise ValueError(f"environment variable '{var}' is not set")
            return os.environ[var]

        return _ENV_VAR_PATTERN.sub(_replace, value)
    if isinstance(value, list):
        return [_interpolate_env_vars(item) for item in value]
    if isinstance(value, dict):
        return {key: _interpolate_env_vars(item) for key, item in value.items()}
    return value
