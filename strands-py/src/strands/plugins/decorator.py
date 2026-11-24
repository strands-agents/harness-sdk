"""Hook decorator for Plugin methods.

Marks methods as hook callbacks for automatic registration when the plugin
is attached to an agent. Infers event types from type hints and supports
union types for multiple events.

Example:
    ```python
    class MyPlugin(Plugin):
        @hook
        def on_model_call(self, event: BeforeModelCallEvent):
            print(event)
    ```
"""

from collections.abc import Awaitable, Callable
from typing import Generic, TypeVar, cast, overload

from ..hooks._type_inference import infer_event_types
from ..hooks.registry import HookCallback, TEvent

# Bound to a plain Callable rather than HookCallback so methods, which also take self, are accepted.
_HookCallableT = TypeVar("_HookCallableT", bound=Callable[..., None | Awaitable[None]])


class _WrappedHookCallable(HookCallback, Generic[TEvent]):
    """Wrapped version of HookCallback that includes a `_hook_event_types` attribute."""

    _hook_event_types: list[type[TEvent]]


# Handle @hook
@overload
def hook(__func: _HookCallableT) -> _HookCallableT: ...


# Handle @hook()
@overload
def hook() -> Callable[[_HookCallableT], _HookCallableT]: ...


def hook(
    func: _HookCallableT | None = None,
) -> _HookCallableT | Callable[[_HookCallableT], _HookCallableT]:
    """Mark a method as a hook callback for automatic registration.

    Infers event type from the callback's type hint. Supports union types
    for multiple events. Can be used as @hook or @hook().

    Args:
        func: The function to decorate.

    Returns:
        The decorated function with hook metadata.

    Raises:
        ValueError: If event type cannot be inferred from type hints.
    """

    def decorator(f: _HookCallableT) -> _HookCallableT:
        # Infer event types from type hints
        event_types = infer_event_types(f)

        # Store hook metadata on the function
        f_wrapped = cast(_WrappedHookCallable, f)
        f_wrapped._hook_event_types = event_types

        return f

    if func is None:
        return decorator
    return decorator(func)
