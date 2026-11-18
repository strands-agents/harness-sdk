Hook registry system for managing event callbacks in the Strands Agent SDK.

This module provides the core infrastructure for the typed hook system, enabling composable extension of agent functionality through strongly-typed event callbacks. The registry manages the mapping between event types and their associated callback functions, supporting both individual callback registration and bulk registration via hook provider objects.

## HookOrder

```python
class HookOrder()
```

Defined in: [src/strands/hooks/registry.py:31](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/hooks/registry.py#L31)

Named constants for hook execution priority.

Lower values execute first. Hooks with the same order preserve registration order.

## BaseHookEvent

```python
@dataclass
class BaseHookEvent()
```

Defined in: [src/strands/hooks/registry.py:54](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/hooks/registry.py#L54)

Base class for all hook events.

**Attributes**:

-   `invocation_context` - The request this event belongs to (`None` outside one); pass it as `invocation_context` to a nested call to join that request. Kept out of equality and repr.

#### should\_reverse\_callbacks

```python
@property
def should_reverse_callbacks() -> bool
```

Defined in: [src/strands/hooks/registry.py:66](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/hooks/registry.py#L66)

Determine if callbacks for this event should be invoked in reverse order.

**Returns**:

False by default. Override to return True for events that should invoke callbacks in reverse order (e.g., cleanup/teardown events).

#### \_\_post\_init\_\_

```python
def __post_init__() -> None
```

Defined in: [src/strands/hooks/registry.py:86](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/hooks/registry.py#L86)

Disallow writes to non-approved properties.

#### \_\_setattr\_\_

```python
def __setattr__(name: str, value: Any) -> None
```

Defined in: [src/strands/hooks/registry.py:92](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/hooks/registry.py#L92)

Prevent setting attributes on hook events.

**Raises**:

-   `AttributeError` - Always raised to prevent setting attributes on hook events.

## HookEvent

```python
@dataclass
class HookEvent(BaseHookEvent, Generic[_LocalAgentT])
```

Defined in: [src/strands/hooks/registry.py:112](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/hooks/registry.py#L112)

Base class for single agent hook events.

**Attributes**:

-   `agent` - The agent instance that triggered this event.

#### TEvent

Generic for adding callback handlers - contravariant to allow adding handlers which take in base classes.

#### TInvokeEvent

Generic for invoking events - non-contravariant to enable returning events.

## HookProvider

```python
@runtime_checkable
class HookProvider(Protocol)
```

Defined in: [src/strands/hooks/registry.py:130](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/hooks/registry.py#L130)

Protocol for objects that provide hook callbacks to an agent.

Hook providers offer a composable way to extend agent functionality by subscribing to various events in the agent lifecycle. This protocol enables building reusable components that can hook into agent events.

**Example**:

```python
class MyHookProvider(HookProvider):
    def register_hooks(self, registry: HookRegistry) -> None:
        registry.add_callback(StartRequestEvent, self.on_request_start)
        registry.add_callback(EndRequestEvent, self.on_request_end)

agent = Agent(hooks=[MyHookProvider()])
```

#### register\_hooks

```python
def register_hooks(registry: "HookRegistry", **kwargs: Any) -> None
```

Defined in: [src/strands/hooks/registry.py:148](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/hooks/registry.py#L148)

Register callback functions for specific event types.

**Arguments**:

-   `registry` - The hook registry to register callbacks with.
-   `**kwargs` - Additional keyword arguments for future extensibility.

## HookCallback

```python
class HookCallback(Protocol, Generic[TEvent])
```

Defined in: [src/strands/hooks/registry.py:158](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/hooks/registry.py#L158)

Protocol for callback functions that handle hook events.

Hook callbacks are functions that receive a single strongly-typed event argument and perform some action in response. They should not return values and any exceptions they raise will propagate to the caller.

**Example**:

```python
def my_callback(event: StartRequestEvent) -> None:
    print(f"Request started for agent: \{event.agent.name}")

# Or

async def my_callback(event: StartRequestEvent) -> None:
    # await an async operation
```

#### \_\_call\_\_

```python
def __call__(event: TEvent) -> None | Awaitable[None]
```

Defined in: [src/strands/hooks/registry.py:177](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/hooks/registry.py#L177)

Handle a hook event.

**Arguments**:

-   `event` - The strongly-typed event to handle.

## HookRegistry

```python
class HookRegistry()
```

Defined in: [src/strands/hooks/registry.py:190](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/hooks/registry.py#L190)

Registry for managing hook callbacks associated with event types.

The HookRegistry maintains a mapping of event types to callback functions and provides methods for registering callbacks and invoking them when events occur.

The registry handles callback ordering, including reverse ordering for cleanup events, and provides type-safe event dispatching.

#### \_\_init\_\_

```python
def __init__() -> None
```

Defined in: [src/strands/hooks/registry.py:201](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/hooks/registry.py#L201)

Initialize an empty hook registry.

#### add\_callback

```python
def add_callback(event_type: type[TEvent] | list[type[TEvent]] | None,
                 callback: HookCallback[TEvent],
                 *,
                 order: float = HookOrder.DEFAULT) -> None
```

Defined in: [src/strands/hooks/registry.py:205](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/hooks/registry.py#L205)

Register a callback function for a specific event type.

If `event_type` is None, then this will check the callback handler type hint for the lifecycle event type. Union types (`A | B` or `Union[A, B]`) in type hints will register the callback for each event type in the union.

If `event_type` is a list, the callback will be registered for each event type in the list (duplicates are ignored).

**Arguments**:

-   `event_type` - The lifecycle event type(s) this callback should handle. Can be a single type, a list of types, or None to infer from type hints.
-   `callback` - The callback function to invoke when events of this type occur.
-   `order` - Execution priority. Lower values execute first.

**Raises**:

-   `ValueError` - If event\_type is not provided and cannot be inferred from the callback’s type hints, or if AgentInitializedEvent is registered with an async callback, or if the event\_type list is empty.

**Example**:

```python
def my_handler(event: StartRequestEvent):
    print("Request started")

# With explicit event type
registry.add_callback(StartRequestEvent, my_handler)

# With event type inferred from type hint
registry.add_callback(None, my_handler)

# With union type hint (registers for both types)
def union_handler(event: BeforeModelCallEvent | AfterModelCallEvent):
    print(f"Event: \{type(event).__name__}")
registry.add_callback(None, union_handler)

# With list of event types
def multi_handler(event):
    print(f"Event: \{type(event).__name__}")
registry.add_callback([BeforeModelCallEvent, AfterModelCallEvent], multi_handler)
```

#### add\_hook

```python
def add_hook(hook: HookProvider) -> None
```

Defined in: [src/strands/hooks/registry.py:300](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/hooks/registry.py#L300)

Register all callbacks from a hook provider.

This method allows bulk registration of callbacks by delegating to the hook provider’s register\_hooks method. This is the preferred way to register multiple related callbacks.

**Arguments**:

-   `hook` - The hook provider containing callbacks to register.

**Example**:

```python
class MyHooks(HookProvider):
    def register_hooks(self, registry: HookRegistry):
        registry.add_callback(StartRequestEvent, self.on_start)
        registry.add_callback(EndRequestEvent, self.on_end)

registry.add_hook(MyHooks())
```

#### invoke\_callbacks\_async

```python
async def invoke_callbacks_async(
        event: TInvokeEvent) -> tuple[TInvokeEvent, list[Interrupt]]
```

Defined in: [src/strands/hooks/registry.py:322](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/hooks/registry.py#L322)

Invoke all registered callbacks for the given event.

This method finds all callbacks registered for the event’s type and invokes them in the appropriate order. For events with should\_reverse\_callbacks=True, callbacks are invoked in reverse registration order. Any exceptions raised by callback functions will propagate to the caller.

Additionally, this method aggregates interrupts raised by the user to instantiate human-in-the-loop workflows.

**Arguments**:

-   `event` - The event to dispatch to registered callbacks.

**Returns**:

The event dispatched to registered callbacks and any interrupts raised by the user.

**Raises**:

-   `ValueError` - If interrupt name is used more than once.

**Example**:

```python
event = StartRequestEvent(agent=my_agent)
await registry.invoke_callbacks_async(event)
```

#### invoke\_callbacks

```python
def invoke_callbacks(
        event: TInvokeEvent) -> tuple[TInvokeEvent, list[Interrupt]]
```

Defined in: [src/strands/hooks/registry.py:367](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/hooks/registry.py#L367)

Invoke all registered callbacks for the given event.

This method finds all callbacks registered for the event’s type and invokes them in the appropriate order. For events with should\_reverse\_callbacks=True, callbacks are invoked in reverse registration order. Any exceptions raised by callback functions will propagate to the caller.

Additionally, this method aggregates interrupts raised by the user to instantiate human-in-the-loop workflows.

**Arguments**:

-   `event` - The event to dispatch to registered callbacks.

**Returns**:

The event dispatched to registered callbacks and any interrupts raised by the user.

**Raises**:

-   `RuntimeError` - If at least one callback is async, or a synchronous callback returns a coroutine.
-   `ValueError` - If interrupt name is used more than once.

**Example**:

```python
event = StartRequestEvent(agent=my_agent)
registry.invoke_callbacks(event)
```

#### has\_callbacks

```python
def has_callbacks() -> bool
```

Defined in: [src/strands/hooks/registry.py:421](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/hooks/registry.py#L421)

Check if the registry has any registered callbacks.

**Returns**:

True if there are any registered callbacks, False otherwise.

**Example**:

```python
if registry.has_callbacks():
    print("Registry has callbacks registered")
```

#### get\_callbacks\_for

```python
def get_callbacks_for(
        event: TEvent) -> Generator[HookCallback[TEvent], None, None]
```

Defined in: [src/strands/hooks/registry.py:435](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/hooks/registry.py#L435)

Get callbacks registered for the given event in the appropriate order.

For normal events, callbacks are returned in order priority (lower first), with registration order preserved within the same priority.

For reversed events (should\_reverse\_callbacks=True), order priority still applies (lower first), but within the same priority group, registration order is reversed.

**Arguments**:

-   `event` - The event to get callbacks for.

**Yields**:

Callback functions registered for this event type, in the appropriate order.

**Example**:

```python
event = EndRequestEvent(agent=my_agent)
for callback in registry.get_callbacks_for(event):
    callback(event)
```