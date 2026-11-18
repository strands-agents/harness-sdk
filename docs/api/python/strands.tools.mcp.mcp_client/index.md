Model Context Protocol (MCP) server connection management module.

This module provides the MCPClient class which handles connections to MCP servers. It manages the lifecycle of MCP connections, including initialization, tool discovery, tool invocation, and proper cleanup of resources. The connection runs in a background thread to avoid blocking the main application thread while maintaining communication with the MCP service.

## ToolFilters

```python
class ToolFilters(TypedDict)
```

Defined in: [src/strands/tools/mcp/mcp\_client.py:157](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/mcp/mcp_client.py#L157)

Filters for controlling which MCP tools are loaded and available.

Tools are filtered in this order:

1.  If ‘allowed’ is specified, only tools matching these patterns are included
2.  Tools matching ‘rejected’ patterns are then excluded

## MCPServerConfig

```python
class MCPServerConfig(TypedDict)
```

Defined in: [src/strands/tools/mcp/mcp\_client.py:176](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/mcp/mcp_client.py#L176)

Schema for a single MCP server entry in a load\_servers config.

Provide either ‘command’ (stdio) or ‘url’ (streamable-http/sse), not both. When ‘transport’ is omitted it is auto-detected from the fields present. String values support ’${VAR}’ / ’${env:VAR}’ interpolation, and ’~’ in ‘command’ and ‘cwd’ is expanded to the home directory.

‘auth’ holds client credentials for OAuth machine-to-machine (client\_credentials grant) authentication and is only supported for streamable-http transport.

‘disabled’ skips the server entirely. ‘continue\_on\_error’ keeps the rest of the servers usable when this one fails: a config-resolution failure (e.g. a missing env var) skips it during load\_servers instead of raising, and a connection failure yields no tools instead of raising when the agent loads them. ‘auto\_reconnect’ rebuilds a dropped session around a tool call and retries the call once (see MCPClient).

## MCPClient

```python
class MCPClient(ToolProvider)
```

Defined in: [src/strands/tools/mcp/mcp\_client.py:257](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/mcp/mcp_client.py#L257)

Represents a connection to a Model Context Protocol (MCP) server.

This class implements a context manager pattern for efficient connection management, allowing reuse of the same connection for multiple tool calls to reduce latency. It handles the creation, initialization, and cleanup of MCP connections.

The connection runs in a background thread to avoid blocking the main application thread while maintaining communication with the MCP service. When structured content is available from MCP tools, it will be returned as the last item in the content array of the ToolResult.

#### load\_servers

```python
@classmethod
def load_servers(cls,
                 config: "str | dict[str, Any]",
                 *,
                 continue_on_error: bool = False,
                 prefix_with_server_name: bool = False) -> "list[MCPClient]"
```

Defined in: [src/strands/tools/mcp/mcp\_client.py:270](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/mcp/mcp_client.py#L270)

Create MCPClient instances from an `mcpServers` JSON config (file path or mapping).

Returns one client per enabled server. Accepts either a flat mapping of server name to config, or that mapping nested under an `mcpServers` key. Servers marked `"disabled": true` are skipped. When a server has `"continue_on_error": true` (or the `continue_on_error` default is set), a failure resolving its config (e.g. a missing env var) skips that server instead of raising.

Transport is auto-detected from the fields present: `command` selects stdio and `url` selects streamable-http. Set `transport` explicitly (`"stdio"`, `"sse"`, or `"streamable-http"`) to override. String values support `$\{VAR}` / `$\{env:VAR}` interpolation against the process environment, and `~` in `command` and `cwd` is expanded to the user’s home directory.

**Arguments**:

-   `config` - A file path (with optional `file://` prefix) to a JSON config, or a dictionary mapping server names to configs (optionally under an `mcpServers` key).
-   `continue_on_error` - Default `continue_on_error` for every server; a server’s own `continue_on_error` key overrides it.
-   `prefix_with_server_name` - When True, servers without an explicit `prefix` use their config key as the tool name prefix, so same-named tools from different servers no longer collide. Characters outside `[A-Za-z0-9_-]` in the key (e.g. the dot in `awslabs.foo`) are replaced with `_`. A server can still opt out with `"prefix": ""`.

**Returns**:

One MCPClient per enabled server, ready to pass to `Agent(tools=...)`.

**Raises**:

-   `FileNotFoundError` - If the config file does not exist.
-   `json.JSONDecodeError` - If the config file contains invalid JSON.
-   `ValueError` - If the overall config shape is invalid or a server entry is not a mapping. These are malformed-config errors and always raise, regardless of `continue_on_error`. A failure building an individual server (e.g. a missing env var) also raises unless `continue_on_error` applies to that server, in which case it is skipped.

#### \_\_init\_\_

```python
def __init__(transport_callable: Callable[[], MCPTransport] | None = None,
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
             meta: dict[str, Any] | None = None,
             auto_reconnect: bool = False) -> None
```

Defined in: [src/strands/tools/mcp/mcp\_client.py:345](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/mcp/mcp_client.py#L345)

Initialize a new MCP Server connection.

**Arguments**:

-   `transport_callable` - A callable that returns an MCPTransport (read\_stream, write\_stream) tuple. Mutually exclusive with `url`.
-   `url` - Server URL. When provided, a streamable HTTP transport is constructed automatically. Mutually exclusive with `transport_callable`.
-   `headers` - HTTP headers to include on every request to the server. Requires `url`.
-   `auth` - Client credentials for OAuth machine-to-machine (client\_credentials grant) authentication. Requires `url`. Mutually exclusive with `auth_provider`.
-   `auth_provider` - Custom `httpx.Auth` for advanced auth flows, passed through to the streamable HTTP transport. Requires `url`. Mutually exclusive with `auth`.
-   `startup_timeout` - Timeout after which MCP server initialization should be cancelled. Defaults to 30.
-   `tool_filters` - Optional filters to apply to tools.
-   `prefix` - Optional prefix for tool names.
-   `application_name` - Optional name to identify this agent via clientInfo.name. If provided, the MCP server will see this name during the initialize handshake. Defaults to None (uses the MCP SDK default “mcp”).
-   `application_version` - Optional version string to report alongside application\_name. Defaults to None (uses the Strands SDK version).
-   `continue_on_error` - When True, a connection failure during `load_tools` is logged and yields no tools instead of raising, so one unavailable server does not prevent an agent from using the others. Only the connection (`start()`) is swallowed; an error while listing tools after a successful connect still propagates. Defaults to False.
-   `elicitation_callback` - Optional callback function to handle elicitation requests from the MCP server.
-   `progress_callback` - Optional callback to receive progress notifications during tool execution. Called with `(progress, total, message)` as the server reports progress. The `total` and `message` parameters may be `None` if the server does not provide them.
-   `tasks_config` - Configuration for MCP task-augmented execution for long-running tools. Experimental and subject to change as MCP Tasks evolve. On MCP 2.x, this enables finalized SEP-2663 Tasks support. On MCP 1.x, it enables the legacy task workflow. See TasksConfig for details.
-   `on_tools_changed` - Optional callback invoked after the server announces a change to its tool list and the client refreshes it. Called with the previous tool names and the refreshed tool instances. Registering it turns on the refresh: the client listens for the server’s tools list-changed notifications, re-lists the tools (applying the constructor’s prefix and filters), and updates the cached tools that `load_tools` returns. On a connection that negotiated MCP 2026-07-28, registering it also makes `start()` failable: the client must open the server’s `subscriptions/listen` stream to receive the notifications, and a failure to open it (other than the server lacking support) raises `MCPClientInitializationError` from `start()`.
-   `meta` - Optional request metadata (the MCP spec’s `_meta` field) sent with tool calls made through `call_tool_sync`/`call_tool_async`, including model-driven calls dispatched via `MCPAgentTool`, which routes through `call_tool_async`. Trace context is merged on top. A per-call `meta` argument to either method takes precedence over this client-level value.
-   `auto_reconnect` - When True, a tool call that finds the session dropped (the transport failed, timed out, or the server reports the session as terminated) tears the connection down, opens a fresh one through the transport callable, and retries the call once before surfacing an error result. This covers streamable HTTP; a dropped SSE connection or a stdio server process that exits is not reconnected. A refused connection is attempted up to four times with exponential backoff (0.5s, 1s, 2s), within one `startup_timeout` budget for the whole rebuild. Concurrent calls share one reconnect. A call that already reached the server may run twice, so leave this off for servers whose tools are not safe to repeat or that keep per-session state. Defaults to False.

**Raises**:

-   `ValueError` - If neither or both of `transport_callable` and `url` are provided, if `headers`, `auth`, or `auth_provider` is provided without `url`, if both `auth` and `auth_provider` are provided, if `url` is not an http:// or https:// URL, or if `auth` is missing required keys or a value has the wrong type.

#### \_\_enter\_\_

```python
def __enter__() -> "MCPClient"
```

Defined in: [src/strands/tools/mcp/mcp\_client.py:488](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/mcp/mcp_client.py#L488)

Context manager entry point which initializes the MCP server connection.

TODO: Refactor to lazy initialization pattern following idiomatic Python. Heavy work in **enter** is non-idiomatic - should move connection logic to first method call instead.

#### \_\_exit\_\_

```python
def __exit__(exc_type: type[BaseException] | None,
             exc_val: BaseException | None,
             exc_tb: TracebackType | None) -> None
```

Defined in: [src/strands/tools/mcp/mcp\_client.py:496](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/mcp/mcp_client.py#L496)

Context manager exit point that cleans up resources.

#### start

```python
def start() -> "MCPClient"
```

Defined in: [src/strands/tools/mcp/mcp\_client.py:505](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/mcp/mcp_client.py#L505)

Starts the background thread and waits for initialization.

This method starts the background thread that manages the MCP connection and blocks until the connection is ready or times out.

**Returns**:

-   `self` - The MCPClient instance

**Raises**:

-   `Exception` - If the MCP connection fails to initialize within the timeout period

#### client\_name

```python
@property
def client_name() -> str | None
```

Defined in: [src/strands/tools/mcp/mcp\_client.py:553](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/mcp/mcp_client.py#L553)

The `application_name` reported to the server, or `None` when unset (see `__init__`).

Defaults to the config key for `load_servers` clients.

#### continue\_on\_error

```python
@property
def continue_on_error() -> bool
```

Defined in: [src/strands/tools/mcp/mcp\_client.py:561](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/mcp/mcp_client.py#L561)

Whether a connection failure is swallowed instead of raised (see `__init__`).

#### connection\_failed

```python
@property
def connection_failed() -> bool
```

Defined in: [src/strands/tools/mcp/mcp\_client.py:566](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/mcp/mcp_client.py#L566)

Whether a `continue_on_error` connection attempt has failed and not yet been reset.

Sticky within a connection lifecycle: stays True until teardown (removing the last consumer, or `stop()`) resets the client. Always False when `continue_on_error` is not set, since a failure raises instead.

#### on\_tools\_changed

```python
@property
def on_tools_changed() -> ToolsChanged | None
```

Defined in: [src/strands/tools/mcp/mcp\_client.py:576](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/mcp/mcp_client.py#L576)

The registered tools-changed callback, if any (see `__init__`).

#### on\_tools\_changed

```python
@on_tools_changed.setter
def on_tools_changed(callback: ToolsChanged | None) -> None
```

Defined in: [src/strands/tools/mcp/mcp\_client.py:581](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/mcp/mcp_client.py#L581)

Register or remove the tools-changed callback.

On a connection that negotiated MCP 2026-07-28, the `subscriptions/listen` stream that makes the server publish list-changed notifications is opened at session start only when a callback is registered, so a callback set after `start()` receives nothing from such a server until the client is restarted. Servers on earlier protocol versions push the notification unprompted, so a late-set callback works there immediately.

#### load\_tools

```python
async def load_tools(**kwargs: Any) -> Sequence[AgentTool]
```

Defined in: [src/strands/tools/mcp/mcp\_client.py:594](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/mcp/mcp_client.py#L594)

Load and return tools from the MCP server.

This method implements the ToolProvider interface by loading tools from the MCP server and caching them for reuse.

**Arguments**:

-   `**kwargs` - Additional arguments for future compatibility.

**Returns**:

List of AgentTool instances from the MCP server. Empty when the connection fails and `continue_on_error` is set; the failure is sticky within a connection lifecycle and is not retried on subsequent calls. Teardown (removing the last consumer, or `stop()`) resets the client so a later consumer reconnects.

#### add\_consumer

```python
def add_consumer(consumer_id: Any, **kwargs: Any) -> None
```

Defined in: [src/strands/tools/mcp/mcp\_client.py:672](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/mcp/mcp_client.py#L672)

Add a consumer to this tool provider.

Synchronous to prevent GC deadlocks when called from Agent finalizers.

#### remove\_consumer

```python
def remove_consumer(consumer_id: Any, **kwargs: Any) -> None
```

Defined in: [src/strands/tools/mcp/mcp\_client.py:680](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/mcp/mcp_client.py#L680)

Remove a consumer from this tool provider.

This method is idempotent - calling it multiple times with the same ID has no additional effect after the first call.

Synchronous to prevent GC deadlocks when called from Agent finalizers. Uses existing synchronous stop() method for safe cleanup.

#### stop

```python
def stop(exc_type: type[BaseException] | None, exc_val: BaseException | None,
         exc_tb: TracebackType | None) -> None
```

Defined in: [src/strands/tools/mcp/mcp\_client.py:707](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/mcp/mcp_client.py#L707)

Signals the background thread to stop and waits for it to complete, ensuring proper cleanup of all resources.

This method is defensive and can handle partial initialization states that may occur if start() fails partway through initialization.

Resources to cleanup:

-   \_background\_thread: Thread running the async event loop
-   \_background\_thread\_session: MCP ClientSession (auto-closed by context manager)
-   \_background\_thread\_event\_loop: AsyncIO event loop in background thread
-   \_close\_future: AsyncIO future to signal thread shutdown
-   \_close\_exception: Exception that caused the background thread shutdown; None if a normal shutdown occurred.
-   \_init\_future: Future for initialization synchronization

Cleanup order:

1.  Signal close future to background thread (if session initialized)
2.  Wait for background thread to complete
3.  Reset all state for reuse

**Arguments**:

-   `exc_type` - Exception type if an exception was raised in the context
-   `exc_val` - Exception value if an exception was raised in the context
-   `exc_tb` - Exception traceback if an exception was raised in the context

#### list\_tools\_sync

```python
def list_tools_sync(
        pagination_token: str | None = None,
        prefix: str | None = None,
        tool_filters: ToolFilters | None = None
) -> PaginatedList[MCPAgentTool]
```

Defined in: [src/strands/tools/mcp/mcp\_client.py:808](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/mcp/mcp_client.py#L808)

Synchronously retrieves the list of available tools from the MCP server.

This method calls the asynchronous list\_tools method on the MCP session and adapts the returned tools to the AgentTool interface.

**Arguments**:

-   `pagination_token` - Optional token for pagination
-   `prefix` - Optional prefix to apply to tool names. If None, uses constructor default. If explicitly provided (including empty string), overrides constructor default.
-   `tool_filters` - Optional filters to apply to tools. If None, uses constructor default. If explicitly provided (including empty dict), overrides constructor default.

**Returns**:

-   `List[AgentTool]` - A list of available tools adapted to the AgentTool interface

#### list\_prompts\_sync

```python
def list_prompts_sync(
        pagination_token: str | None = None) -> ListPromptsResult
```

Defined in: [src/strands/tools/mcp/mcp\_client.py:865](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/mcp/mcp_client.py#L865)

Synchronously retrieves the list of available prompts from the MCP server.

This method calls the asynchronous list\_prompts method on the MCP session and returns the raw ListPromptsResult with pagination support.

**Arguments**:

-   `pagination_token` - Optional token for pagination

**Returns**:

-   `ListPromptsResult` - The raw MCP response containing prompts and pagination info

#### get\_prompt\_sync

```python
def get_prompt_sync(prompt_id: str, args: dict[str, Any]) -> GetPromptResult
```

Defined in: [src/strands/tools/mcp/mcp\_client.py:893](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/mcp/mcp_client.py#L893)

Synchronously retrieves a prompt from the MCP server.

**Arguments**:

-   `prompt_id` - The ID of the prompt to retrieve
-   `args` - Optional arguments to pass to the prompt

**Returns**:

-   `GetPromptResult` - The prompt response from the MCP server

#### list\_resources\_sync

```python
def list_resources_sync(
        pagination_token: str | None = None) -> ListResourcesResult
```

Defined in: [src/strands/tools/mcp/mcp\_client.py:916](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/mcp/mcp_client.py#L916)

Synchronously retrieves the list of available resources from the MCP server.

This method calls the asynchronous list\_resources method on the MCP session and returns the raw ListResourcesResult with pagination support.

**Arguments**:

-   `pagination_token` - Optional token for pagination

**Returns**:

-   `ListResourcesResult` - The raw MCP response containing resources and pagination info

#### read\_resource\_sync

```python
def read_resource_sync(uri: AnyUrl | str) -> ReadResourceResult
```

Defined in: [src/strands/tools/mcp/mcp\_client.py:942](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/mcp/mcp_client.py#L942)

Synchronously reads a resource from the MCP server.

**Arguments**:

-   `uri` - The URI of the resource to read

**Returns**:

-   `ReadResourceResult` - The resource content from the MCP server

#### list\_resource\_templates\_sync

```python
def list_resource_templates_sync(
        pagination_token: str | None = None) -> ListResourceTemplatesResult
```

Defined in: [src/strands/tools/mcp/mcp\_client.py:966](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/mcp/mcp_client.py#L966)

Synchronously retrieves the list of available resource templates from the MCP server.

Resource templates define URI patterns that can be used to access resources dynamically.

**Arguments**:

-   `pagination_token` - Optional token for pagination

**Returns**:

-   `ListResourceTemplatesResult` - The raw MCP response containing resource templates and pagination info

#### call\_tool\_sync

```python
def call_tool_sync(
        tool_use_id: str,
        name: str,
        arguments: dict[str, Any] | None = None,
        read_timeout_seconds: timedelta | None = None,
        meta: dict[str, Any] | None = None,
        progress_callback: ProgressFnT | None = None,
        *,
        cancel_signal: threading.Event | None = None) -> MCPToolResult
```

Defined in: [src/strands/tools/mcp/mcp\_client.py:1103](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/mcp/mcp_client.py#L1103)

Synchronously calls a tool on the MCP server.

This method automatically uses task-augmented execution when the client opted in via `tasks_config` and the server advertises task support (on the mcp 1.x line, the tool’s `taskSupport` setting is also honored).

**Arguments**:

-   `tool_use_id` - Unique identifier for this tool use
-   `name` - Name of the tool to call
-   `arguments` - Optional arguments to pass to the tool
-   `read_timeout_seconds` - Optional timeout for the tool call. On the mcp 2.x line, the timeout bounds each request round of a multi round-trip tool call rather than the call as a whole — except with task-augmented execution, where it bounds the whole task (polling included) and each lifecycle request uses the `tasks_config` `request_timeout`.
-   `meta` - Optional metadata to pass to the tool call per MCP spec (\_meta)
-   `progress_callback` - Optional callback to receive progress notifications for this call. Overrides the instance-level callback set at construction time. With task-augmented execution, progress can only arrive before the server returns a task handle — MCP forbids progress notifications for tasks — and the mcp 1.x task flow ignores the callback entirely.
-   `cancel_signal` - Optional caller-owned, thread-safe event for this call. A pre-set event cancels before the MCP request starts. If set while the request is in flight, cancellation wins over a concurrently arriving result. The returned error result has `cancelled=True`. Remote cancellation is best-effort and bounded; the shared MCP session remains reusable. During reconnect, cancellation interrupts waiting and backoff; a connection attempt already underway finishes without replaying this call. Clear the event before reusing it for another call.

**Returns**:

-   `MCPToolResult` - The tool result. Locally observed cancellation returns an error result with `cancelled=True` rather than raising. Cancelling the outer asyncio task is separate and still raises `asyncio.CancelledError` for `call_tool_async`. With `auto_reconnect`, a dropped session is rebuilt and the call re-sent once; a failure to do so is returned as an error result.

**Raises**:

-   `MCPClientInitializationError` - If the client is not running and `auto_reconnect` cannot rebuild the session (the client was never started or was stopped).

#### call\_tool\_async

```python
async def call_tool_async(
        tool_use_id: str,
        name: str,
        arguments: dict[str, Any] | None = None,
        read_timeout_seconds: timedelta | None = None,
        meta: dict[str, Any] | None = None,
        progress_callback: ProgressFnT | None = None,
        *,
        cancel_signal: threading.Event | None = None) -> MCPToolResult
```

Defined in: [src/strands/tools/mcp/mcp\_client.py:1196](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/mcp/mcp_client.py#L1196)

Asynchronously calls a tool on the MCP server.

This method automatically uses task-augmented execution when the client opted in via `tasks_config` and the server advertises task support (on the mcp 1.x line, the tool’s `taskSupport` setting is also honored).

**Arguments**:

-   `tool_use_id` - Unique identifier for this tool use
-   `name` - Name of the tool to call
-   `arguments` - Optional arguments to pass to the tool
-   `read_timeout_seconds` - Optional timeout for the tool call. On the mcp 2.x line, the timeout bounds each request round of a multi round-trip tool call rather than the call as a whole — except with task-augmented execution, where it bounds the whole task (polling included) and each lifecycle request uses the `tasks_config` `request_timeout`.
-   `meta` - Optional metadata to pass to the tool call per MCP spec (\_meta)
-   `progress_callback` - Optional callback to receive progress notifications for this call. Overrides the instance-level callback set at construction time. With task-augmented execution, progress can only arrive before the server returns a task handle — MCP forbids progress notifications for tasks — and the mcp 1.x task flow ignores the callback entirely.
-   `cancel_signal` - Optional caller-owned, thread-safe event for this call. A pre-set event cancels before the MCP request starts. If set while the request is in flight, cancellation wins over a concurrently arriving result. The returned error result has `cancelled=True`. Remote cancellation is best-effort and bounded; the shared MCP session remains reusable. During reconnect, cancellation interrupts waiting and backoff; a connection attempt already underway finishes without replaying this call. Clear the event before reusing it for another call.

**Returns**:

-   `MCPToolResult` - The tool result. Locally observed cancellation returns an error result with `cancelled=True` rather than raising. Cancelling the outer asyncio task is separate and still raises `asyncio.CancelledError` for `call_tool_async`. With `auto_reconnect`, a dropped session is rebuilt and the call re-sent once; a failure to do so is returned as an error result.

**Raises**:

-   `MCPClientInitializationError` - If the client is not running and `auto_reconnect` cannot rebuild the session (the client was never started or was stopped).

#### submit\_tool\_sync

```python
def submit_tool_sync(
    name: str,
    arguments: dict[str, Any] | None = None,
    read_timeout_seconds: timedelta | None = None,
    meta: dict[str, Any] | None = None,
    progress_callback: ProgressFnT | None = None
) -> MCPCallToolResult | MCPCreateTaskResult
```

Defined in: [src/strands/tools/mcp/mcp\_client.py:1290](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/mcp/mcp_client.py#L1290)

Submit a tool call once and return its direct result or SEP-2663 task handle.

This protocol-level operation never polls a returned task.

**Arguments**:

-   `name` - Name of the tool to call.
-   `arguments` - Optional arguments to pass to the tool.
-   `read_timeout_seconds` - Optional timeout for the request.
-   `meta` - Optional MCP request metadata.
-   `progress_callback` - Optional progress callback for the request.

**Returns**:

The direct tool result or server-created task handle.

**Raises**:

-   `MCPClientInitializationError` - If the client session is not running.
-   `RuntimeError` - If finalized task support is unavailable (mcp 1.x, missing `tasks_config`, missing server extension, or a protocol mismatch), validated before the request is sent.

#### submit\_tool\_async

```python
async def submit_tool_async(
    name: str,
    arguments: dict[str, Any] | None = None,
    read_timeout_seconds: timedelta | None = None,
    meta: dict[str, Any] | None = None,
    progress_callback: ProgressFnT | None = None
) -> MCPCallToolResult | MCPCreateTaskResult
```

Defined in: [src/strands/tools/mcp/mcp\_client.py:1331](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/mcp/mcp_client.py#L1331)

Asynchronously submit a tool call once without polling a returned task.

**Arguments**:

-   `name` - Name of the tool to call.
-   `arguments` - Optional arguments to pass to the tool.
-   `read_timeout_seconds` - Optional timeout for the request.
-   `meta` - Optional MCP request metadata.
-   `progress_callback` - Optional progress callback for the request.

**Returns**:

The direct tool result or server-created task handle.

**Raises**:

-   `MCPClientInitializationError` - If the client session is not running.
-   `RuntimeError` - If finalized task support is unavailable (mcp 1.x, missing `tasks_config`, missing server extension, or a protocol mismatch), validated before the request is sent.

#### get\_task\_sync

```python
def get_task_sync(
        task_id: str,
        read_timeout_seconds: timedelta | None = None) -> MCPGetTaskResult
```

Defined in: [src/strands/tools/mcp/mcp\_client.py:1371](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/mcp/mcp_client.py#L1371)

Synchronously retrieve the current state of a SEP-2663 task.

**Arguments**:

-   `task_id` - Server-issued task identifier.
-   `read_timeout_seconds` - Optional timeout for the request.

**Returns**:

The task’s validated current state.

**Raises**:

-   `MCPClientInitializationError` - If the client session is not running.
-   `RuntimeError` - If finalized task support is unavailable.
-   `ValueError` - If `task_id` is empty.

#### get\_task\_async

```python
async def get_task_async(
        task_id: str,
        read_timeout_seconds: timedelta | None = None) -> MCPGetTaskResult
```

Defined in: [src/strands/tools/mcp/mcp\_client.py:1392](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/mcp/mcp_client.py#L1392)

Asynchronously retrieve the current state of a SEP-2663 task.

**Arguments**:

-   `task_id` - Server-issued task identifier.
-   `read_timeout_seconds` - Optional timeout for the request.

**Returns**:

The task’s validated current state.

**Raises**:

-   `MCPClientInitializationError` - If the client session is not running.
-   `RuntimeError` - If finalized task support is unavailable.
-   `ValueError` - If `task_id` is empty.

#### update\_task\_sync

```python
def update_task_sync(
        task_id: str,
        input_responses: MCPInputResponses,
        read_timeout_seconds: timedelta | None = None) -> MCPUpdateTaskResult
```

Defined in: [src/strands/tools/mcp/mcp\_client.py:1415](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/mcp/mcp_client.py#L1415)

Synchronously supply responses to a task’s outstanding input requests.

**Arguments**:

-   `task_id` - Server-issued task identifier.
-   `input_responses` - Responses keyed by the corresponding input request keys.
-   `read_timeout_seconds` - Optional timeout for the request.

**Returns**:

The server’s validated acknowledgement.

**Raises**:

-   `MCPClientInitializationError` - If the client session is not running.
-   `RuntimeError` - If finalized task support is unavailable.
-   `TypeError` - If `input_responses` is not a dictionary.
-   `ValueError` - If `task_id` is empty.

#### update\_task\_async

```python
async def update_task_async(
        task_id: str,
        input_responses: MCPInputResponses,
        read_timeout_seconds: timedelta | None = None) -> MCPUpdateTaskResult
```

Defined in: [src/strands/tools/mcp/mcp\_client.py:1447](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/mcp/mcp_client.py#L1447)

Asynchronously supply responses to a task’s outstanding input requests.

**Arguments**:

-   `task_id` - Server-issued task identifier.
-   `input_responses` - Responses keyed by the corresponding input request keys.
-   `read_timeout_seconds` - Optional timeout for the request.

**Returns**:

The server’s validated acknowledgement.

**Raises**:

-   `MCPClientInitializationError` - If the client session is not running.
-   `RuntimeError` - If finalized task support is unavailable.
-   `TypeError` - If `input_responses` is not a dictionary.
-   `ValueError` - If `task_id` is empty.

#### cancel\_task\_sync

```python
def cancel_task_sync(
        task_id: str,
        read_timeout_seconds: timedelta | None = None) -> MCPCancelTaskResult
```

Defined in: [src/strands/tools/mcp/mcp\_client.py:1479](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/mcp/mcp_client.py#L1479)

Synchronously request cooperative cancellation of a SEP-2663 task.

**Arguments**:

-   `task_id` - Server-issued task identifier.
-   `read_timeout_seconds` - Optional timeout for the request.

**Returns**:

The server’s validated acknowledgement.

**Raises**:

-   `MCPClientInitializationError` - If the client session is not running.
-   `RuntimeError` - If finalized task support is unavailable.
-   `ValueError` - If `task_id` is empty.

#### cancel\_task\_async

```python
async def cancel_task_async(
        task_id: str,
        read_timeout_seconds: timedelta | None = None) -> MCPCancelTaskResult
```

Defined in: [src/strands/tools/mcp/mcp\_client.py:1500](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/mcp/mcp_client.py#L1500)

Asynchronously request cooperative cancellation of a SEP-2663 task.

**Arguments**:

-   `task_id` - Server-issued task identifier.
-   `read_timeout_seconds` - Optional timeout for the request.

**Returns**:

The server’s validated acknowledgement.

**Raises**:

-   `MCPClientInitializationError` - If the client session is not running.
-   `RuntimeError` - If finalized task support is unavailable.
-   `ValueError` - If `task_id` is empty.

#### map\_mcp\_content\_to\_tool\_result\_content

```python
def map_mcp_content_to_tool_result_content(
    content: MCPTextContent | MCPImageContent | MCPEmbeddedResource | Any
) -> ToolResultContent | None
```

Defined in: [src/strands/tools/mcp/mcp\_client.py:1915](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/tools/mcp/mcp_client.py#L1915)

Maps MCP content types to tool result content types.

This method converts MCP-specific content types to the generic ToolResultContent format used by the agent framework. Subclasses can override this to intercept or transform specific content blocks before they reach the model.

**Arguments**:

-   `content` - The MCP content to convert

**Returns**:

ToolResultContent or None: The converted content, or None if the content type is not supported