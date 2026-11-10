from unittest.mock import Mock

import pytest

from strands.agent.agent_result import AgentResult
from strands.hooks import (
    AfterInvocationEvent,
    AfterModelCallEvent,
    AfterToolCallEvent,
    AfterToolsEvent,
    AgentInitializedEvent,
    BeforeInvocationEvent,
    BeforeModelCallEvent,
    BeforeToolCallEvent,
    BeforeToolsEvent,
    MessageAddedEvent,
)
from strands.types.content import Message, Messages
from strands.types.tools import ToolResult, ToolUse


@pytest.fixture
def agent():
    return Mock()


@pytest.fixture
def sample_messages() -> Messages:
    return [{"role": "user", "content": [{"text": "Hello, agent!"}]}]


@pytest.fixture
def tool():
    tool = Mock()
    tool.tool_name = "test_tool"
    return tool


@pytest.fixture
def tool_use():
    return ToolUse(name="test_tool", toolUseId="123", input={"param": "value"})


@pytest.fixture
def tool_invocation_state():
    return {"param": "value"}


@pytest.fixture
def tool_result():
    return ToolResult(content=[{"text": "result"}], status="success", toolUseId="123")


@pytest.fixture
def initialized_event(agent):
    return AgentInitializedEvent(agent=agent)


@pytest.fixture
def start_request_event(agent):
    return BeforeInvocationEvent(agent=agent)


@pytest.fixture
def start_request_event_with_messages(agent, sample_messages):
    return BeforeInvocationEvent(agent=agent, messages=sample_messages)


@pytest.fixture
def messaged_added_event(agent):
    return MessageAddedEvent(agent=agent, message=Mock())


@pytest.fixture
def end_request_event(agent):
    return AfterInvocationEvent(agent=agent)


@pytest.fixture
def before_tools_event(agent, tool_use, tool_invocation_state):
    message: Message = {"role": "assistant", "content": [{"toolUse": tool_use}]}
    return BeforeToolsEvent(
        agent=agent,
        message=message,
        invocation_state=tool_invocation_state,
    )


@pytest.fixture
def after_tools_event(agent, tool_result, tool_invocation_state):
    message: Message = {"role": "user", "content": [{"toolResult": tool_result}]}
    return AfterToolsEvent(
        agent=agent,
        message=message,
        invocation_state=tool_invocation_state,
    )


@pytest.fixture
def before_tool_event(agent, tool, tool_use, tool_invocation_state):
    return BeforeToolCallEvent(
        agent=agent,
        selected_tool=tool,
        tool_use=tool_use,
        invocation_state=tool_invocation_state,
    )


@pytest.fixture
def after_tool_event(agent, tool, tool_use, tool_invocation_state, tool_result):
    return AfterToolCallEvent(
        agent=agent,
        selected_tool=tool,
        tool_use=tool_use,
        invocation_state=tool_invocation_state,
        result=tool_result,
    )


def test_event_should_reverse_callbacks(
    initialized_event,
    start_request_event,
    messaged_added_event,
    end_request_event,
    before_tools_event,
    after_tools_event,
    before_tool_event,
    after_tool_event,
):
    # note that we ignore E712 (explicit booleans) for consistency/readability purposes

    assert initialized_event.should_reverse_callbacks == False  # noqa: E712

    assert messaged_added_event.should_reverse_callbacks == False  # noqa: E712

    assert start_request_event.should_reverse_callbacks == False  # noqa: E712
    assert end_request_event.should_reverse_callbacks == True  # noqa: E712

    assert before_tools_event.should_reverse_callbacks == False  # noqa: E712
    assert after_tools_event.should_reverse_callbacks == True  # noqa: E712
    assert before_tool_event.should_reverse_callbacks == False  # noqa: E712
    assert after_tool_event.should_reverse_callbacks == True  # noqa: E712


