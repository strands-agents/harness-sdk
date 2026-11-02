Abstract interface for conversation history management.

## ProactiveCompressionConfig

```python
class ProactiveCompressionConfig(TypedDict)
```

Defined in: [src/strands/agent/conversation\_manager/conversation\_manager.py:20](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/conversation_manager/conversation_manager.py#L20)

Configuration for proactive compression when passed as an object.

**Attributes**:

-   `compression_threshold` - Ratio of context window usage that triggers proactive compression. Value between 0 (exclusive) and 1 (inclusive). Defaults to 0.7 (compress when 70% of the context window is used).

## ConversationManager

```python
class ConversationManager(ABC, HookProvider)
```

Defined in: [src/strands/agent/conversation\_manager/conversation\_manager.py:32](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/conversation_manager/conversation_manager.py#L32)

Abstract base class for managing conversation history.

This class provides an interface for implementing conversation management strategies to control the size of message arrays/conversation histories, helping to:

-   Manage memory usage
-   Control context length
-   Maintain relevant conversation state

ConversationManager implements the HookProvider protocol, allowing derived classes to register hooks for agent lifecycle events. Derived classes that override register\_hooks must call the base implementation to ensure proper hook registration chain.

The primary responsibility of a ConversationManager is overflow recovery: when the model encounters a context window overflow, :meth:`reduce_context` is called with `e` set and MUST make progress reducing the history or re-raise; the agent retries the model call and calls it again while the overflow persists. Each retry nests one level deeper, so each call should remove a substantial amount, not one small piece.

Subclasses can enable proactive compression by passing `proactive_compression` in the constructor. When enabled, the base class registers a `BeforeModelCallEvent` hook that checks projected input tokens against the model’s context window limit and calls :meth:`reduce_context` (without `e`) when the threshold is exceeded. This is a best-effort operation — errors are swallowed so the model call can still proceed.

**Example**:

```python
# Enable proactive compression with default threshold (0.7)
SlidingWindowConversationManager(window_size=50, proactive_compression=True)

# Enable proactive compression with custom threshold
SummarizingConversationManager(proactive_compression=\{"compression_threshold": 0.8})
```

#### \_\_init\_\_

```python
def __init__(
    *,
    proactive_compression: Union[bool, "ProactiveCompressionConfig",
                                 None] = None
) -> None
```

Defined in: [src/strands/agent/conversation\_manager/conversation\_manager.py:67](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/conversation_manager/conversation_manager.py#L67)

Initialize the ConversationManager.

**Arguments**:

-   `proactive_compression` - Enable proactive context compression before the model call.
    -   `True`: compress when 70% of the context window is used (default threshold).
    -   `\{"compression_threshold": float}`: compress at the specified ratio (0, 1\].
    -   `False` or `None`: disabled, only reactive overflow recovery is used.

**Raises**:

-   `ValueError` - If compression\_threshold is not in the valid range (0, 1\].

**Attributes**:

-   `removed_message_count` - The messages that have been removed from the agents messages array. These represent messages provided by the user or LLM that have been removed, not messages included by the conversation manager through something like summarization.

#### register\_hooks

```python
def register_hooks(registry: HookRegistry, **kwargs: Any) -> None
```

Defined in: [src/strands/agent/conversation\_manager/conversation\_manager.py:98](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/conversation_manager/conversation_manager.py#L98)

Register hooks for agent lifecycle events.

Always registers a `BeforeModelCallEvent` hook for proactive compression. When `proactive_compression` is not configured, the handler is a no-op (early return).

Derived classes that override this method must call the base implementation to ensure proper hook registration chain.

**Arguments**:

-   `registry` - The hook registry to register callbacks with.
-   `**kwargs` - Additional keyword arguments for future extensibility.

#### restore\_from\_session

```python
def restore_from_session(state: dict[str, Any]) -> list[Message] | None
```

Defined in: [src/strands/agent/conversation\_manager/conversation\_manager.py:153](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/conversation_manager/conversation_manager.py#L153)

Restore the Conversation Manager’s state from a session.

**Arguments**:

-   `state` - Previous state of the conversation manager

**Returns**:

Optional list of messages to prepend to the agents messages. By default returns None.

#### get\_state

```python
def get_state() -> dict[str, Any]
```

Defined in: [src/strands/agent/conversation\_manager/conversation\_manager.py:166](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/conversation_manager/conversation_manager.py#L166)

Get the current state of a Conversation Manager as a Json serializable dictionary.

#### apply\_management

```python
@abstractmethod
def apply_management(agent: "Agent", **kwargs: Any) -> None
```

Defined in: [src/strands/agent/conversation\_manager/conversation\_manager.py:174](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/conversation_manager/conversation_manager.py#L174)

Applies management strategy to the provided agent.

Processes the conversation history to maintain appropriate size by modifying the messages list in-place. Implementations should handle message pruning, summarization, or other size management techniques to keep the conversation context within desired bounds.

**Arguments**:

-   `agent` - The agent whose conversation history will be manage. This list is modified in-place.
-   `**kwargs` - Additional keyword arguments for future extensibility. The SDK passes
-   `invocation_context` - the request this management runs for, if any; a nested call that joins it adds to the request’s usage, but the request’s limits don’t apply.

#### reduce\_context

```python
@abstractmethod
def reduce_context(agent: "Agent",
                   e: Exception | None = None,
                   **kwargs: Any) -> None
```

Defined in: [src/strands/agent/conversation\_manager/conversation\_manager.py:191](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/agent/conversation_manager/conversation_manager.py#L191)

Reduce the conversation history.

Called in two scenarios:

1.  **Reactive** (e is set): A context window overflow occurred. The implementation MUST make progress reducing the history, or re-raise the error; the agent retries the model call and calls again while the overflow persists. Retries nest (one recursion level per round), so each call should remove a substantial amount.
2.  **Proactive** (e is None): The compression threshold was exceeded. This is best-effort — returning without reduction or raising is acceptable; the model call proceeds regardless.

Implementations should modify `agent.messages` in-place.

**Arguments**:

-   `agent` - The agent whose conversation history will be reduced. This list is modified in-place.
-   `e` - The exception that triggered the context reduction, if any. When set, this is a reactive overflow recovery call — the implementation MUST make progress reducing the history or re-raise. When None, this is a proactive compression call — best-effort reduction to avoid hitting the context window limit.
-   `**kwargs` - Additional keyword arguments for future extensibility. The SDK passes
-   `invocation_context` - the request this reduction runs for, if any; a nested call that joins it adds to the request’s usage, but the request’s limits don’t apply.