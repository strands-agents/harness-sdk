"""Tests for the public event types in the strands.types.events module."""

from unittest.mock import Mock

from strands.types import _events
from strands.types.content import Message
from strands.types.event_loop import Metrics, StopReason, Usage
from strands.types.events import ModelStopReason, ToolResultEvent, TypedEvent
from strands.types.tools import ToolResult


def test_private_events_module_re_exports_the_public_classes():
    tru_classes = (_events.ModelStopReason, _events.ToolResultEvent, _events.TypedEvent)
    exp_classes = (ModelStopReason, ToolResultEvent, TypedEvent)

    assert tru_classes == exp_classes


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
        assert (event.stop_reason, event.message, event.usage, event.metrics) == (stop_reason, message, usage, metrics)
        assert event.is_callback_event is False


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
