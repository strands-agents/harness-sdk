"""Output event types for bidirectional streaming.

Defines the provider-agnostic events produced by bidirectional models and ``BidiAgent``:
connection lifecycle (start, restart, warning, stop), response start and stop, audio, text,
reasoning, and transcript streams (start, delta, stop, and the completed block), barge-in,
token usage, and tool-use groups. Also defines the ``AudioChannel``, ``AudioFormat``, and
``Role`` literals and the ``BidiOutputEvent`` union.
"""

import logging
from typing import TYPE_CHECKING, Any, Literal, cast, get_args

from ...types._events import TypedEvent
from ...types.tools import ToolUse

if TYPE_CHECKING:
    from ..models.model import ConnectionTimeoutError

logger = logging.getLogger(__name__)

AudioChannel = Literal[1, 2]
"""Number of audio channels.

- Mono: 1
- Stereo: 2
"""
AudioFormat = Literal["pcm", "wav", "opus", "mp3"]
"""Audio encoding format of model audio output and ``AudioStreamConfig``.

Distinct from ``strands.types.media.AudioFormat``, the wider set of formats that types
``AudioDelta.format`` on audio input.
"""

Role = Literal["user", "assistant"]
"""Role of a message sender.

- "user": Messages from the user to the assistant.
- "assistant": Messages from the assistant to the user.
"""

_VALID_ROLES: tuple[str, ...] = get_args(Role)


def _normalize_role(role: Any, default: Role = "user") -> Role:
    """Normalize a role value to a supported `Role`.

    Provider outputs and transcript events may carry role values in arbitrary
    casing or outside the supported set. This trims surrounding whitespace,
    coerces the value to lowercase, and falls back to `default` when it is not
    one of the supported roles, so that messages persisted to the conversation
    always carry a valid role.

    The default is the lowest-trust role (`"user"`): unknown or spoofed role
    values are never attributed to the assistant. Legitimate assistant output
    passes an explicit `role="assistant"`, which the allowlist accepts verbatim.

    Args:
        role: The incoming role value (any type).
        default: Role to use when the value is missing or unsupported.

    Returns:
        A role guaranteed to be one of the supported `Role` values.
    """
    normalized = role.strip().lower() if isinstance(role, str) else None
    if normalized not in _VALID_ROLES:
        logger.debug("role=<%s>, default=<%s> | coercing unsupported transcript role", role, default)
        return default
    return cast(Role, normalized)


class BidiConnectionStartEvent(TypedEvent):
    """Streaming connection established and ready for interaction.

    Args:
        connection_id: Unique identifier for this streaming connection.
        model: Model identifier (e.g., "gpt-realtime-2.1", "gemini-3.8-live").
    """

    def __init__(self, connection_id: str, model: str):
        """Initialize connection start event."""
        super().__init__(
            {
                "type": "bidi_connection_start",
                "connection_id": connection_id,
                "model": model,
            }
        )

    @property
    def connection_id(self) -> str:
        """Unique identifier for this streaming connection."""
        return cast(str, self["connection_id"])

    @property
    def model(self) -> str:
        """Model identifier (e.g., 'gpt-realtime-2.1', 'gemini-3.8-live')."""
        return cast(str, self["model"])


class BidiConnectionRestartEvent(TypedEvent):
    """Agent is restarting the model connection.

    Emitted on both restart paths: reactively after the model reports a timeout, and
    proactively when the restart timer fires ahead of the provider's limit.

    Args:
        reason: What triggered the restart ("timeout" reactively, "scheduled" proactively).
        timeout_error: The model's timeout error on the reactive path; None when scheduled.
        turn_interrupted: True if the restart cut off an in-progress assistant response or a
            user turn that had not been answered yet. The new connection receives the history
            as context, so that turn is not answered on its own; an app can re-prompt or notify
            the user when this is set.
    """

    def __init__(
        self,
        reason: Literal["timeout", "scheduled"],
        timeout_error: "ConnectionTimeoutError | None" = None,
        turn_interrupted: bool = False,
    ):
        """Initialize connection restart event."""
        super().__init__(
            {
                "type": "bidi_connection_restart",
                "reason": reason,
                "timeout_error": timeout_error,
                "turn_interrupted": turn_interrupted,
            }
        )

    @property
    def reason(self) -> Literal["timeout", "scheduled"]:
        """What triggered the restart ("timeout" or "scheduled")."""
        return cast(Literal["timeout", "scheduled"], self["reason"])

    @property
    def timeout_error(self) -> "ConnectionTimeoutError | None":
        """Connection timeout error on the reactive path; None when scheduled."""
        return cast("ConnectionTimeoutError | None", self["timeout_error"])

    @property
    def turn_interrupted(self) -> bool:
        """True if the restart cut off an in-progress response or an unanswered user turn."""
        return cast(bool, self["turn_interrupted"])


