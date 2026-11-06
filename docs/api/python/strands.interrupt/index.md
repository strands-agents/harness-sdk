Human-in-the-loop interrupt system for agent workflows.

## Interrupt

```python
@dataclass
class Interrupt()
```

Defined in: [src/strands/interrupt.py:20](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/interrupt.py#L20)

Represents an interrupt that can pause agent execution for human-in-the-loop workflows.

**Attributes**:

-   `id` - Unique identifier. Treat as opaque: pass it back to resume the agent, do not parse or construct it.
-   `name` - User defined name.
-   `reason` - User provided reason for raising the interrupt.
-   `response` - Human response provided when resuming the agent after an interrupt.

#### to\_dict

```python
def to_dict() -> dict[str, Any]
```

Defined in: [src/strands/interrupt.py:36](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/interrupt.py#L36)

Serialize to dict for session management.

## InterruptException

```python
class InterruptException(Exception)
```

Defined in: [src/strands/interrupt.py:41](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/interrupt.py#L41)

Exception raised when human input is required.

#### \_\_init\_\_

```python
def __init__(interrupt: Interrupt) -> None
```

Defined in: [src/strands/interrupt.py:44](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/interrupt.py#L44)

Set the interrupt.

## PendingToolExecution

```python
@dataclass
class PendingToolExecution()
```

Defined in: [src/strands/interrupt.py:50](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/interrupt.py#L50)

State required to resume tool execution without calling the model again.

**Attributes**:

-   `assistant_message` - Assistant message containing the pending tool uses.
-   `completed_tool_results` - Results completed or synthesized during the interrupted execution.

## \_InterruptState

```python
@dataclass
class _InterruptState()
```

Defined in: [src/strands/interrupt.py:63](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/interrupt.py#L63)

Track the state of interrupt events raised by the user.

Note, unanswered interrupts are cleared after resuming; an answered invocation-scoped response is retained for the rest of its interrupt cycle.

**Attributes**:

-   `interrupts` - Interrupts raised by the user. May be non-empty even when `activated` is False because retained responses persist until their cycle ends.
-   `context` - Additional context associated with an interrupt event.
-   `activated` - True if agent is in an interrupt state, False otherwise.
-   `pending_tool_execution` - State required to resume an interrupted tool execution.

#### activate

```python
def activate() -> None
```

Defined in: [src/strands/interrupt.py:83](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/interrupt.py#L83)

Activate the interrupt state.

#### deactivate

```python
def deactivate() -> None
```

Defined in: [src/strands/interrupt.py:88](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/interrupt.py#L88)

Deactivate the interrupt state.

Interrupts, context, and pending tool execution are cleared.

#### end\_tool\_cycle

```python
def end_tool_cycle() -> None
```

Defined in: [src/strands/interrupt.py:99](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/interrupt.py#L99)

Clear a completed tool cycle’s state, keeping answered invocation-scoped responses.

#### end\_interrupt\_cycle

```python
def end_interrupt_cycle() -> None
```

Defined in: [src/strands/interrupt.py:111](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/interrupt.py#L111)

Release invocation-scoped interrupts once their interrupt cycle is over.

#### resume

```python
def resume(prompt: "AgentInput") -> None
```

Defined in: [src/strands/interrupt.py:124](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/interrupt.py#L124)

Configure the interrupt state if resuming from an interrupt event.

**Arguments**:

-   `prompt` - User responses if resuming from interrupt.

**Raises**:

-   `TypeError` - If in interrupt state but user did not provide responses.

#### set\_pending\_tool\_results

```python
def set_pending_tool_results(
        completed_tool_results: list["ToolResult"]) -> None
```

Defined in: [src/strands/interrupt.py:160](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/interrupt.py#L160)

Update completed results for a pending tool execution.

#### to\_dict

```python
def to_dict() -> dict[str, Any]
```

Defined in: [src/strands/interrupt.py:181](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/interrupt.py#L181)

Serialize to dict for session management.

Exclude deactivated invocation-scoped responses — persisting them would give a restored agent a standing approval.

#### from\_dict

```python
@classmethod
def from_dict(cls, data: dict[str, Any]) -> "_InterruptState"
```

Defined in: [src/strands/interrupt.py:205](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/interrupt.py#L205)

Initialize interrupt state from serialized interrupt state.

Interrupt state can be serialized with the `to_dict` method. Legacy tool execution context is migrated into the typed pending state.