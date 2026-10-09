"""Tests for event types in the strands.types._events module."""

from unittest.mock import MagicMock, Mock

from pydantic import BaseModel

from strands.experimental.checkpoint import Checkpoint
from strands.telemetry import EventLoopMetrics
from strands.types._events import (
    AgentAsToolStreamEvent,
    AgentResultEvent,
    CitationStreamEvent,
    EventLoopStopEvent,
    EventLoopThrottleEvent,
    ForceStopEvent,
    InitEventLoopEvent,
    ModelMessageEvent,
    ModelStopReason,
    ModelStreamChunkEvent,
    ModelStreamEvent,
    ReasoningRedactedContentStreamEvent,
    ReasoningSignatureStreamEvent,
    ReasoningTextStreamEvent,
    StartEvent,
    StartEventLoopEvent,
    StructuredOutputEvent,
    TextStreamEvent,
    ToolResultEvent,
    ToolResultMessageEvent,
    ToolStreamEvent,
    ToolUseStreamEvent,
    TypedEvent,
)
from strands.types.citations import Citation
from strands.types.content import Message
from strands.types.event_loop import Metrics, StopReason, Usage
from strands.types.streaming import ContentBlockDelta, StreamEvent
from strands.types.tools import ToolResult, ToolUse


class SampleModel(BaseModel):
    """Sample Pydantic model for testing."""

    name: str
    value: int


class TestTypedEvent:
    """Tests for the base TypedEvent class."""

    def test_initialization_with_data(self):
        """Test TypedEvent initialization with data."""
        data = {"key": "value", "number": 42}
        event = TypedEvent(data)
        assert event["key"] == "value"
        assert event["number"] == 42

    def test_initialization_without_data(self):
        """Test TypedEvent initialization without data."""
        event = TypedEvent()
        assert len(event) == 0

    def test_is_callback_event_default(self):
        """Test that is_callback_event returns True by default."""
        event = TypedEvent()
        assert event.is_callback_event is True

    def test_as_dict(self):
        """Test as_dict method returns dictionary representation."""
        data = {"test": "data", "nested": {"key": "value"}}
        event = TypedEvent(data)
        result = event.as_dict()
        assert result == data
        assert isinstance(result, dict)

    def test_prepare_default_implementation(self):
        """Test prepare method default implementation does nothing."""
        event = TypedEvent({"initial": "data"})
        invocation_state = {"state": "value"}
        event.prepare(invocation_state)
        # Default implementation does nothing
        assert event == {"initial": "data"}


class TestInitEventLoopEvent:
    """Tests for InitEventLoopEvent."""

    def test_initialization(self):
        """Test InitEventLoopEvent initialization."""
        event = InitEventLoopEvent()
        assert event["init_event_loop"] is True

    def test_prepare_updates_with_invocation_state(self):
        """Test prepare method updates event with invocation state."""
        event = InitEventLoopEvent()
        invocation_state = {"request_id": "123", "session": "abc"}
        event.prepare(invocation_state)
        assert event["request_id"] == "123"
        assert event["session"] == "abc"
        assert event["init_event_loop"] is True


class TestStartEvent:
    """Tests for StartEvent (deprecated)."""

    def test_initialization(self):
        """Test StartEvent initialization."""
        event = StartEvent()
        assert event["start"] is True


class TestStartEventLoopEvent:
    """Tests for StartEventLoopEvent."""

    def test_initialization(self):
        """Test StartEventLoopEvent initialization."""
        event = StartEventLoopEvent()
        assert event["start_event_loop"] is True


class TestModelStreamChunkEvent:
    """Tests for ModelStreamChunkEvent."""

    def test_initialization_with_stream_event(self):
        """Test ModelStreamChunkEvent initialization with StreamEvent."""
        stream_event = Mock(spec=StreamEvent)
        event = ModelStreamChunkEvent(stream_event)
        assert event["event"] == stream_event
        assert event.chunk == stream_event


class TestModelStreamEvent:
    """Tests for ModelStreamEvent."""

    def test_initialization_with_delta_data(self):
        """Test ModelStreamEvent initialization with delta data."""
        delta_data = {"type": "text", "content": "hello"}
        event = ModelStreamEvent(delta_data)
        assert event["type"] == "text"
        assert event["content"] == "hello"

    def test_is_callback_event_empty(self):
        """Test is_callback_event returns False when empty."""
        event = ModelStreamEvent({})
        assert event.is_callback_event is False

    def test_is_callback_event_non_empty(self):
        """Test is_callback_event returns True when non-empty."""
        event = ModelStreamEvent({"data": "value"})
        assert event.is_callback_event is True

    def test_prepare_with_delta(self):
        """Test prepare method updates when delta is present."""
        event = ModelStreamEvent({"delta": "content", "other": "data"})
        invocation_state = {"request_id": "456"}
        event.prepare(invocation_state)
        assert event["request_id"] == "456"
        assert event["delta"] == "content"

    def test_prepare_without_delta(self):
        """Test prepare method does nothing when delta is not present."""
        event = ModelStreamEvent({"other": "data"})
        invocation_state = {"request_id": "456"}
        event.prepare(invocation_state)
        assert "request_id" not in event