class BidiConnectionWarningEvent(TypedEvent):
    """Agent is approaching a proactive restart.

    Emitted by the proactive restart timer before a restart; informational only.

    Args:
        time_left_s: Approximate seconds until the scheduled restart.
    """

    def __init__(self, time_left_s: float):
        """Initialize connection warning event."""
        super().__init__(
            {
                "type": "bidi_connection_warning",
                "time_left_s": time_left_s,
            }
        )

    @property
    def time_left_s(self) -> float:
        """Approximate seconds until the scheduled restart."""
        return cast(float, self["time_left_s"])


class BidiResponseStartEvent(TypedEvent):
    """Start of a model response.

    Args:
        response_id: Unique identifier for this response (used in BidiResponseStopEvent).
    """

    def __init__(self, response_id: str):
        """Initialize response start event."""
        super().__init__({"type": "bidi_response_start", "response_id": response_id})

    @property
    def response_id(self) -> str:
        """Unique identifier for this response."""
        return cast(str, self["response_id"])


class BidiAudioStartEvent(TypedEvent):
    """Beginning of an assistant audio stream, identified by ``content_id``."""

    def __init__(self, content_id: str) -> None:
        """Initialize audio start event."""
        super().__init__({"type": "bidi_audio_start", "content_id": content_id})

    @property
    def content_id(self) -> str:
        """Identifier shared by this audio stream's events."""
        return cast(str, self["content_id"])


class BidiAudioDeltaEvent(TypedEvent):
    """Incremental audio output from the model.

    Args:
        audio: Base64-encoded audio chunk.
        format: Audio encoding format.
        sample_rate: Number of audio samples per second in Hz.
        channels: Number of audio channels (1=mono, 2=stereo).
        content_id: Unique identifier shared by this audio stream's events.
    """

    def __init__(
        self,
        audio: str,
        format: AudioFormat,
        sample_rate: int,
        channels: AudioChannel,
        content_id: str,
    ):
        """Initialize audio delta event."""
        super().__init__(
            {
                "type": "bidi_audio_delta",
                "audio": audio,
                "format": format,
                "sample_rate": sample_rate,
                "channels": channels,
                "content_id": content_id,
            }
        )

    @property
    def content_id(self) -> str:
        """Identifier shared by this audio stream's events."""
        return cast(str, self["content_id"])

    @property
    def audio(self) -> str:
        """Base64-encoded audio chunk."""
        return cast(str, self["audio"])

    @property
    def format(self) -> AudioFormat:
        """Audio encoding format."""
        return cast(AudioFormat, self["format"])

    @property
    def sample_rate(self) -> int:
        """Number of audio samples per second in Hz."""
        return cast(int, self["sample_rate"])

    @property
    def channels(self) -> AudioChannel:
        """Number of audio channels (1=mono, 2=stereo)."""
        return cast(AudioChannel, self["channels"])


class BidiAudioStopEvent(TypedEvent):
    """End of an assistant audio stream, which may still be playing."""

    def __init__(self, content_id: str) -> None:
        """Initialize audio stop event."""
        super().__init__({"type": "bidi_audio_stop", "content_id": content_id})

    @property
    def content_id(self) -> str:
        """Identifier shared by this audio stream's events."""
        return cast(str, self["content_id"])


class BidiTextStartEvent(TypedEvent):
    """Beginning of assistant text output, identified by ``content_id``."""

    def __init__(self, content_id: str):
        """Initialize text start event."""
        super().__init__({"type": "bidi_text_start", "content_id": content_id})

    @property
    def content_id(self) -> str:
        """Identifier shared by this text block's events."""
        return cast(str, self["content_id"])


