Shared helpers for context compression strategies.

These functions are used by both the conversation managers (reactive/proactive compression) and the agentic context-management tools (model-driven compression). They cover the low-level mechanics: finding safe split/trim boundaries that don’t break tool-use/tool-result pairs, generating a summary via the model, and filtering messages by type.

#### MessageType

Filter selecting which messages a compression operation targets.

-   `"tools"`: only messages containing a toolUse or toolResult block.
-   `"messages"`: only messages without any toolUse or toolResult block.
-   `"all"`: every message.

#### adjust\_split\_point\_for\_tool\_pairs

```python
def adjust_split_point_for_tool_pairs(messages: list[Message],
                                      split_point: int) -> int
```

Defined in: [src/strands/agent/conversation\_manager/compression/context\_compression.py:63](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/conversation_manager/compression/context_compression.py#L63)

Adjust a split point forward to avoid breaking toolUse/toolResult pairs.

Walks the split point forward until the message at that position is neither an orphaned toolResult nor a toolUse without an immediately following toolResult.

**Arguments**:

-   `messages` - The full list of messages.
-   `split_point` - The initially calculated split point.

**Returns**:

The adjusted split point that doesn’t break a toolUse/toolResult pair.

**Raises**:

-   `ContextWindowOverflowException` - If the split point exceeds the message array length, or if no valid split point can be found (walked past all messages).

#### find\_valid\_trim\_point

```python
def find_valid_trim_point(messages: list[Message], start_index: int) -> int
```

Defined in: [src/strands/agent/conversation\_manager/compression/context\_compression.py:108](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/conversation_manager/compression/context_compression.py#L108)

Find a valid trim point for truncation starting at `start_index`.

A valid trim point must:

1.  Be a user message (required by most model providers)
2.  Not be an orphaned toolResult
3.  Not be a toolUse unless its toolResult immediately follows

**Arguments**:

-   `messages` - The full list of messages.
-   `start_index` - The index to begin searching from.

**Returns**:

The valid trim index, or `len(messages)` if none is found.

#### generate\_summary

```python
async def generate_summary(
        messages_to_summarize: list[Message],
        model: "Model",
        system_prompt: str | None = None,
        invocation_context: "InvocationContext | None" = None) -> Message
```

Defined in: [src/strands/agent/conversation\_manager/compression/context\_compression.py:150](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/conversation_manager/compression/context_compression.py#L150)

Generate a summary of the provided messages by calling the model directly.

This bypasses the full agent pipeline (lock, metrics, traces, tool loop) and simply asks the underlying model to summarize the conversation.

**Arguments**:

-   `messages_to_summarize` - The messages to summarize.
-   `model` - The model used to generate the summary.
-   `system_prompt` - Optional system prompt override. Defaults to :data:`DEFAULT_SUMMARIZATION_PROMPT`.
-   `invocation_context` - The request the summary call’s usage adds to.

**Returns**:

A user-role message containing the model-generated summary.

**Raises**:

-   `RuntimeError` - If the model fails to produce a response, or its reply carries no text.

#### as\_user\_summary

```python
def as_user_summary(message: Message) -> Message
```

Defined in: [src/strands/agent/conversation\_manager/compression/context\_compression.py:193](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/conversation_manager/compression/context_compression.py#L193)

Re-role a model reply as the user-role summary message kept in history.

Only the reply’s text is kept: providers reject reasoning and tool-use blocks in user messages (Bedrock: “User messages cannot contain reasoning content”).

**Arguments**:

-   `message` - The summarizer’s reply.

**Returns**:

A user-role message holding the reply’s text blocks.

**Raises**:

-   `RuntimeError` - If the reply carries no text.

#### matches\_message\_type

```python
def matches_message_type(message: Message, filter: MessageType) -> bool
```

Defined in: [src/strands/agent/conversation\_manager/compression/context\_compression.py:222](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/conversation_manager/compression/context_compression.py#L222)

Return True if the message matches the given type filter.

**Arguments**:

-   `message` - The message to test.
-   `filter` - The message-type filter (`"tools"`, `"messages"`, or `"all"`).

**Returns**:

True if the message matches the filter.