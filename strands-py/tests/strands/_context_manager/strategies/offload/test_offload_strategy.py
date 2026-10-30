"""Tests for offload strategies — truncate, drop, and base infrastructure."""

import unittest.mock

import pytest

from strands._context_manager.strategies.offload import Offload
from strands._context_manager.strategies.offload.base import (
    _build_tool_name_map,
    _collect_removable_with_pair,
    _get_oldest_matches,
    _insert_marker,
    _Measure,
    _message_matches_target,
    _repair_alternation,
    _resolve_tool_filter,
    _splice_with_pairs,
    _target_matches_message,
    _tool_matches_target,
)
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


def _text(role, text):
    return Message(role=role, content=[ContentBlock(text=text)])


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

    def test_mixed_list_subtracts_excludes_from_includes(self):
        include, exclude = _resolve_tool_filter(["tool::bash", "python", "!tool::python", "!grep"])
        assert include == {"bash"}
        assert exclude is None

    def test_rejects_list_that_excludes_every_include(self):
        with pytest.raises(ValueError, match="excludes every tool it includes"):
            Offload.drop(["tool::bash", "!bash"])

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
            Message(role="assistant", content=[ContentBlock(text="latest")]),
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
            Message(role="assistant", content=[ContentBlock(text="latest")]),
        ]
        tru_result = _collect_removable_with_pair(messages, 1)
        assert assistant_msg in tru_result
        assert user_msg in tru_result

    def test_never_collects_last_message(self):
        messages: Messages = [_text("user", "task"), _text("assistant", "a1"), _text("user", "latest")]
        assert _collect_removable_with_pair(messages, 2) == []

    def test_skips_tool_use_whose_result_is_last_message(self):
        assistant_msg, user_msg = _make_tool_pair()
        messages: Messages = [_text("user", "task"), assistant_msg, user_msg]
        assert _collect_removable_with_pair(messages, 1) == []

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
            Message(role="assistant", content=[ContentBlock(text="latest")]),
        ]
        removed, lowest = _splice_with_pairs(messages, [user_msg])
        assert removed == 2
        assert lowest == 1
        assert len(messages) == 2


class TestOffloadFactory:
    """Tests for the Offload namespace and .when()."""

    @pytest.mark.parametrize(
        ("strategy", "exp_name"),
        [
            (Offload.drop("tool_results"), "offload:drop"),
            (Offload.truncate("tool_results", {"preview_tokens": 500}), "offload:truncate"),
            (Offload.summarize("tool_results"), "offload:summarize"),
        ],
    )
    def test_strategy_runs_without_when(self, mock_agent, strategy, exp_name):
        strategy.init(mock_agent)
        assert strategy.name == exp_name
        assert strategy._runs_eagerly

    def test_when_replaces_conditions_and_keeps_config(self):
        bare = Offload.truncate("tool_results", {"preview_tokens": 500})
        strategy = bare.when(block_threshold=2000).when(preserve_recent=2)
        assert strategy is not bare
        assert (strategy._target, strategy._truncate_config) == ("tool_results", {"preview_tokens": 500})
        assert (strategy._block_threshold, strategy._preserve_recent) == (None, _Measure(2, is_share=False))

    @pytest.mark.parametrize(
        ("target", "exp_error"),
        [("*", r'\("\*"\) would act on every message'), ("media", r'\("media"\) would remove media')],
    )
    def test_strategy_that_cannot_run_without_conditions_raises_on_init(self, mock_agent, target, exp_error):
        strategy = Offload.drop(target)
        with pytest.raises(ValueError, match=exp_error):
            strategy.init(mock_agent)

    def test_when_adds_conditions(self):
        strategy = Offload.truncate("tool_results").when(block_threshold=2000)
        assert strategy._block_threshold == _Measure(2000, is_share=False)

    def test_when_with_utilization(self):
        strategy = Offload.drop("*").when(context_utilization="85%")
        assert strategy._context_utilization == _Measure(0.85, is_share=True)

    def test_truncate_validates_threshold_gt_preview(self):
        with pytest.raises(ValueError, match="must be greater than preview_tokens"):
            Offload.truncate("tool_results", {"preview_tokens": 1000}).when(block_threshold=500)

    @pytest.mark.parametrize(("window", "threshold", "exp_tokens"), [(100_000, "1%", 1000), (None, "0.1%", 200)])
    def test_truncate_checks_percent_threshold_against_preview_on_init(self, mock_agent, window, threshold, exp_tokens):
        mock_agent.model.context_window_limit = window
        strategy = Offload.truncate("tool_results", {"preview_tokens": 1000}).when(block_threshold=threshold)
        with pytest.raises(
            ValueError, match=rf"block_threshold \({exp_tokens} tokens of the context window\) must be greater"
        ):
            strategy.init(mock_agent)

    def test_truncate_accepts_percent_threshold_above_preview_on_init(self, mock_agent):
        mock_agent.model.context_window_limit = 100_000
        Offload.truncate("tool_results", {"preview_tokens": 1000}).when(block_threshold="2%").init(mock_agent)

    def test_empty_list_target_raises(self):
        with pytest.raises(ValueError, match="Empty array target"):
            Offload.drop([])

    @pytest.mark.parametrize("builder", [Offload.drop("*"), Offload.truncate("*"), Offload.summarize("*")])
    @pytest.mark.parametrize("preserve_recent", [0, "0%"])
    def test_rejects_eager_message_level(self, builder, preserve_recent):
        with pytest.raises(ValueError, match=r'\("\*"\) would act on every message'):
            builder.when(preserve_recent=preserve_recent)

    @pytest.mark.parametrize("builder", [Offload.drop("media"), Offload.truncate("media"), Offload.summarize("media")])
    @pytest.mark.parametrize("conditions", [{}, {"block_threshold": 100}, {"preserve_recent": "0%"}])
    def test_rejects_eager_media(self, builder, conditions):
        with pytest.raises(ValueError, match=r'\("media"\) would remove media before the model sees it'):
            builder.when(**conditions)

    @pytest.mark.parametrize("conditions", [{"context_utilization": "80%"}, {"preserve_recent": 1}])
    def test_allows_gated_media(self, conditions):
        assert Offload.drop("media").when(**conditions).name == "offload:drop"

    def test_allows_wildcard_with_only_threshold(self):
        assert Offload.drop("*").when(block_threshold=100).name == "offload:drop"

    def test_truncate_wildcard_validates_threshold_gt_preview(self):
        with pytest.raises(ValueError, match=r"block_threshold \(500\) must be greater than preview_tokens \(1000\)"):
            Offload.truncate("*", {"preview_tokens": 1000}).when(block_threshold=500)


