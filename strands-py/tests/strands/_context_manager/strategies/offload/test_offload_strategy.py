"""Tests for offload strategies — truncate, drop, and base infrastructure."""

import unittest.mock

import pytest

from strands._context_manager.strategies.offload import Offload
from strands._context_manager.strategies.offload.base import (
    _build_tool_name_map,
    _collect_removable_with_pair,
    _get_oldest_matches,
    _message_matches_target,
    _repair_alternation,
    _resolve_tool_filter,
    _splice_with_pairs,
    _target_matches_message,
    _tool_matches_target,
)
from strands._context_manager.strategies.offload.drop import DROPPED_MARKER
from strands._context_manager.strategies.offload.truncate import EmergencyTruncateStrategy
from strands._context_manager.types import ContextState
from strands.hooks.events import MessageAddedEvent
from strands.hooks.registry import HookRegistry
from strands.types.content import ContentBlock, Message, Messages
from strands.types.tools import ToolResult, ToolUse


@pytest.fixture
def mock_agent():
    agent = unittest.mock.MagicMock()
    agent.model = unittest.mock.AsyncMock()
    agent.model.count_tokens = unittest.mock.AsyncMock(return_value=5000)
    agent.model.estimate_utilization = unittest.mock.MagicMock(return_value=0.5)
    agent.messages = []
    return agent


def _make_tool_pair(tool_name="my_tool", tool_use_id="tu-1"):
    """Create an assistant tool-use message + user tool-result message pair."""
    assistant_msg = Message(
        role="assistant",
        content=[ContentBlock(toolUse=ToolUse(toolUseId=tool_use_id, name=tool_name, input={}))],
    )
    user_msg = Message(
        role="user",
        content=[
            ContentBlock(
                toolResult=ToolResult(
                    toolUseId=tool_use_id,
                    status="success",
                    content=[{"text": "x" * 10000}],
                )
            )
        ],
    )
    return assistant_msg, user_msg


class TestBuildToolNameMap:
    """Tests for building tool name map."""

    def test_builds_map_from_assistant_messages(self):
        messages: Messages = [
            Message(
                role="assistant",
                content=[ContentBlock(toolUse=ToolUse(toolUseId="t1", name="bash", input={}))],
            ),
            Message(role="user", content=[ContentBlock(text="result")]),
        ]
        tru_map = _build_tool_name_map(messages)
        assert tru_map == {"t1": "bash"}

    def test_ignores_user_messages(self):
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="hello")]),
        ]
        tru_map = _build_tool_name_map(messages)
        assert tru_map == {}


class TestResolveToolFilter:
    """Tests for resolve_tool_filter."""

    def test_returns_none_for_string_target(self):
        include, exclude = _resolve_tool_filter("tool_results")
        assert include is None
        assert exclude is None

    def test_parses_include_list(self):
        include, exclude = _resolve_tool_filter(["tool::bash", "tool::python"])
        assert include == {"bash", "python"}
        assert exclude is None

    def test_parses_exclude_list(self):
        include, exclude = _resolve_tool_filter(["!tool::bash"])
        assert include is None
        assert exclude == {"bash"}

    def test_mixed_include_and_exclude_prefers_include(self):
        include, exclude = _resolve_tool_filter(["tool::bash", "!tool::python"])
        assert include == {"bash"}
        assert exclude is None

    def test_entries_without_tool_prefix_still_parsed(self):
        include, exclude = _resolve_tool_filter(["raw_name"])
        assert include == {"raw_name"}
        assert exclude is None

    def test_exclude_entries_without_tool_prefix_still_parsed(self):
        include, exclude = _resolve_tool_filter(["!raw_name"])
        assert include is None
        assert exclude == {"raw_name"}

    def test_empty_list_returns_none_none(self):
        include, exclude = _resolve_tool_filter([])
        assert include is None
        assert exclude is None


