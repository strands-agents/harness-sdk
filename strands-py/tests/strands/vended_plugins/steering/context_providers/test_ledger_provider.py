"""Unit tests for ledger context providers."""

from unittest.mock import Mock, patch

from strands.hooks.events import AfterToolCallEvent, BeforeToolCallEvent
from strands.vended_plugins.steering.context_providers.ledger_provider import (
    LedgerAfterToolCall,
    LedgerBeforeToolCall,
    LedgerProvider,
)
from strands.vended_plugins.steering.core.context import SteeringContext


def test_context_providers_method():
    """Test context_providers method returns correct callbacks."""
    provider = LedgerProvider()

    callbacks = provider.context_providers()

    assert len(callbacks) == 2
    assert isinstance(callbacks[0], LedgerBeforeToolCall)
    assert isinstance(callbacks[1], LedgerAfterToolCall)


@patch("strands.vended_plugins.steering.context_providers.ledger_provider.datetime")
def test_ledger_before_tool_call_new_ledger(mock_datetime):
    """Test LedgerBeforeToolCall with new ledger."""
    mock_datetime.now.return_value.isoformat.return_value = "2024-01-01T12:00:00"

    callback = LedgerBeforeToolCall()
    steering_context = SteeringContext()

    tool_use = {"name": "test_tool", "input": {"param": "value"}}
    event = Mock(spec=BeforeToolCallEvent)
    event.tool_use = tool_use

    callback(event, steering_context)

    ledger = steering_context.data.get("ledger")
    assert ledger is not None
    assert "session_start" in ledger
    assert "tool_calls" in ledger
    assert len(ledger["tool_calls"]) == 1

    tool_call = ledger["tool_calls"][0]
    assert tool_call["tool_name"] == "test_tool"
    assert tool_call["tool_args"] == {"param": "value"}
    assert tool_call["status"] == "pending"


@patch("strands.vended_plugins.steering.context_providers.ledger_provider.datetime")
def test_ledger_before_tool_call_existing_ledger(mock_datetime):
    """Test LedgerBeforeToolCall with existing ledger."""
    mock_datetime.now.return_value.isoformat.return_value = "2024-01-01T12:00:00"

    callback = LedgerBeforeToolCall()
    steering_context = SteeringContext()

    # Set up existing ledger
    existing_ledger = {
        "session_start": "2024-01-01T10:00:00",
        "tool_calls": [{"name": "previous_tool"}],
        "conversation_history": [],
        "session_metadata": {},
    }
    steering_context.data.set("ledger", existing_ledger)

    tool_use = {"name": "new_tool", "input": {"param": "value"}}
    event = Mock(spec=BeforeToolCallEvent)
    event.tool_use = tool_use

    callback(event, steering_context)

    ledger = steering_context.data.get("ledger")
    assert len(ledger["tool_calls"]) == 2
    assert ledger["tool_calls"][0]["name"] == "previous_tool"
    assert ledger["tool_calls"][1]["tool_name"] == "new_tool"


@patch("strands.vended_plugins.steering.context_providers.ledger_provider.datetime")
def test_ledger_after_tool_call_success(mock_datetime):
    """Test LedgerAfterToolCall with successful completion."""
    mock_datetime.now.return_value.isoformat.return_value = "2024-01-01T12:05:00"

    callback = LedgerAfterToolCall()
    steering_context = SteeringContext()

    # Set up existing ledger with pending call
    existing_ledger = {
        "tool_calls": [
            {
                "tool_use_id": "test-id",
                "tool_name": "test_tool",
                "status": "pending",
                "timestamp": "2024-01-01T12:00:00",
            }
        ]
    }
    steering_context.data.set("ledger", existing_ledger)

    event = Mock(spec=AfterToolCallEvent)
    event.tool_use = {"toolUseId": "test-id"}
    event.result = {"status": "success", "content": ["success_result"]}
    event.exception = None

    callback(event, steering_context)

    ledger = steering_context.data.get("ledger")
    tool_call = ledger["tool_calls"][0]
    assert tool_call["status"] == "success"
    assert tool_call["result"] == ["success_result"]
    assert tool_call["error"] is None
    assert tool_call["completion_timestamp"] == "2024-01-01T12:05:00"