class TestConditionParsing:
    """Tests for parsing utilization, threshold, and preserve_recent values."""

    @pytest.mark.parametrize(
        ("name", "value", "expected"),
        [
            ("context_utilization", "70%", _Measure(0.7, is_share=True)),
            ("context_utilization", 50_000, _Measure(50_000, is_share=False)),
            ("context_utilization", 1000, _Measure(1000, is_share=False)),
            ("block_threshold", 2500, _Measure(2500, is_share=False)),
            ("block_threshold", "5%", _Measure(0.05, is_share=True)),
            ("preserve_recent", 4, _Measure(4, is_share=False)),
            ("preserve_recent", "50%", _Measure(0.5, is_share=True)),
        ],
    )
    def test_accepts(self, name, value, expected):
        strategy = Offload.drop("tool_results").when(**{name: value})
        assert getattr(strategy, f"_{name}") == expected

    @pytest.mark.parametrize(
        ("name", "value"),
        [
            ("context_utilization", 0),
            ("context_utilization", 0.5),
            ("context_utilization", 1),
            ("context_utilization", 1.5),
            ("context_utilization", "101%"),
            ("context_utilization", "70"),
            ("block_threshold", 0),
            ("block_threshold", -1),
            ("block_threshold", 0.5),
            ("block_threshold", "100%"),
            ("preserve_recent", 0.5),
            ("preserve_recent", 1.5),
            ("preserve_recent", "100%"),
        ],
    )
    def test_rejects(self, name, value):
        with pytest.raises(ValueError, match=f"{name}="):
            Offload.drop("tool_results").when(**{name: value})

    @pytest.mark.parametrize(
        ("name", "value", "exp_hint"),
        [
            ("context_utilization", 80, '; for 80%, write "80%"$'),
            ("context_utilization", 0.8, '; for 80%, write "80%"$'),
            ("context_utilization", 1, '; for 100%, write "100%"$'),
            ("context_utilization", 999, r"of at least 1000$"),
            ("preserve_recent", 0.7, '; for 70%, write "70%"$'),
            ("preserve_recent", 4.0, "; for a count, write 4$"),
            ("context_utilization", 1500.0, "; for a count, write 1500$"),
            ("preserve_recent", 1.0, "a whole message count$"),
            ("block_threshold", 1.0, "a whole token count above 0$"),
        ],
    )
    def test_rejected_number_suggests_the_spelling_it_reads_as(self, name, value, exp_hint):
        with pytest.raises(ValueError, match=exp_hint):
            Offload.drop("tool_results").when(**{name: value})