class TestToolUseStreamEvent:
    """Tests for ToolUseStreamEvent."""

    def test_initialization(self):
        """Test ToolUseStreamEvent initialization."""
        delta = Mock(spec=ContentBlockDelta)
        current_tool_use = {"toolUseId": "123", "name": "calculator"}
        event = ToolUseStreamEvent(delta, current_tool_use)
        assert event["delta"] == delta
        assert event["current_tool_use"] == current_tool_use


class TestTextStreamEvent:
    """Tests for TextStreamEvent."""

    def test_initialization(self):
        """Test TextStreamEvent initialization."""
        delta = Mock(spec=ContentBlockDelta)
        text = "Hello, world!"
        event = TextStreamEvent(delta, text)
        assert event["data"] == text
        assert event["delta"] == delta


class TestCitationStreamEvent:
    """Tests for CitationStreamEvent."""

    def test_initialization(self):
        """Test CitationStreamEvent initialization."""
        delta = Mock(spec=ContentBlockDelta)
        citation = Mock(spec=Citation)
        event = CitationStreamEvent(delta, citation)
        assert event["citation"] == citation
        assert event["delta"] == delta


class TestReasoningTextStreamEvent:
    """Tests for ReasoningTextStreamEvent."""

    def test_initialization_with_reasoning_text(self):
        """Test ReasoningTextStreamEvent initialization with text."""
        delta = Mock(spec=ContentBlockDelta)
        reasoning_text = "Thinking about the problem..."
        event = ReasoningTextStreamEvent(delta, reasoning_text)
        assert event["reasoningText"] == reasoning_text
        assert event["delta"] == delta
        assert event["reasoning"] is True

    def test_initialization_with_none(self):
        """Test ReasoningTextStreamEvent initialization with None."""
        delta = Mock(spec=ContentBlockDelta)
        event = ReasoningTextStreamEvent(delta, None)
        assert event["reasoningText"] is None
        assert event["reasoning"] is True


class TestReasoningRedactedContentStreamEvent:
    """Tests for ReasoningRedactedContentStreamEvent."""

    def test_initialization_with_redacted_content(self):
        """Test ReasoningRedactedContentStreamEvent initialization with content."""
        delta = Mock(spec=ContentBlockDelta)
        redacted_content = b"[REDACTED]"
        event = ReasoningRedactedContentStreamEvent(delta, redacted_content)
        assert event["reasoningRedactedContent"] == redacted_content
        assert event["delta"] == delta
        assert event["reasoning"] is True

    def test_initialization_with_none(self):
        """Test ReasoningRedactedContentStreamEvent initialization with None."""
        delta = Mock(spec=ContentBlockDelta)
        event = ReasoningRedactedContentStreamEvent(delta, None)
        assert event["reasoningRedactedContent"] is None
        assert event["reasoning"] is True


class TestReasoningSignatureStreamEvent:
    """Tests for ReasoningSignatureStreamEvent."""

    def test_initialization(self):
        """Test ReasoningSignatureStreamEvent initialization."""
        delta = Mock(spec=ContentBlockDelta)
        signature = "signature_xyz123"
        event = ReasoningSignatureStreamEvent(delta, signature)
        assert event["reasoning_signature"] == signature
        assert event["delta"] == delta
        assert event["reasoning"] is True


class TestModelStopReason:
    """Tests for ModelStopReason."""

    def test_initialization(self):
        """Test ModelStopReason initialization."""
        stop_reason = Mock(spec=StopReason)
        message = Mock(spec=Message)
        usage = Mock(spec=Usage)
        metrics = Mock(spec=Metrics)

        event = ModelStopReason(stop_reason, message, usage, metrics)
        assert event["stop"] == (stop_reason, message, usage, metrics)
        assert event.is_callback_event is False


