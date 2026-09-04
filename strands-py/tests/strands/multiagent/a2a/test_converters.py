"""Tests for A2A converter functions."""

from uuid import uuid4

import pytest
from a2a.types import (
    Artifact,
    Part,
    Role,
    StreamResponse,
    Task,
    TaskArtifactUpdateEvent,
    TaskState,
    TaskStatus,
    TaskStatusUpdateEvent,
)
from a2a.types import Message as A2AMessage

from strands.agent.agent_result import AgentResult
from strands.multiagent.a2a._converters import (
    _extract_task_state,
    _parts_to_content,
    convert_content_blocks_to_parts,
    convert_input_to_message,
    convert_responses_to_agent_result,
)


def test_convert_string_input():
    """Test converting string input to A2A message."""
    message = convert_input_to_message("Hello")

    assert isinstance(message, A2AMessage)
    assert message.role == Role.ROLE_USER
    assert len(message.parts) == 1
    assert message.parts[0].text == "Hello"


def test_convert_message_list_input():
    """Test converting message list input to A2A message."""
    messages = [
        {"role": "user", "content": [{"text": "Hello"}]},
    ]

    message = convert_input_to_message(messages)

    assert isinstance(message, A2AMessage)
    assert message.role == Role.ROLE_USER
    assert len(message.parts) == 1


def test_convert_content_blocks_input():
    """Test converting content blocks input to A2A message."""
    content_blocks = [{"text": "Hello"}, {"text": "World"}]

    message = convert_input_to_message(content_blocks)

    assert isinstance(message, A2AMessage)
    assert len(message.parts) == 2


def test_convert_unsupported_input():
    """Test that unsupported input types raise ValueError."""
    with pytest.raises(ValueError, match="Unsupported input type"):
        convert_input_to_message(123)


def test_convert_interrupt_response_raises_error():
    """Test that InterruptResponseContent raises explicit error."""
    interrupt_responses = [{"interruptResponse": {"interruptId": "123", "response": "A"}}]

    with pytest.raises(ValueError, match="InterruptResponseContent is not supported for A2AAgent"):
        convert_input_to_message(interrupt_responses)


def test_convert_message_list_finds_last_user_message():
    """Test that message list conversion finds the last user message."""
    messages = [
        {"role": "user", "content": [{"text": "First"}]},
        {"role": "assistant", "content": [{"text": "Response"}]},
        {"role": "user", "content": [{"text": "Second"}]},
    ]

    message = convert_input_to_message(messages)

    assert message.parts[0].text == "Second"


def test_convert_content_blocks_to_parts():
    """Test converting content blocks to A2A parts."""
    content_blocks = [{"text": "Hello"}, {"text": "World"}]

    parts = convert_content_blocks_to_parts(content_blocks)

    assert len(parts) == 2
    assert parts[0].text == "Hello"
    assert parts[1].text == "World"


def test_convert_content_blocks_skips_non_text():
    """Test that non-text content blocks are skipped."""
    content_blocks = [{"text": "Hello"}, {"image": "data"}, {"text": "World"}]

    parts = convert_content_blocks_to_parts(content_blocks)

    assert len(parts) == 2


def test_convert_a2a_message_response():
    """Test converting a bare A2A Message response to AgentResult."""
    a2a_message = A2AMessage(
        message_id=uuid4().hex,
        role=Role.ROLE_AGENT,
        parts=[Part(text="Response")],
    )

    result = convert_responses_to_agent_result([StreamResponse(message=a2a_message)])

    assert isinstance(result, AgentResult)
    assert result.message["role"] == "assistant"
    assert len(result.message["content"]) == 1
    assert result.message["content"][0]["text"] == "Response"


def test_convert_multiple_parts_response():
    """Test converting response with multiple parts to separate content blocks."""
    a2a_message = A2AMessage(
        message_id=uuid4().hex,
        role=Role.ROLE_AGENT,
        parts=[Part(text="First"), Part(text="Second")],
    )

    result = convert_responses_to_agent_result([StreamResponse(message=a2a_message)])

    assert len(result.message["content"]) == 2
    assert result.message["content"][0]["text"] == "First"
    assert result.message["content"][1]["text"] == "Second"