class TestConditionResolution:
    """Tests for resolving token counts and percents against the context window."""

    @pytest.mark.parametrize(
        ("window", "exp_threshold"),
        [(100_000, 5000), (None, 10_000)],
    )
    def test_percent_threshold_resolves_against_window(self, mock_agent, window, exp_threshold):
        mock_agent.model.context_window_limit = window
        strategy = Offload.drop("tool_results").when(block_threshold="5%")
        assert strategy._resolve_threshold(mock_agent) == exp_threshold

    @pytest.mark.parametrize(("utilization", "exp_reached"), [(0.5, True), (0.49, False)])
    def test_token_utilization_resolves_against_window(self, mock_agent, utilization, exp_reached):
        mock_agent.model.context_window_limit = 100_000
        strategy = Offload.drop("*").when(context_utilization=50_000)
        context = ContextState(messages=[], agent=mock_agent, utilization=utilization)
        assert strategy._utilization_reached(context) is exp_reached

    def test_token_utilization_above_window_raises_on_init(self, mock_agent):
        mock_agent.model.context_window_limit = 100_000
        strategy = Offload.drop("*").when(context_utilization=100_001)
        with pytest.raises(
            ValueError, match=r"context_utilization \(100001\) is larger than the model's context window"
        ):
            strategy.init(mock_agent)

    @pytest.mark.parametrize(
        ("window", "utilization"),
        [(100_000, 100_000), (100_000, "100%"), (None, "80%")],
    )
    def test_utilization_within_window_inits(self, mock_agent, window, utilization):
        mock_agent.model.context_window_limit = window
        Offload.drop("*").when(context_utilization=utilization).init(mock_agent)

    def test_token_utilization_without_window_warns_on_init(self, mock_agent):
        mock_agent.model.context_window_limit = None
        strategy = Offload.drop("*").when(context_utilization=500_000)
        with pytest.warns(
            UserWarning, match=r"context_utilization \(500000\) can't be checked against the context window"
        ):
            strategy.init(mock_agent)


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
        tru_result = _get_oldest_matches(messages, "*", _Measure(2, is_share=False), {}, None, None)
        assert len(tru_result) == 3
        assert tru_result[0] is messages[0]
        assert tru_result[2] is messages[2]

    def test_returns_empty_when_count_exceeds_matches(self):
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="msg1")]),
            Message(role="assistant", content=[ContentBlock(text="msg2")]),
        ]
        assert _get_oldest_matches(messages, "*", _Measure(5, is_share=False), {}, None, None) == []

    def test_returns_empty_when_count_equals_matches(self):
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="msg1")]),
        ]
        assert _get_oldest_matches(messages, "*", _Measure(1, is_share=False), {}, None, None) == []

    def test_ratio_preserves_fraction_of_matches(self):
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="msg1")]),
            Message(role="assistant", content=[ContentBlock(text="msg2")]),
            Message(role="user", content=[ContentBlock(text="msg3")]),
            Message(role="assistant", content=[ContentBlock(text="msg4")]),
            Message(role="user", content=[ContentBlock(text="msg5")]),
        ]
        # 70% of 5 matching → ceil(5 * 0.7) = 4 preserved → 1 oldest returned
        tru_result = _get_oldest_matches(messages, "*", _Measure(0.7, is_share=True), {}, None, None)
        assert len(tru_result) == 1
        assert tru_result[0] is messages[0]

    def test_ratio_zero_preserves_nothing(self):
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="msg1")]),
            Message(role="assistant", content=[ContentBlock(text="msg2")]),
        ]
        tru_result = _get_oldest_matches(messages, "*", _Measure(0, is_share=False), {}, None, None)
        assert len(tru_result) == 2


class TestDropStrategy:
    """Tests for DropStrategy per-block execution."""

    @pytest.mark.asyncio
    async def test_replaces_tool_result_with_marker(self, mock_agent):
        strategy = Offload.drop("tool_results").when(block_threshold=100)
        _, user_msg = _make_tool_pair()
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            user_msg,
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.5)
        acted = await strategy.apply(context)
        assert acted is True
        assert messages[1]["content"][0]["toolResult"]["content"][0]["text"] == "[Dropped: ~5,000 tokens]"

    @pytest.mark.asyncio
    async def test_replaces_text_with_marker(self, mock_agent):
        strategy = Offload.drop("assistant_text").when(block_threshold=100)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="assistant", content=[ContentBlock(text="x" * 10000)]),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.5)
        acted = await strategy.apply(context)
        assert acted is True
        assert messages[1]["content"][0]["text"] == "[Dropped: ~5,000 tokens]"

    @pytest.mark.asyncio
    async def test_skips_below_threshold(self, mock_agent):
        mock_agent.model.count_tokens = unittest.mock.AsyncMock(return_value=50)
        strategy = Offload.drop("assistant_text").when(block_threshold=100)
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
        strategy = Offload.truncate("tool_results", {"preview_tokens": 100}).when(block_threshold=200)
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
        strategy = Offload.truncate("assistant_text", {"preview_tokens": 100}).when(block_threshold=200)
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
        strategy = Offload.drop("*").when(context_utilization="80%")
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
        strategy = Offload.drop("*").when(context_utilization="80%")
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="assistant", content=[ContentBlock(text="content")]),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.5)
        assert await strategy.apply(context) is False

    @pytest.mark.asyncio
    async def test_inserts_dropped_marker(self, mock_agent):
        strategy = Offload.drop("*").when(context_utilization="80%")
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
        strategy = Offload.drop("*").when(context_utilization="80%")
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
        strategy = Offload.drop("*").when(context_utilization="80%")
        messages: Messages = [Message(role="user", content=[ContentBlock(text="only")])]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.9)
        assert await strategy.apply(context) is False

    @pytest.mark.asyncio
    async def test_returns_false_when_no_eligible_messages(self, mock_agent):
        strategy = Offload.drop("assistant_text").when(context_utilization="80%")
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="user", content=[ContentBlock(text="only user messages")]),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.9)
        assert await strategy.apply(context) is False

    @pytest.mark.asyncio
    async def test_returns_false_when_splice_removes_nothing(self, mock_agent):
        strategy = Offload.drop("*").when(context_utilization="80%")
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
    async def test_leaves_marker_on_assistant_after_cut(self, mock_agent):
        strategy = EmergencyTruncateStrategy()
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="assistant", content=[ContentBlock(text="a1")]),
            Message(role="user", content=[ContentBlock(text="u2")]),
            Message(role="assistant", content=[ContentBlock(text="a2")]),
            Message(role="user", content=[ContentBlock(text="u3")]),
        ]
        context = ContextState(messages=messages, agent=mock_agent, utilization=1.1, overflow=True)
        assert await strategy.apply(context) is True
        assert [(m["role"], [b["text"] for b in m["content"]]) for m in messages] == [
            ("user", ["pin"]),
            ("assistant", ["a2", "[... 2 messages elided ...]"]),
            ("user", ["u3"]),
        ]

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
        strategy = Offload.drop("tool_results").when(block_threshold=100)
        agent = unittest.mock.MagicMock()
        agent.hooks = HookRegistry()
        strategy.init(agent)
        assert len(agent.hooks._registered_callbacks.get(MessageAddedEvent, [])) == 1

    def test_skips_hook_for_message_level_strategy(self):
        strategy = Offload.drop("*").when(context_utilization="80%")
        agent = unittest.mock.MagicMock()
        agent.hooks = HookRegistry()
        strategy.init(agent)
        assert len(agent.hooks._registered_callbacks.get(MessageAddedEvent, [])) == 0

    def test_skips_hook_when_preserve_recent_set(self):
        strategy = Offload.drop("tool_results").when(block_threshold=100, preserve_recent=2)
        agent = unittest.mock.MagicMock()
        agent.hooks = HookRegistry()
        strategy.init(agent)
        assert len(agent.hooks._registered_callbacks.get(MessageAddedEvent, [])) == 0

    @pytest.mark.asyncio
    async def test_eager_hook_fires_and_transforms(self):
        strategy = Offload.drop("assistant_text").when(block_threshold=100)
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
        assert message["content"][0]["text"] == "[Dropped: ~5,000 tokens]"


