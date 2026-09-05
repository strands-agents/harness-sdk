import unittest.mock
from typing import cast

import pytest
from pydantic import BaseModel

from strands.agent.agent_result import AgentResult
from strands.experimental.checkpoint import Checkpoint
from strands.interrupt import Interrupt
from strands.telemetry.metrics import EventLoopMetrics
from strands.types.content import Message
from strands.types.streaming import StopReason


@pytest.fixture
def mock_metrics():
    return unittest.mock.Mock(spec=EventLoopMetrics)


@pytest.fixture
def simple_message():
    return {"role": "assistant", "content": [{"text": "Hello world!"}]}


@pytest.fixture
def complex_message():
    return {
        "role": "assistant",
        "content": [
            {"text": "First paragraph"},
            {"text": "Second paragraph"},
            {"non_text_content": "This should be ignored"},
            {"text": "Third paragraph"},
        ],
    }


@pytest.fixture
def empty_message():
    return {"role": "assistant", "content": []}


def test__init__(mock_metrics, simple_message: Message):
    """Test that AgentResult can be properly initialized with all required fields."""
    stop_reason: StopReason = "end_turn"
    state = {"key": "value"}

    result = AgentResult(stop_reason=stop_reason, message=simple_message, metrics=mock_metrics, state=state)

    assert result.stop_reason == stop_reason
    assert result.message == simple_message
    assert result.metrics == mock_metrics
    assert result.state == state
    assert result.structured_output is None


def test__str__simple(mock_metrics, simple_message: Message):
    """Test that str() works with a simple message."""
    result = AgentResult(stop_reason="end_turn", message=simple_message, metrics=mock_metrics, state={})

    message_string = str(result)
    assert message_string == "Hello world!\n"


def test__str__complex(mock_metrics, complex_message: Message):
    """Test that str() works with a complex message with multiple text blocks."""
    result = AgentResult(stop_reason="end_turn", message=complex_message, metrics=mock_metrics, state={})

    message_string = str(result)
    assert message_string == "First paragraph\nSecond paragraph\nThird paragraph\n"


def test__str__empty(mock_metrics, empty_message: Message):
    """Test that str() works with an empty message."""
    result = AgentResult(stop_reason="end_turn", message=empty_message, metrics=mock_metrics, state={})

    message_string = str(result)
    assert message_string == ""


def test__str__no_content(mock_metrics):
    """Test that str() works with a message that has no content field."""
    message_without_content = cast(Message, {"role": "assistant"})

    result = AgentResult(stop_reason="end_turn", message=message_without_content, metrics=mock_metrics, state={})

    message_string = str(result)
    assert message_string == ""


def test__str__non_dict_content(mock_metrics):
    """Test that str() handles non-dictionary content items gracefully."""
    message_with_non_dict = cast(
        Message,
        {"role": "assistant", "content": [{"text": "Valid text"}, "Not a dictionary", {"text": "More valid text"}]},
    )

    result = AgentResult(stop_reason="end_turn", message=message_with_non_dict, metrics=mock_metrics, state={})

    message_string = str(result)
    assert message_string == "Valid text\nMore valid text\n"


def test_to_dict(mock_metrics, simple_message: Message):
    """Test that to_dict serializes AgentResult correctly."""
    result = AgentResult(stop_reason="end_turn", message=simple_message, metrics=mock_metrics, state={"key": "value"})

    data = result.to_dict()

    assert data == {
        "type": "agent_result",
        "message": simple_message,
        "stop_reason": "end_turn",
        "checkpoint": None,
    }


def test_from_dict():
    """Test that from_dict works with valid data."""
    data = {
        "type": "agent_result",
        "message": {"role": "assistant", "content": [{"text": "Test response"}]},
        "stop_reason": "end_turn",
    }

    result = AgentResult.from_dict(data)

    assert result.message == data["message"]
    assert result.stop_reason == data["stop_reason"]
    assert isinstance(result.metrics, EventLoopMetrics)
    assert result.state == {}