def test_ledger_after_tool_call_no_calls():
    """Test LedgerAfterToolCall when no tool calls exist."""
    callback = LedgerAfterToolCall()
    steering_context = SteeringContext()

    # Set up ledger with no tool calls
    existing_ledger = {"tool_calls": []}
    steering_context.data.set("ledger", existing_ledger)

    event = Mock(spec=AfterToolCallEvent)
    event.result = {"status": "success", "content": ["test"]}
    event.exception = None

    # Should not crash when no tool calls exist
    callback(event, steering_context)

    ledger = steering_context.data.get("ledger")
    assert ledger["tool_calls"] == []


def test_session_start_persistence():
    """Test that session_start is set during initialization and persists."""
    with patch("strands.vended_plugins.steering.context_providers.ledger_provider.datetime") as mock_datetime:
        mock_datetime.now.return_value.isoformat.return_value = "2024-01-01T10:00:00"

        callback = LedgerBeforeToolCall()

        assert callback.session_start == "2024-01-01T10:00:00"


@patch("strands.vended_plugins.steering.context_providers.ledger_provider.datetime")
def test_parallel_tool_calls_all_pending(mock_datetime):
    """Test multiple tool calls added as pending before any execute."""
    mock_datetime.now.return_value.isoformat.return_value = "2024-01-01T12:00:00"

    callback = LedgerBeforeToolCall()
    steering_context = SteeringContext()

    # Add three tool calls in sequence (simulating parallel proposal)
    for i, tool_name in enumerate(["tool_a", "tool_b", "tool_c"]):
        event = Mock(spec=BeforeToolCallEvent)
        event.tool_use = {"toolUseId": f"id_{i}", "name": tool_name, "input": {}}
        callback(event, steering_context)

    ledger = steering_context.data.get("ledger")
    assert len(ledger["tool_calls"]) == 3
    assert all(call["status"] == "pending" for call in ledger["tool_calls"])
    assert [call["tool_name"] for call in ledger["tool_calls"]] == ["tool_a", "tool_b", "tool_c"]


@patch("strands.vended_plugins.steering.context_providers.ledger_provider.datetime")
def test_parallel_tool_calls_complete_by_id(mock_datetime):
    """Test tool calls complete in any order by matching toolUseId."""
    # Need timestamps for: session_start + 3 tool calls + 1 completion
    mock_datetime.now.return_value.isoformat.side_effect = [
        "2024-01-01T11:00:00",  # session_start
        "2024-01-01T12:00:00",  # tool_a
        "2024-01-01T12:01:00",  # tool_b
        "2024-01-01T12:02:00",  # tool_c
        "2024-01-01T12:03:00",  # completion
    ]

    before_callback = LedgerBeforeToolCall()
    after_callback = LedgerAfterToolCall()
    steering_context = SteeringContext()

    # Add three pending tool calls
    for i, tool_name in enumerate(["tool_a", "tool_b", "tool_c"]):
        event = Mock(spec=BeforeToolCallEvent)
        event.tool_use = {"toolUseId": f"id_{i}", "name": tool_name, "input": {}}
        before_callback(event, steering_context)

    # Complete middle tool first (out of order)
    event = Mock(spec=AfterToolCallEvent)
    event.tool_use = {"toolUseId": "id_1"}
    event.result = {"status": "success", "content": ["result_b"]}
    event.exception = None
    after_callback(event, steering_context)

    ledger = steering_context.data.get("ledger")
    assert ledger["tool_calls"][0]["status"] == "pending"
    assert ledger["tool_calls"][1]["status"] == "success"
    assert ledger["tool_calls"][1]["result"] == ["result_b"]
    assert ledger["tool_calls"][2]["status"] == "pending"


@patch("strands.vended_plugins.steering.context_providers.ledger_provider.datetime")
def test_parallel_tool_calls_complete_all_out_of_order(mock_datetime):
    """Test all parallel tool calls complete in reverse order."""
    # Need timestamps for: session_start + 3 tool calls + 3 completions
    mock_datetime.now.return_value.isoformat.side_effect = [
        "2024-01-01T11:00:00",  # session_start
        "2024-01-01T12:00:00",  # tool_0
        "2024-01-01T12:01:00",  # tool_1
        "2024-01-01T12:02:00",  # tool_2
        "2024-01-01T12:03:00",  # completion tool_2
        "2024-01-01T12:04:00",  # completion tool_1
        "2024-01-01T12:05:00",  # completion tool_0
    ]

    before_callback = LedgerBeforeToolCall()
    after_callback = LedgerAfterToolCall()
    steering_context = SteeringContext()

    # Add three pending tool calls
    for i in range(3):
        event = Mock(spec=BeforeToolCallEvent)
        event.tool_use = {"toolUseId": f"id_{i}", "name": f"tool_{i}", "input": {}}
        before_callback(event, steering_context)

    # Complete in reverse order: 2, 1, 0
    for i in [2, 1, 0]:
        event = Mock(spec=AfterToolCallEvent)
        event.tool_use = {"toolUseId": f"id_{i}"}
        event.result = {"status": "success", "content": [f"result_{i}"]}
        event.exception = None
        after_callback(event, steering_context)

    ledger = steering_context.data.get("ledger")
    assert all(call["status"] == "success" for call in ledger["tool_calls"])
    assert ledger["tool_calls"][0]["result"] == ["result_0"]
    assert ledger["tool_calls"][1]["result"] == ["result_1"]
    assert ledger["tool_calls"][2]["result"] == ["result_2"]