class TestEventLoopStopEvent:
    """Tests for EventLoopStopEvent."""

    def test_initialization_without_structured_output(self):
        """Test EventLoopStopEvent initialization without structured output."""
        stop_reason = Mock(spec=StopReason)
        message = Mock(spec=Message)
        metrics = Mock(spec=EventLoopMetrics)
        request_state = {"state": "final"}

        event = EventLoopStopEvent(stop_reason, message, metrics, request_state)
        assert event["stop"] == (stop_reason, message, metrics, request_state, None, None, None)
        assert event.is_callback_event is False

    def test_initialization_with_structured_output(self):
        """Test EventLoopStopEvent initialization with structured output."""
        stop_reason = Mock(spec=StopReason)
        message = Mock(spec=Message)
        metrics = Mock(spec=EventLoopMetrics)
        request_state = {"state": "final"}
        structured_output = SampleModel(name="test", value=42)

        event = EventLoopStopEvent(stop_reason, message, metrics, request_state, structured_output)
        assert event["stop"] == (stop_reason, message, metrics, request_state, structured_output, None, None)
        assert event.is_callback_event is False


class TestStructuredOutputEvent:
    """Tests for StructuredOutputEvent."""

    def test_initialization(self):
        """Test StructuredOutputEvent initialization."""
        structured_output = SampleModel(name="output", value=100)
        event = StructuredOutputEvent(structured_output)
        assert event["structured_output"] == structured_output
        assert isinstance(event["structured_output"], SampleModel)


class TestEventLoopThrottleEvent:
    """Tests for EventLoopThrottleEvent."""

    def test_initialization(self):
        """Test EventLoopThrottleEvent initialization."""
        delay = 5
        event = EventLoopThrottleEvent(delay)
        assert event["event_loop_throttled_delay"] == 5

    def test_prepare_updates_with_invocation_state(self):
        """Test prepare method updates event with invocation state."""
        event = EventLoopThrottleEvent(10)
        invocation_state = {"request_id": "throttle_123"}
        event.prepare(invocation_state)
        assert event["request_id"] == "throttle_123"
        assert event["event_loop_throttled_delay"] == 10


class TestToolResultEvent:
    """Tests for ToolResultEvent."""

    def test_initialization(self):
        """Test ToolResultEvent initialization."""
        tool_result: ToolResult = {
            "toolUseId": "tool_123",
            "content": [{"text": "Result"}],
            "isError": False,
        }
        event = ToolResultEvent(tool_result)
        assert event["tool_result"] == tool_result
        assert event.tool_use_id == "tool_123"
        assert event.tool_result == tool_result
        assert event.is_callback_event is False

    def test_tool_use_id_property(self):
        """Test tool_use_id property returns correct ID."""
        tool_result: ToolResult = {
            "toolUseId": "unique_id_456",
            "content": [],
        }
        event = ToolResultEvent(tool_result)
        assert event.tool_use_id == "unique_id_456"


class TestToolStreamEvent:
    """Tests for ToolStreamEvent."""

    def test_initialization(self):
        """Test ToolStreamEvent initialization."""
        tool_use: ToolUse = {
            "toolUseId": "stream_123",
            "name": "streaming_tool",
            "input": {},
        }
        tool_stream_data = {"progress": 50, "status": "processing"}
        event = ToolStreamEvent(tool_use, tool_stream_data)

        assert event["tool_stream_event"]["tool_use"] == tool_use
        assert event["tool_stream_event"]["data"] == tool_stream_data
        assert event.tool_use_id == "stream_123"

    def test_tool_use_id_property(self):
        """Test tool_use_id property returns correct ID."""
        tool_use: ToolUse = {
            "toolUseId": "another_stream_456",
            "name": "tool",
            "input": {},
        }
        event = ToolStreamEvent(tool_use, {})
        assert event.tool_use_id == "another_stream_456"


class TestModelMessageEvent:
    """Tests for ModelMessageEvent."""

    def test_initialization(self):
        """Test ModelMessageEvent initialization."""
        message = Mock(spec=Message)
        event = ModelMessageEvent(message)
        assert event["message"] == message


class TestToolResultMessageEvent:
    """Tests for ToolResultMessageEvent."""

    def test_initialization(self):
        """Test ToolResultMessageEvent initialization."""
        message = {"role": "tool", "content": "Tool result message"}
        event = ToolResultMessageEvent(message)
        assert event["message"] == message


class TestForceStopEvent:
    """Tests for ForceStopEvent."""

    def test_initialization_with_string_reason(self):
        """Test ForceStopEvent initialization with string reason."""
        reason = "User requested stop"
        event = ForceStopEvent(reason)
        assert event["force_stop"] is True
        assert event["force_stop_reason"] == "User requested stop"

    def test_initialization_with_exception(self):
        """Test ForceStopEvent initialization with exception."""
        exception = ValueError("Something went wrong")
        event = ForceStopEvent(exception)
        assert event["force_stop"] is True
        assert event["force_stop_reason"] == "Something went wrong"