def test_convert_bare_task_response_uses_task_artifacts():
    """Test that a bare `task` response (no separate update event) extracts task.artifacts."""
    task = Task(
        id="task-1",
        context_id="ctx-1",
        status=TaskStatus(state=TaskState.TASK_STATE_SUBMITTED),
        artifacts=[Artifact(artifact_id="a1", parts=[Part(text="Task response")])],
    )

    result = convert_responses_to_agent_result([StreamResponse(task=task)])

    assert isinstance(result, AgentResult)
    assert len(result.message["content"]) == 1
    assert result.message["content"][0]["text"] == "Task response"


def test_convert_task_artifact_update_event():
    """Test converting a TaskArtifactUpdateEvent response to AgentResult."""
    event = TaskArtifactUpdateEvent(
        task_id="task-1",
        context_id="ctx-1",
        artifact=Artifact(artifact_id="a1", parts=[Part(text="Streamed artifact")]),
    )

    result = convert_responses_to_agent_result([StreamResponse(artifact_update=event)])

    assert result.message["content"][0]["text"] == "Streamed artifact"


def test_convert_task_status_update_event_with_message():
    """Test converting a TaskStatusUpdateEvent with a message to AgentResult."""
    event = TaskStatusUpdateEvent(
        task_id="task-1",
        context_id="ctx-1",
        status=TaskStatus(
            state=TaskState.TASK_STATE_FAILED,
            message=A2AMessage(message_id=uuid4().hex, role=Role.ROLE_AGENT, parts=[Part(text="Status message")]),
        ),
    )

    result = convert_responses_to_agent_result([StreamResponse(status_update=event)])

    assert result.message["content"][0]["text"] == "Status message"


def test_convert_status_update_without_message_has_no_content():
    """A terminal status_update with no message and no prior artifact yields empty content.

    This is the streaming pattern where the final content already arrived via a separate
    artifact_update event earlier in the same call — covered by
    test_artifact_update_then_status_update_does_not_duplicate below.
    """
    event = TaskStatusUpdateEvent(
        task_id="task-1",
        context_id="ctx-1",
        status=TaskStatus(state=TaskState.TASK_STATE_COMPLETED),
    )

    result = convert_responses_to_agent_result([StreamResponse(status_update=event)])

    assert result.message["content"] == []
    assert result.stop_reason == "end_turn"


def test_artifact_update_then_status_update_does_not_duplicate():
    """The common non-compliant-streaming pattern: artifact carries content, terminal status has none.

    Regression test: summing artifact_update content across the stream must not also pull in the
    terminal status_update's (nonexistent) message, and must not double-count.
    """
    artifact_event = StreamResponse(
        artifact_update=TaskArtifactUpdateEvent(
            task_id="task-1",
            context_id="ctx-1",
            artifact=Artifact(artifact_id="a1", parts=[Part(text="final answer")]),
        )
    )
    status_event = StreamResponse(
        status_update=TaskStatusUpdateEvent(
            task_id="task-1",
            context_id="ctx-1",
            status=TaskStatus(state=TaskState.TASK_STATE_COMPLETED),
        )
    )

    result = convert_responses_to_agent_result([artifact_event, status_event])

    assert result.message["content"] == [{"text": "final answer"}]
    assert result.state.get("a2a_task_state") == "completed"


def test_multiple_artifact_updates_accumulate_in_order():
    """Multiple artifact_update chunks (compliant-streaming deltas) accumulate in stream order."""
    responses = [
        StreamResponse(
            artifact_update=TaskArtifactUpdateEvent(
                task_id="task-1",
                context_id="ctx-1",
                artifact=Artifact(artifact_id="a1", parts=[Part(text="Hello, ")]),
            )
        ),
        StreamResponse(
            artifact_update=TaskArtifactUpdateEvent(
                task_id="task-1",
                context_id="ctx-1",
                artifact=Artifact(artifact_id="a1", parts=[Part(text="world!")]),
                append=True,
                last_chunk=True,
            )
        ),
    ]

    result = convert_responses_to_agent_result(responses)

    assert result.message["content"] == [{"text": "Hello, "}, {"text": "world!"}]


