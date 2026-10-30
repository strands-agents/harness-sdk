Agent-related type definitions for the SDK.

This module defines the types used for an Agent.

## LocalAgent

```python
class LocalAgent(Protocol)
```

Defined in: [src/strands/types/agent.py:35](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/types/agent.py#L35)

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
-   `event_loop_metrics` - Aggregated metrics for the agent’s loop execution.

#### tool

```python
@property
def tool() -> _ToolCaller
```

Defined in: [src/strands/types/agent.py:68](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/types/agent.py#L68)

Caller for invoking registered tools directly.

#### tool\_names

```python
@property
def tool_names() -> list[str]
```

Defined in: [src/strands/types/agent.py:73](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/types/agent.py#L73)

Names of tools registered with the agent.

#### system\_prompt\_content

```python
@property
def system_prompt_content() -> list[SystemContentBlock] | None
```

Defined in: [src/strands/types/agent.py:78](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/types/agent.py#L78)

Structured system prompt content used by the agent.

#### session\_id

```python
@property
def session_id() -> str
```

Defined in: [src/strands/types/agent.py:83](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/types/agent.py#L83)

Identifier for the current conversation session.

#### storage

```python
@property
def storage() -> Storage | None
```

Defined in: [src/strands/types/agent.py:88](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/types/agent.py#L88)

Default storage backend for agent subsystems.

#### sandbox

```python
@property
def sandbox() -> Sandbox
```

Defined in: [src/strands/types/agent.py:93](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/types/agent.py#L93)

Execution environment for running commands, code, and file operations.

#### context\_manager

```python
@property
def context_manager() -> ContextManager | None
```

Defined in: [src/strands/types/agent.py:98](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/types/agent.py#L98)

The ContextManager plugin, if one is registered on this agent.

#### cancel\_signal

```python
@property
def cancel_signal() -> threading.Event
```

Defined in: [src/strands/types/agent.py:103](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/types/agent.py#L103)

The cancellation signal for the current invocation.

#### cancel

```python
def cancel(*,
           message: str | None = None,
           after_current_tools: bool = False) -> None
```

Defined in: [src/strands/types/agent.py:107](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/types/agent.py#L107)

Request cancellation at the agent’s next supported checkpoint.

**Arguments**:

-   `message` - Optional terminal assistant message appended to history on exit.
-   `after_current_tools` - If True, defer cancellation until the current tool batch finishes; the loop exits before the next model call.

#### add\_hook

```python
def add_hook(callback: HookCallback[_TEvent],
             event_type: type[_TEvent] | list[type[_TEvent]] | None = None,
             *,
             order: float = ...) -> None
```

Defined in: [src/strands/types/agent.py:117](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/types/agent.py#L117)

Register a hook callback.

#### take\_snapshot

```python
def take_snapshot(*,
                  preset: SnapshotPreset | None = None,
                  include: list[SnapshotField] | None = None,
                  exclude: list[SnapshotField] | None = None,
                  app_data: dict[str, Any] | None = None) -> Snapshot
```

Defined in: [src/strands/types/agent.py:127](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/types/agent.py#L127)

Capture current agent state as an in-memory snapshot.

The fields a preset captures, and the fields accepted by include and exclude, are implementation-defined.

#### load\_snapshot

```python
def load_snapshot(snapshot: Snapshot) -> None
```

Defined in: [src/strands/types/agent.py:142](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/types/agent.py#L142)

Restore agent state from a previously captured snapshot.

Only fields present in snapshot.data are restored; absent fields are left unchanged.

## Limits

```python
class Limits(TypedDict)
```

Defined in: [src/strands/types/agent.py:150](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/types/agent.py#L150)

Limits for the request a top-level `invoke_async` / `stream_async` call starts.

They apply to this agent’s loop and to every nested call: agents passed as tools, and any Graph or Swarm you pass the request’s `invocation_context` to (Graph and Swarm have no `limits` option of their own). An agent run by a hand-written tool joins only when the tool forwards `tool_context.invocation_context` as `invocation_context`; otherwise it runs standalone under its own limits. A nested call can also set its own `limits`: it stops at whichever limit is reached first, its own or the request’s.

Auxiliary calls (summarization, routing, memory extraction, steering, HITL, goal judging, web-fetch) and decision models asked with the request’s `invocation_context` add their tokens to the request’s usage, but no limits apply to them. The same holds for an agent that an extension point (a conversation manager, context or routing strategy, or memory extractor) runs with the `invocation_context` it receives, unless the extension point also passes `limits`. Usage starts from zero on each top-level call; pass `result.invocation_context` to a later call to continue on the same limits and usage.

Limits are checked before each turn, so tools requested by the previous turn finish first and `agent.messages` stays reinvokable. Each limit, when set, must be a positive `int`; omit a field (or pass `limits=None`) for no limit on that dimension.

Priority when several are reached at once (highest first): `turns`, `total_tokens`, `output_tokens`, `structured_output_attempts`, with `stop_reason` `"limit_turns"`, `"limit_total_tokens"`, `"limit_output_tokens"`, or `"limit_structured_output_attempts"`.

**Attributes**:

-   `turns` - Maximum number of turns. One turn is one model call plus any tool execution that follows.
-   `output_tokens` - Maximum cumulative model-generated tokens across every model call in the request, unlike a provider’s per-call cap. Soft limit: a single oversized response can overshoot it, more so when nested calls run in parallel.
-   `total_tokens` - Maximum cumulative input + output tokens across every model call in the request. Each model call’s input includes prior turns, so this compounds across the run and approximates total token spend. Soft limit, same caveat as `output_tokens`.
-   `structured_output_attempts` - Maximum failed structured output attempts across the request. A model response counts as one failed attempt when it calls the structured output tool with invalid input, or doesn’t return valid structured output while the tool is forced. When omitted, retries are unbounded and a failed forced response raises `StructuredOutputException`.

## ConcurrentInvocationMode

```python
class ConcurrentInvocationMode(str, Enum)
```

Defined in: [src/strands/types/agent.py:205](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/types/agent.py#L205)

Mode controlling concurrent invocation behavior.

Values: THROW: Raises ConcurrencyException if concurrent invocation is attempted (default). UNSAFE\_REENTRANT: Allows concurrent invocations without locking.

**Warnings**:

The `UNSAFE_REENTRANT` mode makes no guarantees about resulting behavior and is provided only for advanced use cases where the caller understands the risks.