class TestRepairAlternation:
    """Tests for repair_alternation."""

    def test_merges_consecutive_same_role(self):
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="a")]),
            Message(role="user", content=[ContentBlock(text="b")]),
            Message(role="assistant", content=[ContentBlock(text="c")]),
        ]
        _repair_alternation(messages)
        assert len(messages) == 2
        assert messages[0]["role"] == "user"
        assert len(messages[0]["content"]) == 2
        assert messages[1]["role"] == "assistant"

    def test_no_change_when_alternating(self):
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="a")]),
            Message(role="assistant", content=[ContentBlock(text="b")]),
        ]
        _repair_alternation(messages)
        assert len(messages) == 2


class TestCollectRemovableWithPair:
    """Tests for pair-safe removal."""

    def test_includes_paired_tool_use(self):
        assistant_msg, user_msg = _make_tool_pair()
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="start")]),
            assistant_msg,
            user_msg,
        ]
        tru_result = _collect_removable_with_pair(messages, 2)
        assert assistant_msg in tru_result
        assert user_msg in tru_result

    def test_skips_index_zero(self):
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="first")]),
        ]
        tru_result = _collect_removable_with_pair(messages, 0)
        assert tru_result == []

    def test_refuses_to_remove_head_pin_pair(self):
        assistant_msg, user_msg = _make_tool_pair()
        messages: Messages = [assistant_msg, user_msg]
        tru_result = _collect_removable_with_pair(messages, 1)
        assert tru_result == []

    def test_collects_tool_use_and_following_tool_result(self):
        assistant_msg = Message(
            role="assistant",
            content=[ContentBlock(toolUse=ToolUse(toolUseId="tu-1", name="bash", input={}))],
        )
        user_msg = Message(
            role="user",
            content=[ContentBlock(toolResult=ToolResult(toolUseId="tu-1", status="success", content=[{"text": "ok"}]))],
        )
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="start")]),
            assistant_msg,
            user_msg,
        ]
        tru_result = _collect_removable_with_pair(messages, 1)
        assert assistant_msg in tru_result
        assert user_msg in tru_result

    def test_returns_empty_for_out_of_bounds_index(self):
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="only")]),
        ]
        tru_result = _collect_removable_with_pair(messages, 5)
        assert tru_result == []


class TestSpliceWithPairs:
    """Tests for splice_with_pairs."""

    def test_removes_messages_and_returns_count(self):
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="assistant", content=[ContentBlock(text="a")]),
            Message(role="user", content=[ContentBlock(text="b")]),
            Message(role="assistant", content=[ContentBlock(text="c")]),
        ]
        to_remove = [messages[1], messages[2]]
        removed, lowest = _splice_with_pairs(messages, to_remove)
        assert removed == 2
        assert lowest == 1
        assert len(messages) == 2

    def test_skips_message_not_in_identity_map(self):
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="assistant", content=[ContentBlock(text="keep")]),
        ]
        foreign_message = Message(role="user", content=[ContentBlock(text="not in list")])
        removed, lowest = _splice_with_pairs(messages, [foreign_message])
        assert removed == 0
        assert lowest == len(messages)

    def test_removes_pair_when_tool_result_targeted(self):
        assistant_msg, user_msg = _make_tool_pair()
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            assistant_msg,
            user_msg,
        ]
        removed, lowest = _splice_with_pairs(messages, [user_msg])
        assert removed == 2
        assert lowest == 1
        assert len(messages) == 1


class TestOffloadBuilder:
    """Tests for the Offload namespace builder API."""

    def test_drop_creates_strategy(self):
        strategy = Offload.drop("tool_results")
        assert strategy.name == "offload:drop"

    def test_truncate_creates_strategy(self):
        strategy = Offload.truncate("tool_results", {"preview_tokens": 500})
        assert strategy.name == "offload:truncate"

    def test_summarize_creates_strategy(self):
        strategy = Offload.summarize("*")
        assert strategy.name == "offload:summarize"

    def test_when_adds_conditions(self):
        strategy = Offload.truncate("tool_results").when(threshold=2000)
        assert strategy._threshold == 2000

    def test_when_with_utilization(self):
        strategy = Offload.drop("*").when(utilization=0.85)
        assert strategy._utilization_threshold == 0.85

    def test_truncate_validates_threshold_gt_preview(self):
        with pytest.raises(ValueError, match="must be greater than preview_tokens"):
            Offload.truncate("tool_results", {"preview_tokens": 1000}).when(threshold=500)

    def test_empty_list_target_raises(self):
        with pytest.raises(ValueError, match="Empty array target"):
            Offload.drop([])