def test_artifact_replace_does_not_duplicate_on_resend():
    """A peer that re-sends its full cumulative artifact each turn (append=False) must not duplicate.

    append=False (the default) means "replace this artifact's content", not "add to it".
    """
    responses = [
        StreamResponse(
            artifact_update=TaskArtifactUpdateEvent(
                task_id="task-1", context_id="ctx-1", artifact=Artifact(artifact_id="a1", parts=[Part(text="Hel")])
            )
        ),
        StreamResponse(
            artifact_update=TaskArtifactUpdateEvent(
                task_id="task-1", context_id="ctx-1", artifact=Artifact(artifact_id="a1", parts=[Part(text="Hello")])
            )
        ),
        StreamResponse(
            artifact_update=TaskArtifactUpdateEvent(
                task_id="task-1",
                context_id="ctx-1",
                artifact=Artifact(artifact_id="a1", parts=[Part(text="Hello world")]),
            )
        ),
    ]

    result = convert_responses_to_agent_result(responses)

    assert result.message["content"] == [{"text": "Hello world"}]


def test_terminal_status_message_appended_after_artifact_content():
    """An actionable terminal status message (e.g. an approval prompt) is not dropped when
    artifact content already streamed — both are surfaced, in order.
    """
    artifact_event = StreamResponse(
        artifact_update=TaskArtifactUpdateEvent(
            task_id="task-1",
            context_id="ctx-1",
            artifact=Artifact(artifact_id="a1", parts=[Part(text="partial answer")]),
        )
    )
    status_event = StreamResponse(
        status_update=TaskStatusUpdateEvent(
            task_id="task-1",
            context_id="ctx-1",
            status=TaskStatus(
                state=TaskState.TASK_STATE_INPUT_REQUIRED,
                message=A2AMessage(message_id=uuid4().hex, role=Role.ROLE_AGENT, parts=[Part(text="need approval")]),
            ),
        )
    )

    result = convert_responses_to_agent_result([artifact_event, status_event])

    assert result.message["content"] == [{"text": "partial answer"}, {"text": "need approval"}]
    assert result.stop_reason == "interrupt"


def test_parts_to_content_drops_empty_text_parts():
    """An empty-text part (the compliant-streaming last_chunk marker) yields no content block."""
    assert _parts_to_content([Part(text="")]) == []
    assert _parts_to_content([Part(text="real"), Part(text="")]) == [{"text": "real"}]


def test_task_without_status_does_not_reset_observed_state():
    """A bare `task` snapshot with no status field must not overwrite an already-observed state.

    `task.status.state` reads as TASK_STATE_UNSPECIFIED (0) when `status` was never set, which
    is a real enum value rather than "no state" — extraction must gate on HasField("status").
    """
    status_event = StreamResponse(
        status_update=TaskStatusUpdateEvent(
            task_id="task-1", context_id="ctx-1", status=TaskStatus(state=TaskState.TASK_STATE_COMPLETED)
        )
    )
    task_without_status = StreamResponse(task=Task(id="task-1", context_id="ctx-1"))

    result = convert_responses_to_agent_result([status_event, task_without_status])

    assert result.state.get("a2a_task_state") == "completed"


# =========================================================================
# Lifecycle state mapping
# =========================================================================


@pytest.mark.parametrize(
    ("task_state", "expected_stop_reason", "expected_state_str"),
    [
        (TaskState.TASK_STATE_COMPLETED, "end_turn", "completed"),
        (TaskState.TASK_STATE_FAILED, "end_turn", "failed"),
        (TaskState.TASK_STATE_CANCELED, "end_turn", "canceled"),
        (TaskState.TASK_STATE_REJECTED, "end_turn", "rejected"),
        (TaskState.TASK_STATE_INPUT_REQUIRED, "interrupt", "input-required"),
        (TaskState.TASK_STATE_AUTH_REQUIRED, "interrupt", "auth-required"),
        (TaskState.TASK_STATE_WORKING, "end_turn", "working"),
        (TaskState.TASK_STATE_SUBMITTED, "end_turn", "submitted"),
        (TaskState.TASK_STATE_UNSPECIFIED, "end_turn", "unknown"),
    ],
)
def test_convert_response_state_mapping(task_state, expected_stop_reason, expected_state_str):
    """Test that each TaskState maps to the documented stop_reason and state string."""
    event = TaskStatusUpdateEvent(
        task_id="task-1",
        context_id="ctx-1",
        status=TaskStatus(state=task_state),
    )

    result = convert_responses_to_agent_result([StreamResponse(status_update=event)])

    assert result.stop_reason == expected_stop_reason
    assert result.state.get("a2a_task_state") == expected_state_str