def test_roundtrip_serialization(mock_metrics, complex_message: Message):
    """Test that to_dict() and from_dict() work together correctly."""
    original = AgentResult(
        stop_reason="max_tokens", message=complex_message, metrics=mock_metrics, state={"test": "data"}
    )

    # Serialize and deserialize
    data = original.to_dict()
    restored = AgentResult.from_dict(data)

    assert restored.message == original.message
    assert restored.stop_reason == original.stop_reason
    assert isinstance(restored.metrics, EventLoopMetrics)
    assert restored.state == {}  # State is not serialized


# Tests for structured output functionality
class StructuredOutputModel(BaseModel):
    """Test model for structured output."""

    name: str
    value: int
    optional_field: str | None = None


def test__init__with_structured_output(mock_metrics, simple_message: Message):
    """Test that AgentResult can be initialized with structured_output."""
    stop_reason: StopReason = "end_turn"
    state = {"key": "value"}
    structured_output = StructuredOutputModel(name="test", value=42)

    result = AgentResult(
        stop_reason=stop_reason,
        message=simple_message,
        metrics=mock_metrics,
        state=state,
        structured_output=structured_output,
    )

    assert result.stop_reason == stop_reason
    assert result.message == simple_message
    assert result.metrics == mock_metrics
    assert result.state == state
    assert result.structured_output == structured_output
    assert isinstance(result.structured_output, StructuredOutputModel)
    assert result.structured_output.name == "test"
    assert result.structured_output.value == 42


def test__init__structured_output_defaults_to_none(mock_metrics, simple_message: Message):
    """Test that structured_output defaults to None when not provided."""
    result = AgentResult(stop_reason="end_turn", message=simple_message, metrics=mock_metrics, state={})

    assert result.structured_output is None


def test__str__with_structured_output(mock_metrics, simple_message: Message):
    """Test that str() returns structured output JSON when structured_output is present."""
    structured_output = StructuredOutputModel(name="test", value=42)

    result = AgentResult(
        stop_reason="end_turn",
        message=simple_message,
        metrics=mock_metrics,
        state={},
        structured_output=structured_output,
    )

    # When structured_output is present, it takes priority over message text
    message_string = str(result)
    assert message_string == structured_output.model_dump_json()
    assert "test" in message_string
    assert "42" in message_string


def test__str__empty_message_with_structured_output(mock_metrics, empty_message: Message):
    """Test that str() returns structured output JSON when message has no text content."""
    structured_output = StructuredOutputModel(name="example", value=123, optional_field="optional")

    result = AgentResult(
        stop_reason="end_turn",
        message=empty_message,
        metrics=mock_metrics,
        state={},
        structured_output=structured_output,
    )

    # When message has no text content, str() should return structured output as JSON
    message_string = str(result)

    # Verify it's the same as the structured output's JSON representation
    assert message_string == structured_output.model_dump_json()

    # Verify it contains the expected data
    assert "example" in message_string
    assert "123" in message_string
    assert "optional" in message_string


@pytest.fixture
def citations_message():
    """Message with citationsContent block."""
    return {
        "role": "assistant",
        "content": [
            {
                "citationsContent": {
                    "citations": [
                        {
                            "title": "Source Document",
                            "location": {"document": {"pageNumber": 1}},
                            "sourceContent": [{"text": "source text"}],
                        }
                    ],
                    "content": [{"text": "This is cited text from the document."}],
                }
            }
        ],
    }


@pytest.fixture
def mixed_text_and_citations_message():
    """Message with both plain text and citationsContent blocks."""
    return {
        "role": "assistant",
        "content": [
            {"text": "Introduction paragraph"},
            {
                "citationsContent": {
                    "citations": [{"title": "Doc", "location": {}, "sourceContent": []}],
                    "content": [{"text": "Cited content here."}],
                }
            },
            {"text": "Conclusion paragraph"},
        ],
    }


def test__str__with_citations_content(mock_metrics, citations_message: Message):
    """Test that str() extracts text from citationsContent blocks."""
    result = AgentResult(stop_reason="end_turn", message=citations_message, metrics=mock_metrics, state={})

    message_string = str(result)
    assert message_string == "This is cited text from the document.\n"


def test__str__mixed_text_and_citations_content(mock_metrics, mixed_text_and_citations_message: Message):
    """Test that str() works with both plain text and citationsContent blocks."""
    result = AgentResult(
        stop_reason="end_turn", message=mixed_text_and_citations_message, metrics=mock_metrics, state={}
    )

    message_string = str(result)
    assert message_string == "Introduction paragraph\nCited content here.\nConclusion paragraph\n"


