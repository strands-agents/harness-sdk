"""Hook registry system for managing event callbacks in the Strands Agent SDK.

This module provides the core infrastructure for the typed hook system, enabling
composable extension of agent functionality through strongly-typed event callbacks.
The registry manages the mapping between event types and their associated callback
functions, supporting both individual callback registration and bulk registration
via hook provider objects.
"""

import bisect
import inspect
import logging
from collections.abc import Awaitable, Generator
from dataclasses import dataclass
from itertools import groupby
from typing import TYPE_CHECKING, Any, Generic, Protocol, runtime_checkable

from typing_extensions import TypeVar

from ..interrupt import Interrupt, InterruptException
from ._type_inference import infer_event_types

if TYPE_CHECKING:
    from ..agent import Agent
    from ..types.agent import LocalAgent

logger = logging.getLogger(__name__)


class HookOrder:
    """Named constants for hook execution priority.

    Lower values execute first. Hooks with the same order preserve registration order.
    """

    SDK_FIRST: int = -100
    INTERVENTION_OUTPUT: int = -90
    DEFAULT: int = 0
    MODEL_ROUTING: int = 50
    INTERVENTION_INPUT: int = 90
    SDK_LAST: int = 100


@dataclass
class _CallbackEntry:
    """Internal entry pairing a callback with its execution order."""

    callback: "HookCallback"
    order: float


@dataclass
class BaseHookEvent:
    """Base class for all hook events."""

    @property
    def should_reverse_callbacks(self) -> bool:
        """Determine if callbacks for this event should be invoked in reverse order.

        Returns:
            False by default. Override to return True for events that should
            invoke callbacks in reverse order (e.g., cleanup/teardown events).
        """
        return False

    def _can_write(self, name: str) -> bool:
        """Check if the given property can be written to.

        Args:
            name: The name of the property to check.

        Returns:
            True if the property can be written to, False otherwise.
        """
        return False

    def __post_init__(self) -> None:
        """Disallow writes to non-approved properties."""
        # This is needed as otherwise the class can't be initialized at all, so we trigger
        # this after class initialization
        super().__setattr__("_disallow_writes", True)

    def __setattr__(self, name: str, value: Any) -> None:
        """Prevent setting attributes on hook events.

        Raises:
            AttributeError: Always raised to prevent setting attributes on hook events.
        """
        #  Allow setting attributes:
        #    - during init (when __dict__) doesn't exist
        #    - if the subclass specifically said the property is writable
        if not hasattr(self, "_disallow_writes") or self._can_write(name):
            return super().__setattr__(name, value)

        raise AttributeError(f"Property {name} is not writable")


_LocalAgentT = TypeVar("_LocalAgentT", bound="LocalAgent", default="Agent", covariant=True)
"""Agent type carried by hook events."""


@dataclass
class HookEvent(BaseHookEvent, Generic[_LocalAgentT]):
    """Base class for single agent hook events.

    Attributes:
        agent: The agent instance that triggered this event.
    """

    agent: _LocalAgentT


TEvent = TypeVar("TEvent", bound=BaseHookEvent, contravariant=True)
"""Generic for adding callback handlers - contravariant to allow adding handlers which take in base classes."""

TInvokeEvent = TypeVar("TInvokeEvent", bound=BaseHookEvent)
"""Generic for invoking events - non-contravariant to enable returning events."""


@runtime_checkable
class HookProvider(Protocol):
    """Protocol for objects that provide hook callbacks to an agent.

    Hook providers offer a composable way to extend agent functionality by
    subscribing to various events in the agent lifecycle. This protocol enables
    building reusable components that can hook into agent events.

    Example:
        ```python
        class MyHookProvider(HookProvider):
            def register_hooks(self, registry: HookRegistry) -> None:
                registry.add_callback(StartRequestEvent, self.on_request_start)
                registry.add_callback(EndRequestEvent, self.on_request_end)

        agent = Agent(hooks=[MyHookProvider()])
        ```
    """

    def register_hooks(self, registry: "HookRegistry", **kwargs: Any) -> None:
        """Register callback functions for specific event types.

        Args:
            registry: The hook registry to register callbacks with.
            **kwargs: Additional keyword arguments for future extensibility.
        """
        ...


class HookCallback(Protocol, Generic[TEvent]):
    """Protocol for callback functions that handle hook events.

    Hook callbacks are functions that receive a single strongly-typed event
    argument and perform some action in response. They should not return
    values and any exceptions they raise will propagate to the caller.

    Example:
        ```python
        def my_callback(event: StartRequestEvent) -> None:
            print(f"Request started for agent: {event.agent.name}")

        # Or

        async def my_callback(event: StartRequestEvent) -> None:
            # await an async operation
        ```
    """

    def __call__(self, event: TEvent) -> None | Awaitable[None]:
        """Handle a hook event.

        Args:
            event: The strongly-typed event to handle.
        """
        ...