class BidiTextDeltaEvent(TypedEvent):
    """Incremental assistant text output, separate from speech transcripts."""

    def __init__(self, delta: str, content_id: str):
        """Initialize text delta event."""
        super().__init__({"type": "bidi_text_delta", "delta": delta, "content_id": content_id})

    @property
    def content_id(self) -> str:
        """Identifier shared by this text block's events."""
        return cast(str, self["content_id"])

    @property
    def delta(self) -> str:
        """Incremental text."""
        return cast(str, self["delta"])


class BidiTextStopEvent(TypedEvent):
    """End of an assistant text stream, before its completed block is emitted."""

    def __init__(self, content_id: str):
        """Initialize text stop event."""
        super().__init__({"type": "bidi_text_stop", "content_id": content_id})

    @property
    def content_id(self) -> str:
        """Identifier shared by this text block's events."""
        return cast(str, self["content_id"])


class BidiTextBlockEvent(TypedEvent):
    """Complete assistant text, emitted after its stop event by the agent."""

    def __init__(self, text: str, content_id: str):
        """Initialize text block event."""
        super().__init__({"type": "bidi_text_block", "text": text, "content_id": content_id})

    @property
    def content_id(self) -> str:
        """Identifier shared by this text block's events."""
        return cast(str, self["content_id"])

    @property
    def text(self) -> str:
        """Complete text."""
        return cast(str, self["text"])


class BidiReasoningStartEvent(TypedEvent):
    """Beginning of model-provided reasoning text, identified by ``content_id``."""

    def __init__(self, content_id: str):
        """Initialize reasoning start event."""
        super().__init__({"type": "bidi_reasoning_start", "content_id": content_id})

    @property
    def content_id(self) -> str:
        """Identifier shared by this reasoning block's events."""
        return cast(str, self["content_id"])


class BidiReasoningDeltaEvent(TypedEvent):
    """Incremental reasoning text or thought summary exposed by the model."""

    def __init__(self, delta: str, content_id: str):
        """Initialize reasoning delta event."""
        super().__init__({"type": "bidi_reasoning_delta", "delta": delta, "content_id": content_id})

    @property
    def content_id(self) -> str:
        """Identifier shared by this reasoning block's events."""
        return cast(str, self["content_id"])

    @property
    def delta(self) -> str:
        """Incremental reasoning text."""
        return cast(str, self["delta"])


class BidiReasoningStopEvent(TypedEvent):
    """End of a reasoning stream, before its completed block is emitted."""

    def __init__(self, content_id: str):
        """Initialize reasoning stop event."""
        super().__init__({"type": "bidi_reasoning_stop", "content_id": content_id})

    @property
    def content_id(self) -> str:
        """Identifier shared by this reasoning block's events."""
        return cast(str, self["content_id"])


class BidiReasoningBlockEvent(TypedEvent):
    """Complete reasoning text, emitted after its stop event by the agent."""

    def __init__(self, text: str, content_id: str):
        """Initialize reasoning block event."""
        super().__init__({"type": "bidi_reasoning_block", "text": text, "content_id": content_id})

    @property
    def content_id(self) -> str:
        """Identifier shared by this reasoning block's events."""
        return cast(str, self["content_id"])

    @property
    def text(self) -> str:
        """Complete reasoning text or thought summary."""
        return cast(str, self["text"])


class BidiTranscriptStartEvent(TypedEvent):
    """Beginning of a user or assistant transcript, before its text arrives.

    Args:
        role: Who is speaking ("user" or "assistant").
        content_id: Unique identifier shared by this transcript's events.
    """

    def __init__(self, role: Role, content_id: str):
        """Initialize transcript start event."""
        super().__init__(
            {
                "type": "bidi_transcript_start",
                "role": _normalize_role(role, default="user"),
                "content_id": content_id,
            }
        )

    @property
    def content_id(self) -> str:
        """Identifier shared by this transcript's events."""
        return cast(str, self["content_id"])

    @property
    def role(self) -> Role:
        """The role of the speaker."""
        return cast(Role, self["role"])


