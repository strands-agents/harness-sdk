Summarizing conversation history management with configurable options.

## SummarizingConversationManager

```python
class SummarizingConversationManager(ConversationManager)
```

Defined in: [src/strands/agent/conversation\_manager/summarizing\_conversation\_manager.py:38](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/conversation_manager/summarizing_conversation_manager.py#L38)

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

Defined in: [src/strands/agent/conversation\_manager/summarizing\_conversation\_manager.py:46](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/conversation_manager/summarizing_conversation_manager.py#L46)

Initialize the summarizing conversation manager.

**Arguments**:

-   `summary_ratio` - Ratio of messages to summarize vs keep when context overflow occurs. Value between 0.1 and 0.8. Defaults to 0.3 (summarize 30% of oldest messages).
-   `preserve_recent_messages` - Minimum number of recent messages to always keep. Defaults to 10 messages.
-   `summarization_agent` - Optional agent to use for summarization instead of the parent agent. If provided, this agent can use tools as part of the summarization process.
-   `summarization_system_prompt` - Optional system prompt override for summarization. If None, uses the default summarization prompt.
-   `pin_first` - Number of messages at the start of the conversation to permanently pin. Pinned messages are protected from summarization and from the overflow truncation fallback, and compacted to the front. A pinned message that alone exceeds the context window is re-raised as an overflow rather than truncated.
-   `proactive_compression` - Enable proactive context compression before the model call.
    -   `True`: compress when 70% of the context window is used (default threshold).
    -   `\{"compression_threshold": float}`: compress at the specified ratio (0, 1\].
    -   `False` or `None`: disabled, only reactive overflow recovery is used.

#### register\_hooks

```python
@override
def register_hooks(registry: HookRegistry, **kwargs: Any) -> None
```

Defined in: [src/strands/agent/conversation\_manager/summarizing\_conversation\_manager.py:94](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/conversation_manager/summarizing_conversation_manager.py#L94)

Register hooks for agent lifecycle events.

Besides the base proactive-compression hook, resets the truncation budget once a model call ends the run of consecutive overflows, so each overflow episode starts by truncating a single block again.

#### restore\_from\_session

```python
@override
def restore_from_session(state: dict[str, Any]) -> list[Message] | None
```

Defined in: [src/strands/agent/conversation\_manager/summarizing\_conversation\_manager.py:109](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/conversation_manager/summarizing_conversation_manager.py#L109)

Restores the Summarizing Conversation manager from its previous state in a session.

**Arguments**:

-   `state` - The previous state of the Summarizing Conversation Manager.

**Returns**:

Optionally returns the previous conversation summary if it exists.

#### get\_state

```python
def get_state() -> dict[str, Any]
```

Defined in: [src/strands/agent/conversation\_manager/summarizing\_conversation\_manager.py:122](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/conversation_manager/summarizing_conversation_manager.py#L122)

Returns a dictionary representation of the state for the Summarizing Conversation Manager.

#### apply\_management

```python
def apply_management(agent: "Agent", **kwargs: Any) -> None
```

Defined in: [src/strands/agent/conversation\_manager/summarizing\_conversation\_manager.py:126](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/conversation_manager/summarizing_conversation_manager.py#L126)

Apply management strategy to conversation history.

For the summarizing conversation manager, no proactive management is performed. Summarization only occurs when there’s a context overflow that triggers reduce\_context. An overflow episode never spans invocations, so the truncation budget is reset here as well.

**Arguments**:

-   `agent` - The agent whose conversation history will be managed. The agent’s messages list is modified in-place.
-   `**kwargs` - Additional keyword arguments for future extensibility.

#### reduce\_context

```python
def reduce_context(agent: "Agent",
                   e: Exception | None = None,
                   **kwargs: Any) -> None
```

Defined in: [src/strands/agent/conversation\_manager/summarizing\_conversation\_manager.py:140](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/conversation_manager/summarizing_conversation_manager.py#L140)

Reduce context using summarization.

When `e` is set (reactive overflow recovery) and summarization fails with a `ContextWindowOverflowException` — too few messages to summarize, or the summary call itself overflows — the largest text blocks in non-pinned messages are truncated to head+tail previews instead. The first overflow truncates one block; `Agent` retries the model call and calls again on a further overflow, and each consecutive truncation doubles the number of blocks (1, 2, 4, …) until a model call succeeds, so a single oversized paste costs exactly one block while a history that needs many blocks gone converges in O(log n) rounds. Blocks of 2K characters or fewer are never truncated, and each block is truncated once, keeping about min(half, 4K) characters; the failure is re-raised when nothing else is left. Any other summarization error (throttling, network) is re-raised untouched, since a retry may still succeed. Truncation edits `agent.messages` in place; whether the original content survives depends on the session manager (repository-based managers persist messages as they are appended and keep it, `SnapshotSessionManager` persists the truncated history).

When `e` is None (proactive compression), summarization failure is logged and returns silently — the model call proceeds regardless.

**Arguments**:

-   `agent` - The agent whose conversation history will be reduced. The agent’s messages list is modified in-place.
-   `e` - The exception that triggered the context reduction, if any. When set, this is a reactive overflow recovery call. When None, this is a proactive compression call (best-effort).
-   `**kwargs` - Additional keyword arguments for future extensibility, including the `invocation_context` the summary call’s usage adds to.

**Raises**:

-   `Exception` - If summarization fails during reactive overflow recovery (e is set) for a reason other than overflow, or no text block is left to truncate.