def test_before_tools_event_fields_default_and_writability(before_tools_event, agent, tool_use, tool_invocation_state):
    tru_event = before_tools_event
    exp_event = BeforeToolsEvent(
        agent=agent,
        message={"role": "assistant", "content": [{"toolUse": tool_use}]},
        invocation_state=tool_invocation_state,
    )
    assert tru_event == exp_event
    assert tru_event.cancel is False

    tru_event.cancel = True
    assert tru_event.cancel is True
    tru_event.cancel = "tools not allowed"
    assert tru_event.cancel == "tools not allowed"

    with pytest.raises(AttributeError, match="Property agent is not writable"):
        tru_event.agent = Mock()
    with pytest.raises(AttributeError, match="Property message is not writable"):
        tru_event.message = {"role": "assistant", "content": []}
    with pytest.raises(AttributeError, match="Property invocation_state is not writable"):
        tru_event.invocation_state = {}


def test_before_tools_event_interrupt_id(before_tools_event):
    tru_interrupt_id = before_tools_event._interrupt_id("test_name")
    exp_interrupt_id = "v1:before_tools:78714d6c-613c-5cf4-bf25-7037569941f9"
    assert tru_interrupt_id == exp_interrupt_id


def test_after_tools_event_fields_default_and_writability(after_tools_event, agent, tool_result, tool_invocation_state):
    tru_event = after_tools_event
    exp_event = AfterToolsEvent(
        agent=agent,
        message={"role": "user", "content": [{"toolResult": tool_result}]},
        invocation_state=tool_invocation_state,
    )
    assert tru_event == exp_event
    assert tru_event.end_turn is False

    with pytest.raises(AttributeError, match="Property agent is not writable"):
        tru_event.agent = Mock()
    with pytest.raises(AttributeError, match="Property message is not writable"):
        tru_event.message = {"role": "user", "content": []}
    with pytest.raises(AttributeError, match="Property invocation_state is not writable"):
        tru_event.invocation_state = {}


def test_message_added_event_cannot_write_properties(messaged_added_event):
    with pytest.raises(AttributeError, match="Property agent is not writable"):
        messaged_added_event.agent = Mock()
    with pytest.raises(AttributeError, match="Property message is not writable"):
        messaged_added_event.message = {}


def test_before_tool_invocation_event_can_write_properties(before_tool_event):
    new_tool_use = ToolUse(name="new_tool", toolUseId="456", input={})
    before_tool_event.selected_tool = None  # Should not raise
    before_tool_event.tool_use = new_tool_use  # Should not raise


def test_before_tool_invocation_event_cannot_write_properties(before_tool_event):
    with pytest.raises(AttributeError, match="Property agent is not writable"):
        before_tool_event.agent = Mock()
    with pytest.raises(AttributeError, match="Property invocation_state is not writable"):
        before_tool_event.invocation_state = {}


def test_after_tool_invocation_event_can_write_properties(after_tool_event):
    new_result = ToolResult(content=[{"text": "new result"}], status="success", toolUseId="456")
    after_tool_event.result = new_result  # Should not raise


def test_after_tool_invocation_event_cannot_write_properties(after_tool_event):
    with pytest.raises(AttributeError, match="Property agent is not writable"):
        after_tool_event.agent = Mock()
    with pytest.raises(AttributeError, match="Property selected_tool is not writable"):
        after_tool_event.selected_tool = None
    with pytest.raises(AttributeError, match="Property tool_use is not writable"):
        after_tool_event.tool_use = ToolUse(name="new", toolUseId="456", input={})
    with pytest.raises(AttributeError, match="Property invocation_state is not writable"):
        after_tool_event.invocation_state = {}
    with pytest.raises(AttributeError, match="Property exception is not writable"):
        after_tool_event.exception = Exception("test")


def test_after_invocation_event_properties_not_writable(agent):
    """Test that properties are not writable after initialization."""
    mock_message: Message = {"role": "assistant", "content": [{"text": "test"}]}
    mock_result = AgentResult(
        stop_reason="end_turn",
        message=mock_message,
        metrics={},
        state={},
    )

    event = AfterInvocationEvent(agent=agent, result=None)

    with pytest.raises(AttributeError, match="Property result is not writable"):
        event.result = mock_result

    with pytest.raises(AttributeError, match="Property agent is not writable"):
        event.agent = Mock()

    with pytest.raises(AttributeError, match="Property invocation_state is not writable"):
        event.invocation_state = {}