class TestAgentResultEvent:
    """Tests for AgentResultEvent."""

    def test_initialization(self):
        """Test AgentResultEvent initialization."""
        # Mock the AgentResult
        agent_result = MagicMock()
        agent_result.messages = []
        agent_result.stop_reason = "max_tokens"

        event = AgentResultEvent(agent_result)
        assert event["result"] == agent_result


class TestEventSerialization:
    """Tests for event serialization and conversion."""

    def test_typed_event_serialization(self):
        """Test that TypedEvent can be serialized to dict."""
        event = TypedEvent({"key": "value", "nested": {"data": 123}})
        serialized = event.as_dict()
        assert serialized == {"key": "value", "nested": {"data": 123}}

    def test_complex_event_serialization(self):
        """Test complex event serialization."""
        delta = Mock(spec=ContentBlockDelta)
        delta.to_dict = Mock(return_value={"type": "delta"})

        event = TextStreamEvent(delta, "Hello")
        # The event should be serializable as a dict
        assert isinstance(event.as_dict(), dict)
        assert event["data"] == "Hello"

    def test_event_inheritance(self):
        """Test that all events inherit from TypedEvent."""
        events = [
            InitEventLoopEvent(),
            StartEvent(),
            StartEventLoopEvent(),
            StructuredOutputEvent(SampleModel(name="test", value=1)),
            EventLoopThrottleEvent(5),
            ForceStopEvent("test"),
        ]

        for event in events:
            assert isinstance(event, TypedEvent)
            assert isinstance(event, dict)
            assert hasattr(event, "is_callback_event")
            assert hasattr(event, "as_dict")
            assert hasattr(event, "prepare")


class TestAgentAsToolStreamEvent:
    """Tests for AgentAsToolStreamEvent."""

    def test_initialization(self):
        """Test AgentAsToolStreamEvent initialization with agent-tool reference."""
        tool_use: ToolUse = {
            "toolUseId": "agent_tool_123",
            "name": "researcher",
            "input": {"input": "hello"},
        }
        agent_event = {"data": "partial response"}
        mock_agent_as_tool = MagicMock()
        mock_agent_as_tool.tool_name = "researcher"

        event = AgentAsToolStreamEvent(tool_use, agent_event, mock_agent_as_tool)

        assert event["tool_stream_event"]["tool_use"] == tool_use
        assert event["tool_stream_event"]["data"] == agent_event
        assert event.agent_as_tool is mock_agent_as_tool
        assert event.tool_use_id == "agent_tool_123"

    def test_payload_marks_the_chunk_as_a_sub_agent_event(self):
        """The emitted dict carries the marker a consumer without the class needs.

        Guards https://github.com/strands-agents/harness-sdk/issues/3749: the A2A executor sees
        only the dict, and forwards a chunk a tool yielded itself but not a sub-agent's events.
        """
        tool_use: ToolUse = {"toolUseId": "id_123", "name": "researcher", "input": {}}

        sub_agent_event = AgentAsToolStreamEvent(tool_use, {"data": "token"}, MagicMock()).as_dict()
        tool_event = ToolStreamEvent(tool_use, {"progress": 1}).as_dict()

        assert sub_agent_event["tool_stream_event"]["sub_agent"] is True
        assert "sub_agent" not in tool_event["tool_stream_event"]

    def test_is_tool_stream_event_subclass(self):
        """Test that AgentAsToolStreamEvent is a ToolStreamEvent subclass."""
        tool_use: ToolUse = {
            "toolUseId": "id_123",
            "name": "tool",
            "input": {},
        }
        mock_agent_as_tool = MagicMock()
        event = AgentAsToolStreamEvent(tool_use, {}, mock_agent_as_tool)

        assert isinstance(event, ToolStreamEvent)
        assert isinstance(event, TypedEvent)
        assert type(event) is AgentAsToolStreamEvent


# =========================================================================
# EventLoopStopEvent checkpoint kwarg (Part B)
# =========================================================================


def test_event_loop_stop_event_carries_checkpoint() -> None:
    checkpoint = Checkpoint(position="after_model", cycle_index=0)
    event = EventLoopStopEvent(
        "checkpoint",
        {"role": "assistant", "content": [{"text": "hi"}]},
        EventLoopMetrics(),
        {},
        checkpoint=checkpoint,
    )
    stop = event["stop"]
    assert len(stop) == 7
    assert stop[0] == "checkpoint"
    assert stop[6] is checkpoint


def test_event_loop_stop_event_checkpoint_defaults_to_none() -> None:
    event = EventLoopStopEvent(
        "end_turn",
        {"role": "assistant", "content": [{"text": "done"}]},
        EventLoopMetrics(),
        {},
    )
    stop = event["stop"]
    assert len(stop) == 7
    assert stop[6] is None
