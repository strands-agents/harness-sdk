Hook events emitted by bidirectional agents.

## BidiAgentStopEvent

```python
@dataclass
class BidiAgentStopEvent(_HookEvent)
```

Defined in: [src/strands/experimental/bidi/hooks/events.py:25](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/hooks/events.py#L25)

Event triggered after BidiAgent attempts to stop its streaming session.

This event is fired after background-task and model cleanup have been attempted, including when cleanup raises an exception. Hook providers can use this event for cleanup, logging, or state persistence.

Note: This event uses reverse callback ordering, meaning callbacks registered later will be invoked first during cleanup.

This event is triggered at the end of agent.stop().

#### should\_reverse\_callbacks

```python
@property
def should_reverse_callbacks() -> bool
```

Defined in: [src/strands/experimental/bidi/hooks/events.py:39](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/hooks/events.py#L39)

True to invoke callbacks in reverse order.

## BidiResponseStopEvent

```python
@dataclass
class BidiResponseStopEvent(_HookEvent)
```

Defined in: [src/strands/experimental/bidi/hooks/events.py:45](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/hooks/events.py#L45)

Event triggered when the model reports that a response has ended.

A connection failure or shutdown without a model-reported completion does not emit this event.

**Attributes**:

-   `response_id` - Identifier of the response that ended.

## BidiBargeInEvent

```python
@dataclass
class BidiBargeInEvent(_HookEvent)
```

Defined in: [src/strands/experimental/bidi/hooks/events.py:59](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/hooks/events.py#L59)

Event triggered to stop current response generation or playback.

This event is fired when the user barges in (e.g., by speaking during the assistant’s response) or when an error stops output. This is specific to a response and does not pause the bidirectional session.

Hook providers can use this event to log barge-ins, stop playback, or trigger cleanup.

**Attributes**:

-   `reason` - Why response output should stop (“user\_speech” or “error”).

## BidiBeforeConnectionRestartEvent

```python
@dataclass
class BidiBeforeConnectionRestartEvent(_HookEvent)
```

Defined in: [src/strands/experimental/bidi/hooks/events.py:76](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/hooks/events.py#L76)

Event emitted before the agent restarts the model connection.

A restart is triggered either reactively, after the model reports a timeout, or proactively, when the reconnect timer fires ahead of the provider’s limit.

**Attributes**:

-   `reason` - What triggered the restart (“timeout” reactively, “scheduled” proactively).
-   `timeout_error` - The model’s timeout error on the reactive path; None when scheduled.

## BidiAfterConnectionRestartEvent

```python
@dataclass
class BidiAfterConnectionRestartEvent(_HookEvent)
```

Defined in: [src/strands/experimental/bidi/hooks/events.py:92](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/experimental/bidi/hooks/events.py#L92)

Event emitted after the agent attempts to restart the model connection.

**Attributes**:

-   `reason` - What triggered the restart (“timeout” reactively, “scheduled” proactively).
-   `exception` - Populated if an exception was raised during the restart. None means success.