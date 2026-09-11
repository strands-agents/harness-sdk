"""Shared utilities for testing BidiAgent hooks."""

from strands import LocalAgent
from strands.experimental.bidi.hooks.events import (
    BidiAgentStopEvent,
    BidiInterruptionEvent,
    BidiResponseCompleteEvent,
)
from strands.hooks import (
    AfterToolCallEvent,
    AgentInitializedEvent,
    BeforeToolCallEvent,
    HookProvider,
    MessageAddedEvent,
)


class HookEventCollector(HookProvider):
    """Hook provider that collects all emitted events for testing."""

    def __init__(self):
        self.events = []

    def register_hooks(self, registry):
        registry.add_callback(AgentInitializedEvent, self.on_initialized)
        registry.add_callback(BidiResponseCompleteEvent, self.on_response_complete)
        registry.add_callback(BidiAgentStopEvent, self.on_agent_stop)
        registry.add_callback(BeforeToolCallEvent, self.on_before_tool_call)
        registry.add_callback(AfterToolCallEvent, self.on_after_tool_call)
        registry.add_callback(MessageAddedEvent, self.on_message_added)
        registry.add_callback(BidiInterruptionEvent, self.on_interruption)

    def on_initialized(self, event: AgentInitializedEvent[LocalAgent]):
        self.events.append(("initialized", event))

    def on_response_complete(self, event: BidiResponseCompleteEvent):
        self.events.append(("response_complete", event))

    def on_agent_stop(self, event: BidiAgentStopEvent):
        self.events.append(("agent_stop", event))

    def on_before_tool_call(self, event: BeforeToolCallEvent[LocalAgent]):
        self.events.append(("before_tool_call", event))

    def on_after_tool_call(self, event: AfterToolCallEvent[LocalAgent]):
        self.events.append(("after_tool_call", event))

    def on_message_added(self, event: MessageAddedEvent[LocalAgent]):
        self.events.append(("message_added", event))

    def on_interruption(self, event: BidiInterruptionEvent):
        self.events.append(("interruption", event))

    def get_event_types(self):
        """Get list of event type names in order."""
        return [event_type for event_type, _ in self.events]

    def get_events_by_type(self, event_type):
        """Get all events of a specific type."""
        return [event for et, event in self.events if et == event_type]

    def get_tool_calls(self):
        """Get list of tool names that were called."""
        before_calls = self.get_events_by_type("before_tool_call")
        return [event.tool_use["name"] for event in before_calls]

    def verify_tool_execution(self):
        """Verify that tool execution hooks were properly paired."""
        before_calls = self.get_events_by_type("before_tool_call")
        after_calls = self.get_events_by_type("after_tool_call")

        assert len(before_calls) == len(after_calls), "Before and after tool call hooks should be paired"

        before_tools = [event.tool_use["name"] for event in before_calls]
        after_tools = [event.tool_use["name"] for event in after_calls]

        assert before_tools == after_tools, "Tool call order should match between before and after hooks"

        return before_tools
