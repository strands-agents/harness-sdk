import base64

import pytest

from strands.models._anthropic_messages import RawEventReader, format_event, message_to_events


def _read_all(events):
    reader = RawEventReader()
    out = [chunk for event in events for chunk in reader.read(event)]
    return out + reader.finish()


def test_raw_event_reader_streams_thinking_text_and_tool_use():
    events = [
        {"type": "message_start", "message": {"usage": {"input_tokens": 10, "output_tokens": 1}}},
        {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "hmm"}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "sig"}},
        {"type": "content_block_stop", "index": 0},
        {"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "id": "t1", "name": "f"}},
        {"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": "{}"}},
        {"type": "content_block_stop", "index": 1},
        {"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 7}},
        {"type": "message_stop", "amazon-bedrock-invocationMetrics": {"inputTokenCount": 10}},
    ]

    assert _read_all(events) == [
        {"messageStart": {"role": "assistant"}},
        {"contentBlockStart": {"contentBlockIndex": 0, "start": {}}},
        {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"reasoningContent": {"text": "hmm"}}}},
        {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"reasoningContent": {"signature": "sig"}}}},
        {"contentBlockStop": {"contentBlockIndex": 0}},
        {"contentBlockStart": {"contentBlockIndex": 1, "start": {"toolUse": {"name": "f", "toolUseId": "t1"}}}},
        {"contentBlockDelta": {"contentBlockIndex": 1, "delta": {"toolUse": {"input": "{}"}}}},
        {"contentBlockStop": {"contentBlockIndex": 1}},
        {"messageStop": {"stopReason": "tool_use"}},
        {
            "metadata": {
                "usage": {"inputTokens": 10, "outputTokens": 7, "totalTokens": 17},
                "metrics": {"latencyMs": 0},
            }
        },
    ]


def test_raw_event_reader_emits_redacted_thinking_from_block_start():
    data = base64.b64encode(b"secret").decode()
    events = [{"type": "content_block_start", "index": 0, "content_block": {"type": "redacted_thinking", "data": data}}]

    assert _read_all(events) == [
        {"contentBlockStart": {"contentBlockIndex": 0, "start": {}}},
        {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"reasoningContent": {"redactedContent": b"secret"}}}},
    ]


def test_raw_event_reader_skips_server_tool_blocks():
    events = [
        {"type": "content_block_start", "index": 0, "content_block": {"type": "server_tool_use", "id": "s1"}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": "{}"}},
        {"type": "content_block_stop", "index": 0},
        {"type": "ping"},
    ]

    assert _read_all(events) == []


def test_message_to_events_round_trips_a_complete_response():
    message = {
        "content": [
            {"type": "thinking", "thinking": "hmm", "signature": "sig"},
            {"type": "text", "text": "hi"},
            {"type": "tool_use", "id": "t1", "name": "f", "input": {"a": 1}},
        ],
        "stop_reason": "tool_use",
        "usage": {"input_tokens": 3, "output_tokens": 4},
    }

    chunks = _read_all(message_to_events(message))

    deltas = [chunk["contentBlockDelta"]["delta"] for chunk in chunks if "contentBlockDelta" in chunk]
    assert deltas == [
        {"reasoningContent": {"text": "hmm"}},
        {"reasoningContent": {"signature": "sig"}},
        {"text": "hi"},
        {"toolUse": {"input": '{"a": 1}'}},
    ]
    assert chunks[-2] == {"messageStop": {"stopReason": "tool_use"}}
    assert chunks[-1]["metadata"]["usage"] == {"inputTokens": 3, "outputTokens": 4, "totalTokens": 7}


def test_format_event_rejects_unknown_delta():
    with pytest.raises(RuntimeError, match="unknown type"):
        format_event({"type": "content_block_delta", "index": 0, "delta": {"type": "mystery"}})
