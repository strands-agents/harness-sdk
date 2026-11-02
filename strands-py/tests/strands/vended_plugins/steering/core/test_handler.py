"""Unit tests for steering handler base class."""

import inspect
from unittest.mock import AsyncMock, Mock

import pytest

from strands.hooks.events import AfterModelCallEvent, BeforeToolCallEvent
from strands.hooks.registry import HookRegistry
from strands.plugins import Plugin
from strands.vended_plugins.steering.core.action import Guide, Interrupt, Proceed
from strands.vended_plugins.steering.core.context import (
    SteeringContext,
    SteeringContextCallback,
    SteeringContextProvider,
)
from strands.vended_plugins.steering.core.handler import SteeringHandler


class TestSteeringHandler(SteeringHandler):
    """Test implementation of SteeringHandler."""

    async def steer_before_tool(self, *, agent, tool_use, **kwargs):
        return Proceed(reason="Test proceed")


def test_steering_handler_initialization():
    """Test SteeringHandler initialization."""
    handler = TestSteeringHandler()
    assert handler is not None


def test_steering_handler_has_name_attribute():
    """Test SteeringHandler has name attribute for Plugin."""
    handler = TestSteeringHandler()
    assert hasattr(handler, "name")
    assert handler.name == "steering"


def test_steering_handler_is_plugin():
    """Test SteeringHandler implements Plugin."""
    handler = TestSteeringHandler()
    assert isinstance(handler, Plugin)


def test_init_agent():
    """Test init_agent with plugin registry registers hooks on agent."""
    from strands.plugins.registry import _PluginRegistry

    handler = TestSteeringHandler()
    agent = Mock()
    agent.hooks = HookRegistry()
    agent.tool_registry = Mock()
    agent.add_hook = Mock(side_effect=lambda callback, event_type=None: agent.hooks.add_callback(event_type, callback))

    # Use the registry to properly initialize the plugin
    registry = _PluginRegistry(agent)
    registry.add_and_init(handler)

    # Verify hooks were registered (tool and model steering hooks via @hook decorator)
    assert agent.add_hook.call_count >= 2
    # Check that the decorated hook methods were registered
    assert BeforeToolCallEvent in agent.hooks._registered_callbacks
    assert AfterModelCallEvent in agent.hooks._registered_callbacks


def test_steering_context_initialization():
    """Test steering context is initialized."""
    handler = TestSteeringHandler()

    assert handler.steering_context is not None
    assert isinstance(handler.steering_context, SteeringContext)


def test_steering_context_persistence():
    """Test steering context persists across calls."""
    handler = TestSteeringHandler()

    handler.steering_context.data.set("test", "value")
    assert handler.steering_context.data.get("test") == "value"


def test_steering_context_access():
    """Test steering context can be accessed and modified."""
    handler = TestSteeringHandler()

    handler.steering_context.data.set("key", "value")
    assert handler.steering_context.data.get("key") == "value"


@pytest.mark.asyncio
async def test_proceed_action_flow():
    """Test complete flow with Proceed action."""

    class ProceedHandler(SteeringHandler):
        async def steer_before_tool(self, *, agent, tool_use, **kwargs):
            return Proceed(reason="Test proceed")

    handler = ProceedHandler()
    agent = Mock()
    tool_use = {"name": "test_tool"}
    event = BeforeToolCallEvent(agent=agent, selected_tool=None, tool_use=tool_use, invocation_state={})

    await handler.provide_tool_steering_guidance(event)

    # Should not modify event for Proceed
    assert not event.cancel_tool


@pytest.mark.asyncio
async def test_guide_action_flow():
    """Test complete flow with Guide action."""

    class GuideHandler(SteeringHandler):
        async def steer_before_tool(self, *, agent, tool_use, **kwargs):
            return Guide(reason="Test guidance")

    handler = GuideHandler()
    agent = Mock()
    tool_use = {"name": "test_tool"}
    event = BeforeToolCallEvent(agent=agent, selected_tool=None, tool_use=tool_use, invocation_state={})

    await handler.provide_tool_steering_guidance(event)

    # Should set cancel_tool with guidance message
    expected_message = "Tool call cancelled. Test guidance You MUST follow this guidance immediately."
    assert event.cancel_tool == expected_message


@pytest.mark.asyncio
async def test_guide_action_flow_for_an_override_that_takes_no_keyword_arguments():
    class LegacyGuideHandler(SteeringHandler):
        async def steer_before_tool(self, *, agent, tool_use):
            return Guide(reason="Test guidance")

    event = BeforeToolCallEvent(agent=Mock(), selected_tool=None, tool_use={"name": "test_tool"}, invocation_state={})

    await LegacyGuideHandler().provide_tool_steering_guidance(event)

    assert event.cancel_tool == "Tool call cancelled. Test guidance You MUST follow this guidance immediately."