class BidiTranscriptDeltaEvent(TypedEvent):
    """Incremental transcription of user or assistant speech.

    Args:
        delta: The incremental transcript text.
        role: Who is speaking ("user" or "assistant").
        content_id: Unique identifier shared by this transcript's events.
    """

    def __init__(self, delta: str, role: Role, content_id: str):
        """Initialize transcript delta event."""
        super().__init__(
            {
                "type": "bidi_transcript_delta",
                "delta": delta,
                "role": _normalize_role(role, default="user"),
                "content_id": content_id,
            }
        )

    @property
    def content_id(self) -> str:
        """Identifier shared by this transcript's events."""
        return cast(str, self["content_id"])

    @property
    def delta(self) -> str:
        """The incremental transcript text."""
        return cast(str, self["delta"])

    @property
    def role(self) -> Role:
        """The role of the message sender."""
        return cast(Role, self["role"])


class BidiTranscriptStopEvent(TypedEvent):
    """End of a transcript stream, before its completed block is emitted.

    Args:
        role: Who spoke ("user" or "assistant").
        content_id: Unique identifier shared by this transcript's events.
    """

    def __init__(self, role: Role, content_id: str):
        """Initialize transcript stop event."""
        super().__init__(
            {
                "type": "bidi_transcript_stop",
                "role": _normalize_role(role, default="user"),
                "content_id": content_id,
            }
        )

    @property
    def content_id(self) -> str:
        """Identifier shared by this transcript's events."""
        return cast(str, self["content_id"])

    @property
    def role(self) -> Role:
        """The role of the speaker."""
        return cast(Role, self["role"])


class BidiTranscriptBlockEvent(TypedEvent):
    """Complete transcript, emitted after its stop event by the agent.

    Args:
        transcript: The final transcript text.
        role: Who spoke ("user" or "assistant").
        content_id: Unique identifier shared by this transcript's events.
    """

    def __init__(self, transcript: str, role: Role, content_id: str):
        """Initialize transcript block event."""
        super().__init__(
            {
                "type": "bidi_transcript_block",
                "transcript": transcript,
                "role": _normalize_role(role, default="user"),
                "content_id": content_id,
            }
        )

    @property
    def content_id(self) -> str:
        """Identifier shared by this transcript's events."""
        return cast(str, self["content_id"])

    @property
    def transcript(self) -> str:
        """The final transcript text."""
        return cast(str, self["transcript"])

    @property
    def role(self) -> Role:
        """The role of the speaker."""
        return cast(Role, self["role"])


class BidiBargeInEvent(TypedEvent):
    """Stop current response generation or playback while the session continues."""

    def __init__(self) -> None:
        """Initialize barge-in event."""
        super().__init__({"type": "bidi_barge_in"})


class BidiResponseStopEvent(TypedEvent):
    """Response output ended. User transcription may still be pending.

    Args:
        response_id: ID of the response that ended (matches BidiResponseStartEvent).
    """

    def __init__(self, response_id: str):
        """Initialize response stop event."""
        super().__init__(
            {
                "type": "bidi_response_stop",
                "response_id": response_id,
            }
        )

    @property
    def response_id(self) -> str:
        """Unique identifier for this response."""
        return cast(str, self["response_id"])


class ModalityUsage(dict):
    """Token usage for a specific modality.

    Attributes:
        modality: Type of content.
        input_tokens: Tokens used for this modality's input.
        output_tokens: Tokens used for this modality's output.
    """

    modality: Literal["text", "audio", "image", "cached"]
    input_tokens: int
    output_tokens: int


