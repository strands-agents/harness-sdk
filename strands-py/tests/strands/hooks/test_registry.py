import unittest.mock
from typing import Union

import pytest

from strands import LocalAgent
from strands.hooks import (
    AfterModelCallEvent,
    AgentInitializedEvent,
    BeforeInvocationEvent,
    BeforeModelCallEvent,
    BeforeToolCallEvent,
    HookOrder,
    HookRegistry,
)
from strands.interrupt import Interrupt, _InterruptState


def _has_callback(registry, event_type, callback):
    """Check if a callback is registered for an event type."""
    return any(entry.callback is callback for entry in registry._registered_callbacks.get(event_type, []))


@pytest.fixture
def registry():
    return HookRegistry()


@pytest.fixture
def agent():
    instance = unittest.mock.Mock()
    instance._interrupt_state = _InterruptState()
    return instance


def test_hook_registry_add_callback_agent_init_coroutine(registry):
    callback = unittest.mock.AsyncMock()

    with pytest.raises(ValueError, match=r"AgentInitializedEvent can only be registered with a synchronous callback"):
        registry.add_callback(AgentInitializedEvent, callback)


@pytest.mark.asyncio
async def test_hook_registry_invoke_callbacks_async_interrupt(registry, agent):
    event = BeforeToolCallEvent(
        agent=agent,
        selected_tool=None,
        tool_use={"toolUseId": "test_tool_id", "name": "test_tool_name", "input": {}},
        invocation_state={},
    )

    callback1 = unittest.mock.Mock(side_effect=lambda event: event.interrupt("test_name_1", "test reason 1"))
    callback2 = unittest.mock.Mock()
    callback3 = unittest.mock.Mock(side_effect=lambda event: event.interrupt("test_name_2", "test reason 2"))

    registry.add_callback(BeforeToolCallEvent, callback1)
    registry.add_callback(BeforeToolCallEvent, callback2)
    registry.add_callback(BeforeToolCallEvent, callback3)

    _, tru_interrupts = await registry.invoke_callbacks_async(event)
    exp_interrupts = [
        Interrupt(
            id="v1:before_tool_call:test_tool_id:da3551f3-154b-5978-827e-50ac387877ee",
            name="test_name_1",
            reason="test reason 1",
        ),
        Interrupt(
            id="v1:before_tool_call:test_tool_id:0f5a8068-d1ba-5a48-bf67-c9d33786d8d4",
            name="test_name_2",
            reason="test reason 2",
        ),
    ]
    assert tru_interrupts == exp_interrupts

    callback1.assert_called_once_with(event)
    callback2.assert_called_once_with(event)
    callback3.assert_called_once_with(event)


@pytest.mark.asyncio
async def test_hook_registry_invoke_callbacks_async_interrupt_name_clash(registry, agent):
    event = BeforeToolCallEvent(
        agent=agent,
        selected_tool=None,
        tool_use={"toolUseId": "test_tool_id", "name": "test_tool_name", "input": {}},
        invocation_state={},
    )

    callback1 = unittest.mock.Mock(side_effect=lambda event: event.interrupt("test_name", "test reason 1"))
    callback2 = unittest.mock.Mock(side_effect=lambda event: event.interrupt("test_name", "test reason 2"))

    registry.add_callback(BeforeToolCallEvent, callback1)
    registry.add_callback(BeforeToolCallEvent, callback2)

    with pytest.raises(ValueError, match="interrupt_name=<test_name> | interrupt name used more than once"):
        await registry.invoke_callbacks_async(event)


def test_hook_registry_invoke_callbacks_coroutine(registry, agent):
    callback = unittest.mock.AsyncMock()
    registry.add_callback(BeforeInvocationEvent, callback)

    with pytest.raises(RuntimeError, match=r"use invoke_callbacks_async to invoke async callback"):
        registry.invoke_callbacks(BeforeInvocationEvent(agent=agent))


def test_hook_registry_add_callback_infers_event_type(registry):
    """Test that add_callback infers event type from callback type hint."""

    def typed_callback(event: BeforeInvocationEvent) -> None:
        pass

    # Register without explicit event_type - should infer from type hint
    registry.add_callback(None, typed_callback)

    # Verify callback was registered
    assert BeforeInvocationEvent in registry._registered_callbacks
    assert _has_callback(registry, BeforeInvocationEvent, typed_callback)


def test_hook_registry_add_callback_infers_parameterized_event_type(registry):
    def typed_callback(event: BeforeToolCallEvent[LocalAgent]) -> None:
        pass

    registry.add_callback(None, typed_callback)

    assert _has_callback(registry, BeforeToolCallEvent, typed_callback)