@pytest.mark.asyncio
async def test_interrupt_action_approved_flow():
    """Test complete flow with Interrupt action when approved."""

    class InterruptHandler(SteeringHandler):
        async def steer_before_tool(self, *, agent, tool_use, **kwargs):
            return Interrupt(reason="Need approval")

    handler = InterruptHandler()
    tool_use = {"name": "test_tool"}
    event = Mock()
    event.tool_use = tool_use
    event.interrupt = Mock(return_value=True)  # Approved

    await handler.provide_tool_steering_guidance(event)

    event.interrupt.assert_called_once()


@pytest.mark.asyncio
async def test_interrupt_action_denied_flow():
    """Test complete flow with Interrupt action when denied."""

    class InterruptHandler(SteeringHandler):
        async def steer_before_tool(self, *, agent, tool_use, **kwargs):
            return Interrupt(reason="Need approval")

    handler = InterruptHandler()
    tool_use = {"name": "test_tool"}
    event = Mock()
    event.tool_use = tool_use
    event.interrupt = Mock(return_value=False)  # Denied

    await handler.provide_tool_steering_guidance(event)

    event.interrupt.assert_called_once()
    assert event.cancel_tool.startswith("Manual approval denied:")


@pytest.mark.asyncio
async def test_unknown_action_flow():
    """Test complete flow with unknown action type raises error."""

    class UnknownActionHandler(SteeringHandler):
        async def steer_before_tool(self, *, agent, tool_use, **kwargs):
            return Mock()  # Not a valid SteeringAction

    handler = UnknownActionHandler()
    agent = Mock()
    tool_use = {"name": "test_tool"}
    event = BeforeToolCallEvent(agent=agent, selected_tool=None, tool_use=tool_use, invocation_state={})

    with pytest.raises(ValueError, match="Unknown steering action type"):
        await handler.provide_tool_steering_guidance(event)


def test_init_agent_override():
    """Test that init_agent can be overridden."""

    class CustomHandler(SteeringHandler):
        async def steer_before_tool(self, *, agent, tool_use, **kwargs):
            return Proceed(reason="Custom")

        def init_agent(self, agent):
            # Custom hook registration - don't call parent
            pass

    handler = CustomHandler()
    agent = Mock()

    handler.init_agent(agent)

    # Should not register any hooks
    assert agent.add_hook.call_count == 0


# Integration tests with context providers
class MockContextCallback(SteeringContextCallback[BeforeToolCallEvent]):
    """Mock context callback for testing."""

    def __call__(self, event: BeforeToolCallEvent, steering_context, **kwargs) -> None:
        steering_context.data.set("test_key", "test_value")


class MockContextProvider(SteeringContextProvider):
    """Mock context provider for testing."""

    def __init__(self, callbacks):
        self.callbacks = callbacks

    def context_providers(self):
        return self.callbacks


class TestSteeringHandlerWithProvider(SteeringHandler):
    """Test implementation with context callbacks."""

    def __init__(self, context_callbacks=None):
        providers = [MockContextProvider(context_callbacks)] if context_callbacks else None
        super().__init__(context_providers=providers)

    async def steer_before_tool(self, *, agent, tool_use, **kwargs):
        return Proceed(reason="Test proceed")


def test_handler_registers_context_provider_hooks():
    """Test that handler registers hooks from context callbacks via registry."""
    from strands.plugins.registry import _PluginRegistry

    mock_callback = MockContextCallback()
    handler = TestSteeringHandlerWithProvider(context_callbacks=[mock_callback])
    agent = Mock()
    agent.hooks = HookRegistry()
    agent.tool_registry = Mock()
    agent.add_hook = Mock(side_effect=lambda callback, event_type=None: agent.hooks.add_callback(event_type, callback))

    # Use the registry to properly initialize the plugin
    registry = _PluginRegistry(agent)
    registry.add_and_init(handler)

    # Should register hooks for context callback (via init_agent) and steering guidance (via @hook)
    # init_agent registers context callbacks manually, @hook decorated methods are auto-registered
    assert agent.add_hook.call_count >= 2

    # Check that BeforeToolCallEvent was registered (both context callback and steering guidance)
    assert BeforeToolCallEvent in agent.hooks._registered_callbacks


