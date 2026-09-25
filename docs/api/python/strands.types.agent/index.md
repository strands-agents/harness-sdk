Agent-related type definitions for the SDK.

This module defines the types used for an Agent.

## LocalAgent

```python
class LocalAgent(Protocol)
```

Defined in: [src/strands/types/agent.py:30](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/types/agent.py#L30)

Interface for SDK-provided agents with locally accessible capabilities.

This protocol is exported for type annotations and is not intended for external implementation.

**Attributes**:

-   `agent_id` - Unique identifier for the agent.
-   `name` - Display name for the agent.
-   `description` - Optional description of the agent.
-   `messages` - Conversation history maintained by the agent.
-   `state` - Application state associated with the agent.
-   `hooks` - Registry containing the agent’s hook callbacks.
-   `model` - Model used by the agent.
-   `system_prompt` - String representation of the agent’s system prompt.
-   `tool_registry` - Registry containing tools available to the agent.

#### tool

```python
@property
def tool() -> _ToolCaller
```

Defined in: [src/strands/types/agent.py:61](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/types/agent.py#L61)

Caller for invoking registered tools directly.

#### tool\_names

```python
@property
def tool_names() -> list[str]
```

Defined in: [src/strands/types/agent.py:66](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/types/agent.py#L66)

Names of tools registered with the agent.

#### system\_prompt\_content

```python
@property
def system_prompt_content() -> list[SystemContentBlock] | None
```

Defined in: [src/strands/types/agent.py:71](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/types/agent.py#L71)

Structured system prompt content used by the agent.

#### session\_id

```python
@property
def session_id() -> str
```

Defined in: [src/strands/types/agent.py:76](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/types/agent.py#L76)

Identifier for the current conversation session.

#### add\_hook

```python
def add_hook(callback: HookCallback[_TEvent],
             event_type: type[_TEvent] | list[type[_TEvent]] | None = None,
             *,
             order: float = ...) -> None
```

Defined in: [src/strands/types/agent.py:80](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/types/agent.py#L80)

Register a hook callback.

#### take\_snapshot

```python
def take_snapshot(*,
                  preset: SnapshotPreset | None = None,
                  include: list[SnapshotField] | None = None,
                  exclude: list[SnapshotField] | None = None,
                  app_data: dict[str, Any] | None = None) -> Snapshot
```

Defined in: [src/strands/types/agent.py:90](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/types/agent.py#L90)

Capture current agent state as an in-memory snapshot.

The fields a preset captures, and the fields accepted by include and exclude, are implementation-defined.

#### load\_snapshot

```python
def load_snapshot(snapshot: Snapshot) -> None
```

Defined in: [src/strands/types/agent.py:105](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/types/agent.py#L105)

Restore agent state from a previously captured snapshot.

Only fields present in snapshot.data are restored; absent fields are left unchanged.

## Limits

```python
class Limits(TypedDict)
```

Defined in: [src/strands/types/agent.py:113](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/types/agent.py#L113)

Per-invocation budget caps for the agent loop.

Each cap, when set, bounds a single `invoke_async` / `stream_async` call only; counters are not cumulative across reuses of the same agent. Caps are checked at the top of each loop iteration, so tools requested by the previous turn always run to completion before a cap fires and `agent.messages` remains in a reinvokable state.

Each cap, when set, must be a positive `int`. Omit any field (or pass `limits=None`) for no limit on that dimension.

Priority on simultaneous trip (highest first): `turns`, `total_tokens`, `output_tokens`. The corresponding `stop_reason` is `"limit_turns"`, `"limit_total_tokens"`, or `"limit_output_tokens"`.

**Attributes**:

-   `turns` - Maximum number of agent loop iterations (turns). One turn is one model call plus any tool execution that follows. Counted against `len(metrics.latest_agent_invocation.cycles)`.
-   `output_tokens` - Maximum cumulative model-generated tokens, summed across every model call in the loop (`metrics.latest_agent_invocation.usage["outputTokens"]`). Distinct from per-call provider-level caps, which bound a single model call’s output. Soft cap: a single oversized response can overshoot the budget; checked at turn boundaries, not within an individual model call.
-   `total_tokens` - Maximum cumulative input + output tokens (`metrics.latest_agent_invocation.usage["totalTokens"]`). Each model call’s input includes prior turns, so this counter compounds across the run and approximates total token spend. Soft cap, same caveat as `output_tokens`.

## ConcurrentInvocationMode

```python
class ConcurrentInvocationMode(str, Enum)
```

Defined in: [src/strands/types/agent.py:155](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/types/agent.py#L155)

Mode controlling concurrent invocation behavior.

Values: THROW: Raises ConcurrencyException if concurrent invocation is attempted (default). UNSAFE\_REENTRANT: Allows concurrent invocations without locking.

**Warnings**:

The `UNSAFE_REENTRANT` mode makes no guarantees about resulting behavior and is provided only for advanced use cases where the caller understands the risks.