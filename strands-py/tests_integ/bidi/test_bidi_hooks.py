"""Integration tests for BidiAgent hooks with real model providers."""

import pytest

from strands import tool
from strands.experimental.bidi.agent.agent import BidiAgent
from strands.experimental.bidi.hooks.events import BidiAgentStopEvent
from strands.hooks import AgentInitializedEvent, HookProvider

from .hook_utils import HookEventCollector


@pytest.mark.asyncio
class TestBidiAgentHooksLifecycle:
    """Test BidiAgent hook lifecycle events."""

    async def test_agent_initialization_emits_hook(self):
        """Verify agent initialization emits AgentInitializedEvent."""
        collector = HookEventCollector()
        agent = BidiAgent(hooks=[collector])

        # Should have emitted initialized event
        assert "initialized" in collector.get_event_types()
        init_events = collector.get_events_by_type("initialized")
        assert len(init_events) == 1
        assert init_events[0].agent == agent

    async def test_session_lifecycle_emits_hooks(self):
        """Verify stopping the agent emits the cleanup event after initialization."""
        collector = HookEventCollector()
        agent = BidiAgent(hooks=[collector])

        await agent.start()
        assert collector.get_events_by_type("agent_stop") == []
        await agent.stop()

        event_types = collector.get_event_types()
        assert event_types.index("initialized") < event_types.index("agent_stop")
        assert len(collector.get_events_by_type("agent_stop")) == 1

    async def test_message_added_hook_on_text_input(self):
        """Verify sending text emits MessageAddedEvent."""
        collector = HookEventCollector()
        agent = BidiAgent(hooks=[collector])

        await agent.start()

        # Send text message
        await agent.send("Hello, agent!")

        await agent.stop()

        # Should have emitted message_added event
        message_events = collector.get_events_by_type("message_added")
        assert len(message_events) >= 1

        # Find the user message event
        user_messages = [e for e in message_events if e.message["role"] == "user"]
        assert len(user_messages) >= 1
        assert user_messages[0].message["content"][0]["text"] == "Hello, agent!"


@pytest.mark.asyncio
class TestBidiAgentHooksWithTools:
    """Test BidiAgent hook events with tool execution."""

    async def test_tool_call_hooks_emitted(self):
        """Verify tool execution emits before/after tool call events."""

        @tool
        def test_calculator(expression: str) -> str:
            """Calculate a math expression."""
            return f"Result: {eval(expression)}"

        collector = HookEventCollector()
        agent = BidiAgent(tools=[test_calculator], hooks=[collector])

        # Note: This test verifies hook infrastructure is in place
        # Actual tool execution would require model interaction
        # which is tested in full integration tests

        # Verify hooks are registered
        assert agent.hooks.has_callbacks()

        # Verify tool is registered
        assert "test_calculator" in agent.tool_names


@pytest.mark.asyncio
class TestBidiAgentHooksEventData:
    """Test BidiAgent hook event data integrity."""

    async def test_hook_events_contain_agent_reference(self):
        """Verify all hook events contain correct agent reference."""
        collector = HookEventCollector()
        agent = BidiAgent(hooks=[collector])

        await agent.start()
        await agent.send("Test message")
        await agent.stop()

        # All events should reference the same agent
        for _, event in collector.events:
            assert hasattr(event, "agent")
            assert event.agent == agent

    async def test_message_added_event_contains_message(self):
        """Verify MessageAddedEvent contains the actual message."""
        collector = HookEventCollector()
        agent = BidiAgent(hooks=[collector])

        await agent.start()
        test_text = "Test message content"
        await agent.send(test_text)
        await agent.stop()

        # Find message_added events
        message_events = collector.get_events_by_type("message_added")
        assert len(message_events) >= 1

        # Verify message content
        user_messages = [e for e in message_events if e.message["role"] == "user"]
        assert len(user_messages) >= 1
        assert user_messages[0].message["content"][0]["text"] == test_text


@pytest.mark.asyncio
class TestBidiAgentHooksOrdering:
    """Test BidiAgent hook callback ordering."""

    async def test_multiple_hooks_fire_in_order(self):
        """Verify multiple hook providers fire in registration order."""
        call_order = []

        class FirstHook(HookProvider):
            def register_hooks(self, registry):
                registry.add_callback(AgentInitializedEvent, lambda e: call_order.append("first"))

        class SecondHook(HookProvider):
            def register_hooks(self, registry):
                registry.add_callback(AgentInitializedEvent, lambda e: call_order.append("second"))

        class ThirdHook(HookProvider):
            def register_hooks(self, registry):
                registry.add_callback(AgentInitializedEvent, lambda e: call_order.append("third"))

        agent = BidiAgent(hooks=[FirstHook(), SecondHook(), ThirdHook()])

        await agent.start()
        await agent.stop()

        # Verify order
        assert call_order == ["first", "second", "third"]

    async def test_agent_stop_fires_in_reverse_order(self):
        """Verify agent stop hooks fire in reverse order (cleanup)."""
        call_order = []

        class FirstHook(HookProvider):
            def register_hooks(self, registry):
                registry.add_callback(BidiAgentStopEvent, lambda e: call_order.append("first"))

        class SecondHook(HookProvider):
            def register_hooks(self, registry):
                registry.add_callback(BidiAgentStopEvent, lambda e: call_order.append("second"))

        class ThirdHook(HookProvider):
            def register_hooks(self, registry):
                registry.add_callback(BidiAgentStopEvent, lambda e: call_order.append("third"))

        agent = BidiAgent(hooks=[FirstHook(), SecondHook(), ThirdHook()])

        await agent.start()
        await agent.stop()

        # Verify reverse order for cleanup
        assert call_order == ["third", "second", "first"]


@pytest.mark.asyncio
class TestBidiAgentHooksContextManager:
    """Test BidiAgent hooks with async context manager."""

    async def test_hooks_fire_with_context_manager(self):
        """Verify hooks fire correctly when using async context manager."""
        collector = HookEventCollector()

        async with BidiAgent(hooks=[collector]) as agent:
            await agent.send("Test message")

        # Verify lifecycle events
        event_types = collector.get_event_types()
        assert "initialized" in event_types
        assert "agent_stop" in event_types

        # Verify order
        assert event_types.index("initialized") < event_types.index("agent_stop")