def test_convert_response_no_events_yields_end_turn_and_no_state():
    """An empty response list defaults to end_turn with no a2a_task_state entry."""
    result = convert_responses_to_agent_result([])

    assert result.stop_reason == "end_turn"
    assert result.message["content"] == []
    assert "a2a_task_state" not in result.state


def test_extract_task_state_from_status_update():
    """Test _extract_task_state helper on a status_update response."""
    event = TaskStatusUpdateEvent(task_id="t", context_id="c", status=TaskStatus(state=TaskState.TASK_STATE_FAILED))

    state = _extract_task_state(StreamResponse(status_update=event))

    assert state == TaskState.TASK_STATE_FAILED


def test_extract_task_state_from_task():
    """Test _extract_task_state helper on a bare task response."""
    task = Task(id="t", context_id="c", status=TaskStatus(state=TaskState.TASK_STATE_SUBMITTED))

    state = _extract_task_state(StreamResponse(task=task))

    assert state == TaskState.TASK_STATE_SUBMITTED


def test_extract_task_state_from_message_returns_none():
    """Test _extract_task_state returns None for Message responses."""
    message = A2AMessage(message_id=uuid4().hex, role=Role.ROLE_AGENT, parts=[Part(text="hi")])

    state = _extract_task_state(StreamResponse(message=message))

    assert state is None


def test_extract_task_state_from_artifact_update_returns_none():
    """_extract_task_state returns None for artifact_update responses (they carry no state)."""
    event = TaskArtifactUpdateEvent(
        task_id="t", context_id="c", artifact=Artifact(artifact_id="a1", parts=[Part(text="x")])
    )

    state = _extract_task_state(StreamResponse(artifact_update=event))

    assert state is None


def test_task_with_no_artifacts_falls_back_to_status_message():
    """A Task whose answer lives in task.status.message (no artifacts) still produces content.

    Third-party A2A servers may reply with a completed Task carrying text only in
    task.status.message — the spec does not require artifacts.
    """
    task = Task(
        id="t1",
        context_id="c1",
        status=TaskStatus(
            state=TaskState.TASK_STATE_COMPLETED,
            message=A2AMessage(message_id=uuid4().hex, role=Role.ROLE_AGENT, parts=[Part(text="the answer")]),
        ),
    )

    result = convert_responses_to_agent_result([StreamResponse(task=task)])

    assert result.stop_reason == "end_turn"
    assert any(block.get("text") == "the answer" for block in result.message["content"])


def test_task_with_artifacts_ignores_status_message():
    """When a Task has artifacts, task.status.message is not used (artifacts take precedence)."""
    task = Task(
        id="t1",
        context_id="c1",
        status=TaskStatus(
            state=TaskState.TASK_STATE_COMPLETED,
            message=A2AMessage(message_id=uuid4().hex, role=Role.ROLE_AGENT, parts=[Part(text="status text")]),
        ),
        artifacts=[Artifact(artifact_id="a1", parts=[Part(text="artifact text")])],
    )

    result = convert_responses_to_agent_result([StreamResponse(task=task)])

    content_texts = [block["text"] for block in result.message["content"] if "text" in block]
    assert "artifact text" in content_texts
    assert "status text" not in content_texts


def test_state_to_stop_reason_covers_all_lifecycle_states():
    """Verify _STATE_TO_STOP_REASON has mappings for all documented lifecycle states.

    Guards against future additions to the a2a-sdk that we miss.
    """
    from strands.multiagent.a2a._converters import _STATE_TO_STOP_REASON

    # These are the states we explicitly handle
    expected_mapped = {
        TaskState.TASK_STATE_COMPLETED,
        TaskState.TASK_STATE_FAILED,
        TaskState.TASK_STATE_CANCELED,
        TaskState.TASK_STATE_REJECTED,
        TaskState.TASK_STATE_INPUT_REQUIRED,
        TaskState.TASK_STATE_AUTH_REQUIRED,
    }
    assert set(_STATE_TO_STOP_REASON.keys()) == expected_mapped

    # These should NOT be in the mapping (they're non-terminal progress states)
    assert TaskState.TASK_STATE_WORKING not in _STATE_TO_STOP_REASON
    assert TaskState.TASK_STATE_SUBMITTED not in _STATE_TO_STOP_REASON
    assert TaskState.TASK_STATE_UNSPECIFIED not in _STATE_TO_STOP_REASON