class TestToolMatchesTarget:
    """Tests for tool_matches_target — all branch paths."""

    def _make_tool_result_block(self, status="success", tool_use_id="tu-1"):
        return ContentBlock(
            toolResult=ToolResult(
                toolUseId=tool_use_id,
                status=status,
                content=[{"text": "result"}],
            )
        )

    def test_wildcard_target_matches_any_tool_result(self):
        block = self._make_tool_result_block()
        assert _tool_matches_target(block, "*", {}, None, None) is True

    def test_tool_results_target_matches_success_status(self):
        block = self._make_tool_result_block(status="success")
        assert _tool_matches_target(block, "tool_results", {}, None, None) is True

    def test_tool_results_target_rejects_error_status(self):
        block = self._make_tool_result_block(status="error")
        assert _tool_matches_target(block, "tool_results", {}, None, None) is False

    def test_tool_result_errors_target_matches_error_status(self):
        block = self._make_tool_result_block(status="error")
        assert _tool_matches_target(block, "tool_result_errors", {}, None, None) is True

    def test_tool_result_errors_target_rejects_success_status(self):
        block = self._make_tool_result_block(status="success")
        assert _tool_matches_target(block, "tool_result_errors", {}, None, None) is False

    def test_returns_false_when_tool_name_not_in_map(self):
        block = self._make_tool_result_block(tool_use_id="unknown-id")
        assert _tool_matches_target(block, ["tool::bash"], {}, {"bash"}, None) is False

    def test_include_filter_matches_tool_name(self):
        block = self._make_tool_result_block(tool_use_id="tu-1")
        assert _tool_matches_target(block, ["tool::bash"], {"tu-1": "bash"}, {"bash"}, None) is True

    def test_include_filter_rejects_non_matching_tool_name(self):
        block = self._make_tool_result_block(tool_use_id="tu-1")
        assert _tool_matches_target(block, ["tool::bash"], {"tu-1": "python"}, {"bash"}, None) is False

    def test_exclude_filter_rejects_matching_tool_name(self):
        block = self._make_tool_result_block(tool_use_id="tu-1")
        assert _tool_matches_target(block, ["!tool::bash"], {"tu-1": "bash"}, None, {"bash"}) is False

    def test_exclude_filter_allows_non_matching_tool_name(self):
        block = self._make_tool_result_block(tool_use_id="tu-1")
        assert _tool_matches_target(block, ["!tool::bash"], {"tu-1": "python"}, None, {"bash"}) is True

    def test_returns_false_with_no_filters_and_list_target(self):
        block = self._make_tool_result_block(tool_use_id="tu-1")
        assert _tool_matches_target(block, [], {"tu-1": "bash"}, None, None) is False


class TestTargetMatchesMessage:
    """Tests for target_matches_message — text-level targets."""

    def test_assistant_text_target_matches_assistant_with_text(self):
        message = Message(role="assistant", content=[ContentBlock(text="hello")])
        assert _target_matches_message("assistant_text", message) is True

    def test_assistant_text_target_rejects_user_message(self):
        message = Message(role="user", content=[ContentBlock(text="hello")])
        assert _target_matches_message("assistant_text", message) is False

    def test_user_text_target_matches_user_with_text(self):
        message = Message(role="user", content=[ContentBlock(text="hello")])
        assert _target_matches_message("user_text", message) is True

    def test_user_text_target_rejects_assistant_message(self):
        message = Message(role="assistant", content=[ContentBlock(text="hello")])
        assert _target_matches_message("user_text", message) is False

    def test_none_target_matches_any(self):
        message = Message(role="user", content=[ContentBlock(text="hello")])
        assert _target_matches_message(None, message) is True

    def test_wildcard_target_matches_any(self):
        message = Message(role="assistant", content=[ContentBlock(text="hello")])
        assert _target_matches_message("*", message) is True

    def test_unknown_string_target_returns_false(self):
        message = Message(role="user", content=[ContentBlock(text="hello")])
        assert _target_matches_message("tool_results", message) is False


