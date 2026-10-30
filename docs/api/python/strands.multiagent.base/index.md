Multi-Agent Base Class.

Provides minimal foundation for multi-agent patterns (Swarm, Graph).

## Status

```python
class Status(Enum)
```

Defined in: [src/strands/multiagent/base.py:29](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/multiagent/base.py#L29)

Execution status for both graphs and nodes.

**Attributes**:

-   `PENDING` - Task has not started execution yet.
-   `DISPATCHED` - Node has been dispatched but execution has not started yet.
-   `EXECUTING` - Task is currently running.
-   `COMPLETED` - Task finished successfully.
-   `FAILED` - Task encountered an error and could not complete.
-   `INTERRUPTED` - Task was interrupted by user.

## NodeResult

```python
@dataclass
class NodeResult()
```

Defined in: [src/strands/multiagent/base.py:50](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/multiagent/base.py#L50)

Unified result from node execution - handles both Agent and nested MultiAgentBase results.

#### \_\_str\_\_

```python
def __str__() -> str
```

Defined in: [src/strands/multiagent/base.py:66](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/multiagent/base.py#L66)

Return a human-readable string representation of the node result.

Delegates to the inner result’s string representation:

-   AgentResult: Uses AgentResult.**str** (extracts text content)
-   MultiAgentResult: Uses MultiAgentResult.**str** (recursive)
-   Exception: Uses the exception’s string representation

**Returns**:

String representation of the node’s result.

#### get\_agent\_results

```python
def get_agent_results() -> list[AgentResult]
```

Defined in: [src/strands/multiagent/base.py:79](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/multiagent/base.py#L79)

Get all AgentResult objects from this node, flattened if nested.

#### to\_dict

```python
def to_dict() -> dict[str, Any]
```

Defined in: [src/strands/multiagent/base.py:92](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/multiagent/base.py#L92)

Convert NodeResult to JSON-serializable dict, ignoring state field.

#### from\_dict

```python
@classmethod
def from_dict(cls, data: dict[str, Any]) -> "NodeResult"
```

Defined in: [src/strands/multiagent/base.py:113](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/multiagent/base.py#L113)

Rehydrate a NodeResult from persisted JSON.

## MultiAgentResult

```python
@dataclass
class MultiAgentResult()
```

Defined in: [src/strands/multiagent/base.py:148](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/multiagent/base.py#L148)

Result from multi-agent execution with accumulated metrics.

**Attributes**:

-   `invocation_context` - The request this run belonged to; its `usage` covers the whole request, including nodes and any enclosing call.

#### \_\_str\_\_

```python
def __str__() -> str
```

Defined in: [src/strands/multiagent/base.py:165](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/multiagent/base.py#L165)

Return a human-readable string representation of the multi-agent result.

Priority order:

1.  Interrupts (if present) → stringified list of interrupt dicts
2.  Node results → each node’s string output, prefixed with node name

**Returns**:

String representation based on the priority order above.

#### from\_dict

```python
@classmethod
def from_dict(cls, data: dict[str, Any]) -> "MultiAgentResult"
```

Defined in: [src/strands/multiagent/base.py:190](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/multiagent/base.py#L190)

Rehydrate a MultiAgentResult from persisted JSON.

#### to\_dict

```python
def to_dict() -> dict[str, Any]
```

Defined in: [src/strands/multiagent/base.py:214](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/multiagent/base.py#L214)

Convert MultiAgentResult to JSON-serializable dict.

## MultiAgentBase

```python
class MultiAgentBase(ABC)
```

Defined in: [src/strands/multiagent/base.py:228](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/multiagent/base.py#L228)

Base class for multi-agent helpers.

This class integrates with existing Strands Agent instances and provides multi-agent orchestration capabilities.

**Attributes**:

-   `id` - Unique MultiAgent id for session management,etc.

#### \_\_init\_\_

```python
def __init__() -> None
```

Defined in: [src/strands/multiagent/base.py:244](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/multiagent/base.py#L244)

Initialize base multi-agent state.

#### invoke\_async

```python
@abstractmethod
async def invoke_async(task: MultiAgentInput,
                       invocation_state: dict[str, Any] | None = None,
                       **kwargs: Any) -> MultiAgentResult
```

Defined in: [src/strands/multiagent/base.py:288](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/multiagent/base.py#L288)

Invoke asynchronously.

**Arguments**:

-   `task` - The task to execute
-   `invocation_state` - Additional state/context passed to underlying agents. Defaults to None to avoid mutable default argument issues.
-   `**kwargs` - Additional keyword arguments passed to underlying agents.

#### stream\_async

```python
async def stream_async(task: MultiAgentInput,
                       invocation_state: dict[str, Any] | None = None,
                       **kwargs: Any) -> AsyncIterator[dict[str, Any]]
```

Defined in: [src/strands/multiagent/base.py:301](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/multiagent/base.py#L301)

Stream events during multi-agent execution.

Default implementation executes invoke\_async and yields the result as a single event. Subclasses can override this method to provide true streaming capabilities.

**Arguments**:

-   `task` - The task to execute
-   `invocation_state` - Additional state/context passed to underlying agents. Defaults to None to avoid mutable default argument issues.
-   `**kwargs` - Additional keyword arguments passed to underlying agents.

**Yields**:

Dictionary events containing multi-agent execution information including:

-   Multi-agent coordination events (node start/complete, handoffs)
-   Forwarded single-agent events with node context
-   Final result event

#### \_\_call\_\_

```python
def __call__(task: MultiAgentInput,
             invocation_state: dict[str, Any] | None = None,
             **kwargs: Any) -> MultiAgentResult
```

Defined in: [src/strands/multiagent/base.py:326](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/multiagent/base.py#L326)

Invoke synchronously.

**Arguments**:

-   `task` - The task to execute
-   `invocation_state` - Additional state/context passed to underlying agents. Defaults to None to avoid mutable default argument issues.
-   `**kwargs` - Additional keyword arguments passed to underlying agents.

#### serialize\_state

```python
def serialize_state() -> dict[str, Any]
```

Defined in: [src/strands/multiagent/base.py:346](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/multiagent/base.py#L346)

Return a JSON-serializable snapshot of the orchestrator state.

#### deserialize\_state

```python
def deserialize_state(payload: dict[str, Any]) -> None
```

Defined in: [src/strands/multiagent/base.py:350](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/multiagent/base.py#L350)

Restore orchestrator state from a session dict.

#### add\_hook

```python
def add_hook(callback: HookCallback,
             event_type: type | list[type] | None = None,
             *,
             order: float = HookOrder.DEFAULT) -> None
```

Defined in: [src/strands/multiagent/base.py:354](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/multiagent/base.py#L354)

Register a hook callback with the orchestrator.

Subclasses that support hooks should override this method to register the callback with their hook registry.

**Arguments**:

-   `callback` - The callback function to invoke when events of this type occur.
-   `event_type` - The class type(s) of events this callback should handle. Can be a single type, a list of types, or None to infer from the callback’s first parameter type hint.
-   `order` - Execution priority. Lower values execute first.