def test_invocation_state_is_available_in_invocation_events(agent):
    """Test that invocation_state is accessible in BeforeInvocationEvent and AfterInvocationEvent."""
    invocation_state = {"session_id": "test-123", "request_id": "req-456"}

    before_event = BeforeInvocationEvent(agent=agent, invocation_state=invocation_state)
    assert before_event.invocation_state == invocation_state
    assert before_event.invocation_state["session_id"] == "test-123"
    assert before_event.invocation_state["request_id"] == "req-456"

    after_event = AfterInvocationEvent(agent=agent, invocation_state=invocation_state, result=None)
    assert after_event.invocation_state == invocation_state
    assert after_event.invocation_state["session_id"] == "test-123"
    assert after_event.invocation_state["request_id"] == "req-456"


def test_invocation_state_is_available_in_model_call_events(agent):
    """Test that invocation_state is accessible in BeforeModelCallEvent and AfterModelCallEvent."""
    invocation_state = {"session_id": "test-123", "request_id": "req-456"}

    before_event = BeforeModelCallEvent(agent=agent, invocation_state=invocation_state)
    assert before_event.invocation_state == invocation_state
    assert before_event.invocation_state["session_id"] == "test-123"
    assert before_event.invocation_state["request_id"] == "req-456"

    after_event = AfterModelCallEvent(agent=agent, invocation_state=invocation_state)
    assert after_event.invocation_state == invocation_state
    assert after_event.invocation_state["session_id"] == "test-123"
    assert after_event.invocation_state["request_id"] == "req-456"


def test_before_invocation_event_messages_default_none(agent):
    """Test that BeforeInvocationEvent.messages defaults to None for backward compatibility."""
    event = BeforeInvocationEvent(agent=agent)
    assert event.messages is None


def test_before_invocation_event_messages_writable(agent, sample_messages):
    """Test that BeforeInvocationEvent.messages can be modified in-place for guardrail redaction."""
    event = BeforeInvocationEvent(agent=agent, messages=sample_messages)

    # Should be able to modify the messages list in-place
    event.messages[0]["content"] = [{"text": "[REDACTED]"}]
    assert event.messages[0]["content"] == [{"text": "[REDACTED]"}]

    # Should be able to reassign messages entirely
    new_messages: Messages = [{"role": "user", "content": [{"text": "Different message"}]}]
    event.messages = new_messages
    assert event.messages == new_messages


def test_before_invocation_event_agent_not_writable(start_request_event_with_messages):
    """Test that BeforeInvocationEvent.agent is not writable."""
    with pytest.raises(AttributeError, match="Property agent is not writable"):
        start_request_event_with_messages.agent = Mock()


def test_after_invocation_event_resume_defaults_to_none(agent):
    """Test that AfterInvocationEvent.resume defaults to None."""
    event = AfterInvocationEvent(agent=agent, result=None)
    assert event.resume is None


def test_after_invocation_event_resume_is_writable(agent):
    """Test that AfterInvocationEvent.resume can be set by hooks."""
    event = AfterInvocationEvent(agent=agent, result=None)
    event.resume = "continue with this input"
    assert event.resume == "continue with this input"


def test_after_invocation_event_resume_accepts_various_input_types(agent):
    """Test that resume accepts all AgentInput types."""
    event = AfterInvocationEvent(agent=agent, result=None)

    # String input
    event.resume = "hello"
    assert event.resume == "hello"

    # Content block list
    event.resume = [{"text": "hello"}]
    assert event.resume == [{"text": "hello"}]

    # None to stop
    event.resume = None
    assert event.resume is None


def test_before_model_call_event_projected_input_tokens_default(agent):
    """Test that projected_input_tokens defaults to None."""
    event = BeforeModelCallEvent(agent=agent)
    assert event.projected_input_tokens is None


def test_before_model_call_event_projected_input_tokens_set(agent):
    """Test that projected_input_tokens can be set at construction."""
    event = BeforeModelCallEvent(agent=agent, projected_input_tokens=500)
    assert event.projected_input_tokens == 500


def test_before_model_call_event_projected_input_tokens_not_writable(agent):
    """Test that projected_input_tokens is not writable after construction."""
    event = BeforeModelCallEvent(agent=agent, projected_input_tokens=500)
    with pytest.raises(AttributeError, match="Property projected_input_tokens is not writable"):
        event.projected_input_tokens = 1000