class TestMessageMatchesTarget:
    """Tests for message_matches_target — combined text and tool matching."""

    def test_falls_through_to_tool_result_matching(self):
        tool_result_block = ContentBlock(
            toolResult=ToolResult(toolUseId="tu-1", status="success", content=[{"text": "result"}])
        )
        user_msg = Message(role="user", content=[tool_result_block])
        assert _message_matches_target(user_msg, "tool_results", {"tu-1": "bash"}, None, None) is True

    def test_target_none_guard_returns_false_for_non_text_match(self):
        assistant_msg = Message(role="assistant", content=[ContentBlock(text="hello")])
        assert _message_matches_target(assistant_msg, "tool_results", {}, None, None) is False

    def test_returns_false_when_no_tool_results_match(self):
        tool_result_block = ContentBlock(
            toolResult=ToolResult(toolUseId="tu-1", status="error", content=[{"text": "error"}])
        )
        user_msg = Message(role="user", content=[tool_result_block])
        assert _message_matches_target(user_msg, "tool_results", {}, None, None) is False

    def test_skips_non_user_messages_for_tool_matching(self):
        tool_result_block = ContentBlock(
            toolResult=ToolResult(toolUseId="tu-1", status="success", content=[{"text": "result"}])
        )
        assistant_msg = Message(role="assistant", content=[tool_result_block])
        assert _message_matches_target(assistant_msg, "tool_results", {}, None, None) is False


class TestGetOldestMatches:
    """Tests for get_oldest_matches — count excludes recent N."""

    def test_returns_oldest_excluding_recent(self):
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="msg1")]),
            Message(role="assistant", content=[ContentBlock(text="msg2")]),
            Message(role="user", content=[ContentBlock(text="msg3")]),
            Message(role="assistant", content=[ContentBlock(text="msg4")]),
            Message(role="user", content=[ContentBlock(text="msg5")]),
        ]
        tru_result = _get_oldest_matches(messages, "*", 2, {}, None, None)
        assert len(tru_result) == 3
        assert tru_result[0] is messages[0]
        assert tru_result[2] is messages[2]

    def test_returns_empty_when_count_exceeds_matches(self):
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="msg1")]),
            Message(role="assistant", content=[ContentBlock(text="msg2")]),
        ]
        assert _get_oldest_matches(messages, "*", 5, {}, None, None) == []

    def test_returns_empty_when_count_equals_matches(self):
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="msg1")]),
        ]
        assert _get_oldest_matches(messages, "*", 1, {}, None, None) == []


class TestDropStrategy:
    """Tests for DropStrategy per-block execution."""

    @pytest.mark.asyncio
    async def test_replaces_tool_result_with_marker(self, mock_agent):
        strategy = Offload.drop("tool_results").when(threshold=100)
        _, user_msg = _make_tool_pair()
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            user_msg,
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.5)
        acted = await strategy.apply(context)
        assert acted is True
        assert messages[1]["content"][0]["toolResult"]["content"][0]["text"] == DROPPED_MARKER

    @pytest.mark.asyncio
    async def test_replaces_text_with_marker(self, mock_agent):
        strategy = Offload.drop("*").when(threshold=100)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="assistant", content=[ContentBlock(text="x" * 10000)]),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.5)
        acted = await strategy.apply(context)
        assert acted is True
        assert messages[1]["content"][0]["text"] == DROPPED_MARKER

    @pytest.mark.asyncio
    async def test_skips_below_threshold(self, mock_agent):
        mock_agent.model.count_tokens = unittest.mock.AsyncMock(return_value=50)
        strategy = Offload.drop("*").when(threshold=100)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="assistant", content=[ContentBlock(text="short")]),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.5)
        assert await strategy.apply(context) is False


class TestTruncateStrategy:
    """Tests for TruncateStrategy per-block execution."""

    @pytest.mark.asyncio
    async def test_truncates_large_tool_result(self, mock_agent):
        strategy = Offload.truncate("tool_results", {"preview_tokens": 100}).when(threshold=200)
        _, user_msg = _make_tool_pair()
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            user_msg,
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.5)
        assert await strategy.apply(context) is True
        assert "[Truncated:" in messages[1]["content"][0]["toolResult"]["content"][0]["text"]

    @pytest.mark.asyncio
    async def test_truncates_large_text_block(self, mock_agent):
        strategy = Offload.truncate("*", {"preview_tokens": 100}).when(threshold=200)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="assistant", content=[ContentBlock(text="a" * 50000)]),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.5)
        assert await strategy.apply(context) is True
        assert "[Truncated:" in messages[1]["content"][0]["text"]