@patch("strands.vended_plugins.steering.context_providers.ledger_provider.datetime")
def test_parallel_tool_calls_with_failure(mock_datetime):
    """Test parallel tool calls where one fails."""
    # Need timestamps for: session_start + 2 tool calls + 2 completions
    mock_datetime.now.return_value.isoformat.side_effect = [
        "2024-01-01T11:00:00",  # session_start
        "2024-01-01T12:00:00",  # tool_0
        "2024-01-01T12:01:00",  # tool_1
        "2024-01-01T12:02:00",  # completion tool_0
        "2024-01-01T12:03:00",  # completion tool_1
    ]

    before_callback = LedgerBeforeToolCall()
    after_callback = LedgerAfterToolCall()
    steering_context = SteeringContext()

    # Add two pending tool calls
    for i in range(2):
        event = Mock(spec=BeforeToolCallEvent)
        event.tool_use = {"toolUseId": f"id_{i}", "name": f"tool_{i}", "input": {}}
        before_callback(event, steering_context)

    # First succeeds
    event = Mock(spec=AfterToolCallEvent)
    event.tool_use = {"toolUseId": "id_0"}
    event.result = {"status": "success", "content": ["result_0"]}
    event.exception = None
    after_callback(event, steering_context)

    # Second fails
    event = Mock(spec=AfterToolCallEvent)
    event.tool_use = {"toolUseId": "id_1"}
    event.result = {"status": "error", "content": []}
    event.exception = ValueError("test error")
    after_callback(event, steering_context)

    ledger = steering_context.data.get("ledger")
    assert ledger["tool_calls"][0]["status"] == "success"
    assert ledger["tool_calls"][0]["error"] is None
    assert ledger["tool_calls"][1]["status"] == "error"
    assert ledger["tool_calls"][1]["error"] == "test error"


@patch("strands.vended_plugins.steering.context_providers.ledger_provider.datetime")
def test_after_tool_call_no_matching_id(mock_datetime):
    """Test AfterToolCallEvent when tool_use_id doesn't match any pending call."""
    mock_datetime.now.return_value.isoformat.return_value = "2024-01-01T12:00:00"

    before_callback = LedgerBeforeToolCall()
    after_callback = LedgerAfterToolCall()
    steering_context = SteeringContext()

    # Add a pending tool call
    event = Mock(spec=BeforeToolCallEvent)
    event.tool_use = {"toolUseId": "id_1", "name": "tool_1", "input": {}}
    before_callback(event, steering_context)

    # Try to complete a different tool_use_id that doesn't exist
    event = Mock(spec=AfterToolCallEvent)
    event.tool_use = {"toolUseId": "id_999"}
    event.result = {"status": "success", "content": ["result"]}
    event.exception = None
    after_callback(event, steering_context)

    # Original tool should still be pending (no match found)
    ledger = steering_context.data.get("ledger")
    assert ledger["tool_calls"][0]["status"] == "pending"
    assert "completion_timestamp" not in ledger["tool_calls"][0]


@patch("strands.vended_plugins.steering.context_providers.ledger_provider.datetime")
def test_tool_use_id_stored_in_ledger(mock_datetime):
    """Test that toolUseId is stored in ledger entries."""
    mock_datetime.now.return_value.isoformat.return_value = "2024-01-01T12:00:00"

    callback = LedgerBeforeToolCall()
    steering_context = SteeringContext()

    event = Mock(spec=BeforeToolCallEvent)
    event.tool_use = {"toolUseId": "test-id-123", "name": "test_tool", "input": {}}
    callback(event, steering_context)

    ledger = steering_context.data.get("ledger")
    assert ledger["tool_calls"][0]["tool_use_id"] == "test-id-123"
