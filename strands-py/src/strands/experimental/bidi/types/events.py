"""Bidirectional streaming types for real-time audio/text conversations.

Type definitions for bidirectional streaming that extends Strands' existing streaming
capabilities with real-time audio and persistent connection support.

Key features:

- Audio input/output events with standardized formats
- Interruption detection and handling
- Connection lifecycle management
- Provider-agnostic event types
- Type-safe discriminated unions with TypedEvent
- JSON-serializable events (audio/images stored as base64 strings)

Audio format normalization:

- Supports PCM, WAV, Opus, and MP3 formats
- Standardizes sample rates (16kHz, 24kHz, 48kHz)
- Normalizes channel configurations (mono/stereo)
- Abstracts provider-specific encodings
- Audio data stored as base64-encoded strings for JSON compatibility
"""

import logging
from typing import TYPE_CHECKING, Any, Literal, cast, get_args

from ....types._events import ToolUseStreamEvent, TypedEvent

if TYPE_CHECKING:
    from ..models.model import BidiModelTimeoutError

logger = logging.getLogger(__name__)

AudioChannel = Literal[1, 2]
"""Number of audio channels.

- Mono: 1
- Stereo: 2
"""
AudioFormat = Literal["pcm", "wav", "opus", "mp3"]
"""Audio encoding format."""
AudioSampleRate = Literal[8000, 16000, 24000, 48000]
"""Audio sample rate in Hz."""

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


StopReason = Literal["complete", "error", "interrupted", "tool_use"]
"""Reason for the model ending its response generation.

- "complete": Model completed its response.
- "error": Model encountered an error.
- "interrupted": Model was interrupted by the user.
- "tool_use": Model is requesting a tool use.
"""

# ============================================================================
# Input Events (sent via agent.send())
# ============================================================================


class BidiTextInputEvent(TypedEvent):
    """Text input event for sending text to the model.

    Used for sending text content through the send() method.

    Parameters:
        text: The text content to send to the model.
        role: The role of the message sender (default: "user").
    """

    def __init__(self, text: str, role: Role = "user"):
        """Initialize text input event."""
        super().__init__(
            {
                "type": "bidi_text_input",
                "text": text,
                "role": role,
            }
        )

    @property
    def text(self) -> str:
        """The text content to send to the model."""
        return cast(str, self["text"])

    @property
    def role(self) -> Role:
        """The role of the message sender."""
        return cast(Role, self["role"])


class BidiAudioInputEvent(TypedEvent):
    """Audio input event for sending audio to the model.

    Used for sending audio data through the send() method.

    Parameters:
        audio: Base64-encoded audio string to send to model.
        format: Audio format from SUPPORTED_AUDIO_FORMATS.
        sample_rate: Sample rate from SUPPORTED_SAMPLE_RATES.
        channels: Channel count from SUPPORTED_CHANNELS.
    """

    def __init__(
        self,
        audio: str,
        format: AudioFormat | str,
        sample_rate: AudioSampleRate,
        channels: AudioChannel,
    ):
        """Initialize audio input event."""
        super().__init__(
            {
                "type": "bidi_audio_input",
                "audio": audio,
                "format": format,
                "sample_rate": sample_rate,
                "channels": channels,
            }
        )

    @property
    def audio(self) -> str:
        """Base64-encoded audio string."""
        return cast(str, self["audio"])

    @property
    def format(self) -> AudioFormat:
        """Audio encoding format."""
        return cast(AudioFormat, self["format"])

    @property
    def sample_rate(self) -> AudioSampleRate:
        """Number of audio samples per second in Hz."""
        return cast(AudioSampleRate, self["sample_rate"])

    @property
    def channels(self) -> AudioChannel:
        """Number of audio channels (1=mono, 2=stereo)."""
        return cast(AudioChannel, self["channels"])


class BidiImageInputEvent(TypedEvent):
    """Image input event for sending images/video frames to the model.

    Used for sending image data through the send() method.

    Parameters:
        image: Base64-encoded image string.
        mime_type: MIME type (e.g., "image/jpeg", "image/png").
    """

    def __init__(
        self,
        image: str,
        mime_type: str,
    ):
        """Initialize image input event."""
        super().__init__(
            {
                "type": "bidi_image_input",
                "image": image,
                "mime_type": mime_type,
            }
        )

    @property
    def image(self) -> str:
        """Base64-encoded image string."""
        return cast(str, self["image"])

    @property
    def mime_type(self) -> str:
        """MIME type of the image (e.g., "image/jpeg", "image/png")."""
        return cast(str, self["mime_type"])


# ============================================================================
# Output Events (received via agent.receive())
# ============================================================================