class TestMessageLevelDrop:
    """Tests for message-level drop — base _apply_per_message behavior exercised via Drop."""

    @pytest.mark.asyncio
    async def test_removes_oldest_messages(self, mock_agent):
        strategy = Offload.drop("*").when(utilization=0.8)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="assistant", content=[ContentBlock(text="old1")]),
            Message(role="user", content=[ContentBlock(text="old2")]),
            Message(role="assistant", content=[ContentBlock(text="old3")]),
            Message(role="user", content=[ContentBlock(text="recent")]),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.9)
        assert await strategy.apply(context) is True
        assert len(messages) < 5

    @pytest.mark.asyncio
    async def test_skips_when_below_utilization(self, mock_agent):
        strategy = Offload.drop("*").when(utilization=0.8)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="assistant", content=[ContentBlock(text="content")]),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.5)
        assert await strategy.apply(context) is False

    @pytest.mark.asyncio
    async def test_inserts_dropped_marker(self, mock_agent):
        strategy = Offload.drop("*").when(utilization=0.8)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="assistant", content=[ContentBlock(text="old1")]),
            Message(role="user", content=[ContentBlock(text="old2")]),
            Message(role="assistant", content=[ContentBlock(text="old3")]),
            Message(role="user", content=[ContentBlock(text="old4")]),
            Message(role="assistant", content=[ContentBlock(text="recent")]),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.9)
        await strategy.apply(context)
        all_text = " ".join(block.get("text", "") for msg in messages for block in msg["content"])
        assert "[Dropped:" in all_text

    @pytest.mark.asyncio
    async def test_preserves_alternation(self, mock_agent):
        strategy = Offload.drop("*").when(utilization=0.8)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="assistant", content=[ContentBlock(text="a1")]),
            Message(role="user", content=[ContentBlock(text="u2")]),
            Message(role="assistant", content=[ContentBlock(text="a2")]),
            Message(role="user", content=[ContentBlock(text="u3")]),
            Message(role="assistant", content=[ContentBlock(text="a3")]),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.9)
        await strategy.apply(context)
        for idx in range(len(messages) - 1):
            assert messages[idx]["role"] != messages[idx + 1]["role"]

    @pytest.mark.asyncio
    async def test_returns_false_with_single_message(self, mock_agent):
        strategy = Offload.drop("*").when(utilization=0.8)
        messages: Messages = [Message(role="user", content=[ContentBlock(text="only")])]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.9)
        assert await strategy.apply(context) is False

    @pytest.mark.asyncio
    async def test_returns_false_when_no_eligible_messages(self, mock_agent):
        strategy = Offload.drop("assistant_text").when(utilization=0.8)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="user", content=[ContentBlock(text="only user messages")]),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.9)
        assert await strategy.apply(context) is False

    @pytest.mark.asyncio
    async def test_returns_false_when_splice_removes_nothing(self, mock_agent):
        strategy = Offload.drop("*").when(utilization=0.8)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="assistant", content=[ContentBlock(text="a")]),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.9)
        with unittest.mock.patch(
            "strands._context_manager.strategies.offload.base._splice_with_pairs",
            return_value=(0, 1),
        ):
            assert await strategy.apply(context) is False


