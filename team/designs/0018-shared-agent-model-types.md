# Shared Agent and Model Types

**Status**: Proposed

**Date**: 2026-08-12

**Issue**: [#3764](https://github.com/strands-agents/harness-sdk/issues/3764)

## Overview

`Agent` and `BidiAgent` expose much of the same state, tool, and hook surface, but they do not share a type. The same is true of `Model` and `BidiModel`. Code that supports both therefore relies on `Any`, duplicated APIs, or runtime type checks, limiting the guidance available from static typing.

This document proposes a common typing foundation for standard and bidirectional agents and models. The goal is to let tools, hooks, session management, and other shared components depend on common capabilities, while keeping behavior specific to turn-based or bidirectional interaction separate.

## Problem

The missing shared types have led to several workable but awkward patterns in code that supports both interaction styles. The following examples show how those patterns appear in tools, hooks, session management, and model-facing code.

### Tool Context

[`ToolContext.agent`](https://github.com/strands-agents/harness-sdk/blob/3e3859e9c68fffc31c23e2f67b10037bc95493e2/strands-py/src/strands/types/tools.py#L141-L162) is typed as `Any`:

```python
@dataclass
class ToolContext(_Interruptible):
    ...
    agent: Any  # Agent or BidiAgent - using Any for backwards compatibility
    ...
```

This allows one context type to serve both agents, but the type checker cannot validate or provide useful guidance for any access through `agent`.

### Tool Executor

[`ToolExecutor`](https://github.com/strands-agents/harness-sdk/blob/3e3859e9c68fffc31c23e2f67b10037bc95493e2/strands-py/src/strands/tools/executors/_executor.py#L38-L64) serves both `Agent` and `BidiAgent`. Without a common agent type, it accepts `Agent | BidiAgent`, checks the agent at runtime, and casts it to construct the corresponding hook event:

```python
event = (
    BeforeToolCallEvent(agent=cast("Agent", agent), **kwargs)
    if ToolExecutor._is_agent(agent)
    else BidiBeforeToolCallEvent(agent=cast("BidiAgent", agent), **kwargs)
)
```

This works, but it is cumbersome. The executor must carry both concrete types, branch between equivalent paths, and add casts for the type checker. The same pattern can appear elsewhere as other shared components add behavior for both agent implementations.

### Hook Events

Hooks define separate events for standard and bidirectional agents, even where the event data and lifecycle semantics match. A hook provider that supports both must register for both event types, and shared code must select which event to emit.

The copies can also drift as they evolve independently. [`AfterToolCallEvent`](https://github.com/strands-agents/harness-sdk/blob/3e3859e9c68fffc31c23e2f67b10037bc95493e2/strands-py/src/strands/hooks/events.py#L248-L296) gained a `retry` field, but the corresponding update has not yet been made to [`BidiAfterToolCallEvent`](https://github.com/strands-agents/harness-sdk/blob/3e3859e9c68fffc31c23e2f67b10037bc95493e2/strands-py/src/strands/experimental/hooks/events.py#L148-L187). The executor therefore reads the field defensively with `getattr`.

### Session Methods

Session persistence performs the same core operations for both agent types. It initializes the agent, appends messages, and synchronizes state. Because the existing methods accept `Agent`, [`SessionManager`](https://github.com/strands-agents/harness-sdk/blob/3e3859e9c68fffc31c23e2f67b10037bc95493e2/strands-py/src/strands/session/session_manager.py#L64-L170) defines a second set of methods for `BidiAgent`, and hook registration routes each agent type to its own set.

Only the `Agent` methods are abstract. The bidirectional methods are concrete and raise `NotImplementedError` by default. A custom session manager can therefore satisfy the declared abstract interface and instantiate successfully, but fail when used with `BidiAgent`.

Supporting both agent types also requires maintaining two implementations of the same operations. This duplication continues into `RepositorySessionManager` and session serialization.

### Model Types

[`BidiModel`](https://github.com/strands-agents/harness-sdk/blob/3e3859e9c68fffc31c23e2f67b10037bc95493e2/strands-py/src/strands/experimental/bidi/models/model.py#L30-L115) is defined independently from `Model`, so shared code cannot express the model capabilities that apply to both interaction patterns. This becomes relevant in hooks and other agent-adjacent components that use model features such as stateful behavior, token counting, and context window information.

[`ContextOffloader`](https://github.com/strands-agents/harness-sdk/blob/3e3859e9c68fffc31c23e2f67b10037bc95493e2/strands-py/src/strands/vended_plugins/context_offloader/plugin.py#L486-L488) provides one example. It counts a tool result through the model on a hook event.

```python
token_count = await event.agent.model.count_tokens([tool_result_message])
```

`count_tokens` is available on `Model` but is not declared by `BidiModel`. A hook intended to support both agent types therefore cannot express this dependency through one model type.

## Solution

This design uses the existing model hierarchy for model compatibility and introduces a protocol for locally available agent capabilities. It unifies the common surfaces without combining the different agent lifecycles.

### Model Types

`Model` is already the abstract provider contract in Python and TypeScript, so unlike agents, models do not need a new shared protocol. `BidiModel` becomes an abstract subclass of `Model` that adds persistent connection methods.

```python
class BidiModel(Model):
    @abstractmethod
    async def start(
        self,
        system_prompt: str | None = None,
        tools: list[ToolSpec] | None = None,
        messages: Messages | None = None,
        **kwargs: Any,
    ) -> None: ...

    @abstractmethod
    async def send(self, content: BidiInputEvent | ToolResultEvent) -> None: ...

    @abstractmethod
    def receive(self) -> AsyncIterable[BidiOutputEvent]: ...

    @abstractmethod
    async def stop(self) -> None: ...
```

As a `Model` subclass, each bidirectional provider must implement the existing abstract contract as well as the new methods. The current providers may initially implement `stream` by raising `NotImplementedError`. This provides type compatibility first. A provider gains behavioral compatibility once it implements regular streaming, without changing its type or the interfaces that receive it.

This treats bidirectional interaction as an additional invocation mode rather than a separate model category. Providers often expose several modes through a single client. The Bedrock Runtime client, for example, exposes operations such as `invoke_model`, `converse`, and `converse_stream`. A `BidiModel` follows the same pattern by supporting regular streaming alongside the methods needed for a persistent conversation. The [Unified Model](#unified-model) appendix considers taking this further by defining the bidirectional methods directly on `Model`.

When a `BidiModel` is passed through a `Model`-typed interface, only the `Model` API is visible. This is intentional. The persistent lifecycle is normally owned by `BidiAgent`. Tools, shared hooks, and session managers generally should not call `start`, consume `receive`, or call `stop`. They can still use `stream` for isolated model work without taking ownership of the active conversation.

This ownership boundary is a default, not a restriction. Specialized code may still need a bidirectional method. Direct `send` is one plausible example for behavior such as a progress announcement during an active session. This code can accept `BidiModel` directly or narrow the type.

```python
model = tool_context.agent.model

if isinstance(model, BidiModel):
    await model.send(BidiTextInputEvent(text="Still working"))
```

### Agent Type

TypeScript already defines [`LocalAgent`](https://github.com/strands-agents/harness-sdk/blob/3e3859e9c68fffc31c23e2f67b10037bc95493e2/strands-ts/src/types/agent.ts#L249-L404) for APIs that expose locally available agent state, tools, hooks, and services without exposing agent invocation. This proposal brings the same design boundary into Python.

Python `Agent` and `BidiAgent` share that local surface, but they expose different invocation APIs. `LocalAgent` captures the common capabilities while excluding both turn-based invocation methods and the bidirectional connection lifecycle.

```python
@runtime_checkable
class LocalAgent(Protocol):
    agent_id: str
    name: str
    description: str | None
    messages: Messages
    state: AgentState
    hooks: HookRegistry
    event_loop_metrics: EventLoopMetrics

    @property
    def system_prompt(self) -> str | None: ...

    @system_prompt.setter
    def system_prompt(
        self,
        value: str | list[SystemContentBlock] | None,
    ) -> None: ...

    @property
    def model(self) -> Model: ...

    @property
    def sandbox(self) -> Sandbox: ...

    @property
    def tool_names(self) -> list[str]: ...

    @property
    def tool_registry(self) -> ToolRegistry: ...

    @property
    def tool_executor(self) -> ToolExecutor: ...

    def add_hook(
        self,
        callback: HookCallback[TEvent],
        event_type: type[TEvent] | list[type[TEvent]] | None = None,
        *,
        order: float = HookOrder.DEFAULT,
    ) -> None: ...

    def take_snapshot(
        self,
        *,
        preset: SnapshotPreset | None = None,
        include: list[SnapshotField] | None = None,
        exclude: list[SnapshotField] | None = None,
        app_data: dict[str, Any] | None = None,
    ) -> Snapshot: ...

    def load_snapshot(self, snapshot: Snapshot) -> None: ...
```

The protocol is intentionally broad. It covers the public members already used through built-in tool contexts and hook events, including metrics and snapshots. `BidiAgent` must provide the same local services before it is used through `LocalAgent`.

`model` remains typed as `Model` so existing tools and hooks can continue to call methods such as `stream`. The TypeScript contract likewise declares `readonly model: Model`. Python uses a read-only property for the same reason, allowing `Agent.model` to remain `Model` and `BidiAgent.model` to remain the narrower `BidiModel`.

Excluding agent invocation is deliberate. Tools and hooks commonly use their agent's model for isolated work, but they do not normally reinvoke the agent that is currently running. Concurrent agent invocation is also generally disallowed. Code that needs invocation or private runtime state should accept the concrete agent type or narrow with `isinstance`.

Changing existing annotations directly from `Any` or `Agent` to `LocalAgent` could break customer builds that run a type checker. This proposal instead uses defaulted generic parameters at the affected extension points. Existing unparameterized annotations keep their current types, while code that supports both agents opts into `LocalAgent`.

`ToolContext` defaults to `Any`, matching its current annotation. Shared hook events and `SessionManager` default to `Agent`, matching theirs. Each can be parameterized with `LocalAgent` when it supports both agent implementations.

The SDK supports Python 3.10, so it uses `typing_extensions.TypeVar` rather than the Python 3.13 type-parameter syntax. The existing `typing-extensions` dependency already supports defaults.

This approach preserves runtime behavior and the existing static defaults. A future major version can make `LocalAgent` the default once customers have had time to adopt the shared contract. The [Direct Adoption](#direct-adoption) and [Any Boundaries](#any-boundaries) appendices describe simpler alternatives.

## Impact

The proposed types replace the workarounds described in the Problem section.

### Tool Context

`ToolContext` becomes generic over its agent type. The default remains `Any`, preserving the current behavior for existing annotations.

```python
from typing import Any, Generic

from typing_extensions import TypeVar

AgentT = TypeVar(
    "AgentT",
    bound=LocalAgent,
    default=Any,
)

@dataclass
class ToolContext(_Interruptible, Generic[AgentT]):
    ...
    agent: AgentT
    ...
```

Tools that support both agents opt into completion and type checking for the common surface.

```python
@tool(context=True)
async def read_file(
    path: str,
    tool_context: ToolContext[LocalAgent],
) -> str:
    return await tool_context.agent.sandbox.read_text(path)
```

The tool decorator already inspects parameter annotations to identify `ToolContext`. It must also recognize parameterized annotations by resolving their generic origin.

### Tool Executor

`ToolExecutor` can construct the shared tool events directly with `LocalAgent` as the event's agent type.

```python
event = BeforeToolCallEvent[LocalAgent](
    agent=agent,
    selected_tool=tool_func,
    tool_use=tool_use,
    invocation_state=invocation_state,
)
```

The runtime branch and casts used to select an event type are no longer needed. The executor may retain its internal `Agent | BidiAgent` union where it accesses private implementation state.

### Hook Events

`HookEvent` becomes generic over its agent type and defaults to `Agent`. Existing standard-agent callbacks therefore retain their current type.

```python
from typing import Generic

from typing_extensions import TypeVar

AgentT = TypeVar(
    "AgentT",
    bound=LocalAgent,
    default=Agent,
    covariant=True,
)

@dataclass
class HookEvent(BaseHookEvent, Generic[AgentT]):
    agent: AgentT
```

`AgentInitializedEvent`, `MessageAddedEvent`, `BeforeToolCallEvent`, and `AfterToolCallEvent` carry the same generic parameter. A hook that supports both agents opts into `LocalAgent`.

```python
def on_before_tool(
    event: BeforeToolCallEvent[LocalAgent],
) -> None:
    ...

registry.add_callback(BeforeToolCallEvent, on_before_tool)
```

The parameterized annotation is used for static checking. At runtime, registration and dispatch continue to use the underlying `BeforeToolCallEvent` class. Hook inference must resolve the generic origin when it reads a callback annotation.

`BidiAgent` should emit the shared event classes themselves, using `LocalAgent` as their static agent type. The bidirectional loop must also honor `AfterToolCallEvent.retry`.

Connection and interruption events remain bidirectional. The same applies to `BidiBeforeInvocationEvent` and `BidiAfterInvocationEvent`, which describe the lifetime of a session rather than one turn. Standard-only events remain unparameterized and continue to expose `Agent`.

### Session Methods

`SessionManager` becomes contravariantly generic over the agent type and defaults to `Agent`. Existing direct subclasses can retain their current method signatures. A direct manager that supports both agents extends `SessionManager[LocalAgent]`.

```python
AgentT = TypeVar(
    "AgentT",
    bound=LocalAgent,
    default=Agent,
    contravariant=True,
)

class SessionManager(HookProvider, ABC, Generic[AgentT]):
    def initialize(self, agent: AgentT, **kwargs: Any) -> None: ...
    def append_message(
        self,
        message: Message,
        agent: AgentT,
        **kwargs: Any,
    ) -> None: ...
    def sync_agent(self, agent: AgentT, **kwargs: Any) -> None: ...
    def redact_latest_message(
        self,
        redact_message: Message,
        agent: AgentT,
        **kwargs: Any,
    ) -> None: ...
```

```python
class RepositorySessionManager(SessionManager[LocalAgent]):
    ...
```

Most custom storage integrations implement [`SessionRepository`](https://strandsagents.com/docs/user-guide/concepts/agents/session-management/#custom-session-repositories) and pass it to `RepositorySessionManager`. That repository contract remains unchanged. Because `RepositorySessionManager` supports both agent types, custom repositories receive the same support without adopting the generic interface themselves.

`Agent` accepts a standard or shared manager. `BidiAgent` requires `SessionManager[LocalAgent]`. The shared initialization and message events call the common methods for either agent. `AfterInvocationEvent` and `BidiAfterInvocationEvent` can both register `sync_agent` for their respective lifecycles.

This removes `initialize_bidi_agent`, `append_bidi_message`, and `sync_bidi_agent` from the abstract interface. `RepositorySessionManager` can share common persistence logic and narrow only when an agent has different serialization requirements.

### Model Types

`LocalAgent.model` is typed as `Model`, so model configuration and regular model calls work uniformly for both agents.

```python
model = tool_context.agent.model
tokens = await model.count_tokens(tool_context.agent.messages)

async for event in model.stream(messages):
    ...
```

Bidirectional methods require `BidiModel`.

```python
model = tool_context.agent.model

if isinstance(model, BidiModel):
    await model.send(progress_event)
```

`BidiAgent.model` remains `BidiModel`, so a turn-only model is still rejected by the type checker.

## Resources

- [#1722 Bidirectional streaming graduation](https://github.com/strands-agents/harness-sdk/issues/1722)
- [#3764 Shared agent and model typing](https://github.com/strands-agents/harness-sdk/issues/3764)
- [Compatibility policy](../COMPATIBILITY.md)
- [Hook event conventions](../../strands-py/docs/HOOKS.md)
- [`Protocol` and ABC guidance](../../strands-py/docs/STYLE_GUIDE.md)

## Appendix

### Unified Model

An alternative is to define `start`, `send`, `receive`, and `stop` directly on `Model`. This would treat every invocation mode as part of one provider contract, and code with a `Model` reference could use bidirectional methods without narrowing.

This shape fits providers that expose several invocation APIs through one client. It is harder to introduce into the current contract because most models do not support a persistent connection. Making the methods abstract would break every existing provider, while default implementations that raise `NotImplementedError` would expose methods that may not work.

A future major version could revisit this design alongside an explicit way to discover supported invocation modes. For now, the `BidiModel` subclass keeps the bidirectional requirement enforceable without changing the contract for turn-only providers.

### Direct Adoption

The initial proposal changed the affected APIs directly to `LocalAgent`.

```python
class ToolContext:
    agent: LocalAgent

class HookEvent:
    agent: LocalAgent

class SessionManager:
    def initialize(self, agent: LocalAgent, **kwargs: Any) -> None: ...
```

This is the simplest and strictest design. It also changes the static contract immediately. Existing hooks and helpers may pass the agent to code that accepts `Agent`, and custom session managers may override methods with `Agent` parameters. Those patterns continue to work at runtime but can fail during type checking.

This approach may be appropriate for a major version. It aligns the default Python types with the shared boundary already used in TypeScript without requiring generic compatibility defaults.

### Any Boundaries

Another option is to use `Any` for agent values at extension points shared by `Agent` and `BidiAgent`.

```python
class ToolContext:
    agent: Any

class BeforeToolCallEvent:
    agent: Any

class SessionManager:
    def initialize(self, agent: Any, **kwargs: Any) -> None: ...
```

The tradeoff is that shared extension code receives little static guidance, which leaves much of the current typing problem unresolved. This could still be a pragmatic first step. A future major version could replace `Any` with `LocalAgent` and align the defaults with TypeScript.