class TestBlockMatchesTarget:
    """Tests for _block_matches_target — non-text/non-tool blocks."""

    def test_image_block_matches_media(self):
        strategy = Offload.drop("media").when(context_utilization="50%", block_threshold=100)
        block = ContentBlock(image={"format": "png", "source": {"bytes": b"fake"}})
        message = Message(role="user", content=[ContentBlock(text="look"), block])
        assert strategy._block_matches_target(block, message, {}) is True
        assert strategy._block_matches_target(message["content"][0], message, {}) is False

    def test_media_target_skips_media_inside_tool_results(self):
        strategy = Offload.drop("media").when(context_utilization="50%", block_threshold=100)
        _, user_msg = _make_tool_pair()
        assert strategy._block_matches_target(user_msg["content"][0], user_msg, {"tu-1": "my_tool"}) is False

    def test_image_block_matches_wildcard(self):
        strategy = Offload.drop("*").when(block_threshold=100)
        block = ContentBlock(image={"format": "png", "source": {"bytes": b"fake"}})
        message = Message(role="user", content=[block])
        assert strategy._block_matches_target(block, message, {}) is True

    def test_image_block_matches_none_target(self):
        strategy = Offload.drop(None).when(block_threshold=100)
        block = ContentBlock(image={"format": "png", "source": {"bytes": b"fake"}})
        message = Message(role="user", content=[block])
        assert strategy._block_matches_target(block, message, {}) is True

    def test_image_block_rejects_tool_results_target(self):
        strategy = Offload.drop("tool_results").when(block_threshold=100)
        block = ContentBlock(image={"format": "png", "source": {"bytes": b"fake"}})
        message = Message(role="user", content=[block])
        assert strategy._block_matches_target(block, message, {}) is False

    def test_document_block_matches_wildcard(self):
        strategy = Offload.drop("*").when(block_threshold=100)
        block = ContentBlock(document={"format": "pdf", "name": "doc", "source": {"bytes": b"fake"}})
        message = Message(role="user", content=[block])
        assert strategy._block_matches_target(block, message, {}) is True

    def test_tool_use_block_never_matches(self):
        strategy = Offload.drop("*").when(block_threshold=100)
        block = ContentBlock(toolUse=ToolUse(toolUseId="tu-1", name="bash", input={}))
        message = Message(role="assistant", content=[block])
        assert strategy._block_matches_target(block, message, {}) is False