class BidiConnectionStartEvent(TypedEvent):
    """Streaming connection established and ready for interaction.

    Parameters:
        connection_id: Unique identifier for this streaming connection.
        model: Model identifier (e.g., "gpt-realtime", "gemini-2.0-flash-live").
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
        """Model identifier (e.g., 'gpt-realtime', 'gemini-2.0-flash-live')."""
        return cast(str, self["model"])


class BidiConnectionRestartEvent(TypedEvent):
    """Agent is restarting the model connection.

    Emitted on both reconnect paths: reactively after the model reports a timeout, and
    proactively when the reconnect timer fires ahead of the provider's limit.

    Parameters:
        reason: What triggered the restart ("timeout" reactively, "scheduled" proactively).
        timeout_error: The model's timeout error on the reactive path; None when scheduled.
        turn_interrupted: True if the restart cut an in-progress or owed turn (the alignment
            wait could not complete it before the deadline, or a timeout struck mid-turn). The
            provider replays history as context, so that turn will not be answered on its own —
            an app can re-prompt or notify the user when this is set.
    """

    def __init__(
        self,
        reason: Literal["timeout", "scheduled"],
        timeout_error: "BidiModelTimeoutError | None" = None,
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
    def reason(self) -> str:
        """What triggered the restart ("timeout" or "scheduled")."""
        return cast(str, self["reason"])

    @property
    def timeout_error(self) -> "BidiModelTimeoutError | None":
        """Model timeout error on the reactive path; None when scheduled."""
        return cast("BidiModelTimeoutError | None", self["timeout_error"])

    @property
    def turn_interrupted(self) -> bool:
        """True if the restart cut an in-progress or owed turn that will not be answered."""
        return cast(bool, self["turn_interrupted"])


class BidiConnectionWarningEvent(TypedEvent):
    """Agent is approaching a proactive reconnect.

    Emitted by the proactive reconnect timer before a reconnect; informational only.

    Parameters:
        time_left_s: Approximate seconds until the scheduled reconnect.
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
        """Approximate seconds until the scheduled reconnect."""
        return cast(float, self["time_left_s"])


class BidiResponseStartEvent(TypedEvent):
    """Model starts generating a response.

    Parameters:
        response_id: Unique identifier for this response (used in response.complete).
    """

    def __init__(self, response_id: str):
        """Initialize response start event."""
        super().__init__({"type": "bidi_response_start", "response_id": response_id})

    @property
    def response_id(self) -> str:
        """Unique identifier for this response."""
        return cast(str, self["response_id"])


class BidiAudioStreamEvent(TypedEvent):
    """Streaming audio output from the model.

    Parameters:
        audio: Base64-encoded audio string.
        format: Audio encoding format.
        sample_rate: Number of audio samples per second in Hz.
        channels: Number of audio channels (1=mono, 2=stereo).
    """

    def __init__(
        self,
        audio: str,
        format: AudioFormat,
        sample_rate: AudioSampleRate,
        channels: AudioChannel,
    ):
        """Initialize audio stream event."""
        super().__init__(
            {
                "type": "bidi_audio_stream",
                "audio": audio,
                "format": format,
                "sample_rate": sample_rate,
                "channels": channels,
            }
        )

    @property
    def audio(self) -> str:
        """Base64-encoded audio string."""
        return cast(str, self["audio"])

    @property
    def format(self) -> AudioFormat:
        """Audio encoding format."""
        return cast(AudioFormat, self["format"])

    @property
    def sample_rate(self) -> AudioSampleRate:
        """Number of audio samples per second in Hz."""
        return cast(AudioSampleRate, self["sample_rate"])

    @property
    def channels(self) -> AudioChannel:
        """Number of audio channels (1=mono, 2=stereo)."""
        return cast(AudioChannel, self["channels"])


class BidiTranscriptStreamEvent(TypedEvent):
    """Incremental transcription of user or assistant speech.

    Parameters:
        delta: The incremental transcript text.
        role: Who is speaking ("user" or "assistant").
    """

    def __init__(self, delta: str, role: Role):
        """Initialize transcript stream event."""
        super().__init__(
            {
                "type": "bidi_transcript_stream",
                "delta": delta,
                "role": _normalize_role(role, default="user"),
            }
        )

    @property
    def delta(self) -> str:
        """The incremental transcript text."""
        return cast(str, self["delta"])

    @property
    def role(self) -> Role:
        """The role of the message sender."""
        return cast(Role, self["role"])


