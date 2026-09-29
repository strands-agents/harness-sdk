"""Tests for bidirectional streaming event types.

This module tests JSON serialization for all bidirectional streaming event types.
"""

import base64
import json

import pytest

from strands.experimental.bidi.types import (
    BidiAudioDeltaEvent,
    BidiAudioStartEvent,
    BidiAudioStopEvent,
    BidiBargeInEvent,
    BidiConnectionStartEvent,
    BidiConnectionStopEvent,
    BidiReasoningBlockEvent,
    BidiReasoningDeltaEvent,
    BidiReasoningStartEvent,
    BidiReasoningStopEvent,
    BidiResponseStartEvent,
    BidiResponseStopEvent,
    BidiTextBlockEvent,
    BidiTextDeltaEvent,
    BidiTextStartEvent,
    BidiTextStopEvent,
    BidiTranscriptBlockEvent,
    BidiTranscriptDeltaEvent,
    BidiTranscriptStartEvent,
    BidiTranscriptStopEvent,
    BidiUsageEvent,
)
from strands.experimental.bidi.types.events import _normalize_role


@pytest.mark.parametrize(
    "event_class,kwargs,expected_type",
    [
        # Output events
        (
            BidiConnectionStartEvent,
            {"connection_id": "c1", "model": "m1"},
            "bidi_connection_start",
        ),
        (BidiResponseStartEvent, {"response_id": "r1"}, "bidi_response_start"),
        (BidiTextStartEvent, {"content_id": "text"}, "bidi_text_start"),
        (BidiTextDeltaEvent, {"delta": " Some text. ", "content_id": "text"}, "bidi_text_delta"),
        (BidiTextStopEvent, {"content_id": "text"}, "bidi_text_stop"),
        (BidiTextBlockEvent, {"text": " Some text. ", "content_id": "text"}, "bidi_text_block"),
        (BidiReasoningStartEvent, {"content_id": "reasoning"}, "bidi_reasoning_start"),
        (BidiReasoningDeltaEvent, {"delta": " Some thought. ", "content_id": "reasoning"}, "bidi_reasoning_delta"),
        (BidiReasoningStopEvent, {"content_id": "reasoning"}, "bidi_reasoning_stop"),
        (BidiReasoningBlockEvent, {"text": " Some thought. ", "content_id": "reasoning"}, "bidi_reasoning_block"),
        (BidiTranscriptStartEvent, {"role": "user", "content_id": "u1"}, "bidi_transcript_start"),
        (BidiTranscriptStopEvent, {"role": "user", "content_id": "u1"}, "bidi_transcript_stop"),
        (
            BidiAudioStartEvent,
            {"content_id": "audio"},
            "bidi_audio_start",
        ),
        (BidiAudioStopEvent, {"content_id": "audio"}, "bidi_audio_stop"),
        (
            BidiAudioDeltaEvent,
            {
                "audio": base64.b64encode(b"audio").decode("utf-8"),
                "format": "pcm",
                "sample_rate": 24000,
                "channels": 1,
                "content_id": "audio",
            },
            "bidi_audio_delta",
        ),
        (
            BidiTranscriptDeltaEvent,
            {
                "delta": "Hello",
                "role": "assistant",
                "content_id": "t1",
            },
            "bidi_transcript_delta",
        ),
        (
            BidiTranscriptBlockEvent,
            {"transcript": "Hello", "role": "assistant", "content_id": "t1"},
            "bidi_transcript_block",
        ),
        (BidiBargeInEvent, {"reason": "user_speech"}, "bidi_barge_in"),
        (
            BidiResponseStopEvent,
            {"response_id": "r1"},
            "bidi_response_stop",
        ),
        (
            BidiUsageEvent,
            {"input_tokens": 10, "output_tokens": 20, "total_tokens": 30},
            "bidi_usage",
        ),
        (
            BidiConnectionStopEvent,
            {"connection_id": "c1", "reason": "complete"},
            "bidi_connection_stop",
        ),
    ],
)
def test_event_json_serialization(event_class, kwargs, expected_type):
    """Test that all event types are JSON serializable and deserializable."""
    event = event_class(**kwargs)
    tru_event = json.loads(json.dumps(event))
    assert tru_event == event
    assert tru_event["type"] == expected_type
    tru_attributes = {name: getattr(event, name) for name in kwargs}
    assert tru_attributes == kwargs