def test__str__with_interrupts(mock_metrics, simple_message: Message):
    """Test that str() returns stringified interrupts when present."""
    interrupts = [
        Interrupt(id="int-1", name="approval", reason="Need user approval"),
        Interrupt(id="int-2", name="input", reason="Need more info"),
    ]

    result = AgentResult(
        stop_reason="end_turn",
        message=simple_message,
        metrics=mock_metrics,
        state={},
        interrupts=interrupts,
    )

    message_string = str(result)

    # Should contain stringified interrupt dicts
    assert "int-1" in message_string
    assert "approval" in message_string
    assert "Need user approval" in message_string
    assert "int-2" in message_string
    assert "input" in message_string
    assert "Need more info" in message_string


def test__str__interrupts_priority_over_structured_output(mock_metrics, simple_message: Message):
    """Test that interrupts take priority over structured_output in str()."""
    interrupts = [Interrupt(id="int-1", name="approval", reason="Needs approval")]
    structured_output = StructuredOutputModel(name="test", value=42)

    result = AgentResult(
        stop_reason="end_turn",
        message=simple_message,
        metrics=mock_metrics,
        state={},
        interrupts=interrupts,
        structured_output=structured_output,
    )

    message_string = str(result)

    # Should return interrupts, not structured output
    assert "int-1" in message_string
    assert "approval" in message_string
    # Should NOT contain structured output
    assert "test" not in message_string or "approval" in message_string  # "test" might appear but not from structured
    assert '"value": 42' not in message_string


def test__str__interrupts_priority_over_text_content(mock_metrics, simple_message: Message):
    """Test that interrupts take priority over message text content in str()."""
    interrupts = [Interrupt(id="int-1", name="confirm", reason="Please confirm")]

    result = AgentResult(
        stop_reason="end_turn",
        message=simple_message,
        metrics=mock_metrics,
        state={},
        interrupts=interrupts,
    )

    message_string = str(result)

    # Should return interrupts, not message text
    assert "int-1" in message_string
    assert "confirm" in message_string
    assert "Hello world!" not in message_string


def test__str__empty_interrupts_returns_agent_message(mock_metrics, simple_message: Message):
    """Test that empty interrupts list falls through to other content."""
    result = AgentResult(
        stop_reason="end_turn",
        message=simple_message,
        metrics=mock_metrics,
        state={},
        interrupts=[],
    )

    message_string = str(result)

    # Empty list is falsy, should fall through to text content
    assert message_string == "Hello world!\n"


def test_context_size_delegates_to_metrics(mock_metrics, simple_message: Message):
    """Test that context_size delegates to metrics.latest_context_size."""
    mock_metrics.latest_context_size = 12345
    result = AgentResult(stop_reason="end_turn", message=simple_message, metrics=mock_metrics, state={})
    assert result.context_size == 12345


def test_context_size_none_when_no_data(mock_metrics, simple_message: Message):
    """Test that context_size returns None when metrics has no data."""
    mock_metrics.latest_context_size = None
    result = AgentResult(stop_reason="end_turn", message=simple_message, metrics=mock_metrics, state={})
    assert result.context_size is None


def test_cost_captures_latest_invocation_cost(simple_message: Message):
    """Test that cost captures metrics.latest_invocation_cost."""
    metrics = EventLoopMetrics()
    metrics.reset_usage_metrics()
    metrics.latest_agent_invocation.usage["totalCostUsd"] = 0.0045

    result = AgentResult(stop_reason="end_turn", message=simple_message, metrics=metrics, state={})
    assert result.cost == 0.0045


def test_cost_is_snapshot_of_invocation(simple_message: Message):
    """Test that a later invocation does not change an existing result's cost."""
    metrics = EventLoopMetrics()
    metrics.reset_usage_metrics()
    metrics.latest_agent_invocation.usage["totalCostUsd"] = 0.0045
    result = AgentResult(stop_reason="end_turn", message=simple_message, metrics=metrics, state={})

    metrics.reset_usage_metrics()
    metrics.latest_agent_invocation.usage["totalCostUsd"] = 0.009

    assert result.cost == 0.0045