def test_hook_registry_add_callback_raises_error_no_type_hint(registry):
    """Test that add_callback raises error when type hint is missing."""

    def untyped_callback(event):
        pass

    with pytest.raises(ValueError, match="cannot infer event type"):
        registry.add_callback(None, untyped_callback)


def test_hook_registry_add_callback_raises_error_invalid_type_hint(registry):
    """Test that add_callback raises error when type hint is not a BaseHookEvent subclass."""

    def invalid_callback(event: str) -> None:
        pass

    with pytest.raises(ValueError, match="must be a subclass of BaseHookEvent"):
        registry.add_callback(None, invalid_callback)


def test_hook_registry_add_callback_raises_error_no_parameters(registry):
    """Test that add_callback raises error when callback has no parameters."""

    def no_param_callback() -> None:
        pass

    with pytest.raises(ValueError, match="callback has no parameters"):
        registry.add_callback(None, no_param_callback)


def test_hook_registry_add_callback_infers_event_type_when_callback_provided_without_event_type(registry):
    """Test that add_callback infers event type when callback is provided but event_type is None."""

    def typed_callback(event: BeforeInvocationEvent) -> None:
        pass

    registry.add_callback(None, typed_callback)

    assert BeforeInvocationEvent in registry._registered_callbacks
    assert _has_callback(registry, BeforeInvocationEvent, typed_callback)


def test_hook_registry_add_callback_with_explicit_event_type_and_callback(registry):
    """Test that add_callback works with explicit event_type and callback."""

    def callback(event: BeforeInvocationEvent) -> None:
        pass

    registry.add_callback(BeforeInvocationEvent, callback)

    assert BeforeInvocationEvent in registry._registered_callbacks
    assert _has_callback(registry, BeforeInvocationEvent, callback)


# ========== Tests for union type support ==========


def test_hook_registry_add_callback_infers_union_types_pipe_syntax(registry):
    """Test that add_callback registers callback for each type in A | B union."""

    def union_callback(event: BeforeModelCallEvent | AfterModelCallEvent) -> None:
        pass

    registry.add_callback(None, union_callback)

    # Callback should be registered for both event types
    assert BeforeModelCallEvent in registry._registered_callbacks
    assert AfterModelCallEvent in registry._registered_callbacks
    assert _has_callback(registry, BeforeModelCallEvent, union_callback)
    assert _has_callback(registry, AfterModelCallEvent, union_callback)


def test_hook_registry_add_callback_infers_union_types_union_syntax(registry):
    """Test that add_callback registers callback for each type in Union[A, B]."""

    def union_callback(event: Union[BeforeModelCallEvent, AfterModelCallEvent]) -> None:  # noqa: UP007
        pass

    registry.add_callback(None, union_callback)

    # Callback should be registered for both event types
    assert BeforeModelCallEvent in registry._registered_callbacks
    assert AfterModelCallEvent in registry._registered_callbacks
    assert _has_callback(registry, BeforeModelCallEvent, union_callback)
    assert _has_callback(registry, AfterModelCallEvent, union_callback)


def test_hook_registry_add_callback_union_with_none_raises_error(registry):
    """Test that add_callback raises error when union contains None."""

    def callback_with_none(event: BeforeModelCallEvent | None) -> None:
        pass

    with pytest.raises(ValueError, match="None is not a valid event type"):
        registry.add_callback(None, callback_with_none)


def test_hook_registry_add_callback_union_with_invalid_type_raises_error(registry):
    """Test that add_callback raises error when union contains non-BaseHookEvent type."""

    def callback_with_invalid_type(event: BeforeModelCallEvent | str) -> None:
        pass

    with pytest.raises(ValueError, match="Invalid type in union"):
        registry.add_callback(None, callback_with_invalid_type)


def test_hook_registry_add_callback_union_multiple_types(registry):
    """Test that add_callback handles union with more than two types."""

    def multi_union_callback(event: BeforeModelCallEvent | AfterModelCallEvent | BeforeInvocationEvent) -> None:
        pass

    registry.add_callback(None, multi_union_callback)

    # Callback should be registered for all three event types
    assert BeforeModelCallEvent in registry._registered_callbacks
    assert AfterModelCallEvent in registry._registered_callbacks
    assert BeforeInvocationEvent in registry._registered_callbacks
    assert _has_callback(registry, BeforeModelCallEvent, multi_union_callback)
    assert _has_callback(registry, AfterModelCallEvent, multi_union_callback)
    assert _has_callback(registry, BeforeInvocationEvent, multi_union_callback)


# ========== Tests for list of types support ==========


