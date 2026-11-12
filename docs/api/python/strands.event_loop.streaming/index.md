Utilities for handling streaming responses from language models.

#### remove\_blank\_messages\_content\_text

```python
def remove_blank_messages_content_text(messages: Messages) -> Messages
```

Defined in: [src/strands/event\_loop/streaming.py:122](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/event_loop/streaming.py#L122)

Remove or replace blank text in message content.

!!deprecated!! This function is deprecated and will be removed in a future version.

**Arguments**:

-   `messages` - Conversation messages to update.

**Returns**:

Updated messages.

#### handle\_message\_start

```python
def handle_message_start(event: MessageStartEvent,
                         message: Message) -> Message
```

Defined in: [src/strands/event\_loop/streaming.py:178](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/event_loop/streaming.py#L178)

Handles the start of a message by setting the role in the message dictionary.

**Arguments**:

-   `event` - A message start event.
-   `message` - The message dictionary being constructed.

**Returns**:

Updated message dictionary with the role set.

#### handle\_content\_block\_start

```python
def handle_content_block_start(
        event: ContentBlockStartEvent) -> dict[str, Any]
```

Defined in: [src/strands/event\_loop/streaming.py:192](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/event_loop/streaming.py#L192)

Handles the start of a content block by extracting tool usage information if any.

**Arguments**:

-   `event` - Start event.

**Returns**:

Dictionary with tool use id and name if tool use request, empty dictionary otherwise.

#### handle\_content\_block\_delta

```python
def handle_content_block_delta(
        event: ContentBlockDeltaEvent,
        state: dict[str, Any]) -> tuple[dict[str, Any], ModelStreamEvent]
```

Defined in: [src/strands/event\_loop/streaming.py:215](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/event_loop/streaming.py#L215)

Handles content block delta updates by appending text, tool input, or reasoning content to the state.

**Arguments**:

-   `event` - Delta event.
-   `state` - The current state of message processing.

**Returns**:

Updated state with appended text or tool input.

#### handle\_content\_block\_stop

```python
def handle_content_block_stop(state: dict[str, Any]) -> dict[str, Any]
```

Defined in: [src/strands/event\_loop/streaming.py:308](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/event_loop/streaming.py#L308)

Handles the end of a content block by finalizing tool usage, text content, or reasoning content.

**Arguments**:

-   `state` - The current state of message processing.

**Returns**:

Updated state with finalized content block.

#### handle\_message\_stop

```python
def handle_message_stop(event: MessageStopEvent,
                        content: list[dict[str, Any]]) -> StopReason
```

Defined in: [src/strands/event\_loop/streaming.py:385](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/event_loop/streaming.py#L385)

Handles the end of a message by returning the stop reason.

Some models return “end\_turn” even when tool calls are present, which prevents the event loop from processing those tool calls. This function overrides to “tool\_use” so tool execution proceeds correctly.

**Arguments**:

-   `event` - Stop event.
-   `content` - The message content blocks accumulated during streaming.

**Returns**:

The reason for stopping the stream.

#### handle\_redact\_content

```python
def handle_redact_content(event: RedactContentEvent, state: dict[str,
                                                                 Any]) -> None
```

Defined in: [src/strands/event\_loop/streaming.py:412](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/event_loop/streaming.py#L412)

Handles redacting content from the input or output.

**Arguments**:

-   `event` - Redact Content Event.
-   `state` - The current state of message processing.

#### extract\_usage\_metrics

```python
def extract_usage_metrics(
        event: MetadataEvent,
        time_to_first_byte_ms: int | None = None) -> tuple[Usage, Metrics]
```

Defined in: [src/strands/event\_loop/streaming.py:423](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/event_loop/streaming.py#L423)

Extracts usage metrics from the metadata chunk.

**Arguments**:

-   `event` - metadata.
-   `time_to_first_byte_ms` - time to get the first byte from the model in milliseconds

**Returns**:

The extracted usage metrics and latency.

#### process\_stream

```python
async def process_stream(
    chunks: AsyncIterable[StreamEvent],
    start_time: float | None = None,
    cancel_signal: threading.Event | None = None,
    invocation_context: InvocationContext | None = None
) -> AsyncGenerator[TypedEvent, None]
```

Defined in: [src/strands/event\_loop/streaming.py:444](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/event_loop/streaming.py#L444)

Processes the response stream from the API, constructing the final message and extracting usage metrics.

**Arguments**:

-   `chunks` - The chunks of the response stream from the model.
-   `start_time` - Time when the model request is initiated
-   `cancel_signal` - Optional threading.Event to check for cancellation during streaming.
-   `invocation_context` - The request the call’s usage adds to once the stream ends. A cancelled stream adds the usage reported before it stopped; a stream that raises adds nothing.

**Yields**:

The reason for stopping, the constructed message, and the usage metrics.

#### stream\_messages

```python
async def stream_messages(model: "Model",
                          system_prompt: str | None,
                          messages: Messages,
                          tool_specs: list[ToolSpec],
                          *,
                          tool_choice: Any | None = None,
                          system_prompt_content: list[SystemContentBlock]
                          | None = None,
                          invocation_state: dict[str, Any] | None = None,
                          model_state: dict[str, Any] | None = None,
                          dynamic_trailing_blocks: int = 0,
                          cancel_signal: threading.Event | None = None,
                          agent_metadata: AgentMetadata | None = None,
                          structured_output_model: type[BaseModel]
                          | None = None,
                          invocation_context: InvocationContext | None = None,
                          **kwargs: Any) -> AsyncGenerator[TypedEvent, None]
```

Defined in: [src/strands/event\_loop/streaming.py:540](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/event_loop/streaming.py#L540)

Streams messages to the model and processes the response, through the SDK-internal `ModelProxy`.

**Arguments**:

-   `model` - Model provider.
-   `system_prompt` - The system prompt string, used for backwards compatibility with models that expect it.
-   `messages` - List of messages to send.
-   `tool_specs` - The list of tool specs.
-   `tool_choice` - Optional tool choice constraint for forcing specific tool usage.
-   `system_prompt_content` - The authoritative system prompt content blocks that always contains the system prompt data.
-   `invocation_state` - Caller-provided state/context that was passed to the agent when it was invoked.
-   `model_state` - Runtime state for model providers (e.g., server-side response ids).
-   `dynamic_trailing_blocks` - How many trailing blocks of the last user message are rebuilt on every call, so a provider placing cache points keeps its own ahead of them.
-   `cancel_signal` - Optional threading.Event to check for cancellation during streaming. Also forwarded to the model so a provider can abort an in-flight request.
-   `agent_metadata` - Metadata of the invoking agent, forwarded to the model.
-   `structured_output_model` - Output model this call must produce, forwarded to the model so the provider can choose how to enforce it.
-   `invocation_context` - The request the call’s usage adds to once the stream ends.
-   `**kwargs` - Additional keyword arguments for future extensibility.

**Yields**:

The reason for stopping, the final message, and the usage metrics