class TestEmergencyTruncateStrategy:
    """Tests for the last-resort emergency truncation."""

    @pytest.mark.asyncio
    async def test_fires_when_utilization_above_one(self, mock_agent):
        mock_agent.model.count_tokens = unittest.mock.AsyncMock(return_value=110000)
        mock_agent.model.estimate_utilization = unittest.mock.MagicMock(return_value=1.1)
        strategy = EmergencyTruncateStrategy()
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="assistant", content=[ContentBlock(text="a1")]),
            Message(role="user", content=[ContentBlock(text="u2")]),
            Message(role="assistant", content=[ContentBlock(text="a2")]),
            Message(role="user", content=[ContentBlock(text="u3")]),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=1.1)
        assert await strategy.apply(context) is True
        assert len(messages) < 5

    @pytest.mark.asyncio
    async def test_does_not_fire_when_under_one(self, mock_agent):
        mock_agent.model.count_tokens = unittest.mock.AsyncMock(return_value=80000)
        mock_agent.model.estimate_utilization = unittest.mock.MagicMock(return_value=0.8)
        strategy = EmergencyTruncateStrategy()
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="assistant", content=[ContentBlock(text="a1")]),
            Message(role="user", content=[ContentBlock(text="u2")]),
            Message(role="assistant", content=[ContentBlock(text="a2")]),
        ]
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.8)
        assert await strategy.apply(context) is False

    @pytest.mark.asyncio
    async def test_does_not_fire_with_three_or_fewer_messages(self, mock_agent):
        mock_agent.model.count_tokens = unittest.mock.AsyncMock(return_value=110000)
        mock_agent.model.estimate_utilization = unittest.mock.MagicMock(return_value=1.1)
        strategy = EmergencyTruncateStrategy()
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="assistant", content=[ContentBlock(text="a")]),
            Message(role="user", content=[ContentBlock(text="u")]),
        ]
        context = ContextState(messages=messages, agent=mock_agent, utilization=1.1)
        assert await strategy.apply(context) is False


class TestEagerHookRegistration:
    """Tests for BaseOffloadStrategy.init — eager hook registration."""

    def test_registers_eager_hook_for_per_block_strategy(self):
        strategy = Offload.drop("tool_results").when(threshold=100)
        agent = unittest.mock.MagicMock()
        agent.hooks = HookRegistry()
        strategy.init(agent)
        assert len(agent.hooks._registered_callbacks.get(MessageAddedEvent, [])) == 1

    def test_skips_hook_for_message_level_strategy(self):
        strategy = Offload.drop("*").when(utilization=0.8)
        agent = unittest.mock.MagicMock()
        agent.hooks = HookRegistry()
        strategy.init(agent)
        assert len(agent.hooks._registered_callbacks.get(MessageAddedEvent, [])) == 0

    def test_skips_hook_when_preserve_recent_set(self):
        strategy = Offload.drop("tool_results").when(threshold=100, preserve_recent=2)
        agent = unittest.mock.MagicMock()
        agent.hooks = HookRegistry()
        strategy.init(agent)
        assert len(agent.hooks._registered_callbacks.get(MessageAddedEvent, [])) == 0

    @pytest.mark.asyncio
    async def test_eager_hook_fires_and_transforms(self):
        strategy = Offload.drop("*").when(threshold=100)
        agent = unittest.mock.MagicMock()
        agent.hooks = HookRegistry()
        agent.model = unittest.mock.AsyncMock()
        agent.model.count_tokens = unittest.mock.AsyncMock(return_value=5000)
        strategy.init(agent)

        message = Message(role="assistant", content=[ContentBlock(text="x" * 10000)])
        agent.messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            message,
        ]
        event = MessageAddedEvent(agent=agent, message=message)
        callbacks = agent.hooks._registered_callbacks[MessageAddedEvent]
        await callbacks[0].callback(event)
        assert message["content"][0]["text"] == DROPPED_MARKER


class TestBlockMatchesTarget:
    """Tests for _block_matches_target — non-text/non-tool blocks."""

    def test_image_block_matches_wildcard(self):
        strategy = Offload.drop("*").when(threshold=100)
        block = ContentBlock(image={"format": "png", "source": {"bytes": b"fake"}})
        message = Message(role="user", content=[block])
        assert strategy._block_matches_target(block, message, {}) is True

    def test_image_block_matches_none_target(self):
        strategy = Offload.drop(None).when(threshold=100)
        block = ContentBlock(image={"format": "png", "source": {"bytes": b"fake"}})
        message = Message(role="user", content=[block])
        assert strategy._block_matches_target(block, message, {}) is True

    def test_image_block_rejects_tool_results_target(self):
        strategy = Offload.drop("tool_results").when(threshold=100)
        block = ContentBlock(image={"format": "png", "source": {"bytes": b"fake"}})
        message = Message(role="user", content=[block])
        assert strategy._block_matches_target(block, message, {}) is False

    def test_document_block_matches_wildcard(self):
        strategy = Offload.drop("*").when(threshold=100)
        block = ContentBlock(document={"format": "pdf", "name": "doc", "source": {"bytes": b"fake"}})
        message = Message(role="user", content=[block])
        assert strategy._block_matches_target(block, message, {}) is True

    def test_tool_use_block_never_matches(self):
        strategy = Offload.drop("*").when(threshold=100)
        block = ContentBlock(toolUse=ToolUse(toolUseId="tu-1", name="bash", input={}))
        message = Message(role="assistant", content=[block])
        assert strategy._block_matches_target(block, message, {}) is False


