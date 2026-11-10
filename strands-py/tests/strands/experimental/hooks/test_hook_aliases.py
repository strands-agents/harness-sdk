"""Tests to verify that experimental hook aliases work interchangeably with real types.

This test module ensures that the experimental hook event aliases maintain
backwards compatibility and can be used interchangeably with the actual
hook event types.
"""

import importlib
import sys
import warnings
from unittest.mock import Mock

import pytest

# Suppress deprecation warnings from imports since we're testing the aliases themselves
with warnings.catch_warnings():
    warnings.simplefilter("ignore", DeprecationWarning)
    from strands.experimental.hooks import (
        AfterModelInvocationEvent,
        AfterToolInvocationEvent,
        BeforeModelInvocationEvent,
        BeforeToolInvocationEvent,
    )
from strands.hooks import (
    AfterModelCallEvent,
    AfterToolCallEvent,
    BeforeModelCallEvent,
    BeforeToolCallEvent,
    HookRegistry,
)


def test_experimental_aliases_are_same_types():
    """Verify that experimental aliases are identical to the actual types."""
    assert BeforeToolInvocationEvent is BeforeToolCallEvent
    assert AfterToolInvocationEvent is AfterToolCallEvent
    assert BeforeModelInvocationEvent is BeforeModelCallEvent
    assert AfterModelInvocationEvent is AfterModelCallEvent

    assert BeforeToolCallEvent is BeforeToolInvocationEvent
    assert AfterToolCallEvent is AfterToolInvocationEvent
    assert BeforeModelCallEvent is BeforeModelInvocationEvent
    assert AfterModelCallEvent is AfterModelInvocationEvent


def test_before_tool_call_event_type_equality():
    """Verify that BeforeToolInvocationEvent alias has the same type identity."""
    before_tool_event = BeforeToolCallEvent(
        agent=Mock(),
        selected_tool=Mock(),
        tool_use={"name": "test", "toolUseId": "123", "input": {}},
        invocation_state={},
    )

    assert isinstance(before_tool_event, BeforeToolInvocationEvent)
    assert isinstance(before_tool_event, BeforeToolCallEvent)


def test_after_tool_call_event_type_equality():
    """Verify that AfterToolInvocationEvent alias has the same type identity."""
    after_tool_event = AfterToolCallEvent(
        agent=Mock(),
        selected_tool=Mock(),
        tool_use={"name": "test", "toolUseId": "123", "input": {}},
        invocation_state={},
        result={"toolUseId": "123", "status": "success", "content": [{"text": "result"}]},
    )

    assert isinstance(after_tool_event, AfterToolInvocationEvent)
    assert isinstance(after_tool_event, AfterToolCallEvent)


def test_before_model_call_event_type_equality():
    """Verify that BeforeModelInvocationEvent alias has the same type identity."""
    before_model_event = BeforeModelCallEvent(agent=Mock(), invocation_state={})

    assert isinstance(before_model_event, BeforeModelInvocationEvent)
    assert isinstance(before_model_event, BeforeModelCallEvent)


def test_after_model_call_event_type_equality():
    """Verify that AfterModelInvocationEvent alias has the same type identity."""
    after_model_event = AfterModelCallEvent(agent=Mock(), invocation_state={})

    assert isinstance(after_model_event, AfterModelInvocationEvent)
    assert isinstance(after_model_event, AfterModelCallEvent)


@pytest.mark.asyncio
async def test_experimental_aliases_in_hook_registry():
    """Verify that experimental aliases work with hook registry callbacks."""
    hook_registry = HookRegistry()
    callback_called = False
    received_event = None

    def experimental_callback(event: BeforeToolInvocationEvent):
        nonlocal callback_called, received_event
        callback_called = True
        received_event = event

    # Register callback using experimental alias
    hook_registry.add_callback(BeforeToolInvocationEvent, experimental_callback)

    # Create event using actual type
    test_event = BeforeToolCallEvent(
        agent=Mock(),
        selected_tool=Mock(),
        tool_use={"name": "test", "toolUseId": "123", "input": {}},
        invocation_state={},
    )

    # Invoke callbacks - should work since alias points to same type
    await hook_registry.invoke_callbacks_async(test_event)

    assert callback_called
    assert received_event is test_event


def test_deprecation_warning_on_access(captured_warnings):
    """Verify that accessing deprecated aliases emits deprecation warning."""
    import strands.experimental.hooks.events as events_module

    # Clear any existing warnings
    captured_warnings.clear()

    # Access a deprecated alias - this should trigger the warning
    _ = events_module.BeforeToolInvocationEvent

    assert len(captured_warnings) == 1
    assert issubclass(captured_warnings[0].category, DeprecationWarning)
    assert "BeforeToolInvocationEvent" in str(captured_warnings[0].message)
    assert "BeforeToolCallEvent" in str(captured_warnings[0].message)


def test_deprecation_warning_on_import_only_for_experimental(captured_warnings):
    """Verify that importing from experimental module emits deprecation warning."""
    # Re-import the module to trigger the warning
    module = sys.modules.get("strands.hooks")
    if module:
        importlib.reload(module)
    else:
        importlib.import_module("strands.hooks")

    assert len(captured_warnings) == 0
