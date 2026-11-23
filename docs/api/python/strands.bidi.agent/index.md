Bidirectional Agent for real-time streaming conversations.

Provides real-time audio and text interaction through persistent streaming connections. Unlike traditional request-response patterns, this agent maintains long-running conversations where users can barge in, provide additional input, and receive continuous responses including audio output.

Key capabilities:

-   Persistent conversation connections with concurrent processing
-   Real-time audio input/output streaming
-   Automatic barge-in detection and tool execution
-   Event-driven communication with model providers

## BidiAgent

```python
class BidiAgent(LocalAgent)
```

Defined in: [src/strands/bidi/agent/agent.py:86](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/agent/agent.py#L86)

Agent for bidirectional streaming conversations.

Enables real-time audio and text interaction with AI models through persistent connections. Supports concurrent tool execution and barge-in handling.

#### \_\_init\_\_

```python
def __init__(model: BidiModel | str | None = None,
             tools: list[str | AgentTool | ToolProvider] | None = None,
             system_prompt: str | list[SystemContentBlock] | None = None,
             messages: Messages | None = None,
             record_direct_tool_call: bool = True,
             agent_id: str | None = None,
             name: str | None = None,
             description: str | None = None,
             hooks: list[HookProvider] | None = None,
             state: AgentState | dict | None = None,
             session_manager: "SessionManager[LocalAgent] | None" = None,
             storage: Storage | None = None)
```

Defined in: [src/strands/bidi/agent/agent.py:95](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/agent/agent.py#L95)

Initialize bidirectional agent.

**Arguments**:

-   `model` - BidiModel instance, Bedrock model ID string, or None to use Nova Sonic 2.5.
-   `tools` - Optional list of tools with flexible format support.
-   `system_prompt` - System prompt for conversations as a string or structured content blocks. Structured blocks are retained, while their text is passed to Bidi models as a string.
-   `messages` - Optional conversation history to initialize with.
-   `record_direct_tool_call` - Whether to record direct tool calls in message history.
-   `agent_id` - Optional ID for the agent, useful for connection management and multi-agent scenarios.
-   `name` - Name of the Agent.
-   `description` - Description of what the Agent does.
-   `hooks` - Optional list of hook providers to register for lifecycle events.
-   `state` - Stateful information for the agent. Can be either an AgentState object, or a json serializable dict.
-   `session_manager` - Manager for handling agent sessions including conversation history and state. If provided, enables session-based persistence and state management.
-   `storage` - Default storage backend for agent subsystems. When provided, subsystems that do not have their own explicit storage (e.g., SessionManager) resolve from this value. Each subsystem auto-namespaces under its own prefix to avoid key collisions. Storage specified directly on a subsystem always takes precedence over this agent-level default. Defaults to None.

**Raises**:

-   `ValueError` - If model configuration is invalid or state is invalid type.
-   `TypeError` - If model type is unsupported.

#### tool

```python
@property
def tool() -> _ToolCaller
```

Defined in: [src/strands/bidi/agent/agent.py:219](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/agent/agent.py#L219)

Call tool as a function.

**Returns**:

ToolCaller for method-style tool execution.

**Example**:

```plaintext
agent = BidiAgent(model=model, tools=[calculator])
agent.tool.calculator(expression="2+2")
```

#### tool\_names

```python
@property
def tool_names() -> list[str]
```

Defined in: [src/strands/bidi/agent/agent.py:234](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/agent/agent.py#L234)

Get a list of all registered tool names.

**Returns**:

Names of all tools available to this agent.

#### system\_prompt

```python
@property
def system_prompt() -> str | None
```

Defined in: [src/strands/bidi/agent/agent.py:244](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/agent/agent.py#L244)

Get the system prompt as a string.

#### system\_prompt

```python
@system_prompt.setter
def system_prompt(value: str | list[SystemContentBlock] | None) -> None
```

Defined in: [src/strands/bidi/agent/agent.py:249](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/agent/agent.py#L249)

Set the system prompt and retain its structured content representation.

#### system\_prompt\_content

```python
@property
def system_prompt_content() -> list[SystemContentBlock] | None
```

Defined in: [src/strands/bidi/agent/agent.py:254](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/agent/agent.py#L254)

Get the system prompt as structured content blocks.

#### session\_id

```python
@property
def session_id() -> str
```

Defined in: [src/strands/bidi/agent/agent.py:259](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/agent/agent.py#L259)

Get the conversation session identifier.

#### storage

```python
@property
def storage() -> Storage | None
```

Defined in: [src/strands/bidi/agent/agent.py:264](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/agent/agent.py#L264)

Default storage backend for agent subsystems.

#### sandbox

```python
@property
def sandbox() -> Sandbox
```

Defined in: [src/strands/bidi/agent/agent.py:269](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/agent/agent.py#L269)

Execution environment for tool code: the host, with no isolation.

#### context\_manager

```python
@property
def context_manager() -> "ContextManager | None"
```

Defined in: [src/strands/bidi/agent/agent.py:274](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/agent/agent.py#L274)

The ContextManager plugin; always None because bidirectional agents do not support plugins.

#### event\_loop\_metrics

```python
@property
def event_loop_metrics() -> "EventLoopMetrics"
```

Defined in: [src/strands/bidi/agent/agent.py:279](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/agent/agent.py#L279)

Raise because bidirectional agents do not collect event loop metrics yet.

#### cancel

```python
def cancel(*,
           message: str | None = None,
           after_current_tools: bool = False,
           cancel_background_tasks: bool = False) -> None
```

Defined in: [src/strands/bidi/agent/agent.py:287](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/agent/agent.py#L287)

Request cancellation of the current conversation.

Thread-safe and idempotent. Cancellation takes effect only after a tool group completes, so `after_current_tools` is accepted for API parity with `Agent.cancel()` but has no additional effect here. The `message` argument is stored for future use; BidiAgent does not yet surface it in output history.

**Arguments**:

-   `message` - Optional terminal message describing why cancellation was requested. When several callers set a message, the last write wins; a no-arg call leaves any stored message intact.
-   `after_current_tools` - Accepted for signature parity with `Agent.cancel()`; BidiAgent cancellation is always deferred to the end of the current tool group.
-   `cancel_background_tasks` - Accepted for signature parity with `Agent.cancel()`; BidiAgent has no background tasks.

#### cancel\_signal

```python
@property
def cancel_signal() -> threading.Event
```

Defined in: [src/strands/bidi/agent/agent.py:313](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/agent/agent.py#L313)

The cancellation signal for the current conversation.

Treat as read-only; call `cancel()` to request cancellation.

#### add\_hook

```python
def add_hook(callback: HookCallback[TEvent],
             event_type: type[TEvent] | list[type[TEvent]] | None = None,
             *,
             order: float = HookOrder.DEFAULT) -> None
```

Defined in: [src/strands/bidi/agent/agent.py:320](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/agent/agent.py#L320)

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

#### start

```python
async def start(invocation_state: dict[str, Any] | None = None) -> None
```

Defined in: [src/strands/bidi/agent/agent.py:355](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/agent/agent.py#L355)

Start a persistent bidirectional conversation connection.

Initializes the streaming connection and starts background tasks for processing model events, tool execution, and connection management.

**Arguments**:

-   `invocation_state` - Optional context shared by reference with tools and hooks until stop(), including across connection restarts. Tools access it through ToolContext.invocation\_state. Defaults to a new empty dictionary.

**Raises**:

RuntimeError: If agent already started.

**Example**:

```python
await agent.start(invocation_state=\{
    "user_id": "user_123",
    "session_id": "session_456",
    "database": db_connection,
})
```

#### send

```python
async def send(input_data: BidiAgentInput) -> None
```

Defined in: [src/strands/bidi/agent/agent.py:386](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/agent/agent.py#L386)

Send user content to the model.

Strings are shorthand for text blocks. Lists of text and image blocks form one user message, preserving block order. Audio deltas are sent individually and are not added to conversation history. Tool results are sent by the agent’s tool runner.

**Arguments**:

-   `input_data` - Can be:
    
    -   str: Text message from user
    -   TextBlock, AudioDelta, or ImageBlock: Text, streaming audio, or image input
    -   BidiUserContentBlockData: A dictionary containing one text or image key
    -   BidiContentDeltaData: A dictionary containing one audio\_delta key
    -   list: A non-empty list of strings, text or image blocks, or their dictionary forms

**Raises**:

-   `RuntimeError` - If start has not been called.
-   `TypeError` - If the input has an unsupported type or invalid input arguments.
-   `ValueError` - If the input list is empty or an input dictionary does not contain exactly one supported key.

**Example**:

await agent.send(“Hello”) await agent.send(AudioDelta(format=“pcm”, source={“bytes”: audio\_bytes})) await agent.send({“audio\_delta”: {“format”: “pcm”, “source”: {“bytes”: audio\_bytes}}}) await agent.send(\[TextBlock(“Use these details.”), TextBlock(“Order number: 123.”)\])

#### receive

```python
async def receive() -> AsyncGenerator[BidiOutputEvent, None]
```

Defined in: [src/strands/bidi/agent/agent.py:448](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/agent/agent.py#L448)

Receive events from the model including audio, text, and tool calls.

**Yields**:

Model output events processed by background tasks including audio output, text responses, tool calls, and connection updates. The agent also yields:

-   A completed `BidiTextBlockEvent`, `BidiReasoningBlockEvent`, or `BidiTranscriptBlockEvent` after each text, reasoning, or transcript stop event.
-   Tool execution events such as `ToolStreamEvent` and `ToolResultEvent`, and a `ToolResultMessageEvent` once a tool group’s results are recorded.

**Raises**:

-   `RuntimeError` - If start has not been called.
-   `ConnectionTimeoutError` - If the model connection times out and automatic restart is disabled.

#### stop

```python
async def stop() -> None
```

Defined in: [src/strands/bidi/agent/agent.py:471](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/agent/agent.py#L471)

End the conversation connection and clean up background tasks.

Terminates the streaming connection, cancels background tasks, and closes the connection to the model provider.

#### take\_snapshot

```python
def take_snapshot(*,
                  preset: SnapshotPreset | None = None,
                  include: list[SnapshotField] | None = None,
                  exclude: list[SnapshotField] | None = None,
                  app_data: dict[str, Any] | None = None) -> Snapshot
```

Defined in: [src/strands/bidi/agent/agent.py:484](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/agent/agent.py#L484)

Capture current agent state as an in-memory snapshot.

Captures committed conversation history and application state. Live connection state, in-progress responses, and pending tool calls are not included.

**Arguments**:

-   `preset` - Named preset of fields to capture. Currently only “session” is supported, which captures messages and state.
-   `include` - Additional fields to capture on top of the preset.
-   `exclude` - Fields to remove after applying preset and include.
-   `app_data` - Application-owned arbitrary JSON stored verbatim in the snapshot.

**Returns**:

A Snapshot containing the captured agent state.

**Raises**:

-   `SnapshotException` - If no fields are resolved or a field is invalid or unsupported.

#### load\_snapshot

```python
def load_snapshot(snapshot: Snapshot) -> None
```

Defined in: [src/strands/bidi/agent/agent.py:535](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/agent/agent.py#L535)

Restore agent state from a previously captured snapshot.

Only fields present in snapshot.data are restored; absent fields are left unchanged and fields this agent does not support are ignored. The restored history is sent to the model on the next start().

**Arguments**:

-   `snapshot` - The snapshot to restore from.

**Raises**:

-   `SnapshotException` - If snapshot.schema\_version is not “1.0” or snapshot.scope is not “agent”.
-   `RuntimeError` - If the agent is started.

#### \_\_aenter\_\_

```python
async def __aenter__(
        invocation_state: dict[str, Any] | None = None) -> "BidiAgent"
```

Defined in: [src/strands/bidi/agent/agent.py:564](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/agent/agent.py#L564)

Async context manager entry point.

Automatically starts the bidirectional connection when entering the context. Cleans up if startup fails.

**Arguments**:

-   `invocation_state` - Optional context to pass to tools during execution. This allows passing custom data (user\_id, session\_id, database connections, etc.) that tools can access via their invocation\_state parameter.

**Returns**:

Self for use in the context.

**Raises**:

-   `RuntimeError` - If the agent is already started.

#### \_\_aexit\_\_

```python
async def __aexit__(*_: Any) -> None
```

Defined in: [src/strands/bidi/agent/agent.py:592](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/agent/agent.py#L592)

Async context manager exit point.

Automatically ends the connection and cleans up resources including when exiting the context, regardless of whether an exception occurred.

#### run

```python
async def run(inputs: list[InputStream],
              outputs: list[OutputStream],
              invocation_state: dict[str, Any] | None = None) -> None
```

Defined in: [src/strands/bidi/agent/agent.py:601](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/bidi/agent/agent.py#L601)

Run the agent using provided I/O streams for bidirectional communication.

**Arguments**:

-   `inputs` - Streams that produce input for the agent.
-   `outputs` - Streams that consume output events from the agent.
-   `invocation_state` - Optional context shared by reference with tools and hooks for the duration of run(), including across connection restarts. Tools access it through ToolContext.invocation\_state. Defaults to a new empty dictionary.

**Example**:

```python
# Using default audio settings:
model = BedrockNovaSonicModel(model_id="amazon.nova-2-5-sonic")
audio_io = AudioIO()
agent = BidiAgent(model=model, tools=[calculator])
await agent.run(
    inputs=[audio_io.input()],
    outputs=[audio_io.output()],
    invocation_state=\{"user_id": "user_123"}
)

# Using custom audio config:
model = BedrockNovaSonicModel(
    model_id="amazon.nova-2-5-sonic",
    audio=\{
        "input": \{"sample_rate": 16000},
        "output": \{"sample_rate": 24000},
    }
)
audio_io = AudioIO()
agent = BidiAgent(model=model, tools=[calculator])
await agent.run(
    inputs=[audio_io.input()],
    outputs=[audio_io.output()],
)
```