class TestTransformBlocks:
    """Tests for _transform_blocks — media block handling per strategy."""

    @pytest.mark.asyncio
    async def test_drop_image_block(self, mock_agent):
        strategy = Offload.drop("*").when(threshold=100)
        image_block = ContentBlock(image={"format": "png", "source": {"bytes": b"fake"}})
        message = Message(role="user", content=[image_block])
        assert await strategy._transform_blocks(message, [message], {}, mock_agent) is True
        assert message["content"][0]["text"] == "[Dropped]"

    @pytest.mark.asyncio
    async def test_drop_document_block(self, mock_agent):
        strategy = Offload.drop("*").when(threshold=100)
        doc_block = ContentBlock(document={"format": "pdf", "name": "doc", "source": {"bytes": b"fake"}})
        message = Message(role="user", content=[doc_block])
        assert await strategy._transform_blocks(message, [message], {}, mock_agent) is True
        assert message["content"][0]["text"] == "[Dropped]"

    @pytest.mark.asyncio
    async def test_truncate_image_block(self, mock_agent):
        strategy = Offload.truncate("*", {"preview_tokens": 50}).when(threshold=100)
        image_block = ContentBlock(image={"format": "png", "source": {"bytes": b"fake"}})
        message = Message(role="user", content=[image_block])
        assert await strategy._transform_blocks(message, [message], {}, mock_agent) is True
        assert "[Offloaded: ~" in message["content"][0]["text"]

    @pytest.mark.asyncio
    async def test_skips_reasoning_content_block(self, mock_agent):
        strategy = Offload.drop("*").when(threshold=100)
        reasoning_block = ContentBlock(reasoningContent={"reasoningText": {"text": "thinking..."}})
        message = Message(role="assistant", content=[reasoning_block])
        assert await strategy._transform_blocks(message, [message], {}, mock_agent) is False
        assert "reasoningContent" in message["content"][0]

    @pytest.mark.asyncio
    async def test_skips_cache_point_block(self, mock_agent):
        strategy = Offload.drop("*").when(threshold=100)
        cache_block = ContentBlock(cachePoint={"type": "default"})
        message = Message(role="assistant", content=[cache_block])
        assert await strategy._transform_blocks(message, [message], {}, mock_agent) is False
        assert "cachePoint" in message["content"][0]


class TestGetEligibleMessages:
    """Tests for _get_eligible_messages — preserve_recent and threshold filtering."""

    @pytest.mark.asyncio
    async def test_preserve_recent_excludes_recent_matches(self, mock_agent):
        strategy = Offload.drop("*").when(utilization=0.8, preserve_recent=1)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="assistant", content=[ContentBlock(text="old")]),
            Message(role="user", content=[ContentBlock(text="recent")]),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.9)
        assert len(await strategy._get_eligible_messages(context)) <= 1

    @pytest.mark.asyncio
    async def test_threshold_filters_messages_without_oversize_blocks(self, mock_agent):
        mock_agent.model.count_tokens = unittest.mock.AsyncMock(return_value=50)
        strategy = Offload.drop("*").when(utilization=0.8, threshold=100)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="assistant", content=[ContentBlock(text="small")]),
            Message(role="user", content=[ContentBlock(text="also small")]),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.9)
        assert await strategy._get_eligible_messages(context) == []

    @pytest.mark.asyncio
    async def test_threshold_includes_messages_with_oversize_blocks(self, mock_agent):
        mock_agent.model.count_tokens = unittest.mock.AsyncMock(return_value=5000)
        strategy = Offload.drop("*").when(utilization=0.8, threshold=100)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="assistant", content=[ContentBlock(text="large" * 10000)]),
            Message(role="user", content=[ContentBlock(text="also large" * 10000)]),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.9)
        assert len(await strategy._get_eligible_messages(context)) == 2

    @pytest.mark.asyncio
    async def test_no_threshold_returns_all_candidates(self, mock_agent):
        strategy = Offload.drop("*").when(utilization=0.8)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="assistant", content=[ContentBlock(text="msg1")]),
            Message(role="user", content=[ContentBlock(text="msg2")]),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.9)
        assert len(await strategy._get_eligible_messages(context)) == 2