class TestTransformBlocks:
    """Tests for _transform_blocks — media block handling per strategy."""

    @pytest.mark.asyncio
    async def test_drop_image_block(self, mock_agent):
        strategy = Offload.drop("*").when(block_threshold=100)
        image_block = ContentBlock(image={"format": "png", "source": {"bytes": b"fake"}})
        message = Message(role="user", content=[image_block])
        assert await strategy._transform_blocks(message, [message], {}, mock_agent) is True
        assert (
            message["content"][0]["text"]
            == "[Dropped: image, ~5,000 tokens, removed from context after it was received]"
        )

    @pytest.mark.asyncio
    async def test_drop_document_block(self, mock_agent):
        strategy = Offload.drop("*").when(block_threshold=100)
        doc_block = ContentBlock(document={"format": "pdf", "name": "doc", "source": {"bytes": b"fake"}})
        message = Message(role="user", content=[doc_block])
        assert await strategy._transform_blocks(message, [message], {}, mock_agent) is True
        assert message["content"][0]["text"] == (
            "[Dropped: document, ~5,000 tokens, removed from context after it was received]"
        )

    @pytest.mark.asyncio
    async def test_truncate_image_block(self, mock_agent):
        strategy = Offload.truncate("*", {"preview_tokens": 50}).when(block_threshold=100)
        image_block = ContentBlock(image={"format": "png", "source": {"bytes": b"fake"}})
        message = Message(role="user", content=[image_block])
        assert await strategy._transform_blocks(message, [message], {}, mock_agent) is True
        assert (
            message["content"][0]["text"]
            == "[Offloaded: image, ~5,000 tokens, removed from context after it was received]"
        )

    @pytest.mark.asyncio
    @pytest.mark.parametrize("threshold", [None, 1000])
    async def test_acts_on_media_counted_as_zero_tokens(self, mock_agent, threshold):
        # The heuristic token count measures media as 0 tokens.
        mock_agent.model.count_tokens = unittest.mock.AsyncMock(return_value=0)
        strategy = Offload.drop("media").when(context_utilization="50%", block_threshold=threshold)
        image_block = ContentBlock(image={"format": "png", "source": {"bytes": b"fake"}})
        message = Message(role="user", content=[ContentBlock(text="what color?"), image_block])
        assert await strategy._transform_blocks(message, [message], {}, mock_agent) is True
        assert message["content"] == [
            ContentBlock(text="what color?"),
            ContentBlock(text="[Dropped: image, removed from context after it was received]"),
        ]

    @pytest.mark.asyncio
    async def test_offloaded_marker_leaves_out_an_unmeasured_size(self, mock_agent):
        mock_agent.model.count_tokens = unittest.mock.AsyncMock(return_value=0)
        strategy = Offload.truncate("media").when(context_utilization="50%")
        image_block = ContentBlock(image={"format": "png", "source": {"bytes": b"fake"}})
        message = Message(role="user", content=[image_block])
        assert await strategy._transform_blocks(message, [message], {}, mock_agent) is True
        assert message["content"][0]["text"] == "[Offloaded: image, removed from context after it was received]"

    @pytest.mark.asyncio
    async def test_without_threshold_skips_empty_text_blocks(self, mock_agent):
        strategy = Offload.drop("assistant_text")
        message = Message(role="assistant", content=[ContentBlock(text=""), ContentBlock(text="  \n")])
        assert await strategy._transform_blocks(message, [message], {}, mock_agent) is False
        assert message["content"] == [ContentBlock(text=""), ContentBlock(text="  \n")]

    @pytest.mark.asyncio
    async def test_skips_reasoning_content_block(self, mock_agent):
        strategy = Offload.drop("*").when(block_threshold=100)
        reasoning_block = ContentBlock(reasoningContent={"reasoningText": {"text": "thinking..."}})
        message = Message(role="assistant", content=[reasoning_block])
        assert await strategy._transform_blocks(message, [message], {}, mock_agent) is False
        assert "reasoningContent" in message["content"][0]

    @pytest.mark.asyncio
    async def test_skips_cache_point_block(self, mock_agent):
        strategy = Offload.drop("*").when(block_threshold=100)
        cache_block = ContentBlock(cachePoint={"type": "default"})
        message = Message(role="assistant", content=[cache_block])
        assert await strategy._transform_blocks(message, [message], {}, mock_agent) is False
        assert "cachePoint" in message["content"][0]


class TestUnconditionalWarning:
    """An unconditioned strategy warns when it's attached to an agent."""

    def test_warns_on_init_for_an_unconditioned_strategy(self, mock_agent):
        with pytest.warns(UserWarning, match=r"Offload\.drop\('assistant_text'\) has no conditions"):
            Offload.drop("assistant_text").init(mock_agent)

    @pytest.mark.parametrize(
        "strategy",
        [
            Offload.drop("assistant_text").when(block_threshold=1),
            Offload.drop("assistant_text").when(context_utilization="50%"),
            Offload.drop("assistant_text").when(preserve_recent=1),
        ],
    )
    def test_conditioned_strategy_does_not_warn(self, mock_agent, strategy, recwarn):
        strategy.init(mock_agent)
        assert not [warning for warning in recwarn if "has no conditions" in str(warning.message)]


class TestGetEligibleMessages:
    """Tests for _get_eligible_messages — preserve_recent and threshold filtering."""

    @pytest.mark.asyncio
    async def test_preserve_recent_excludes_recent_matches(self, mock_agent):
        strategy = Offload.drop("*").when(context_utilization="80%", preserve_recent=1)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="assistant", content=[ContentBlock(text="old")]),
            Message(role="user", content=[ContentBlock(text="recent")]),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.9)
        assert await strategy._get_eligible_messages(context) == [messages[1]]

    @pytest.mark.asyncio
    async def test_no_preserve_recent_returns_all_candidates(self, mock_agent):
        strategy = Offload.drop("*").when(context_utilization="80%")
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="assistant", content=[ContentBlock(text="msg1")]),
            Message(role="user", content=[ContentBlock(text="msg2")]),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.9)
        assert len(await strategy._get_eligible_messages(context)) == 2

    @pytest.mark.asyncio
    async def test_threshold_excludes_messages_at_or_under_it(self, mock_agent):
        mock_agent.model.count_tokens = unittest.mock.AsyncMock(
            side_effect=lambda msgs: len(msgs[0]["content"][0]["text"])
        )
        strategy = Offload.drop("*").when(block_threshold=100)
        messages: Messages = [
            _text("user", "pin"),
            _text("assistant", "x" * 101),
            _text("user", "x" * 100),
            _text("assistant", "x" * 500),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.5)
        assert await strategy._get_eligible_messages(context) == [messages[1], messages[3]]


