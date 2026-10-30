"""Tests for last-resort text truncation."""

from strands.agent.conversation_manager.compression.pin_message import pin_message
from strands.agent.conversation_manager.compression.truncate_text import _truncate_oversized_text_blocks


def _text_message(text, role="user"):
    return {"role": role, "content": [{"text": text}]}


def _tool_result_message(text, tool_use_id="t1"):
    return {
        "role": "user",
        "content": [{"toolResult": {"toolUseId": tool_use_id, "status": "success", "content": [{"text": text}]}}],
    }


class TestTruncateOversizedTextBlocks:
    def test_truncates_to_head_and_tail(self):
        messages = [_text_message("small"), _text_message("h" * 100 + "m" * 200 + "t" * 100)]

        assert _truncate_oversized_text_blocks(messages, preserve_chars=100) is True

        assert messages[0]["content"][0]["text"] == "small"
        truncated = messages[1]["content"][0]["text"]
        assert truncated == "h" * 100 + "...\n\n... [truncated: 200 chars removed] ...\n\n..." + "t" * 100

    def test_truncates_every_oversized_block_in_one_pass(self):
        messages = [_text_message("a" * 1_000), _tool_result_message("b" * 1_000), _text_message("c" * 1_000)]

        assert _truncate_oversized_text_blocks(messages, preserve_chars=10) is True

        assert "[truncated: 980 chars removed]" in messages[0]["content"][0]["text"]
        assert "[truncated: 980 chars removed]" in messages[1]["content"][0]["toolResult"]["content"][0]["text"]
        assert "[truncated: 980 chars removed]" in messages[2]["content"][0]["text"]

    def test_requires_a_meaningful_saving(self):
        # Saving must exceed preserve_chars: 3 * preserve is the floor.
        messages = [_text_message("z" * 300), _text_message("y" * 301)]

        assert _truncate_oversized_text_blocks(messages, preserve_chars=100) is True

        assert messages[0]["content"][0]["text"] == "z" * 300
        assert "[truncated: 101 chars removed]" in messages[1]["content"][0]["text"]

    def test_returns_false_when_nothing_qualifies(self):
        messages = [_text_message("short"), _tool_result_message("also short"), {"role": "user", "content": ["raw"]}]

        assert _truncate_oversized_text_blocks(messages, preserve_chars=100) is False

    def test_does_not_retruncate(self):
        messages = [_text_message("a" * 1_000)]

        assert _truncate_oversized_text_blocks(messages, preserve_chars=10) is True
        once = messages[0]["content"][0]["text"]
        assert _truncate_oversized_text_blocks(messages, preserve_chars=10) is False
        assert messages[0]["content"][0]["text"] == once

    def test_user_text_mentioning_truncated_is_still_truncated(self):
        messages = [_text_message("... [truncated: lol] " + "a" * 1_000)]

        assert _truncate_oversized_text_blocks(messages, preserve_chars=10) is True

    def test_skips_pinned_messages(self):
        messages = [_text_message("p" * 1_000), _text_message("q" * 500)]
        pin_message(messages, 0)

        assert _truncate_oversized_text_blocks(messages, preserve_chars=10) is True

        assert messages[0]["content"][0]["text"] == "p" * 1_000
        assert "[truncated:" in messages[1]["content"][0]["text"]

    def test_non_positive_preserve_chars_is_a_no_op(self):
        messages = [_text_message("a" * 1_000)]

        assert _truncate_oversized_text_blocks(messages, preserve_chars=0) is False
        assert messages[0]["content"][0]["text"] == "a" * 1_000
