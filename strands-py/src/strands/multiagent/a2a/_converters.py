"""Conversion functions between Strands and A2A types."""

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import cast
from uuid import uuid4

from a2a.types import Message as A2AMessage
from a2a.types import Part, Role, TaskArtifactUpdateEvent, TaskState, TaskStatus

from ...agent.agent_result import AgentResult
from ...telemetry.metrics import EventLoopMetrics
from ...types.a2a import A2AResponse
from ...types.agent import AgentInput
from ...types.content import ContentBlock, Message
from ...types.event_loop import StopReason

# Mapping from A2A TaskState to Strands stop_reason
_STATE_TO_STOP_REASON: dict[TaskState, StopReason] = {
    TaskState.TASK_STATE_COMPLETED: "end_turn",
    TaskState.TASK_STATE_FAILED: "end_turn",
    TaskState.TASK_STATE_CANCELED: "end_turn",
    TaskState.TASK_STATE_REJECTED: "end_turn",
    TaskState.TASK_STATE_INPUT_REQUIRED: "interrupt",
    TaskState.TASK_STATE_AUTH_REQUIRED: "interrupt",
}


def _task_state_to_str(task_state: TaskState) -> str:
    """Render a TaskState as the kebab-case string stored in ``AgentResult.state["a2a_task_state"]``.

    TaskState's protobuf enum names are SCREAMING_SNAKE_CASE (e.g. ``TASK_STATE_INPUT_REQUIRED``);
    this renders the kebab-case form (e.g. ``"input-required"``) that existing Strands callers expect.
    """
    if task_state == TaskState.TASK_STATE_UNSPECIFIED:
        return "unknown"
    name: str = TaskState.Name(task_state)  # type: ignore[attr-defined]
    return name.removeprefix("TASK_STATE_").lower().replace("_", "-")


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
            role=Role.ROLE_USER,
            parts=[Part(text=prompt)],
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
                        role=Role.ROLE_USER,
                        parts=parts,
                        message_id=message_id,
                    )
        else:
            parts = convert_content_blocks_to_parts(prompt)
            return A2AMessage(
                role=Role.ROLE_USER,
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
            parts.append(Part(text=block["text"]))
    return parts


def _extract_task_state(response: A2AResponse) -> TaskState | None:
    """Extract the task state carried by a single A2A StreamResponse, if any.

    Args:
        response: A single StreamResponse from the A2A event stream.

    Returns:
        The TaskState if this response carries one (a ``task`` or ``status_update``), else None.
    """
    if response.HasField("status_update"):
        return response.status_update.status.state
    if response.HasField("task") and response.task.HasField("status"):
        return response.task.status.state
    return None


def _parts_to_content(parts: Sequence[Part]) -> list[ContentBlock]:
    """Convert a sequence of A2A text Parts into Strands ContentBlocks.

    Drops non-text parts and empty-text parts (the latter appear as a content-less
    ``last_chunk`` marker on compliant-streaming artifact updates).
    """
    return [{"text": part.text} for part in parts if part.HasField("text") and part.text]


@dataclass
class _ResponseAccumulator:
    """Accumulates content and task state across a full A2A StreamResponse sequence.

    See ``convert_responses_to_agent_result`` for the content precedence this implements.
    """

    artifact_parts: dict[str, list[ContentBlock]] = field(default_factory=dict)
    artifact_order: list[str] = field(default_factory=list)
    terminal_message_content: list[ContentBlock] = field(default_factory=list)
    narration_content: list[ContentBlock] = field(default_factory=list)
    task_content: list[ContentBlock] = field(default_factory=list)
    message_content: list[ContentBlock] = field(default_factory=list)
    task_state: TaskState | None = None

    def ingest(self, response: A2AResponse) -> None:
        """Fold one StreamResponse event into the accumulated content and task state."""
        state = _extract_task_state(response)
        if state is not None:
            self.task_state = state

        if response.HasField("artifact_update"):
            self._ingest_artifact_update(response.artifact_update)
        elif response.HasField("status_update"):
            self._ingest_status_update(response.status_update.status)
        elif response.HasField("task"):
            self.task_content = [
                content for artifact in response.task.artifacts for content in _parts_to_content(artifact.parts)
            ]
            if not self.task_content and response.task.HasField("status") and response.task.status.HasField("message"):
                self.task_content = _parts_to_content(response.task.status.message.parts)
        elif response.HasField("message"):
            self.message_content = _parts_to_content(response.message.parts)

    def _ingest_artifact_update(self, update: TaskArtifactUpdateEvent) -> None:
        """Fold one artifact_update event, honoring ``append`` (A2A: false/unset replaces)."""
        artifact_id = update.artifact.artifact_id
        parts_content = _parts_to_content(update.artifact.parts)
        if artifact_id not in self.artifact_parts:
            self.artifact_parts[artifact_id] = []
            self.artifact_order.append(artifact_id)
        if update.append:
            self.artifact_parts[artifact_id].extend(parts_content)
        else:
            self.artifact_parts[artifact_id] = parts_content

    def _ingest_status_update(self, status: TaskStatus) -> None:
        """Route a status_update's message: a terminal state carries actionable text, else narration."""
        if not status.HasField("message"):
            return
        parts_content = _parts_to_content(status.message.parts)
        if status.state in _STATE_TO_STOP_REASON:
            self.terminal_message_content = parts_content
        else:
            self.narration_content = parts_content

    @property
    def artifact_content(self) -> list[ContentBlock]:
        """Accumulated artifact content across all artifact ids, in first-seen order."""
        return [content for artifact_id in self.artifact_order for content in self.artifact_parts[artifact_id]]

    @property
    def content(self) -> list[ContentBlock]:
        """The final content for the AgentResult, per the precedence documented on the caller."""
        artifact_content = self.artifact_content
        if artifact_content or self.terminal_message_content:
            return artifact_content + self.terminal_message_content
        return self.narration_content or self.task_content or self.message_content


def convert_responses_to_agent_result(responses: Sequence[A2AResponse]) -> AgentResult:
    """Convert the full sequence of A2A StreamResponse events from one call into an AgentResult.

    Each StreamResponse carries at most one of ``task`` | ``message`` | ``status_update`` |
    ``artifact_update``, and no single event is guaranteed to carry the final content by itself, so
    content is reconstructed across the whole stream:
    - ``artifact_update`` parts accumulate per ``artifact_id``, honoring the event's ``append``
      flag (A2A schema: unset/false replaces that artifact's accumulated parts, true appends to
      them), so a peer that re-sends a cumulative artifact each turn doesn't duplicate content.
    - a terminal ``status_update`` message (one whose state is in ``_STATE_TO_STOP_REASON``,
      e.g. input_required or failed) is appended after any artifact content, since it carries
      the actionable text (an approval prompt, a failure reason) rather than duplicating it.
    - a non-terminal ``status_update`` message is progress narration and is only used as a
      fallback when no artifact or terminal-status content was found.
    - a bare ``task`` or ``message`` response (no separate update events) supplies content
      directly.

    Maps A2A task lifecycle states to appropriate Strands stop_reasons:
    - completed → end_turn
    - failed → end_turn (with error content)
    - canceled → end_turn (with cancellation info)
    - rejected → end_turn (with rejection info)
    - input_required → interrupt (agent needs user input)
    - auth_required → interrupt (agent needs authentication)

    Args:
        responses: All StreamResponse events observed for one ``send_message`` call, in order.

    Returns:
        AgentResult with extracted content and metadata.
    """
    accumulator = _ResponseAccumulator()
    for response in responses:
        accumulator.ingest(response)

    task_state = accumulator.task_state
    stop_reason: StopReason = (
        _STATE_TO_STOP_REASON.get(task_state, "end_turn") if task_state is not None else "end_turn"
    )

    message: Message = {
        "role": "assistant",
        "content": accumulator.content,
    }

    # Build state dict with A2A metadata
    state_dict: dict[str, str] = {}
    if task_state is not None:
        state_dict["a2a_task_state"] = _task_state_to_str(task_state)

    return AgentResult(
        stop_reason=stop_reason,
        message=message,
        metrics=EventLoopMetrics(),
        state=state_dict,
    )