class TestGranularity:
    """The target and threshold choose between whole messages and blocks; utilization only gates."""

    @staticmethod
    def _conversation() -> Messages:
        return [
            _text("user", "pin"),
            _text("assistant", "old answer"),
            _text("user", "old question"),
            _text("assistant", "recent answer"),
        ]

    @pytest.mark.asyncio
    async def test_wildcard_without_threshold_removes_messages(self, mock_agent):
        strategy = Offload.drop("*").when(context_utilization="80%", preserve_recent=1)
        messages = self._conversation()
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.9)
        assert await strategy.apply(context) is True
        assert len(messages) < 4
        assert any("[Dropped: " in block.get("text", "") for msg in messages for block in msg["content"])

    @pytest.mark.asyncio
    async def test_wildcard_with_threshold_removes_only_large_messages(self, mock_agent):
        mock_agent.model.count_tokens = unittest.mock.AsyncMock(
            side_effect=lambda msgs: len(msgs[0]["content"][0]["text"])
        )
        strategy = Offload.drop("*").when(context_utilization="80%", block_threshold=100, preserve_recent=1)
        messages: Messages = [
            _text("user", "pin"),
            _text("assistant", "x" * 500),
            _text("user", "old question"),
            _text("assistant", "recent answer"),
        ]
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.9)
        assert await strategy.apply(context) is True
        texts = [block.get("text", "") for msg in messages for block in msg["content"]]
        assert "x" * 500 not in texts
        assert "old question" in texts
        assert "recent answer" in texts

    @pytest.mark.asyncio
    async def test_truncate_wildcard_with_threshold_shortens_large_messages_in_place(self, mock_agent):
        mock_agent.model.count_tokens = unittest.mock.AsyncMock(
            side_effect=lambda msgs: len(msgs[0]["content"][0]["text"])
        )
        strategy = Offload.truncate("*", {"preview_tokens": 100}).when(block_threshold=200)
        messages: Messages = [
            _text("user", "pin"),
            _text("assistant", "x" * 500),
            _text("user", "old question"),
            _text("assistant", "y" * 500),
        ]
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.5)
        assert await strategy.apply(context) is True
        assert len(messages) == 4
        assert messages[1]["content"][0]["text"].startswith("[Truncated:")
        assert messages[2]["content"][0]["text"] == "old question"
        assert messages[3]["content"][0]["text"] == "y" * 500

    @pytest.mark.asyncio
    async def test_block_target_with_utilization_stubs_blocks(self, mock_agent):
        strategy = Offload.drop("assistant_text").when(context_utilization="80%")
        messages = self._conversation()
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.9)
        assert await strategy.apply(context) is True
        assert len(messages) == 4
        assert messages[1]["content"][0]["text"] == "[Dropped: ~5,000 tokens]"

    @pytest.mark.asyncio
    async def test_gated_block_strategy_leaves_the_last_message(self, mock_agent):
        strategy = Offload.drop("tool_results").when(context_utilization="80%")
        old_use, old_result = _make_tool_pair(tool_use_id="tu-old")
        live_use, live_result = _make_tool_pair(tool_use_id="tu-live")
        messages: Messages = [_text("user", "pin"), old_use, old_result, live_use, live_result]
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.9)
        assert await strategy.apply(context) is True
        assert messages[2]["content"][0]["toolResult"]["content"][0]["text"] == "[Dropped: ~5,000 tokens]"
        assert messages[4]["content"][0]["toolResult"]["content"][0]["text"] == "x" * 10000

    @pytest.mark.asyncio
    async def test_gated_block_strategy_leaves_the_first_message(self, mock_agent):
        strategy = Offload.drop("user_text").when(context_utilization="80%")
        messages = [*self._conversation(), _text("user", "live question")]
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.9)
        assert await strategy.apply(context) is True
        assert [msg["content"][0]["text"] for msg in messages] == [
            "pin",
            "old answer",
            "[Dropped: ~5,000 tokens]",
            "recent answer",
            "live question",
        ]

    @pytest.mark.asyncio
    async def test_utilization_gates_block_strategy(self, mock_agent):
        strategy = Offload.drop("assistant_text").when(context_utilization="80%")
        messages = self._conversation()
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.5)
        assert await strategy.apply(context) is False
        assert messages[1]["content"][0]["text"] == "old answer"


class TestTruncateStrategyPerMessage:
    """Tests for TruncateStrategy._apply_per_message — head/tail preview logic."""

    @pytest.mark.asyncio
    async def test_removes_middle_messages_and_inserts_elided_marker(self, mock_agent):
        strategy = Offload.truncate("*").when(context_utilization="80%")
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
        strategy = Offload.truncate("*").when(context_utilization="80%")
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
        strategy = Offload.truncate("*").when(context_utilization="80%", preserve_recent=2)
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
        strategy = Offload.truncate("*").when(context_utilization="80%")
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