class BidiTranscriptCompleteEvent(TypedEvent):
    """Complete transcript for one user or assistant turn.

    Parameters:
        transcript: The complete transcript text.
        role: Who spoke ("user" or "assistant").
    """

    def __init__(self, transcript: str, role: Role):
        """Initialize transcript complete event."""
        super().__init__(
            {
                "type": "bidi_transcript_complete",
                "transcript": transcript,
                "role": _normalize_role(role, default="user"),
            }
        )

    @property
    def transcript(self) -> str:
        """The complete transcript text."""
        return cast(str, self["transcript"])

    @property
    def role(self) -> Role:
        """The role of the speaker."""
        return cast(Role, self["role"])


class BidiInterruptionEvent(TypedEvent):
    """Model generation was interrupted.

    Parameters:
        reason: Why the interruption occurred.
    """

    def __init__(self, reason: Literal["user_speech", "error"]):
        """Initialize interruption event."""
        super().__init__(
            {
                "type": "bidi_interruption",
                "reason": reason,
            }
        )

    @property
    def reason(self) -> str:
        """Why the interruption occurred."""
        return cast(str, self["reason"])


class BidiResponseCompleteEvent(TypedEvent):
    """Model finished generating response.

    Parameters:
        response_id: ID of the response that completed (matches response.start).
        stop_reason: Why the response ended.
    """

    def __init__(
        self,
        response_id: str,
        stop_reason: StopReason,
    ):
        """Initialize response complete event."""
        super().__init__(
            {
                "type": "bidi_response_complete",
                "response_id": response_id,
                "stop_reason": stop_reason,
            }
        )

    @property
    def response_id(self) -> str:
        """Unique identifier for this response."""
        return cast(str, self["response_id"])

    @property
    def stop_reason(self) -> StopReason:
        """Why the response ended."""
        return cast(StopReason, self["stop_reason"])


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

    Parameters:
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


class BidiConnectionCloseEvent(TypedEvent):
    """Streaming connection closed.

    Parameters:
        connection_id: Unique identifier for this streaming connection (matches BidiConnectionStartEvent).
        reason: Why the connection was closed.
    """

    def __init__(
        self,
        connection_id: str,
        reason: Literal["client_disconnect", "timeout", "error", "complete", "user_request"],
    ):
        """Initialize connection close event."""
        super().__init__(
            {
                "type": "bidi_connection_close",
                "connection_id": connection_id,
                "reason": reason,
            }
        )

    @property
    def connection_id(self) -> str:
        """Unique identifier for this streaming connection."""
        return cast(str, self["connection_id"])

    @property
    def reason(self) -> str:
        """Why the interruption occurred."""
        return cast(str, self["reason"])


class BidiErrorEvent(TypedEvent):
    """Error occurred during the session.

    Stores the full Exception object as an instance attribute for debugging while
    keeping the event dict JSON-serializable. The exception can be accessed via
    the `error` property for re-raising or type-based error handling.

    Parameters:
        error: The exception that occurred.
        details: Optional additional error information.
    """

    def __init__(
        self,
        error: Exception,
        details: dict[str, Any] | None = None,
    ):
        """Initialize error event."""
        # Store serializable data in dict (for JSON serialization)
        super().__init__(
            {
                "type": "bidi_error",
                "message": str(error),
                "code": type(error).__name__,
                "details": details,
            }
        )
        # Store exception as instance attribute (not serialized)
        self._error = error

    @property
    def error(self) -> Exception:
        """The original exception that occurred.

        Can be used for re-raising or type-based error handling.
        """
        return self._error

    @property
    def code(self) -> str:
        """Error code derived from exception class name."""
        return cast(str, self["code"])

    @property
    def message(self) -> str:
        """Human-readable error message from the exception."""
        return cast(str, self["message"])

    @property
    def details(self) -> dict[str, Any] | None:
        """Additional error context beyond the exception itself."""
        return cast(dict[str, Any] | None, self.get("details"))


# ============================================================================
# Type Unions
# ============================================================================

# Note: ToolResultEvent is imported from strands.types._events and used alongside
# BidiInputEvent in send() methods for sending tool results back to the model.

BidiInputEvent = BidiTextInputEvent | BidiAudioInputEvent | BidiImageInputEvent
"""Union of different bidi input event types."""

BidiOutputEvent = (
    BidiConnectionStartEvent
    | BidiConnectionRestartEvent
    | BidiConnectionWarningEvent
    | BidiResponseStartEvent
    | BidiAudioStreamEvent
    | BidiTranscriptStreamEvent
    | BidiTranscriptCompleteEvent
    | BidiInterruptionEvent
    | BidiResponseCompleteEvent
    | BidiUsageEvent
    | BidiConnectionCloseEvent
    | BidiErrorEvent
    | ToolUseStreamEvent
)
"""Union of different bidi output event types."""
