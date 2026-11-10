"""Tests for message pinning utilities."""

from strands.agent.conversation_manager.compression.pin_message import is_pinned, pin_message, unpin_message


def make_message(text, role="user", metadata=None):
    msg = {"role": role, "content": [{"text": text}]}
    if metadata is not None:
        msg["metadata"] = metadata
    return msg


class TestIsPinned:
    def test_returns_false_for_unpinned(self):
        messages = [make_message("hello")]
        assert is_pinned(messages, 0) is False

    def test_returns_false_for_empty_custom(self):
        messages = [make_message("hello", metadata={"custom": {}})]
        assert is_pinned(messages, 0) is False

    def test_returns_true_for_pinned(self):
        messages = [make_message("hello", metadata={"custom": {"pinned": True}})]
        assert is_pinned(messages, 0) is True

    def test_returns_false_for_explicitly_unpinned(self):
        messages = [make_message("hello", metadata={"custom": {"pinned": False}})]
        assert is_pinned(messages, 0) is False


class TestPinMessage:
    def test_sets_pinned_true(self):
        messages = [make_message("important")]
        pin_message(messages, 0)
        assert is_pinned(messages, 0) is True

    def test_preserves_existing_metadata(self):
        messages = [make_message("important", metadata={"usage": {"inputTokens": 10}})]
        pin_message(messages, 0)
        assert messages[0]["metadata"]["usage"] == {"inputTokens": 10}
        assert is_pinned(messages, 0) is True

    def test_preserves_existing_custom_fields(self):
        messages = [make_message("important", metadata={"custom": {"myField": "value"}})]
        pin_message(messages, 0)
        assert messages[0]["metadata"]["custom"]["myField"] == "value"
        assert is_pinned(messages, 0) is True


class TestUnpinMessage:
    def test_removes_pinned_flag(self):
        messages = [make_message("important")]
        pin_message(messages, 0)
        unpin_message(messages, 0)
        assert is_pinned(messages, 0) is False

    def test_preserves_other_custom_fields(self):
        messages = [make_message("important", metadata={"custom": {"pinned": True, "other": "keep"}})]
        unpin_message(messages, 0)
        assert is_pinned(messages, 0) is False
        assert messages[0]["metadata"]["custom"]["other"] == "keep"

    def test_removes_metadata_when_nothing_remains(self):
        messages = [make_message("hello")]
        pin_message(messages, 0)
        unpin_message(messages, 0)
        assert "metadata" not in messages[0]

    def test_preserves_non_custom_metadata(self):
        messages = [make_message("important", metadata={"usage": {"inputTokens": 10}, "custom": {"pinned": True}})]
        unpin_message(messages, 0)
        assert messages[0]["metadata"]["usage"] == {"inputTokens": 10}
        assert is_pinned(messages, 0) is False


class TestToolPairPartnerProtection:
    def test_tool_result_partner_of_pinned_tool_use(self):
        tool_result = {
            "toolUseId": "id-1",
            "content": [{"text": "result"}],
            "status": "success",
        }
        messages = [
            {"role": "assistant", "content": [{"toolUse": {"toolUseId": "id-1", "name": "test", "input": {}}}]},
            {"role": "user", "content": [{"toolResult": tool_result}]},
            make_message("other"),
        ]
        pin_message(messages, 0)
        assert is_pinned(messages, 1) is True

    def test_tool_use_partner_of_pinned_tool_result(self):
        tool_result = {
            "toolUseId": "id-1",
            "content": [{"text": "result"}],
            "status": "success",
        }
        messages = [
            {"role": "assistant", "content": [{"toolUse": {"toolUseId": "id-1", "name": "test", "input": {}}}]},
            {"role": "user", "content": [{"toolResult": tool_result}]},
            make_message("other"),
        ]
        pin_message(messages, 1)
        assert is_pinned(messages, 0) is True

    def test_unrelated_message_next_to_pinned_is_not_pinned(self):
        messages = [make_message("a"), make_message("b")]
        pin_message(messages, 0)
        assert is_pinned(messages, 1) is False