class TestTruncateMiddleOut:
    """Tests for truncate("*") keeping the head and tail of old messages within preview_tokens."""

    @pytest.mark.asyncio
    async def test_keeps_head_and_tail_within_preview_budget(self, mock_agent):
        mock_agent.model.count_tokens = unittest.mock.AsyncMock(return_value=100)
        # head budget 600 keeps 6 messages; tail budget 400 keeps 4
        strategy = Offload.truncate("*", {"preview_tokens": 1000}).when(context_utilization="80%")
        messages: Messages = [_text("user", "pin")] + [
            _text("assistant" if index % 2 else "user", f"m{index}") for index in range(1, 21)
        ]
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.9)

        assert await strategy.apply(context) is True

        texts = [block.get("text", "") for msg in messages for block in msg["content"]]
        exp_kept = ["pin", *(f"m{index}" for index in range(1, 7)), *(f"m{index}" for index in range(17, 21))]
        assert [text for text in texts if not text.startswith("[...")] == exp_kept
        assert "[... 10 messages elided ...]" in texts

    @pytest.mark.asyncio
    async def test_converges_instead_of_eliding_its_own_marker(self, mock_agent):
        mock_agent.model.count_tokens = unittest.mock.AsyncMock(
            side_effect=lambda msgs: 100 * sum(len(msg["content"]) for msg in msgs)
        )
        strategy = Offload.truncate("*", {"preview_tokens": 1000}).when(context_utilization="80%")
        messages: Messages = [_text("user", "pin")] + [
            _text("assistant" if index % 2 else "user", f"m{index}") for index in range(1, 21)
        ]
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.9)

        assert await strategy.apply(context) is True
        exp_messages = [dict(msg, content=list(msg["content"])) for msg in messages]
        assert await strategy.apply(context) is False
        assert messages == exp_messages


class TestTruncateBlockThreshold:
    """Tests for truncate without a threshold and for skipping its own previews."""

    @pytest.mark.asyncio
    async def test_leaves_blocks_within_the_preview_and_skips_truncated_blocks(self, mock_agent):
        strategy = Offload.truncate("tool_results", {"preview_tokens": 100}).when()
        assistant_msg, user_msg = _make_tool_pair()
        messages: Messages = [_text("user", "pin"), assistant_msg, user_msg, _text("assistant", "done")]
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.5)
        tool_result_content = messages[2]["content"][0]["toolResult"]["content"]

        tool_result_content[0] = {"text": "x" * 400}
        assert await strategy.apply(context) is False

        tool_result_content[0] = {"text": "x" * 10000}
        assert await strategy.apply(context) is True
        tru_preview = messages[2]["content"][0]["toolResult"]["content"][0]["text"]
        assert tru_preview.startswith("[Truncated:")

        assert await strategy.apply(context) is False
        assert messages[2]["content"][0]["toolResult"]["content"][0]["text"] == tru_preview


class TestOverflowBypass:
    """Tests for overflow flag bypassing utilization gates."""

    @pytest.mark.asyncio
    async def test_message_level_strategy_skips_below_utilization(self, mock_agent):
        strategy = Offload.truncate("*").when(context_utilization="80%")
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="assistant", content=[ContentBlock(text="a1")]),
            Message(role="user", content=[ContentBlock(text="u2")]),
            Message(role="assistant", content=[ContentBlock(text="a2")]),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.5)
        assert await strategy.apply(context) is False

    @pytest.mark.asyncio
    async def test_message_level_strategy_fires_on_overflow(self, mock_agent):
        strategy = Offload.truncate("*").when(context_utilization="80%")
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="assistant", content=[ContentBlock(text="a1")]),
            Message(role="user", content=[ContentBlock(text="u2")]),
            Message(role="assistant", content=[ContentBlock(text="a2")]),
            Message(role="user", content=[ContentBlock(text="u3")]),
            Message(role="assistant", content=[ContentBlock(text="a3")]),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.5, overflow=True)
        assert await strategy.apply(context) is True

    @pytest.mark.asyncio
    async def test_emergency_truncate_fires_on_overflow(self, mock_agent):
        strategy = EmergencyTruncateStrategy()
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="assistant", content=[ContentBlock(text="a1")]),
            Message(role="user", content=[ContentBlock(text="u2")]),
            Message(role="assistant", content=[ContentBlock(text="a2")]),
            Message(role="user", content=[ContentBlock(text="u3")]),
            Message(role="assistant", content=[ContentBlock(text="a3")]),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.5, overflow=True)
        assert await strategy.apply(context) is True

    @pytest.mark.asyncio
    async def test_emergency_truncate_skips_below_utilization_no_overflow(self, mock_agent):
        strategy = EmergencyTruncateStrategy()
        mock_agent.model.count_tokens = unittest.mock.AsyncMock(return_value=5000)
        mock_agent.model.estimate_utilization = unittest.mock.MagicMock(return_value=0.5)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(role="assistant", content=[ContentBlock(text="a1")]),
            Message(role="user", content=[ContentBlock(text="u2")]),
            Message(role="assistant", content=[ContentBlock(text="a2")]),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.5)
        assert await strategy.apply(context) is False