@pytest.mark.asyncio
async def test_context_callbacks_receive_steering_context():
    """Test that context callbacks receive the handler's steering context."""
    from strands.plugins.registry import _PluginRegistry

    mock_callback = MockContextCallback()
    handler = TestSteeringHandlerWithProvider(context_callbacks=[mock_callback])
    agent = Mock()
    agent.hooks = HookRegistry()
    agent.tool_registry = Mock()
    agent.add_hook = Mock(side_effect=lambda callback, event_type=None: agent.hooks.add_callback(event_type, callback))

    # Use the registry to properly initialize the plugin
    registry = _PluginRegistry(agent)
    registry.add_and_init(handler)

    # Get the registered callbacks for BeforeToolCallEvent
    callbacks = agent.hooks._registered_callbacks.get(BeforeToolCallEvent, [])
    assert len(callbacks) > 0

    # The context callback is wrapped in a lambda, so we just call all callbacks
    # and check if the steering context was updated
    event = Mock(spec=BeforeToolCallEvent)
    event.tool_use = {"name": "test_tool", "input": {}}

    # Call all callbacks, handling both sync and async
    for entry in callbacks:
        try:
            result = await entry.callback(event)
            if inspect.iscoroutine(result):
                await result
        except Exception:
            pass  # Some callbacks might be async or have other requirements

    # Verify the steering context was updated by at least one callback
    assert handler.steering_context.data.get("test_key") == "test_value"


def test_multiple_context_callbacks_registered():
    """Test that multiple context callbacks are registered via registry."""
    from strands.plugins.registry import _PluginRegistry

    callback1 = MockContextCallback()
    callback2 = MockContextCallback()

    handler = TestSteeringHandlerWithProvider(context_callbacks=[callback1, callback2])
    agent = Mock()
    agent.hooks = HookRegistry()
    agent.tool_registry = Mock()
    agent.add_hook = Mock(side_effect=lambda callback, event_type=None: agent.hooks.add_callback(event_type, callback))

    # Use the registry to properly initialize the plugin
    registry = _PluginRegistry(agent)
    registry.add_and_init(handler)

    # Should register:
    # - 2 callbacks for context providers (via init_agent manual registration)
    # - 2 for steering guidance (via @hook decorator auto-registration)
    expected_calls = 2 + 2  # 2 callbacks + 2 for steering guidance (tool and model)
    assert agent.add_hook.call_count >= expected_calls


def test_handler_initialization_with_callbacks():
    """Test handler initialization stores context callbacks."""
    callback1 = MockContextCallback()
    callback2 = MockContextCallback()

    handler = TestSteeringHandlerWithProvider(context_callbacks=[callback1, callback2])

    # Should have stored the callbacks
    assert len(handler._context_callbacks) == 2
    assert callback1 in handler._context_callbacks
    assert callback2 in handler._context_callbacks


# Model steering tests
@pytest.mark.asyncio
async def test_model_steering_proceed_action_flow():
    """Test model steering with Proceed action."""

    class ModelProceedHandler(SteeringHandler):
        async def steer_after_model(self, *, agent, message, stop_reason, **kwargs):
            return Proceed(reason="Model response accepted")

    handler = ModelProceedHandler()
    agent = Mock()
    stop_response = Mock()
    stop_response.message = {"role": "assistant", "content": [{"text": "Hello"}]}
    stop_response.stop_reason = "end_turn"
    event = Mock(spec=AfterModelCallEvent)
    event.agent = agent
    event.stop_response = stop_response
    event.retry = False

    await handler.provide_model_steering_guidance(event)

    # Should not set retry for Proceed
    assert event.retry is False


@pytest.mark.asyncio
async def test_model_steering_guide_action_flow():
    """Test model steering with Guide action sets retry and adds message."""

    class ModelGuideHandler(SteeringHandler):
        async def steer_after_model(self, *, agent, message, stop_reason, **kwargs):
            return Guide(reason="Please improve your response")

    handler = ModelGuideHandler()
    agent = AsyncMock()
    stop_response = Mock()
    stop_response.message = {"role": "assistant", "content": [{"text": "Hello"}]}
    stop_response.stop_reason = "end_turn"
    event = Mock(spec=AfterModelCallEvent)
    event.agent = agent
    event.stop_response = stop_response
    event.retry = False

    await handler.provide_model_steering_guidance(event)

    # Should set retry flag
    assert event.retry is True
    # Should add guidance message to conversation
    agent._append_messages.assert_called_once()
    call_args = agent._append_messages.call_args[0][0]
    assert call_args["role"] == "user"
    assert "Please improve your response" in call_args["content"][0]["text"]


@pytest.mark.asyncio
async def test_model_steering_skips_when_no_stop_response():
    """Test model steering skips when stop_response is None."""

    class ModelProceedHandler(SteeringHandler):
        def __init__(self):
            super().__init__()
            self.steer_called = False

        async def steer_after_model(self, *, agent, message, stop_reason, **kwargs):
            self.steer_called = True
            return Proceed(reason="Should not be called")

    handler = ModelProceedHandler()
    event = Mock(spec=AfterModelCallEvent)
    event.stop_response = None

    await handler.provide_model_steering_guidance(event)

    # steer_after_model should not have been called
    assert handler.steer_called is False


