import pytest

from strands.models._request_text import (
    NO_REQUEST_TEXT,
    OMISSION_MARKER,
    instruction_text,
    latest_request_text,
    request_text,
    truncate_text,
)


@pytest.mark.parametrize(
    ("text", "limit", "exp"),
    [
        ("short", 10, "short"),
        ("abcdefghij" * 10, 5, "abcde"),
        ("a" * 50 + "b" * 50, 40, "a" * 7 + OMISSION_MARKER + "b" * 8),
    ],
    ids=["fits", "limit_below_marker", "head_marker_tail"],
)
def test_truncate_text(text, limit, exp):
    assert truncate_text(text, limit) == exp


def test_request_text_labels_media_and_guarded_content_and_skips_tool_results():
    message = {
        "role": "user",
        "content": [{"text": "look"}, {"document": {}}, {"guardContent": {"text": {"text": "g"}}}],
    }
    tool_result = {"role": "user", "content": [{"toolResult": {"toolUseId": "t", "content": [{"text": "secret"}]}}]}

    assert request_text(message, 100) == "look\n[Document]\n[Guarded content]"
    assert request_text(tool_result, 100) is None


def test_latest_request_text_prefers_latest_user_request():
    messages = [
        {"role": "user", "content": [{"text": "first"}]},
        {"role": "assistant", "content": [{"text": "reply"}]},
        {"role": "user", "content": [{"text": "second"}]},
        {"role": "user", "content": [{"toolResult": {"toolUseId": "t", "content": []}}]},
    ]

    assert latest_request_text(messages, 100) == "second"
    assert latest_request_text([], 100) == NO_REQUEST_TEXT


def test_instruction_text_keeps_text_blocks_only():
    assert instruction_text([{"text": "a"}, {"cachePoint": {"type": "default"}}, {"text": "b"}], 100) == "a\nb"
    assert instruction_text("plain", 100) == "plain"
    assert instruction_text(None, 100) == ""