def test_hook_registry_add_callback_with_list_of_types(registry):
    """Test that add_callback registers callback for each type in a list."""

    def my_callback(event) -> None:
        pass

    registry.add_callback([BeforeModelCallEvent, AfterModelCallEvent], my_callback)

    # Callback should be registered for both event types
    assert BeforeModelCallEvent in registry._registered_callbacks
    assert AfterModelCallEvent in registry._registered_callbacks
    assert _has_callback(registry, BeforeModelCallEvent, my_callback)
    assert _has_callback(registry, AfterModelCallEvent, my_callback)


def test_hook_registry_add_callback_with_list_deduplicates(registry):
    """Test that add_callback deduplicates event types in a list."""

    def my_callback(event) -> None:
        pass

    # Same type appears multiple times
    registry.add_callback([BeforeModelCallEvent, BeforeModelCallEvent, AfterModelCallEvent], my_callback)

    # Callback should be registered only once per event type
    assert len(registry._registered_callbacks[BeforeModelCallEvent]) == 1
    assert len(registry._registered_callbacks[AfterModelCallEvent]) == 1


def test_hook_registry_add_callback_with_list_validates_types(registry):
    """Test that add_callback validates all types in a list are BaseHookEvent subclasses."""

    def my_callback(event) -> None:
        pass

    with pytest.raises(ValueError, match="Invalid event type"):
        registry.add_callback([BeforeModelCallEvent, str], my_callback)


def test_hook_registry_add_callback_with_empty_list_raises_error(registry):
    """Test that add_callback raises error when given an empty list."""

    def my_callback(event) -> None:
        pass

    with pytest.raises(ValueError, match="event_type list cannot be empty"):
        registry.add_callback([], my_callback)


@pytest.mark.asyncio
async def test_hook_registry_union_callback_invoked_for_each_type(registry, agent):
    """Test that a union-registered callback is invoked correctly for each event type."""
    call_count = {"before": 0, "after": 0}

    def union_callback(event: BeforeModelCallEvent | AfterModelCallEvent) -> None:
        if isinstance(event, BeforeModelCallEvent):
            call_count["before"] += 1
        elif isinstance(event, AfterModelCallEvent):
            call_count["after"] += 1

    registry.add_callback(None, union_callback)

    # Invoke BeforeModelCallEvent
    before_event = BeforeModelCallEvent(agent=agent)
    await registry.invoke_callbacks_async(before_event)
    assert call_count["before"] == 1

    # Invoke AfterModelCallEvent
    after_event = AfterModelCallEvent(agent=agent)
    await registry.invoke_callbacks_async(after_event)
    assert call_count["after"] == 1


# ========== Tests for hook ordering ==========


def test_lower_order_runs_first(registry, agent):
    """Test that lower order values execute first."""
    order = []

    registry.add_callback(BeforeModelCallEvent, lambda e: order.append("default"), order=HookOrder.DEFAULT)
    registry.add_callback(BeforeModelCallEvent, lambda e: order.append("first"), order=HookOrder.SDK_FIRST)
    registry.add_callback(BeforeModelCallEvent, lambda e: order.append("last"), order=HookOrder.SDK_LAST)

    registry.invoke_callbacks(BeforeModelCallEvent(agent=agent))
    assert order == ["first", "default", "last"]


def test_same_order_preserves_registration_order(registry, agent):
    """Test that callbacks with the same order preserve registration order."""
    order = []

    registry.add_callback(BeforeModelCallEvent, lambda e: order.append("a"))
    registry.add_callback(BeforeModelCallEvent, lambda e: order.append("b"))
    registry.add_callback(BeforeModelCallEvent, lambda e: order.append("c"))

    registry.invoke_callbacks(BeforeModelCallEvent(agent=agent))
    assert order == ["a", "b", "c"]


def test_negative_order_runs_before_default(registry, agent):
    """Test that negative order runs before default."""
    order = []

    registry.add_callback(BeforeModelCallEvent, lambda e: order.append("default"))
    registry.add_callback(BeforeModelCallEvent, lambda e: order.append("early"), order=-50)

    registry.invoke_callbacks(BeforeModelCallEvent(agent=agent))
    assert order == ["early", "default"]


def test_after_events_lower_order_still_runs_first(registry, agent):
    """Test that for After events, lower order still runs first across groups."""
    order = []

    registry.add_callback(AfterModelCallEvent, lambda e: order.append("default_a"))
    registry.add_callback(AfterModelCallEvent, lambda e: order.append("default_b"))
    registry.add_callback(AfterModelCallEvent, lambda e: order.append("first"), order=HookOrder.SDK_FIRST)
    registry.add_callback(AfterModelCallEvent, lambda e: order.append("last"), order=HookOrder.SDK_LAST)

    registry.invoke_callbacks(AfterModelCallEvent(agent=agent))
    # Lower order first, but within same group registration order is reversed
    assert order == ["first", "default_b", "default_a", "last"]
