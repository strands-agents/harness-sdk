import unittest.mock
from dataclasses import dataclass
from unittest.mock import MagicMock, Mock

import pytest

from strands.hooks import HookEvent, HookProvider, HookRegistry


@dataclass
class NormalTestEvent(HookEvent):
    @property
    def should_reverse_callbacks(self) -> bool:
        return False


@dataclass
class AfterTestEvent(HookEvent):
    @property
    def should_reverse_callbacks(self) -> bool:
        return True


class HookProviderForTests(HookProvider):
    """Test hook provider for testing hook registry."""

    def __init__(self):
        self.registered = False

    def register_hooks(self, registry: HookRegistry) -> None:
        self.registered = True


@pytest.fixture
def hook_registry():
    return HookRegistry()


@pytest.fixture
def normal_event():
    return NormalTestEvent(agent=Mock())


@pytest.fixture
def after_event():
    return AfterTestEvent(agent=Mock())


def test_hook_registry_init():
    """Test that HookRegistry initializes with an empty callbacks dictionary."""
    registry = HookRegistry()
    assert registry._registered_callbacks == {}


def test_add_callback(hook_registry, normal_event):
    """Test that callbacks can be added to the registry."""
    callback = unittest.mock.Mock()
    hook_registry.add_callback(NormalTestEvent, callback)

    assert NormalTestEvent in hook_registry._registered_callbacks
    assert any(e.callback is callback for e in hook_registry._registered_callbacks[NormalTestEvent])


def test_add_multiple_callbacks_same_event(hook_registry, normal_event):
    """Test that multiple callbacks can be added for the same event type."""
    callback1 = unittest.mock.Mock()
    callback2 = unittest.mock.Mock()

    hook_registry.add_callback(NormalTestEvent, callback1)
    hook_registry.add_callback(NormalTestEvent, callback2)

    assert len(hook_registry._registered_callbacks[NormalTestEvent]) == 2
    assert any(e.callback is callback1 for e in hook_registry._registered_callbacks[NormalTestEvent])
    assert any(e.callback is callback2 for e in hook_registry._registered_callbacks[NormalTestEvent])


def test_add_hook(hook_registry):
    """Test that hooks can be added to the registry."""
    hook_provider = MagicMock()
    hook_registry.add_hook(hook_provider)

    assert hook_provider.register_hooks.call_count == 1


def test_get_callbacks_for_normal_event(hook_registry, normal_event):
    """Test that get_callbacks_for returns callbacks in the correct order for normal events."""
    callback1 = unittest.mock.Mock()
    callback2 = unittest.mock.Mock()

    hook_registry.add_callback(NormalTestEvent, callback1)
    hook_registry.add_callback(NormalTestEvent, callback2)

    callbacks = list(hook_registry.get_callbacks_for(normal_event))

    assert len(callbacks) == 2
    assert callbacks[0] == callback1
    assert callbacks[1] == callback2


def test_get_callbacks_for_after_event(hook_registry, after_event):
    """Test that get_callbacks_for returns callbacks in reverse order for after events."""
    callback1 = Mock()
    callback2 = Mock()

    hook_registry.add_callback(AfterTestEvent, callback1)
    hook_registry.add_callback(AfterTestEvent, callback2)

    callbacks = list(hook_registry.get_callbacks_for(after_event))

    assert len(callbacks) == 2
    assert callbacks[0] == callback2  # Reverse order
    assert callbacks[1] == callback1  # Reverse order


@pytest.mark.asyncio
async def test_invoke_callbacks_async(hook_registry, normal_event):
    """Test that invoke_callbacks_async calls all registered callbacks for an event."""
    callback1 = Mock()
    callback2 = Mock()

    hook_registry.add_callback(NormalTestEvent, callback1)
    hook_registry.add_callback(NormalTestEvent, callback2)

    await hook_registry.invoke_callbacks_async(normal_event)

    callback1.assert_called_once_with(normal_event)
    callback2.assert_called_once_with(normal_event)


@pytest.mark.asyncio
async def test_invoke_callbacks_async_no_registered_callbacks(hook_registry, normal_event):
    """Test that invoke_callbacks_async doesn't fail when there are no registered callbacks."""
    # No callbacks registered
    await hook_registry.invoke_callbacks_async(normal_event)
    # Test passes if no exception is raised


@pytest.mark.asyncio
async def test_invoke_callbacks_async_after_event(hook_registry, after_event):
    """Test that invoke_callbacks_async calls callbacks in reverse order for after events."""
    call_order: list[str] = []

    def callback1(_event):
        call_order.append("callback1")

    def callback2(_event):
        call_order.append("callback2")

    hook_registry.add_callback(AfterTestEvent, callback1)
    hook_registry.add_callback(AfterTestEvent, callback2)

    await hook_registry.invoke_callbacks_async(after_event)

    assert call_order == ["callback2", "callback1"]  # Reverse order


def test_has_callbacks(hook_registry, normal_event):
    """Test that has_callbacks returns correct boolean values."""
    # Empty registry should return False
    assert not hook_registry.has_callbacks()

    # Registry with callbacks should return True
    callback = Mock()
    hook_registry.add_callback(NormalTestEvent, callback)
    assert hook_registry.has_callbacks()

    # Test with multiple event types
    hook_registry.add_callback(AfterTestEvent, Mock())
    assert hook_registry.has_callbacks()