class TestTruncateStrategyPerMessage:
    """Tests for TruncateStrategy._apply_per_message — head/tail preview logic."""

    @pytest.mark.asyncio
    async def test_removes_middle_messages_and_inserts_elided_marker(self, mock_agent):
        strategy = Offload.truncate("*").when(utilization=0.8)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="assistant", content=[ContentBlock(text="head")]),
            Message(role="user", content=[ContentBlock(text="mid1")]),
            Message(role="assistant", content=[ContentBlock(text="mid2")]),
            Message(role="user", content=[ContentBlock(text="mid3")]),
            Message(role="assistant", content=[ContentBlock(text="mid4")]),
            Message(role="user", content=[ContentBlock(text="mid5")]),
            Message(role="assistant", content=[ContentBlock(text="mid6")]),
            Message(role="user", content=[ContentBlock(text="tail1")]),
            Message(role="assistant", content=[ContentBlock(text="tail2")]),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.9)
        assert await strategy.apply(context) is True
        all_text = " ".join(block.get("text", "") for msg in messages for block in msg["content"])
        assert "elided" in all_text
        assert len(messages) < 10

    @pytest.mark.asyncio
    async def test_preserves_alternation_after_truncation(self, mock_agent):
        strategy = Offload.truncate("*").when(utilization=0.8)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="assistant", content=[ContentBlock(text="a1")]),
            Message(role="user", content=[ContentBlock(text="u2")]),
            Message(role="assistant", content=[ContentBlock(text="a2")]),
            Message(role="user", content=[ContentBlock(text="u3")]),
            Message(role="assistant", content=[ContentBlock(text="a3")]),
            Message(role="user", content=[ContentBlock(text="u4")]),
            Message(role="assistant", content=[ContentBlock(text="a4")]),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.9)
        await strategy.apply(context)
        for idx in range(len(messages) - 1):
            assert messages[idx]["role"] != messages[idx + 1]["role"]

    @pytest.mark.asyncio
    async def test_marker_uses_singular_for_one_message(self, mock_agent):
        strategy = Offload.truncate("*").when(utilization=0.8)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="assistant", content=[ContentBlock(text="a1")]),
            Message(role="user", content=[ContentBlock(text="u2")]),
            Message(role="assistant", content=[ContentBlock(text="a2")]),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.9)
        await strategy.apply(context)
        all_text = " ".join(block.get("text", "") for msg in messages for block in msg["content"])
        assert "1 message elided" in all_text

    @pytest.mark.asyncio
    async def test_marker_uses_plural_for_multiple_messages(self, mock_agent):
        strategy = Offload.truncate("*").when(utilization=0.8)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="assistant", content=[ContentBlock(text="a1")]),
            Message(role="user", content=[ContentBlock(text="u1")]),
            Message(role="assistant", content=[ContentBlock(text="a2")]),
            Message(role="user", content=[ContentBlock(text="u2")]),
            Message(role="assistant", content=[ContentBlock(text="a3")]),
            Message(role="user", content=[ContentBlock(text="u3")]),
            Message(role="assistant", content=[ContentBlock(text="a4")]),
            Message(role="user", content=[ContentBlock(text="u4")]),
            Message(role="assistant", content=[ContentBlock(text="a5")]),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.9)
        await strategy.apply(context)
        all_text = " ".join(block.get("text", "") for msg in messages for block in msg["content"])
        assert "messages elided" in all_text