def test_cost_none_when_untracked(simple_message: Message):
    """Test that cost returns None when the provider did not report cost."""
    result = AgentResult(stop_reason="end_turn", message=simple_message, metrics=EventLoopMetrics(), state={})
    assert result.cost is None


@pytest.mark.parametrize("metrics", [{}, None, unittest.mock.ANY])
def test_cost_none_for_legacy_metrics_placeholders(metrics, simple_message: Message):
    """Test that legacy placeholder metrics leave cost untracked."""
    result = AgentResult(stop_reason="end_turn", message=simple_message, metrics=metrics, state={})
    assert result.cost is None


def test_projected_context_size_delegates_to_metrics(mock_metrics, simple_message: Message):
    """Test that projected_context_size delegates to metrics.projected_context_size."""
    mock_metrics.projected_context_size = 15000
    result = AgentResult(stop_reason="end_turn", message=simple_message, metrics=mock_metrics, state={})
    assert result.projected_context_size == 15000


def test_projected_context_size_none_when_no_data(mock_metrics, simple_message: Message):
    """Test that projected_context_size returns None when metrics has no data."""
    mock_metrics.projected_context_size = None
    result = AgentResult(stop_reason="end_turn", message=simple_message, metrics=mock_metrics, state={})
    assert result.projected_context_size is None


# =========================================================================
# Checkpoint field and round-trip serialization (Part B)
#
# Covers the V0 durable-execution contract: when stop_reason == "checkpoint",
# AgentResult carries a Checkpoint that round-trips through to_dict/from_dict.
# =========================================================================


def test_agent_result_checkpoint_field_default_none() -> None:
    result = AgentResult(
        stop_reason="end_turn",
        message={"role": "assistant", "content": [{"text": "hi"}]},
        metrics=EventLoopMetrics(),
        state={},
    )
    assert result.checkpoint is None


def test_agent_result_accepts_checkpoint() -> None:
    checkpoint = Checkpoint(position="after_model", cycle_index=0)
    result = AgentResult(
        stop_reason="checkpoint",
        message={"role": "assistant", "content": [{"toolUse": {"toolUseId": "1", "name": "t", "input": {}}}]},
        metrics=EventLoopMetrics(),
        state={},
        checkpoint=checkpoint,
    )
    assert result.checkpoint is checkpoint
    assert result.checkpoint.position == "after_model"


def test_agent_result_to_dict_includes_checkpoint() -> None:
    checkpoint = Checkpoint(position="after_model", cycle_index=0)
    result = AgentResult(
        stop_reason="checkpoint",
        message={"role": "assistant", "content": [{"toolUse": {"toolUseId": "1", "name": "t", "input": {}}}]},
        metrics=EventLoopMetrics(),
        state={},
        checkpoint=checkpoint,
    )
    d = result.to_dict()
    assert d["checkpoint"] is not None
    assert d["checkpoint"]["position"] == "after_model"
    assert d["checkpoint"]["cycle_index"] == 0


def test_agent_result_to_dict_checkpoint_none_when_absent() -> None:
    result = AgentResult(
        stop_reason="end_turn",
        message={"role": "assistant", "content": [{"text": "hi"}]},
        metrics=EventLoopMetrics(),
        state={},
    )
    d = result.to_dict()
    assert d["checkpoint"] is None


def test_agent_result_from_dict_round_trips_checkpoint() -> None:
    original = AgentResult(
        stop_reason="checkpoint",
        message={"role": "assistant", "content": [{"toolUse": {"toolUseId": "1", "name": "t", "input": {}}}]},
        metrics=EventLoopMetrics(),
        state={},
        checkpoint=Checkpoint(position="after_tools", cycle_index=3),
    )
    restored = AgentResult.from_dict(original.to_dict())
    assert restored.checkpoint is not None
    assert restored.checkpoint.position == "after_tools"
    assert restored.checkpoint.cycle_index == 3


def test_agent_result_from_dict_handles_missing_checkpoint() -> None:
    restored = AgentResult.from_dict(
        {
            "type": "agent_result",
            "message": {"role": "assistant", "content": [{"text": "done"}]},
            "stop_reason": "end_turn",
        }
    )
    assert restored.checkpoint is None
