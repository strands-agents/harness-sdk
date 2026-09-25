Agent Interface.

This module implements the core Agent class that serves as the primary entry point for interacting with foundation models and tools in the SDK.

The Agent interface supports two complementary interaction patterns:

1.  Natural language for conversation: `agent("Analyze this data")`
2.  Method-style for direct tool access: `agent.tool.tool_name(param1="value")`

## Agent

```python
class Agent(AgentBase, LocalAgent)
```

Defined in: [src/strands/agent/agent.py:171](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/agent.py#L171)

Core Agent implementation.

An agent orchestrates the following workflow:

1.  Receives user input
2.  Processes the input using a language model
3.  Decides whether to use tools to gather information or perform actions
4.  Executes those tools and receives results
5.  Continues reasoning with the new information
6.  Produces a final response

#### \_\_init\_\_

```python
def __init__(
        model: Model | str | ModelRouter | None = None,
        messages: Messages | None = None,
        tools: list[Union[str, dict[str, str], "ToolProvider", Any]]
    | None = None,
        system_prompt: str | list[SystemContentBlock] | None = None,
        structured_output_model: type[BaseModel] | None = None,
        callback_handler: Callable[..., Any] | _DefaultCallbackHandlerSentinel
    | None = _DEFAULT_CALLBACK_HANDLER,
        conversation_manager: ConversationManager | None = None,
        record_direct_tool_call: bool = True,
        load_tools_from_directory: bool = False,
        trace_attributes: Mapping[str, AttributeValue] | None = None,
        *,
        agent_id: str | None = None,
        name: str | None = None,
        description: str | None = None,
        state: AgentState | dict | None = None,
        context_manager:
    ("ContextManagerStrategy | ContextManagerConfig | ContextManager | Literal[False] | None"
     ) = None,
        plugins: list[Plugin] | None = None,
        hooks: list[HookProvider | HookCallback] | None = None,
        interventions: list[InterventionHandler] | None = None,
        session_manager: SessionManager | None = None,
        memory_manager: MemoryManager | MemoryManagerConfig | None = None,
        structured_output_prompt: str | None = None,
        tool_executor: ToolExecutor | None = None,
        retry_strategy: ModelRetryStrategy | _DefaultRetryStrategySentinel
    | None = _DEFAULT_RETRY_STRATEGY,
        concurrent_invocation_mode:
    ConcurrentInvocationMode = ConcurrentInvocationMode.THROW,
        checkpointing: bool = False,
        sandbox: Sandbox | None = None,
        storage: Storage | None = None,
        background_tasks: bool | BackgroundTasksConfig | None = None)
```

Defined in: [src/strands/agent/agent.py:189](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/agent.py#L189)

Initialize the Agent with the specified configuration.

**Arguments**:

-   `model` - Provider for running inference or a string representing the model-id for Bedrock to use. May also be a `ModelRouter`, whose first candidate is resolved to a concrete model and exposed as `agent.model`. Defaults to strands.models.BedrockModel if None.
    
-   `messages` - List of initial messages to pre-load into the conversation. Defaults to an empty list if None.
    
-   `tools` - List of tools to make available to the agent. Can be specified as:
    
    -   String tool names (e.g., “retrieve”)
    -   File paths (e.g., “/path/to/tool.py”)
    -   Imported Python modules (e.g., from strands\_tools import current\_time)
    -   Dictionaries with name/path keys (e.g., {“name”: “tool\_name”, “path”: “/path/to/tool.py”})
    -   ToolProvider instances for managed tool collections
    -   Functions decorated with `@strands.tool` decorator
    -   Agent instances (auto-wrapped via `agent.as_tool()` with defaults)
    
    If provided, only these tools will be available. If None, all tools will be available.
    
-   `system_prompt` - System prompt to guide model behavior. Can be a string or a list of SystemContentBlock objects for advanced features like caching. If None, the model will behave according to its default settings.
    
-   `structured_output_model` - Pydantic model type(s) for structured output. When specified, all agent calls will attempt to return structured output of this type. This can be overridden on the agent invocation. Defaults to None (no structured output).
    
-   `callback_handler` - Callback for processing events as they happen during agent execution. If not provided (using the default), a new PrintingCallbackHandler instance is created. If explicitly set to None, null\_callback\_handler is used.
    
-   `conversation_manager` - Manager for conversation history and context window. Defaults to strands.agent.conversation\_manager.SlidingWindowConversationManager if None.
    
-   `record_direct_tool_call` - Whether to record direct tool calls in message history. Defaults to True.
    
-   `load_tools_from_directory` - Whether to load and automatically reload tools in the `./tools/` directory. Defaults to False.
    
-   `trace_attributes` - Custom trace attributes to apply to the agent’s trace span.
    
-   `agent_id` - Optional ID for the agent, useful for session management and multi-agent scenarios. Defaults to “default”.
    
-   `name` - name of the Agent Defaults to “Strands Agents”.
    
-   `description` - description of what the Agent does Defaults to None.
    
-   `state` - stateful information for the agent. Can be either an AgentState object, or a json serializable dict. Defaults to an empty AgentState object.
    
-   `context_manager` - Context management strategy.
    
-   `"auto"` - Proactive truncation of tool results + summarization at 85% utilization.
    
-   `"agentic"` - Model-driven context management via injected tools. A :class:`~strands._context_manager.types.ContextManagerConfig` dict for custom strategy pipelines. A :class:`~strands._context_manager.context_manager.ContextManager` instance for full control.
    
-   `False` - Disable all context management. When set (except `False`), any co-provided `conversation_manager` is ignored. Defaults to None (SlidingWindowConversationManager, no offloader).
    
-   `plugins` - List of Plugin instances to extend agent functionality. Plugins are initialized with the agent instance after construction and can register hooks, modify agent attributes, or perform other setup tasks. Defaults to None.
    
-   `hooks` - Hooks to be added to the agent hook registry. Accepts HookProvider instances or plain callable hook callbacks (functions with typed event parameters). Defaults to None.
    
-   `interventions` - List of InterventionHandler instances for agent control. Handlers are evaluated in registration order at each lifecycle event. Cheapest handlers (authorization, guardrails) should be listed first; expensive ones (LLM steering) last. Deny short-circuits immediately, Guide feedback accumulates across handlers. Defaults to None.
    
-   `session_manager` - Manager for handling agent sessions including conversation history and state. If provided, enables session-based persistence and state management.
    
-   `memory_manager` - Cross-session memory manager, as a :class:`~strands.memory.MemoryManager` or a :class:`~strands.memory.MemoryManagerConfig` (auto-wrapped). Registers its memory tools; the synchronous `Agent(...)` entry point flushes pending extraction after each invocation. Defaults to None.
    
-   `structured_output_prompt` - Custom prompt message used when forcing structured output. When using structured output, if the model doesn’t automatically use the output tool, the agent sends a follow-up message to request structured formatting. This parameter allows customizing that message. Defaults to “You must format the previous response as structured output.”
    
-   `tool_executor` - Definition of tool execution strategy (e.g., sequential, concurrent, etc.).
    
-   `retry_strategy` - Strategy for retrying model calls on throttling or other transient errors. Defaults to ModelRetryStrategy with max\_attempts=6, initial\_delay=4s, max\_delay=240s. Implement a custom HookProvider for custom retry logic, or pass None to disable retries.
    
-   `concurrent_invocation_mode` - Mode controlling concurrent invocation behavior. Defaults to “throw” which raises ConcurrencyException if concurrent invocation is attempted. Set to “unsafe\_reentrant” to skip lock acquisition entirely, allowing concurrent invocations.
    
-   `Warning` - “unsafe\_reentrant” makes no guarantees about resulting behavior and is provided only for advanced use cases where the caller understands the risks.
    
-   `checkpointing` - When True, the event loop pauses at cycle boundaries (after\_model, after\_tools) and returns `stop_reason="checkpoint"` with a populated `checkpoint` field. Resume by passing the checkpoint back as `\{"checkpointResume": \{"checkpoint": ...}}`. The SDK does not capture conversation state in the checkpoint; pair with a SessionManager for cross-process state continuity. Defaults to False. See :mod:`strands.experimental.checkpoint`.
    
-   `sandbox` - Execution environment for running commands, code, and file operations. When provided, sandbox-aware tools route operations through it via `context.agent.sandbox`. Defaults to `None`, which falls back to a :class:`~strands.sandbox.NotASandboxLocalEnvironment` that runs on the host with no isolation.
    
-   `storage` - Default storage backend for agent subsystems. When provided, subsystems that do not have their own explicit storage (e.g., SessionManager, ContextManager) resolve from this value. Each subsystem auto-namespaces under its own prefix to avoid key collisions. Storage specified directly on a subsystem always takes precedence over this agent-level default. Defaults to None.
    
-   `background_tasks` - Background tool execution configuration. Pass `True` or a :class:`~strands.background_tasks.BackgroundTasksConfig` to let the model run tools in the background and receive their results when they finish. Defaults to None (disabled).
    

**Raises**:

-   `ValueError` - If agent id contains path separators.

#### cancel

```python
def cancel() -> None
```

Defined in: [src/strands/agent/agent.py:604](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/agent.py#L604)

Cancel the currently running agent invocation.

This method is thread-safe and can be called from any context (e.g., another thread, web request handler, background task).

The agent will stop gracefully at the next cancellation-safe point:

-   During model response streaming
-   Before tool execution
-   During MCP tool execution
-   After tool execution, before the next model call

The agent will return a result with stop\_reason=“cancelled”.

For cancellation driven from outside the agent (a client disconnect, a request lifecycle, a timeout), pass a `cancel_signal` into the invocation instead. The agent observes both, so either cancels independently.

**Example**:

```python
agent = Agent(model=model)

# Start agent in background
task = asyncio.create_task(agent.invoke_async("Hello"))

# Cancel from another context
agent.cancel()

result = await task
assert result.stop_reason == "cancelled"
```

**Notes**:

Multiple calls to cancel() are safe and idempotent.

#### cancel\_signal

```python
@property
def cancel_signal() -> threading.Event
```

Defined in: [src/strands/agent/agent.py:642](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/agent.py#L642)

The cancellation signal for the current invocation.

Set by :meth:`cancel` and by a `cancel_signal` passed into the invocation. SDK-built tool contexts receive this same event as `tool_context.cancel_signal`, and hooks can check `event.agent.cancel_signal.is_set()`. Cleared when an invocation completes, so the agent stays reusable.

Treat as read-only: call :meth:`cancel` to trigger cancellation. Setting or clearing this event directly is unsupported.

#### sandbox

```python
@property
def sandbox() -> Sandbox
```

Defined in: [src/strands/agent/agent.py:656](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/agent.py#L656)

Execution environment for running commands, code, and file operations.

Returns the configured sandbox, or a per-agent host default (:class:`~strands.sandbox.NotASandboxLocalEnvironment`, no isolation) when none was configured.

#### storage

```python
@property
def storage() -> Storage | None
```

Defined in: [src/strands/agent/agent.py:666](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/agent.py#L666)

Default storage backend for agent subsystems.

#### context\_manager

```python
@property
def context_manager() -> "ContextManager | None"
```

Defined in: [src/strands/agent/agent.py:671](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/agent.py#L671)

The ContextManager plugin, if one is registered on this agent.

#### session\_id

```python
@property
def session_id() -> str
```

Defined in: [src/strands/agent/agent.py:676](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/agent.py#L676)

Identifier for the current conversation session.

When a session manager is attached, returns its persistent, caller-supplied session ID. Otherwise, returns a random 8-character hex string generated at construction time (unique per agent instance but not persisted across restarts).

#### system\_prompt

```python
@property
def system_prompt() -> str | None
```

Defined in: [src/strands/agent/agent.py:692](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/agent.py#L692)

Get the system prompt as a string for backwards compatibility.

Returns the system prompt as a concatenated string when it contains text content, or None if no text content is present. This maintains backwards compatibility with existing code that expects system\_prompt to be a string.

**Returns**:

The system prompt as a string, or None if no text content exists.

#### system\_prompt

```python
@system_prompt.setter
def system_prompt(value: str | list[SystemContentBlock] | None) -> None
```

Defined in: [src/strands/agent/agent.py:705](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/agent.py#L705)

Set the system prompt and update internal content representation.

Accepts either a string or list of SystemContentBlock objects. The string representation is derived from the stored content blocks.

**Arguments**:

-   `value` - System prompt as string, list of SystemContentBlock objects, or None.
    -   str: Simple text prompt (most common use case)
    -   list\[SystemContentBlock\]: Content blocks with features like caching
    -   None: Clear the system prompt

#### system\_prompt\_content

```python
@property
def system_prompt_content() -> list[SystemContentBlock] | None
```

Defined in: [src/strands/agent/agent.py:720](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/agent.py#L720)

Get the system prompt as a list of content blocks.

Returns the structured content block representation, preserving cache points and other non-text blocks. Returns None if no system prompt is set.

**Returns**:

The system prompt as a list of content blocks, or None if no system prompt is set.

#### tool

```python
@property
def tool() -> _ToolCaller
```

Defined in: [src/strands/agent/agent.py:732](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/agent.py#L732)

Call tool as a function.

**Returns**:

Tool caller through which user can invoke tool as a function.

**Example**:

```plaintext
agent = Agent(tools=[calculator])
agent.tool.calculator(...)
```

#### tool\_names

```python
@property
def tool_names() -> list[str]
```

Defined in: [src/strands/agent/agent.py:747](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/agent.py#L747)

Get a list of all registered tool names.

**Returns**:

Names of all tools available to this agent.

#### concurrent\_invocation\_mode

```python
@property
def concurrent_invocation_mode() -> ConcurrentInvocationMode
```

Defined in: [src/strands/agent/agent.py:757](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/agent.py#L757)

The concurrency posture this agent was configured with.

Mirrors the `concurrent_invocation_mode` constructor argument.

#### shutdown

```python
def shutdown() -> None
```

Defined in: [src/strands/agent/agent.py:764](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/agent.py#L764)

Run the agent’s shutdown procedures at end of life.

Safe to call more than once, and a no-op when there is nothing to release. Call it directly when you own the agent’s lifecycle (e.g. draining on a shutdown signal), or scope the agent with `with` to run it automatically on exit. From async code use :meth:`shutdown_async` or scope with `async with`.

#### shutdown\_async

```python
async def shutdown_async() -> None
```

Defined in: [src/strands/agent/agent.py:776](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/agent.py#L776)

Run the agent’s shutdown procedures at end of life.

Asynchronous variant of :meth:`shutdown`. Safe to call more than once, and a no-op when there is nothing to release.

#### \_\_enter\_\_

```python
def __enter__() -> "Agent"
```

Defined in: [src/strands/agent/agent.py:785](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/agent.py#L785)

Enter a `with` scope, returning the agent unchanged.

Pairs with `__exit__`, which runs :meth:`shutdown` when the scope exits.

#### \_\_exit\_\_

```python
def __exit__(*_: Any) -> None
```

Defined in: [src/strands/agent/agent.py:792](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/agent.py#L792)

Run :meth:`shutdown` when leaving a `with` scope.

Runs on normal exit and when the block raises; any exception still propagates.

#### \_\_aenter\_\_

```python
async def __aenter__() -> "Agent"
```

Defined in: [src/strands/agent/agent.py:799](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/agent.py#L799)

Enter an `async with` scope, returning the agent unchanged.

Pairs with `__aexit__`, which runs :meth:`shutdown_async` when the scope exits.

#### \_\_aexit\_\_

```python
async def __aexit__(*_: Any) -> None
```

Defined in: [src/strands/agent/agent.py:806](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/agent.py#L806)

Run :meth:`shutdown_async` when leaving an `async with` scope.

Runs on normal exit and when the block raises; any exception still propagates.

#### \_\_call\_\_

```python
def __call__(prompt: AgentInput = None,
             *,
             invocation_state: dict[str, Any] | None = None,
             structured_output_model: type[BaseModel] | None = None,
             structured_output_prompt: str | None = None,
             idempotency_token: Any = None,
             limits: Limits | None = None,
             cancel_signal: threading.Event | None = None,
             **kwargs: Any) -> AgentResult
```

Defined in: [src/strands/agent/agent.py:813](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/agent.py#L813)

Process a natural language prompt through the agent’s event loop.

This method implements the conversational interface with multiple input patterns:

-   String input: `agent("hello!")`
-   ContentBlock list: `agent([\{"text": "hello"}, \{"image": \{...}}])`
-   Message list: `agent([\{"role": "user", "content": [\{"text": "hello"}]}])`
-   No input: `agent()` - uses existing conversation history

**Arguments**:

-   `prompt` - User input in various formats:
    -   str: Simple text input
    -   list\[ContentBlock\]: Multi-modal content blocks
    -   list\[Message\]: Complete messages with roles
    -   None: Use existing conversation history
-   `invocation_state` - Additional parameters to pass through the event loop.
-   `structured_output_model` - Pydantic model type(s) for structured output (overrides agent default).
-   `structured_output_prompt` - Custom prompt for forcing structured output (overrides agent default).
-   `idempotency_token` - Dedup token for THROW mode (ignored in UNSAFE\_REENTRANT). If a matching token is already inflight, this call blocks until the original finishes, then gets its final result — only the result, not the streamed events, though `callback_handler` still fires once with it. Matched by `==` (any equatable object; need not be hashable). Raises `IdempotencyAbortedError` if the original is aborted before producing a result.
-   `limits` - Per-invocation budget caps (turns / output\_tokens / total\_tokens). See :class:`~strands.types.agent.Limits`. When a cap is reached, the loop terminates gracefully at the next turn boundary with a corresponding `stop_reason` (e.g. `"limit_turns"`); no exception is raised. Token caps are soft — a single oversized model response can overshoot the budget by one turn, since checks run at turn boundaries, not within a model call.
-   `cancel_signal` - Caller-owned event that cancels this invocation. Use it when cancellation is driven from outside the agent — a client disconnect, a request lifecycle, a timeout. The agent observes both this event and `cancel()`, so either cancels independently, and it never sets or clears the caller’s event. An event that is already set cancels the invocation at its first checkpoint; that checkpoint sits inside model streaming, so the user turn is still recorded and one model request may be issued, then aborted. Clear the event before reusing it for another invocation. On cancellation the result carries `stop_reason="cancelled"`. A duplicate call waiting on an `idempotency_token` does not observe this event; only the primary invocation does.
-   `**kwargs` - Additional parameters to pass through the event loop.\[Deprecating\]

**Returns**:

Result object containing:

-   stop\_reason: Why the event loop stopped (e.g., “end\_turn”, “max\_tokens”)
-   message: The final message from the model
-   metrics: Performance metrics from the event loop
-   state: The final state of the event loop
-   structured\_output: Parsed structured output when structured\_output\_model was specified

**Raises**:

-   `ConcurrencyException` - If another invocation is already in progress on this agent instance.
-   `IdempotencyAbortedError` - If this call is a duplicate of an inflight `idempotency_token` whose primary invocation was aborted before producing a result.
-   `TypeError` - If `limits` contains an unrecognized key or a value that is not a positive integer.
-   `Exception` - Any exceptions from the agent invocation will be propagated to the caller.

#### invoke\_async

```python
async def invoke_async(prompt: AgentInput = None,
                       *,
                       invocation_state: dict[str, Any] | None = None,
                       structured_output_model: type[BaseModel] | None = None,
                       structured_output_prompt: str | None = None,
                       idempotency_token: Any = None,
                       limits: Limits | None = None,
                       cancel_signal: threading.Event | None = None,
                       **kwargs: Any) -> AgentResult
```

Defined in: [src/strands/agent/agent.py:907](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/agent.py#L907)

Process a natural language prompt through the agent’s event loop.

This method implements the conversational interface with multiple input patterns:

-   String input: Simple text input
-   ContentBlock list: Multi-modal content blocks
-   Message list: Complete messages with roles
-   No input: Use existing conversation history

**Arguments**:

-   `prompt` - User input in various formats:
    -   str: Simple text input
    -   list\[ContentBlock\]: Multi-modal content blocks
    -   list\[Message\]: Complete messages with roles
    -   None: Use existing conversation history
-   `invocation_state` - Additional parameters to pass through the event loop.
-   `structured_output_model` - Pydantic model type(s) for structured output (overrides agent default).
-   `structured_output_prompt` - Custom prompt for forcing structured output (overrides agent default).
-   `idempotency_token` - Dedup token for THROW mode (ignored in UNSAFE\_REENTRANT). If a matching token is already inflight, this call blocks until the original finishes, then gets its final result — only the result, not the streamed events, though `callback_handler` still fires once with it. Matched by `==` (any equatable object; need not be hashable). Raises `IdempotencyAbortedError` if the original is aborted before producing a result.
-   `limits` - Per-invocation budget caps (turns / output\_tokens / total\_tokens). See :class:`~strands.types.agent.Limits`. When a cap is reached, the loop terminates gracefully at the next turn boundary with a corresponding `stop_reason` (e.g. `"limit_turns"`); no exception is raised. Token caps are soft — a single oversized model response can overshoot the budget by one turn, since checks run at turn boundaries, not within a model call.
-   `cancel_signal` - Caller-owned event that cancels this invocation. Use it when cancellation is driven from outside the agent — a client disconnect, a request lifecycle, a timeout. The agent observes both this event and `cancel()`, so either cancels independently, and it never sets or clears the caller’s event. An event that is already set cancels the invocation at its first checkpoint; that checkpoint sits inside model streaming, so the user turn is still recorded and one model request may be issued, then aborted. Clear the event before reusing it for another invocation. On cancellation the result carries `stop_reason="cancelled"`. A duplicate call waiting on an `idempotency_token` does not observe this event; only the primary invocation does.
-   `**kwargs` - Additional parameters to pass through the event loop.\[Deprecating\]

**Returns**:

-   `Result` - object containing:
    
    -   stop\_reason: Why the event loop stopped (e.g., “end\_turn”, “max\_tokens”)
    -   message: The final message from the model
    -   metrics: Performance metrics from the event loop
    -   state: The final state of the event loop

**Raises**:

-   `ConcurrencyException` - If another invocation is already in progress on this agent instance.
-   `IdempotencyAbortedError` - If this call is a duplicate of an inflight `idempotency_token` whose primary invocation was aborted before producing a result.
-   `TypeError` - If `limits` contains an unrecognized key or a value that is not a positive integer.
-   `Exception` - Any exceptions from the agent invocation will be propagated to the caller.

#### structured\_output

```python
def structured_output(output_model: type[T], prompt: AgentInput = None) -> T
```

Defined in: [src/strands/agent/agent.py:989](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/agent.py#L989)

This method allows you to get structured output from the agent.

If you pass in a prompt, it will be used temporarily without adding it to the conversation history. If you don’t pass in a prompt, it will use only the existing conversation history to respond.

For smaller models, you may want to use the optional prompt to add additional instructions to explicitly instruct the model to output the structured data.

**Arguments**:

-   `output_model` - The output model (a JSON schema written as a Pydantic BaseModel) that the agent will use when responding.
-   `prompt` - The prompt to use for the agent in various formats:
    -   str: Simple text input
    -   list\[ContentBlock\]: Multi-modal content blocks
    -   list\[Message\]: Complete messages with roles
    -   None: Use existing conversation history

**Raises**:

-   `ValueError` - If no conversation history or prompt is provided.

#### structured\_output\_async

```python
async def structured_output_async(output_model: type[T],
                                  prompt: AgentInput = None) -> T
```

Defined in: [src/strands/agent/agent.py:1020](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/agent.py#L1020)

This method allows you to get structured output from the agent.

If you pass in a prompt, it will be used temporarily without adding it to the conversation history. If you don’t pass in a prompt, it will use only the existing conversation history to respond.

For smaller models, you may want to use the optional prompt to add additional instructions to explicitly instruct the model to output the structured data.

**Arguments**:

-   `output_model` - The output model (a JSON schema written as a Pydantic BaseModel) that the agent will use when responding.
-   `prompt` - The prompt to use for the agent (will not be added to conversation history).

**Raises**:

-   ## `ValueError` - If no conversation history or prompt is provided.
    

#### as\_tool

```python
def as_tool(*,
            name: str | None = None,
            description: str | None = None,
            preserve_context: bool = False,
            delegate: bool = False) -> AgentTool
```

Defined in: [src/strands/agent/agent.py:1091](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/agent.py#L1091)

Convert this agent into a tool for use by another agent.

**Arguments**:

-   `name` - Tool name. Must match the pattern `[a-zA-Z0-9_\\-]\{1,64}`. Defaults to the agent’s name.
-   `description` - Tool description. Defaults to the agent’s description, or a generic description if the agent has no description set.
-   `preserve_context` - Whether to preserve the agent’s conversation history across invocations. When False, the agent’s messages and state are reset to the values they had at construction time before each call, ensuring every invocation starts from the same baseline regardless of any external interactions with the agent. Defaults to False.
-   `delegate` - When True, the orchestrator treats this tool’s result as the final response and exits without an additional model call. The tool’s description is automatically suffixed with an instruction telling the model that this tool should be the only tool called in the turn. Defaults to False.

**Returns**:

A tool wrapping this agent.

**Example**:

```python
researcher = Agent(name="researcher", description="Finds information")
writer = Agent(name="writer", tools=[researcher.as_tool()])
writer("Write about AI agents")

# Delegation: sub-agent response is returned directly as the final answer
billing = Agent(name="billing", description="Handles billing questions")
orchestrator = Agent(tools=[billing.as_tool(delegate=True)])
orchestrator("What is my balance?")
```

#### cleanup

```python
def cleanup() -> None
```

Defined in: [src/strands/agent/agent.py:1137](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/agent.py#L1137)

Clean up resources used by the agent.

This method cleans up all tool providers that require explicit cleanup, such as MCP clients. It should be called when the agent is no longer needed to ensure proper resource cleanup.

Note: This method uses a “belt and braces” approach with automatic cleanup through finalizers as a fallback, but explicit cleanup is recommended.

#### add\_hook

```python
def add_hook(callback: HookCallback[TEvent],
             event_type: type[TEvent] | list[type[TEvent]] | None = None,
             *,
             order: float = HookOrder.DEFAULT) -> None
```

Defined in: [src/strands/agent/agent.py:1149](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/agent.py#L1149)

Register a callback function for a specific event type.

This method supports multiple call patterns:

1.  `add_hook(callback)` - Event type inferred from callback’s type hint
2.  `add_hook(callback, event_type)` - Event type specified explicitly
3.  `add_hook(callback, [TypeA, TypeB])` - Register for multiple event types

When the callback’s type hint is a union type (`A | B` or `Union[A, B]`), the callback is automatically registered for each event type in the union.

Callbacks can be either synchronous or asynchronous functions.

**Arguments**:

-   `callback` - The callback function to invoke when events of this type occur.
-   `event_type` - The class type(s) of events this callback should handle. Can be a single type, a list of types, or None to infer from the callback’s first parameter type hint. If a list is provided, the callback is registered for each type in the list.
-   `order` - Execution priority. Lower values execute first. Use a HookOrder constant such as SDK\_FIRST (-100), DEFAULT (0), MODEL\_ROUTING (50), or SDK\_LAST (100).

**Raises**:

-   `ValueError` - If event\_type is not provided and cannot be inferred from the callback’s type hints, or if the event\_type list is empty.

**Example**:

```python
def log_model_call(event: BeforeModelCallEvent) -> None:
    print(f"Calling model for agent: \{event.agent.name}")

agent = Agent()

# With event type inferred from type hint
agent.add_hook(log_model_call)

# With explicit event type
agent.add_hook(log_model_call, BeforeModelCallEvent)

# With union type hint (registers for all types)
def log_event(event: BeforeModelCallEvent | AfterModelCallEvent) -> None:
    print(f"Event: \{type(event).__name__}")
agent.add_hook(log_event)

# With list of event types
def multi_handler(event) -> None:
    print(f"Event: \{type(event).__name__}")
agent.add_hook(multi_handler, [BeforeModelCallEvent, AfterModelCallEvent])
```

Docs: [https://strandsagents.com/docs/user-guide/concepts/agents/hooks/](https://strandsagents.com/docs/user-guide/concepts/agents/hooks/)

#### \_\_del\_\_

```python
def __del__() -> None
```

Defined in: [src/strands/agent/agent.py:1210](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/agent.py#L1210)

Clean up resources when agent is garbage collected.

#### stream\_async

```python
async def stream_async(prompt: AgentInput = None,
                       *,
                       invocation_state: dict[str, Any] | None = None,
                       structured_output_model: type[BaseModel] | None = None,
                       structured_output_prompt: str | None = None,
                       idempotency_token: Any = None,
                       limits: Limits | None = None,
                       cancel_signal: threading.Event | None = None,
                       **kwargs: Any) -> AsyncIterator[Any]
```

Defined in: [src/strands/agent/agent.py:1250](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/agent.py#L1250)

Process a natural language prompt and yield events as an async iterator.

This method provides an asynchronous interface for streaming agent events with multiple input patterns:

-   String input: Simple text input
-   ContentBlock list: Multi-modal content blocks
-   Message list: Complete messages with roles
-   No input: Use existing conversation history

**Arguments**:

-   `prompt` - User input in various formats:
    -   str: Simple text input
    -   list\[ContentBlock\]: Multi-modal content blocks
    -   list\[Message\]: Complete messages with roles
    -   None: Use existing conversation history
-   `invocation_state` - Additional parameters to pass through the event loop.
-   `structured_output_model` - Pydantic model type(s) for structured output (overrides agent default).
-   `structured_output_prompt` - Custom prompt for forcing structured output (overrides agent default).
-   `idempotency_token` - Dedup token for THROW mode (ignored in UNSAFE\_REENTRANT). If a matching token is already inflight, this call blocks until the original finishes, then gets its final result — only the result, not the streamed events, though `callback_handler` still fires once with it. Matched by `==` (any equatable object; need not be hashable). Raises `IdempotencyAbortedError` if the original is aborted before producing a result.
-   `limits` - Per-invocation budget caps (turns / output\_tokens / total\_tokens). See :class:`~strands.types.agent.Limits`. When a cap is reached, the loop terminates gracefully at the next turn boundary with a corresponding `stop_reason` (e.g. `"limit_turns"`); no exception is raised. Token caps are soft — a single oversized model response can overshoot the budget by one turn, since checks run at turn boundaries, not within a model call.
-   `cancel_signal` - Caller-owned event that cancels this invocation. Use it when cancellation is driven from outside the agent — a client disconnect, a request lifecycle, a timeout. The agent observes both this event and `cancel()`, so either cancels independently, and it never sets or clears the caller’s event. An event that is already set cancels the invocation at its first checkpoint; that checkpoint sits inside model streaming, so the user turn is still recorded and one model request may be issued, then aborted. Clear the event before reusing it for another invocation. On cancellation the result carries `stop_reason="cancelled"`. A duplicate call waiting on an `idempotency_token` does not observe this event; only the primary invocation does.
-   `**kwargs` - Additional parameters to pass to the event loop.\[Deprecating\]

**Yields**:

An async iterator that yields events. Each event is a dictionary containing information about the current state of processing, such as:

-   data: Text content being generated
-   complete: Whether this is the final chunk
-   current\_tool\_use: Information about tools being executed
-   And other event data provided by the callback handler

**Raises**:

-   `ConcurrencyException` - If another invocation is already in progress on this agent instance.
-   `IdempotencyAbortedError` - If this call is a duplicate of an inflight `idempotency_token` whose primary invocation was aborted before producing a result.
-   `TypeError` - If `limits` contains an unrecognized key or a value that is not a positive integer.
-   `Exception` - Any exceptions from the agent invocation will be propagated to the caller.

**Example**:

```python
async for event in agent.stream_async("Analyze this data"):
    if "data" in event:
        yield event["data"]
```

#### take\_snapshot

```python
def take_snapshot(*,
                  preset: SnapshotPreset | None = None,
                  include: list[SnapshotField] | None = None,
                  exclude: list[SnapshotField] | None = None,
                  app_data: dict[str, Any] | None = None) -> Snapshot
```

Defined in: [src/strands/agent/agent.py:1965](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/agent.py#L1965)

Capture current agent state as an in-memory snapshot.

**Arguments**:

-   `preset` - Named preset of fields to capture. Currently only “session” is supported, which captures messages, state, conversation\_manager\_state, and interrupt\_state.
-   `include` - Additional fields to capture on top of the preset.
-   `exclude` - Fields to remove after applying preset and include.
-   `app_data` - Application-owned arbitrary JSON stored verbatim in the snapshot.

**Returns**:

A Snapshot containing the captured agent state.

**Raises**:

-   `SnapshotException` - If no fields are resolved or an invalid field name is provided.

#### load\_snapshot

```python
def load_snapshot(snapshot: Snapshot) -> None
```

Defined in: [src/strands/agent/agent.py:2013](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/agent.py#L2013)

Restore agent state from a previously captured snapshot.

Only fields present in snapshot.data are restored; absent fields are left unchanged.

**Arguments**:

-   `snapshot` - The snapshot to restore from.

**Raises**:

-   `SnapshotException` - If snapshot.schema\_version is not “1.0” or snapshot.scope is not “agent”.
-   `RuntimeError` - If background tasks are still tracked.