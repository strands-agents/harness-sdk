"""Conversion functions between Strands and A2A types."""

from typing import cast
from uuid import uuid4

from a2a.types import Message as A2AMessage
from a2a.types import Part, Role, TaskArtifactUpdateEvent, TaskState, TaskStatusUpdateEvent, TextPart

from ...agent.agent_result import AgentResult
from ...telemetry.metrics import EventLoopMetrics
from ...types.a2a import A2AResponse
from ...types.agent import AgentInput
from ...types.content import ContentBlock, Message
from ...types.event_loop import StopReason

# Mapping from A2A TaskState to Strands stop_reason
_STATE_TO_STOP_REASON: dict[TaskState, StopReason] = {
    TaskState.completed: "end_turn",
    TaskState.failed: "end_turn",
    TaskState.canceled: "end_turn",
    TaskState.rejected: "end_turn",
    TaskState.input_required: "interrupt",
    TaskState.auth_required: "interrupt",
}


def convert_input_to_message(prompt: AgentInput) -> A2AMessage:
    """Convert AgentInput to A2A Message.

    Args:
        prompt: Input in various formats (string, message list, or content blocks).

    Returns:
        A2AMessage ready to send to the remote agent.

    Raises:
        ValueError: If prompt format is unsupported.
    """
    message_id = uuid4().hex

    if isinstance(prompt, str):
        return A2AMessage(
            kind="message",
            role=Role.user,
            parts=[Part(TextPart(kind="text", text=prompt))],
            message_id=message_id,
        )

    if isinstance(prompt, list) and prompt and (isinstance(prompt[0], dict)):
        # Check for interrupt responses - not supported in A2A
        if "interruptResponse" in prompt[0]:
            raise ValueError("InterruptResponseContent is not supported for A2AAgent")

        if "role" in prompt[0]:
            for msg in reversed(prompt):
                if msg.get("role") == "user":
                    content = cast(list[ContentBlock], msg.get("content", []))
                    parts = convert_content_blocks_to_parts(content)
                    return A2AMessage(
                        kind="message",
                        role=Role.user,
                        parts=parts,
                        message_id=message_id,
                    )
        else:
            parts = convert_content_blocks_to_parts(prompt)
            return A2AMessage(
                kind="message",
                role=Role.user,
                parts=parts,
                message_id=message_id,
            )

    raise ValueError(f"Unsupported input type: {type(prompt)}")


def convert_content_blocks_to_parts(content_blocks: list[ContentBlock]) -> list[Part]:
    """Convert Strands ContentBlocks to A2A Parts.

    Args:
        content_blocks: List of Strands content blocks.

    Returns:
        List of A2A Part objects.
    """
    parts = []
    for block in content_blocks:
        if "text" in block:
            parts.append(Part(TextPart(kind="text", text=block["text"])))
    return parts


def _extract_text_parts(parts: list[Part]) -> list[ContentBlock]:
    """Extract text content blocks from A2A parts.

    Args:
        parts: List of A2A Part objects.

    Returns:
        List of ContentBlock dicts for each text part found.
    """
    content: list[ContentBlock] = []
    for part in parts:
        if hasattr(part, "root") and hasattr(part.root, "text"):
            content.append({"text": part.root.text})
    return content


def _extract_task_state(response: A2AResponse) -> TaskState | None:
    """Extract the task state from an A2A response.

    Args:
        response: A2A response (either A2AMessage or tuple of task and update event).

    Returns:
        The TaskState if available, None otherwise.
    """
    if isinstance(response, tuple) and len(response) == 2:
        _task, update_event = response
        if isinstance(update_event, TaskStatusUpdateEvent):
            if update_event.status and hasattr(update_event.status, "state"):
                return update_event.status.state
    return None


def convert_response_to_agent_result(response: A2AResponse) -> AgentResult:
    """Convert A2A response to AgentResult.

    Maps A2A task lifecycle states to appropriate Strands stop_reasons:
    - completed → end_turn
    - failed → end_turn (with error content)
    - canceled → end_turn (with cancellation info)
    - rejected → end_turn (with rejection info)
    - input_required → interrupt (agent needs user input)
    - auth_required → interrupt (agent needs authentication)

    Args:
        response: A2A response (either A2AMessage or tuple of task and update event).

    Returns:
        AgentResult with extracted content and metadata.
    """
    content: list[ContentBlock] = []
    task_state = _extract_task_state(response)
    stop_reason: StopReason = _STATE_TO_STOP_REASON.get(task_state, "end_turn") if task_state else "end_turn"

    if isinstance(response, tuple) and len(response) == 2:
        task, update_event = response

        # Handle artifact updates
        if isinstance(update_event, TaskArtifactUpdateEvent):
            if update_event.artifact and hasattr(update_event.artifact, "parts") and update_event.artifact.parts:
                content.extend(_extract_text_parts(update_event.artifact.parts))
        # Handle status updates with messages
        elif isinstance(update_event, TaskStatusUpdateEvent):
            if (
                update_event.status
                and hasattr(update_event.status, "message")
                and update_event.status.message
                and update_event.status.message.parts
            ):
                content.extend(_extract_text_parts(update_event.status.message.parts))

        # Use task.artifacts when no content was extracted from the event
        if not content and task and hasattr(task, "artifacts") and task.artifacts is not None:
            for artifact in task.artifacts:
                if hasattr(artifact, "parts") and artifact.parts:
                    content.extend(_extract_text_parts(artifact.parts))

        # Use task.status.message when no content was extracted from artifacts
        if (
            not content
            and task
            and hasattr(task, "status")
            and task.status
            and hasattr(task.status, "message")
            and task.status.message
            and task.status.message.parts
        ):
            content.extend(_extract_text_parts(task.status.message.parts))
    elif isinstance(response, A2AMessage):
        content.extend(_extract_text_parts(response.parts))

    message: Message = {
        "role": "assistant",
        "content": content,
    }

    # Build state dict with A2A metadata
    state: dict[str, str] = {}
    if task_state is not None:
        state["a2a_task_state"] = task_state.value

    return AgentResult(
        stop_reason=stop_reason,
        message=message,
        metrics=EventLoopMetrics(),
        state=state,
    )