@pytest.mark.asyncio
async def test_model_steering_unknown_action_raises_error():
    """Test model steering with unknown action type raises error."""

    class UnknownModelActionHandler(SteeringHandler):
        async def steer_after_model(self, *, agent, message, stop_reason, **kwargs):
            return Mock()  # Not a valid ModelSteeringAction

    handler = UnknownModelActionHandler()
    agent = Mock()
    stop_response = Mock()
    stop_response.message = {"role": "assistant", "content": [{"text": "Hello"}]}
    stop_response.stop_reason = "end_turn"
    event = Mock(spec=AfterModelCallEvent)
    event.agent = agent
    event.stop_response = stop_response

    with pytest.raises(ValueError, match="Unknown steering action type for model response"):
        await handler.provide_model_steering_guidance(event)


@pytest.mark.asyncio
async def test_model_steering_interrupt_raises_error():
    """Test model steering with Interrupt action raises error (not supported for model steering)."""

    class InterruptModelHandler(SteeringHandler):
        async def steer_after_model(self, *, agent, message, stop_reason, **kwargs):
            return Interrupt(reason="Should not be allowed")

    handler = InterruptModelHandler()
    agent = Mock()
    stop_response = Mock()
    stop_response.message = {"role": "assistant", "content": [{"text": "Hello"}]}
    stop_response.stop_reason = "end_turn"
    event = Mock(spec=AfterModelCallEvent)
    event.agent = agent
    event.stop_response = stop_response

    with pytest.raises(ValueError, match="Unknown steering action type for model response"):
        await handler.provide_model_steering_guidance(event)


@pytest.mark.asyncio
async def test_model_steering_exception_handling():
    """Test model steering handles exceptions gracefully."""

    class ExceptionModelHandler(SteeringHandler):
        async def steer_after_model(self, *, agent, message, stop_reason, **kwargs):
            raise RuntimeError("Test exception")

    handler = ExceptionModelHandler()
    agent = Mock()
    stop_response = Mock()
    stop_response.message = {"role": "assistant", "content": [{"text": "Hello"}]}
    stop_response.stop_reason = "end_turn"
    event = Mock(spec=AfterModelCallEvent)
    event.agent = agent
    event.stop_response = stop_response
    event.retry = False

    # Should not raise, just return early
    await handler.provide_model_steering_guidance(event)

    # retry should not be set since exception occurred
    assert event.retry is False


@pytest.mark.asyncio
async def test_tool_steering_exception_handling():
    """Test tool steering handles exceptions gracefully."""

    class ExceptionToolHandler(SteeringHandler):
        async def steer_before_tool(self, *, agent, tool_use, **kwargs):
            raise RuntimeError("Test exception")

    handler = ExceptionToolHandler()
    agent = Mock()
    tool_use = {"name": "test_tool"}
    event = BeforeToolCallEvent(agent=agent, selected_tool=None, tool_use=tool_use, invocation_state={})

    # Should not raise, just return early
    await handler.provide_tool_steering_guidance(event)

    # cancel_tool should not be set since exception occurred
    assert not event.cancel_tool


# Default implementation tests
@pytest.mark.asyncio
async def test_default_steer_before_tool_returns_proceed():
    """Test default steer_before_tool returns Proceed."""
    handler = TestSteeringHandler()
    agent = Mock()
    tool_use = {"name": "test_tool"}

    # Call the parent's default implementation
    result = await SteeringHandler.steer_before_tool(handler, agent=agent, tool_use=tool_use)

    assert isinstance(result, Proceed)
    assert "Default implementation" in result.reason


@pytest.mark.asyncio
async def test_default_steer_after_model_returns_proceed():
    """Test default steer_after_model returns Proceed."""
    handler = TestSteeringHandler()
    agent = Mock()
    message = {"role": "assistant", "content": [{"text": "Hello"}]}
    stop_reason = "end_turn"

    # Call the parent's default implementation
    result = await SteeringHandler.steer_after_model(handler, agent=agent, message=message, stop_reason=stop_reason)

    assert isinstance(result, Proceed)
    assert "Default implementation" in result.reason


def test_init_agent_registers_model_steering():
    """Test that model steering hook is registered via plugin registry."""
    from strands.plugins.registry import _PluginRegistry

    handler = TestSteeringHandler()
    agent = Mock()
    agent.hooks = HookRegistry()
    agent.tool_registry = Mock()
    agent.add_hook = Mock(side_effect=lambda callback, event_type=None: agent.hooks.add_callback(event_type, callback))

    # Use the registry to properly initialize the plugin
    registry = _PluginRegistry(agent)
    registry.add_and_init(handler)

    # Verify model steering hook was registered via @hook decorator
    assert AfterModelCallEvent in agent.hooks._registered_callbacks
    callbacks = agent.hooks._registered_callbacks[AfterModelCallEvent]
    assert len(callbacks) == 1