@pytest.mark.parametrize("role", ["user", "assistant"])
@pytest.mark.parametrize(
    "event_class,event_type",
    [(BidiTranscriptStartEvent, "bidi_transcript_start"), (BidiTranscriptStopEvent, "bidi_transcript_stop")],
)
def test_transcript_boundaries_contain_metadata(event_class, event_type, role):
    event = event_class(role, "t1")
    assert event == {"type": event_type, "role": role, "content_id": "t1"}
    assert (event.role, event.content_id) == (role, "t1")


def test_response_stop_contains_id():
    tru_event = BidiResponseStopEvent("r1")
    exp_event = {"type": "bidi_response_stop", "response_id": "r1"}
    assert tru_event == exp_event
    assert tru_event.response_id == "r1"


def test_transcript_delta_event_contains_text_delta():
    """Test that a transcript delta event contains only the incremental text."""
    event = BidiTranscriptDeltaEvent("Hello", "user", "user-transcript")

    assert event.role == "user"
    assert event.delta == "Hello"


def test_transcript_block_event_contains_full_transcript():
    """A block event carries the accumulated transcript."""
    event = BidiTranscriptBlockEvent("Hello world", "assistant", "assistant-transcript")

    exp_event = {
        "type": "bidi_transcript_block",
        "transcript": "Hello world",
        "role": "assistant",
        "content_id": "assistant-transcript",
    }
    assert event == exp_event
    assert json.loads(json.dumps(event)) == exp_event


@pytest.mark.parametrize(
    "raw_role,expected",
    [
        ("user", "user"),
        ("assistant", "assistant"),
        ("USER", "user"),
        ("Assistant", "assistant"),
    ],
)
def test_normalize_role_accepts_supported_roles(raw_role, expected):
    """normalize_role lowercases and preserves supported roles."""
    assert _normalize_role(raw_role) == expected


@pytest.mark.parametrize(
    "raw_role",
    ["system", "admin", "SYSTEM", "tool", "", "unknown", None, 123],
)
def test_normalize_role_falls_back_to_lowest_trust_role(raw_role):
    """normalize_role coerces out-of-range values to the lowest-trust default ("user")."""
    assert _normalize_role(raw_role) == "user"
    assert _normalize_role(raw_role, default="assistant") == "assistant"


@pytest.mark.parametrize(
    "raw_role,expected",
    [
        (" user ", "user"),
        (" User ", "user"),
        ("\tassistant\n", "assistant"),
        ("  USER", "user"),
    ],
)
def test_normalize_role_strips_whitespace(raw_role, expected):
    """normalize_role trims surrounding whitespace before the allowlist check."""
    assert _normalize_role(raw_role) == expected


@pytest.mark.parametrize("raw_role", ["system", "admin", "SYSTEM", "tool", "developer", "unknown", ""])
def test_transcript_delta_event_coerces_out_of_range_role_to_user(raw_role):
    """An out-of-range transcript role is coerced to the lowest-trust role ("user")."""
    event = BidiTranscriptDeltaEvent(delta="hi", role=raw_role, content_id="transcript")

    # Attacker-controlled content is never attributed to the assistant.
    assert event.role == "user"
    assert event["role"] == "user"


def test_transcript_delta_event_strips_whitespace_role():
    """A legitimately-spaced role is trimmed rather than mislabeled as the default."""
    event = BidiTranscriptDeltaEvent(delta="hi", role=" user ", content_id="transcript")

    assert event.role == "user"


def test_transcript_delta_event_normalizes_role_casing():
    """A supported role in mixed casing is normalized to lowercase."""
    event = BidiTranscriptDeltaEvent(delta="hi", role="USER", content_id="transcript")

    assert event.role == "user"