class BidiUsageEvent(TypedEvent):
    """Token usage event with modality breakdown for bidirectional streaming.

    Tracks token consumption across different modalities (audio, text, images)
    during bidirectional streaming sessions.

    Args:
        input_tokens: Total tokens used for all input modalities.
        output_tokens: Total tokens used for all output modalities.
        total_tokens: Sum of input and output tokens.
        modality_details: Optional list of token usage per modality.
        cache_read_input_tokens: Optional tokens read from cache.
        cache_write_input_tokens: Optional tokens written to cache.
    """

    def __init__(
        self,
        input_tokens: int,
        output_tokens: int,
        total_tokens: int,
        modality_details: list[ModalityUsage] | None = None,
        cache_read_input_tokens: int | None = None,
        cache_write_input_tokens: int | None = None,
    ):
        """Initialize usage event."""
        data: dict[str, Any] = {
            "type": "bidi_usage",
            "inputTokens": input_tokens,
            "outputTokens": output_tokens,
            "totalTokens": total_tokens,
        }
        if modality_details is not None:
            data["modality_details"] = modality_details
        if cache_read_input_tokens is not None:
            data["cacheReadInputTokens"] = cache_read_input_tokens
        if cache_write_input_tokens is not None:
            data["cacheWriteInputTokens"] = cache_write_input_tokens
        super().__init__(data)

    @property
    def input_tokens(self) -> int:
        """Total tokens used for all input modalities."""
        return cast(int, self["inputTokens"])

    @property
    def output_tokens(self) -> int:
        """Total tokens used for all output modalities."""
        return cast(int, self["outputTokens"])

    @property
    def total_tokens(self) -> int:
        """Sum of input and output tokens."""
        return cast(int, self["totalTokens"])

    @property
    def modality_details(self) -> list[ModalityUsage]:
        """Optional list of token usage per modality."""
        return cast(list[ModalityUsage], self.get("modality_details", []))

    @property
    def cache_read_input_tokens(self) -> int | None:
        """Optional tokens read from cache."""
        return cast(int | None, self.get("cacheReadInputTokens"))

    @property
    def cache_write_input_tokens(self) -> int | None:
        """Optional tokens written to cache."""
        return cast(int | None, self.get("cacheWriteInputTokens"))


class BidiToolUseBlocksEvent(TypedEvent):
    """A complete group of tool calls requested by the model.

    Args:
        tool_uses: Tool calls to execute together.
    """

    def __init__(self, tool_uses: list[ToolUse]):
        """Initialize a tool-use group."""
        super().__init__({"type": "bidi_tool_use_blocks", "tool_uses": tool_uses})

    @property
    def tool_uses(self) -> list[ToolUse]:
        """Tool calls in provider order."""
        return cast(list[ToolUse], self["tool_uses"])


class BidiConnectionStopEvent(TypedEvent):
    """Streaming connection closed.

    Args:
        connection_id: Unique identifier for this streaming connection (matches BidiConnectionStartEvent).
        reason: Why the connection was closed. ``"user_request"`` after ``agent.cancel()`` takes effect.
    """

    def __init__(
        self,
        connection_id: str,
        reason: Literal["user_request"],
    ):
        """Initialize connection stop event."""
        super().__init__(
            {
                "type": "bidi_connection_stop",
                "connection_id": connection_id,
                "reason": reason,
            }
        )

    @property
    def connection_id(self) -> str:
        """Unique identifier for this streaming connection."""
        return cast(str, self["connection_id"])

    @property
    def reason(self) -> Literal["user_request"]:
        """Why the connection was closed."""
        return cast(Literal["user_request"], self["reason"])


# ============================================================================
# Type Unions
# ============================================================================

BidiOutputEvent = (
    BidiConnectionStartEvent
    | BidiConnectionRestartEvent
    | BidiConnectionWarningEvent
    | BidiResponseStartEvent
    | BidiAudioStartEvent
    | BidiAudioDeltaEvent
    | BidiAudioStopEvent
    | BidiTextStartEvent
    | BidiTextDeltaEvent
    | BidiTextStopEvent
    | BidiTextBlockEvent
    | BidiReasoningStartEvent
    | BidiReasoningDeltaEvent
    | BidiReasoningStopEvent
    | BidiReasoningBlockEvent
    | BidiTranscriptStartEvent
    | BidiTranscriptDeltaEvent
    | BidiTranscriptStopEvent
    | BidiTranscriptBlockEvent
    | BidiBargeInEvent
    | BidiResponseStopEvent
    | BidiUsageEvent
    | BidiConnectionStopEvent
    | BidiToolUseBlocksEvent
)
"""Union of different bidi output event types."""