class HookRegistry:
    """Registry for managing hook callbacks associated with event types.

    The HookRegistry maintains a mapping of event types to callback functions
    and provides methods for registering callbacks and invoking them when
    events occur.

    The registry handles callback ordering, including reverse ordering for
    cleanup events, and provides type-safe event dispatching.
    """

    def __init__(self) -> None:
        """Initialize an empty hook registry."""
        self._registered_callbacks: dict[type, list[_CallbackEntry]] = {}

    def add_callback(
        self,
        event_type: type[TEvent] | list[type[TEvent]] | None,
        callback: HookCallback[TEvent],
        *,
        order: float = HookOrder.DEFAULT,
    ) -> None:
        """Register a callback function for a specific event type.

        If ``event_type`` is None, then this will check the callback handler type hint
        for the lifecycle event type. Union types (``A | B`` or ``Union[A, B]``) in
        type hints will register the callback for each event type in the union.

        If ``event_type`` is a list, the callback will be registered for each event
        type in the list (duplicates are ignored).

        Args:
            event_type: The lifecycle event type(s) this callback should handle.
                Can be a single type, a list of types, or None to infer from type hints.
            callback: The callback function to invoke when events of this type occur.
            order: Execution priority. Lower values execute first.

        Raises:
            ValueError: If event_type is not provided and cannot be inferred from
                the callback's type hints, or if AgentInitializedEvent is registered
                with an async callback, or if the event_type list is empty.

        Example:
            ```python
            def my_handler(event: StartRequestEvent):
                print("Request started")

            # With explicit event type
            registry.add_callback(StartRequestEvent, my_handler)

            # With event type inferred from type hint
            registry.add_callback(None, my_handler)

            # With union type hint (registers for both types)
            def union_handler(event: BeforeModelCallEvent | AfterModelCallEvent):
                print(f"Event: {type(event).__name__}")
            registry.add_callback(None, union_handler)

            # With list of event types
            def multi_handler(event):
                print(f"Event: {type(event).__name__}")
            registry.add_callback([BeforeModelCallEvent, AfterModelCallEvent], multi_handler)
            ```
        """
        resolved_event_types: list[type[TEvent]]

        # Handle list of event types
        if isinstance(event_type, list):
            if not event_type:
                raise ValueError("event_type list cannot be empty")
            resolved_event_types = self._validate_event_type_list(event_type)
        elif event_type is None:
            # Infer event type(s) from callback type hints
            resolved_event_types = infer_event_types(callback)
        else:
            # Single event type provided explicitly
            resolved_event_types = [event_type]

        # Deduplicate event types while preserving order
        unique_event_types: set[type[TEvent]] = set(resolved_event_types)

        # Register callback for each event type
        for resolved_event_type in unique_event_types:
            # Related issue: https://github.com/strands-agents/harness-sdk/issues/330
            if resolved_event_type.__name__ == "AgentInitializedEvent" and inspect.iscoroutinefunction(callback):
                raise ValueError("AgentInitializedEvent can only be registered with a synchronous callback")

            entries = self._registered_callbacks.setdefault(resolved_event_type, [])
            entry = _CallbackEntry(callback=callback, order=order)
            bisect.insort(entries, entry, key=lambda e: e.order)

    def _validate_event_type_list(self, event_types: list[type[TEvent]]) -> list[type[TEvent]]:
        """Validate that all types in a list are valid BaseHookEvent subclasses.

        Args:
            event_types: List of event types to validate.

        Returns:
            The validated list of event types.

        Raises:
            ValueError: If any type is not a valid BaseHookEvent subclass.
        """
        validated: list[type[TEvent]] = []
        for et in event_types:
            if not (isinstance(et, type) and issubclass(et, BaseHookEvent)):
                raise ValueError(f"Invalid event type: {et} | must be a subclass of BaseHookEvent")
            validated.append(et)
        return validated

    def add_hook(self, hook: HookProvider) -> None:
        """Register all callbacks from a hook provider.

        This method allows bulk registration of callbacks by delegating to
        the hook provider's register_hooks method. This is the preferred
        way to register multiple related callbacks.

        Args:
            hook: The hook provider containing callbacks to register.

        Example:
            ```python
            class MyHooks(HookProvider):
                def register_hooks(self, registry: HookRegistry):
                    registry.add_callback(StartRequestEvent, self.on_start)
                    registry.add_callback(EndRequestEvent, self.on_end)

            registry.add_hook(MyHooks())
            ```
        """
        hook.register_hooks(self)

    async def invoke_callbacks_async(self, event: TInvokeEvent) -> tuple[TInvokeEvent, list[Interrupt]]:
        """Invoke all registered callbacks for the given event.

        This method finds all callbacks registered for the event's type and
        invokes them in the appropriate order. For events with should_reverse_callbacks=True,
        callbacks are invoked in reverse registration order. Any exceptions raised by callback
        functions will propagate to the caller.

        Additionally, this method aggregates interrupts raised by the user to instantiate human-in-the-loop workflows.

        Args:
            event: The event to dispatch to registered callbacks.

        Returns:
            The event dispatched to registered callbacks and any interrupts raised by the user.

        Raises:
            ValueError: If interrupt name is used more than once.

        Example:
            ```python
            event = StartRequestEvent(agent=my_agent)
            await registry.invoke_callbacks_async(event)
            ```
        """
        interrupts: dict[str, Interrupt] = {}

        for callback in self.get_callbacks_for(event):
            try:
                if inspect.iscoroutinefunction(callback):
                    await callback(event)
                else:
                    callback(event)

            except InterruptException as exception:
                interrupt = exception.interrupt
                if interrupt.name in interrupts:
                    message = f"interrupt_name=<{interrupt.name}> | interrupt name used more than once"
                    logger.error(message)
                    raise ValueError(message) from exception

                # Each callback is allowed to raise their own interrupt.
                interrupts[interrupt.name] = interrupt

        return event, list(interrupts.values())

    def invoke_callbacks(self, event: TInvokeEvent) -> tuple[TInvokeEvent, list[Interrupt]]:
        """Invoke all registered callbacks for the given event.

        This method finds all callbacks registered for the event's type and
        invokes them in the appropriate order. For events with should_reverse_callbacks=True,
        callbacks are invoked in reverse registration order. Any exceptions raised by callback
        functions will propagate to the caller.

        Additionally, this method aggregates interrupts raised by the user to instantiate human-in-the-loop workflows.

        Args:
            event: The event to dispatch to registered callbacks.

        Returns:
            The event dispatched to registered callbacks and any interrupts raised by the user.

        Raises:
            RuntimeError: If at least one callback is async.
            ValueError: If interrupt name is used more than once.

        Example:
            ```python
            event = StartRequestEvent(agent=my_agent)
            registry.invoke_callbacks(event)
            ```
        """
        callbacks = list(self.get_callbacks_for(event))
        interrupts: dict[str, Interrupt] = {}

        if any(inspect.iscoroutinefunction(callback) for callback in callbacks):
            raise RuntimeError(f"event=<{event}> | use invoke_callbacks_async to invoke async callback")

        for callback in callbacks:
            try:
                callback(event)
            except InterruptException as exception:
                interrupt = exception.interrupt
                if interrupt.name in interrupts:
                    message = f"interrupt_name=<{interrupt.name}> | interrupt name used more than once"
                    logger.error(message)
                    raise ValueError(message) from exception

                # Each callback is allowed to raise their own interrupt.
                interrupts[interrupt.name] = interrupt

        return event, list(interrupts.values())

    def has_callbacks(self) -> bool:
        """Check if the registry has any registered callbacks.

        Returns:
            True if there are any registered callbacks, False otherwise.

        Example:
            ```python
            if registry.has_callbacks():
                print("Registry has callbacks registered")
            ```
        """
        return bool(self._registered_callbacks)

    def get_callbacks_for(self, event: TEvent) -> Generator[HookCallback[TEvent], None, None]:
        """Get callbacks registered for the given event in the appropriate order.

        For normal events, callbacks are returned in order priority (lower first),
        with registration order preserved within the same priority.

        For reversed events (should_reverse_callbacks=True), order priority still
        applies (lower first), but within the same priority group, registration
        order is reversed.

        Args:
            event: The event to get callbacks for.

        Yields:
            Callback functions registered for this event type, in the appropriate order.

        Example:
            ```python
            event = EndRequestEvent(agent=my_agent)
            for callback in registry.get_callbacks_for(event):
                callback(event)
            ```
        """
        event_type = type(event)

        entries = self._registered_callbacks.get(event_type, [])
        if event.should_reverse_callbacks:
            for _order, group in groupby(entries, key=lambda e: e.order):
                for entry in reversed(list(group)):
                    yield entry.callback
        else:
            for entry in entries:
                yield entry.callback
