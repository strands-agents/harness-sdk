Summarizing conversation history management with configurable options.

## SummarizingConversationManager

```python
class SummarizingConversationManager(ConversationManager)
```

Defined in: [src/strands/agent/conversation\_manager/summarizing\_conversation\_manager.py:36](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/conversation_manager/summarizing_conversation_manager.py#L36)

Implements a summarizing window manager.

This manager provides a configurable option to summarize older context instead of simply trimming it, helping preserve important information while staying within context limits.

#### \_\_init\_\_

```python
def __init__(summary_ratio: float = 0.3,
             preserve_recent_messages: int = 10,
             summarization_agent: Optional["Agent"] = None,
             summarization_system_prompt: str | None = None,
             *,
             pin_first: int | None = None,
             proactive_compression: bool | ProactiveCompressionConfig
             | None = None)
```

Defined in: [src/strands/agent/conversation\_manager/summarizing\_conversation\_manager.py:44](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/conversation_manager/summarizing_conversation_manager.py#L44)

Initialize the summarizing conversation manager.

**Arguments**:

-   `summary_ratio` - Ratio of messages to summarize vs keep when context overflow occurs. Value between 0.1 and 0.8. Defaults to 0.3 (summarize 30% of oldest messages).
-   `preserve_recent_messages` - Minimum number of recent messages to always keep. Defaults to 10 messages.
-   `summarization_agent` - Optional agent to use for summarization instead of the parent agent. If provided, this agent can use tools as part of the summarization process.
-   `summarization_system_prompt` - Optional system prompt override for summarization. If None, uses the default summarization prompt.
-   `pin_first` - Number of messages at the start of the conversation to permanently pin. Pinned messages are protected from summarization and compacted to the front.
-   `proactive_compression` - Enable proactive context compression before the model call.
    -   `True`: compress when 70% of the context window is used (default threshold).
    -   `\{"compression_threshold": float}`: compress at the specified ratio (0, 1\].
    -   `False` or `None`: disabled, only reactive overflow recovery is used.

#### restore\_from\_session

```python
@override
def restore_from_session(state: dict[str, Any]) -> list[Message] | None
```

Defined in: [src/strands/agent/conversation\_manager/summarizing\_conversation\_manager.py:88](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/conversation_manager/summarizing_conversation_manager.py#L88)

Restores the Summarizing Conversation manager from its previous state in a session.

**Arguments**:

-   `state` - The previous state of the Summarizing Conversation Manager.

**Returns**:

Optionally returns the previous conversation summary if it exists.

#### get\_state

```python
def get_state() -> dict[str, Any]
```

Defined in: [src/strands/agent/conversation\_manager/summarizing\_conversation\_manager.py:101](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/conversation_manager/summarizing_conversation_manager.py#L101)

Returns a dictionary representation of the state for the Summarizing Conversation Manager.

#### apply\_management

```python
def apply_management(agent: "Agent", **kwargs: Any) -> None
```

Defined in: [src/strands/agent/conversation\_manager/summarizing\_conversation\_manager.py:105](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/conversation_manager/summarizing_conversation_manager.py#L105)

Apply management strategy to conversation history.

For the summarizing conversation manager, no proactive management is performed. Summarization only occurs when there’s a context overflow that triggers reduce\_context.

**Arguments**:

-   `agent` - The agent whose conversation history will be managed. The agent’s messages list is modified in-place.
-   `**kwargs` - Additional keyword arguments for future extensibility.

#### reduce\_context

```python
def reduce_context(agent: "Agent",
                   e: Exception | None = None,
                   **kwargs: Any) -> None
```

Defined in: [src/strands/agent/conversation\_manager/summarizing\_conversation\_manager.py:119](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/conversation_manager/summarizing_conversation_manager.py#L119)

Reduce context using summarization.

When `e` is set (reactive overflow recovery) and summarization fails with a `ContextWindowOverflowException` — too few messages to summarize, or the summary call itself overflows — oversized text blocks in non-pinned messages are truncated to head+tail previews instead; the failure is re-raised when nothing is left to truncate. Any other summarization error (throttling, network) is re-raised untouched, since a retry may still succeed. Truncation edits `agent.messages` only; a session store keeps the original content.

When `e` is None (proactive compression), summarization failure is logged and returns silently — the model call proceeds regardless.

**Arguments**:

-   `agent` - The agent whose conversation history will be reduced. The agent’s messages list is modified in-place.
-   `e` - The exception that triggered the context reduction, if any. When set, this is a reactive overflow recovery call. When None, this is a proactive compression call (best-effort).
-   `**kwargs` - Additional keyword arguments for future extensibility, including the `invocation_context` the summary call’s usage adds to.

**Raises**:

-   `Exception` - If summarization fails during reactive overflow recovery (e is set) for a reason other than overflow, or no text block is left to truncate.