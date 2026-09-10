"""Tests for bidirectional streaming event types.

This module tests JSON serialization for all bidirectional streaming event types.
"""

import base64
import json

import pytest

from strands.experimental.bidi.types.events import (
    BidiAudioInputEvent,
    BidiAudioStreamEvent,
    BidiConnectionCloseEvent,
    BidiConnectionStartEvent,
    BidiErrorEvent,
    BidiImageInputEvent,
    BidiInterruptionEvent,
    BidiResponseCompleteEvent,
    BidiResponseStartEvent,
    BidiTextInputEvent,
    BidiTranscriptCompleteEvent,
    BidiTranscriptStreamEvent,
    BidiUsageEvent,
    _normalize_role,
)


@pytest.mark.parametrize(
    "event_class,kwargs,expected_type",
    [
        # Input events
        (BidiTextInputEvent, {"text": "Hello", "role": "user"}, "bidi_text_input"),
        (
            BidiAudioInputEvent,
            {
                "audio": base64.b64encode(b"audio").decode("utf-8"),
                "format": "pcm",
                "sample_rate": 16000,
                "channels": 1,
            },
            "bidi_audio_input",
        ),
        (
            BidiImageInputEvent,
            {"image": base64.b64encode(b"image").decode("utf-8"), "mime_type": "image/jpeg"},
            "bidi_image_input",
        ),
        # Output events
        (
            BidiConnectionStartEvent,
            {"connection_id": "c1", "model": "m1"},
            "bidi_connection_start",
        ),
        (BidiResponseStartEvent, {"response_id": "r1"}, "bidi_response_start"),
        (
            BidiAudioStreamEvent,
            {
                "audio": base64.b64encode(b"audio").decode("utf-8"),
                "format": "pcm",
                "sample_rate": 24000,
                "channels": 1,
            },
            "bidi_audio_stream",
        ),
        (
            BidiTranscriptStreamEvent,
            {
                "delta": "Hello",
                "role": "assistant",
            },
            "bidi_transcript_stream",
        ),
        (
            BidiTranscriptCompleteEvent,
            {"transcript": "Hello", "role": "assistant"},
            "bidi_transcript_complete",
        ),
        (BidiInterruptionEvent, {"reason": "user_speech"}, "bidi_interruption"),
        (
            BidiResponseCompleteEvent,
            {"response_id": "r1", "stop_reason": "complete"},
            "bidi_response_complete",
        ),
        (
            BidiUsageEvent,
            {"input_tokens": 10, "output_tokens": 20, "total_tokens": 30},
            "bidi_usage",
        ),
        (
            BidiConnectionCloseEvent,
            {"connection_id": "c1", "reason": "complete"},
            "bidi_connection_close",
        ),
        (BidiErrorEvent, {"error": ValueError("test"), "details": None}, "bidi_error"),
    ],
)
def test_event_json_serialization(event_class, kwargs, expected_type):
    """Test that all event types are JSON serializable and deserializable."""
    # Create event
    event = event_class(**kwargs)

    # Verify type field
    assert event["type"] == expected_type

    # Serialize to JSON
    json_str = json.dumps(event)
    print("event_class:", event_class)
    print(json_str)
    # Deserialize back
    data = json.loads(json_str)

    # Verify type preserved
    assert data["type"] == expected_type

    # Verify all non-private keys preserved
    for key in event.keys():
        if not key.startswith("_"):
            assert key in data


def test_transcript_stream_event_contains_text_delta():
    """Test that a transcript stream event contains only the incremental text."""
    event = BidiTranscriptStreamEvent(
        delta="Hello",
        role="user",
    )

    assert event.role == "user"
    assert event.delta == "Hello"


def test_transcript_complete_event_contains_full_transcript():
    """Test that a complete event carries one authoritative transcript."""
    event = BidiTranscriptCompleteEvent(transcript="Hello world", role="assistant")

    assert event.transcript == "Hello world"
    assert event.role == "assistant"


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
def test_transcript_stream_event_coerces_out_of_range_role_to_user(raw_role):
    """An out-of-range transcript role is coerced to the lowest-trust role ("user")."""
    event = BidiTranscriptStreamEvent(
        delta="hi",
        role=raw_role,
    )

    # Attacker-controlled content is never attributed to the assistant.
    assert event.role == "user"
    assert event["role"] == "user"


def test_transcript_stream_event_strips_whitespace_role():
    """A legitimately-spaced role is trimmed rather than mislabeled as the default."""
    event = BidiTranscriptStreamEvent(
        delta="hi",
        role=" user ",
    )

    assert event.role == "user"


def test_transcript_stream_event_normalizes_role_casing():
    """A supported role in mixed casing is normalized to lowercase."""
    event = BidiTranscriptStreamEvent(
        delta="hi",
        role="USER",
    )

    assert event.role == "user"
