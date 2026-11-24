Hook decorator for Plugin methods.

Marks methods as hook callbacks for automatic registration when the plugin is attached to an agent. Infers event types from type hints and supports union types for multiple events.

**Example**:

```python
class MyPlugin(Plugin):
    @hook
    def on_model_call(self, event: BeforeModelCallEvent):
        print(event)
```

#### hook

```python
def hook(
    func: _HookCallableT | None = None
) -> _HookCallableT | Callable[[_HookCallableT], _HookCallableT]
```

Defined in: [src/strands/plugins/decorator.py:42](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/plugins/decorator.py#L42)

Mark a method as a hook callback for automatic registration.

Infers event type from the callback’s type hint. Supports union types for multiple events. Can be used as @hook or @hook().

**Arguments**:

-   `func` - The function to decorate.

**Returns**:

The decorated function with hook metadata.

**Raises**:

-   `ValueError` - If event type cannot be inferred from type hints.