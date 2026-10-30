"""Tests for last-resort text truncation."""

from strands.agent.conversation_manager.compression.pin_message import pin_message
from strands.agent.conversation_manager.compression.truncate_text import _truncate_largest_text_blocks


def _text_message(text, role="user"):
    return {"role": role, "content": [{"text": text}]}


def _tool_result_message(text, tool_use_id="t1"):
    return {
        "role": "user",
        "content": [{"toolResult": {"toolUseId": tool_use_id, "status": "success", "content": [{"text": text}]}}],
    }


def _truncated(text, preserve_chars):
    removed = len(text) - 2 * preserve_chars
    return f"{text[:preserve_chars]}...\n\n... [truncated: {removed} chars removed] ...\n\n...{text[-preserve_chars:]}"


class TestTruncateLargestTextBlocks:
    def test_truncates_to_head_and_tail(self):
        text = "h" * 100 + "m" * 200 + "t" * 100
        messages = [_text_message("small"), _text_message(text)]

        assert _truncate_largest_text_blocks(messages, preserve_chars=100) == 1

        exp_messages = [
            _text_message("small"),
            _text_message("h" * 100 + "...\n\n... [truncated: 200 chars removed] ...\n\n..." + "t" * 100),
        ]
        assert messages == exp_messages

    def test_truncates_only_the_largest_block_per_call(self):
        messages = [_text_message("a" * 1_000), _tool_result_message("b" * 3_000), _text_message("c" * 2_000)]

        assert _truncate_largest_text_blocks(messages, preserve_chars=10) == 1

        exp_messages = [
            _text_message("a" * 1_000),
            _tool_result_message(_truncated("b" * 3_000, 10)),
            _text_message("c" * 2_000),
        ]
        assert messages == exp_messages

        assert _truncate_largest_text_blocks(messages, preserve_chars=10) == 1

        exp_messages[2] = _text_message(_truncated("c" * 2_000, 10))
        assert messages == exp_messages

    def test_truncates_up_to_budget_blocks_largest_first(self):
        messages = [_text_message(str(i) * (1_000 + i)) for i in range(5)]

        assert _truncate_largest_text_blocks(messages, budget=3, preserve_chars=10) == 3

        exp_messages = [
            _text_message("0" * 1_000),
            _text_message("1" * 1_001),
            _text_message(_truncated("2" * 1_002, 10)),
            _text_message(_truncated("3" * 1_003, 10)),
            _text_message(_truncated("4" * 1_004, 10)),
        ]
        assert messages == exp_messages

        # A budget larger than what is left truncates the rest and reports the real count.
        assert _truncate_largest_text_blocks(messages, budget=8, preserve_chars=10) == 2
        assert _truncate_largest_text_blocks(messages, budget=8, preserve_chars=10) == 0

    def test_ties_go_to_the_oldest_block(self):
        messages = [_text_message("a" * 1_000), _text_message("b" * 1_000)]

        assert _truncate_largest_text_blocks(messages, preserve_chars=10) == 1

        exp_messages = [_text_message(_truncated("a" * 1_000, 10)), _text_message("b" * 1_000)]
        assert messages == exp_messages

    def test_requires_a_meaningful_saving(self):
        # Saving must exceed preserve_chars: 3 * preserve is the floor.
        messages = [_text_message("z" * 300), _text_message("y" * 301)]

        assert _truncate_largest_text_blocks(messages, budget=2, preserve_chars=100) == 1

        exp_messages = [_text_message("z" * 300), _text_message(_truncated("y" * 301, 100))]
        assert messages == exp_messages

        assert _truncate_largest_text_blocks(messages, preserve_chars=100) == 0
        assert messages == exp_messages

    def test_returns_zero_when_nothing_qualifies(self):
        messages = [_text_message("short"), _tool_result_message("also short"), {"role": "user", "content": ["raw"]}]

        assert _truncate_largest_text_blocks(messages, preserve_chars=100) == 0

    def test_does_not_retruncate(self):
        messages = [_text_message("a" * 1_000)]

        assert _truncate_largest_text_blocks(messages, preserve_chars=10) == 1
        once = messages[0]["content"][0]["text"]
        assert _truncate_largest_text_blocks(messages, preserve_chars=10) == 0
        assert messages[0]["content"][0]["text"] == once

    def test_user_text_mentioning_truncated_is_still_truncated(self):
        messages = [_text_message("... [truncated: lol] " + "a" * 1_000)]

        assert _truncate_largest_text_blocks(messages, preserve_chars=10) == 1

    def test_skips_pinned_messages(self):
        messages = [_text_message("p" * 1_000), _text_message("q" * 500)]
        pin_message(messages, 0)

        assert _truncate_largest_text_blocks(messages, budget=2, preserve_chars=10) == 1

        exp_messages = [_text_message("p" * 1_000), _text_message(_truncated("q" * 500, 10))]
        pin_message(exp_messages, 0)
        assert messages == exp_messages

    def test_non_positive_preserve_chars_is_a_no_op(self):
        messages = [_text_message("a" * 1_000)]

        assert _truncate_largest_text_blocks(messages, preserve_chars=0) == 0
        assert messages == [_text_message("a" * 1_000)]