class TestPinnedMessageProtection:
    """Tests for pinned message protection in offload strategies."""

    @pytest.mark.asyncio
    async def test_per_block_skips_pinned_messages(self, mock_agent):
        strategy = Offload.drop("*").when(block_threshold=100)
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(
                role="assistant",
                content=[ContentBlock(text="pinned content")],
                metadata={"custom": {"pinned": True}},
            ),
            Message(role="user", content=[ContentBlock(text="unpinned")]),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.5)
        await strategy.apply(context)
        assert messages[1]["content"][0]["text"] == "pinned content"

    @pytest.mark.asyncio
    async def test_message_level_skips_pinned_messages(self, mock_agent):
        strategy = Offload.truncate("*").when(context_utilization="80%")
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="pin")]),
            Message(
                role="assistant",
                content=[ContentBlock(text="pinned")],
                metadata={"custom": {"pinned": True}},
            ),
            Message(role="user", content=[ContentBlock(text="q2")]),
            Message(role="assistant", content=[ContentBlock(text="a2")]),
            Message(role="user", content=[ContentBlock(text="q3")]),
            Message(role="assistant", content=[ContentBlock(text="a3")]),
            Message(role="user", content=[ContentBlock(text="q4")]),
            Message(role="assistant", content=[ContentBlock(text="a4")]),
        ]
        mock_agent.messages = messages
        context = ContextState(messages=messages, agent=mock_agent, utilization=0.9)
        await strategy.apply(context)
        pinned_texts = [
            block.get("text", "")
            for msg in messages
            for block in msg["content"]
            if msg.get("metadata", {}).get("custom", {}).get("pinned")
        ]
        assert "pinned" in pinned_texts

    @pytest.mark.asyncio
    async def test_eager_hook_skips_pinned_message(self, mock_agent):
        mock_agent.hooks = HookRegistry()
        strategy = Offload.drop("*").when(block_threshold=100)
        strategy.init(mock_agent)

        pinned_msg = Message(
            role="user",
            content=[ContentBlock(text="x" * 10000)],
            metadata={"custom": {"pinned": True}},
        )
        mock_agent.messages = [
            Message(role="user", content=[ContentBlock(text="first")]),
            pinned_msg,
        ]
        event = MessageAddedEvent(agent=mock_agent, message=pinned_msg)
        await mock_agent.hooks.invoke_callbacks_async(event)
        assert pinned_msg["content"][0]["text"] == "x" * 10000

    @pytest.mark.asyncio
    async def test_repair_alternation_preserves_pinned_metadata(self):
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="a")]),
            Message(
                role="user",
                content=[ContentBlock(text="b")],
                metadata={"custom": {"pinned": True}},
            ),
        ]
        _repair_alternation(messages)
        assert len(messages) == 1
        assert messages[0].get("metadata", {}).get("custom", {}).get("pinned") is True


class TestInsertMarker:
    """Tests for placing removal markers as assistant content outside message 0."""

    def test_inserts_assistant_message_between_user_messages(self):
        messages: Messages = [_text("user", "task"), _text("user", "u1")]
        _insert_marker(messages, 1, "marker")
        assert messages == [_text("user", "task"), _text("assistant", "marker"), _text("user", "u1")]

    def test_appends_to_assistant_message_before_gap(self):
        original: Message = {**_text("assistant", "a1"), "tracking_id": "msg-1", "metadata": {"custom": {"k": "v"}}}
        messages: Messages = [_text("user", "task"), original, _text("user", "u1")]
        _insert_marker(messages, 2, "marker")
        assert messages[1]["content"] == [ContentBlock(text="a1"), ContentBlock(text="marker")]
        assert messages[1]["tracking_id"] == "msg-1"
        assert messages[1]["metadata"] == {"custom": {"k": "v"}}
        assert original["content"] == [ContentBlock(text="a1")]
        assert len(messages) == 3

    def test_appends_to_assistant_message_after_gap(self):
        messages: Messages = [_text("user", "task"), _text("assistant", "a1"), _text("user", "u1")]
        _insert_marker(messages, 1, "marker")
        assert messages[1]["content"] == [ContentBlock(text="a1"), ContentBlock(text="marker")]
        assert len(messages) == 3

    @pytest.mark.parametrize(
        ("index", "expected"),
        [(0, ["task", "marker", "u1"]), (5, ["task", "u1", "marker"])],
    )
    def test_clamps_index_into_history_after_message_zero(self, index, expected):
        messages: Messages = [_text("user", "task"), _text("user", "u1")]
        _insert_marker(messages, index, "marker")
        assert [message["content"][0]["text"] for message in messages] == expected


class TestRepeatedReductionKeepsMessageZeroVerbatim:
    """Regression tests for https://github.com/strands-agents/harness-sdk/issues/4685."""

    @staticmethod
    def _turn(index, text_only):
        if text_only:
            return [_text("assistant", f"a{index}"), _text("user", f"u{index}")]
        return list(_make_tool_pair(tool_use_id=f"tu-{index}"))

    @pytest.mark.asyncio
    @pytest.mark.parametrize("text_only", [False, True])
    @pytest.mark.parametrize(
        "strategy",
        [
            Offload.drop("*").when(context_utilization="70%", preserve_recent=3),
            Offload.drop("*").when(context_utilization="70%"),
            Offload.truncate("*").when(context_utilization="70%", preserve_recent=3),
            Offload.truncate("*").when(context_utilization="70%"),
            EmergencyTruncateStrategy(),
        ],
        ids=["drop", "drop-all", "truncate", "truncate-all", "emergency"],
    )
    async def test_message_zero_stays_verbatim(self, mock_agent, strategy, text_only):
        task = Message(role="user", content=[ContentBlock(text="task")], metadata={"custom": {"pinned": True}})
        messages: Messages = [task]
        for index in range(30):
            turn = self._turn(index, text_only)
            messages.extend(turn)
            context = ContextState(messages=messages, agent=mock_agent, utilization=1.1, overflow=True)
            await strategy.apply(context)
            assert messages[-1] == turn[-1]
        assert messages[0] == Message(
            role="user", content=[ContentBlock(text="task")], metadata={"custom": {"pinned": True}}
        )
        assert len(messages) < 10
